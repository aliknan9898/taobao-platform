// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';

const list = (value) => Array.isArray(value) ? value : [];
const codeFor = new Map(Object.entries({
  InTransit_PickedUp: 4, InTransit_Departure: 5, InTransit_Arrival: 6,
  AvailableForPickup: 11, OutForDelivery: 10, Delivered: 12, DeliveryFailure: 13,
  Exception_Returning: 14, Exception_Returned: 14
}));
const labels = {
  4: 'Collected by carrier', 5: 'Departed from origin', 6: 'Arrived at destination',
  10: 'Out for delivery', 11: 'Ready for pickup', 12: 'Delivered',
  13: 'Delivery attempt unsuccessful', 14: 'Returning to sender'
};

function parse(data) {
  const byNumber = Object.create(null);
  for (const parcel of list(data.accepted)) {
    const info = parcel.track_info;
    if (!info) continue;
    const events = new Map();
    function record(event, carrier, status = event?.stage, subStatus = event?.sub_status) {
      const date = event?.time_utc || event?.time_iso ||
        [event?.time_raw?.date, event?.time_raw?.time].filter(Boolean).join('T');
      if (!date) return;
      const timestamp = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(date) ? date : date + (date.length === 10 ? 'T00:00:00Z' : 'Z'));
      if (!Number.isFinite(timestamp)) return;
      const at = new Date(timestamp).toISOString();
      const code = codeFor.get(subStatus) || codeFor.get(status) || null;
      const text = String(event.description_translation?.description || event.description || '').slice(0, 200);
      const place = String(event.location || '').slice(0, 100);
      const key = JSON.stringify([at, code, text, place]);
      if (!events.has(key)) events.set(key, { at, code, text, place, carrier, source: '17track' });
    }
    for (const provider of list(info.tracking?.providers)) {
      for (const event of list(provider.events)) record(event, provider.provider?.name);
    }
    if (info.latest_status) {
      record(info.latest_event, undefined, info.latest_status.status, info.latest_status.sub_status);
    }
    byNumber[parcel.number] = [...events.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40);
  }
  return byNumber;
}

async function fetchTracking(numbers, key) {
  const byNumber = Object.create(null);
  const unique = [...new Set(numbers)].filter((number) => /^[a-z0-9][a-z0-9 -]{3,59}$/i.test(number) &&
    !/^CAINIAO_/i.test(number));
  async function call(endpoint, body) {
    const response = await fetch(`https://api.17track.net/track/v2.4/${endpoint}`, {
      method: 'POST', signal: AbortSignal.timeout(4000),
      headers: { 'content-type': 'application/json', '17token': key }, body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`17TRACK HTTP ${response.status}`);
    const json = await response.json();
    if (json.code !== 0 || !json.data) throw new Error('17TRACK rejected the request');
    return json.data;
  }
  for (let offset = 0; offset < unique.length; offset += 40) {
    const batch = unique.slice(offset, offset + 40);
    const data = await call('gettrackinfo', batch.map((number) => ({ number })));
    for (const [number, events] of Object.entries(parse(data))) {
      const original = batch.find((value) => value.toUpperCase() === number.toUpperCase());
      if (original) byNumber[original] = events;
    }
    const missing = new Set(list(data.rejected).filter((x) => x.error?.code === -18019902)
      .map((x) => String(x.number).toUpperCase()));
    const registrations = batch.filter((number) => missing.has(number.toUpperCase())).map((number) => ({ number }));
    if (registrations.length) await call('register', registrations);
  }
  return byNumber;
}

function customerEvents(events, limit = 25) {
  const seen = new Set();
  return list(events).map((event) => {
    if (event.source !== '17track') return event;
    return { at: event.at, text: labels[event.code] || 'Shipment update' };
  }).filter((event) => {
    const key = JSON.stringify([event.at, event.text, event.place]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

module.exports = { fetchTracking, customerEvents, parse };
