'use strict';

const crypto = require('node:crypto');
const db = require('../db');
const { httpError } = require('../auth');

const DAY = 86400e3;
const key = () => process.env.TRACK17_API_KEY;
const enabled = () => process.env.TRACK17_ENABLED === '1' && Boolean(key());
const number = (value) => String(value || '').trim().toUpperCase();
const validNumber = (value) => /^[A-Z0-9-]{4,70}$/.test(value);
let registering = false;

async function registerOpen() {
  if (!enabled() || registering) return;
  const now = Date.now();
  const eligible = db.shipments.peek((row) => row.status === 'in_transit' && row.track?.status !== 12 &&
    !row.track17?.registered && (!row.track17?.attempted_at || now - row.track17.attempted_at >= DAY) &&
    now - row.shipped_at < 30 * DAY && validNumber(number(row.tracking)));
  const unique = new Map();
  for (const row of eligible) {
    const no = number(row.tracking);
    if (!unique.has(no)) unique.set(no, row);
    else unique.set(no, null);
  }
  const batch = [...unique.values()].filter(Boolean).slice(0, 20);
  if (!batch.length) return;
  registering = true;
  try {
    for (const row of batch) db.shipments.update(row.id, { track17: { attempted_at: now } });
    await db.flush();
    const response = await fetch('https://api.17track.net/track/v2.4/register', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json', '17TOKEN': key() },
      body: JSON.stringify(batch.map((row) => ({ number: number(row.tracking), tag: row.id }))),
    });
    if (!response.ok) return;
    const result = await response.json();
    if (result.code !== 0) return;
    const accepted = Array.isArray(result.data?.accepted) ? result.data.accepted : [];
    for (const row of batch) {
      const match = accepted.find((item) => number(item.number) === number(row.tracking));
      const current = db.shipments.get(row.id);
      if (match && Number.isSafeInteger(match.carrier) && current && number(current.tracking) === number(row.tracking)) {
        db.shipments.update(row.id, { track17: { ...current.track17, registered: true, carrier: match.carrier } });
      }
    }
    await db.flush();
  } catch {
    // The recorded attempt delays retries on network failure. Cainiao can still supply updates.
  } finally {
    registering = false;
  }
}

const statusActions = {
  'InTransit_PickedUp': ['PICKED_UP', 'Picked up by the carrier'],
  'InTransit_Departure': ['DEPART_ORIGIN', 'Departed the origin facility'],
  'InTransit_Arrival': ['ARRIVE_DEST', 'Arrived at the destination facility'],
  'InTransit_CustomsProcessing': ['IMPORT', 'Customs clearance in progress'],
  'InTransit_CustomsReleased': ['IMPORT_CLEARANCE_SUCCESS', 'Customs clearance completed'],
  'Exception_Returning': ['RETURN_TO_SENDER', 'Returning to the sender'],
  'Exception_Returned': ['RETURN_TO_SENDER', 'Returned to the sender'],
  AvailableForPickup: ['AVAILABLE_FOR_PICKUP', 'Available for pickup'],
  OutForDelivery: ['OUT_FOR_DELIVERY', 'Out for delivery'],
  DeliveryFailure: ['DELIVERY_FAIL', 'Delivery attempt unsuccessful'],
  Delivered: ['DELIVERED', 'Delivered'],
};

async function webhook(raw, sign) {
  if (!enabled()) throw httpError(404, 'Tracking provider is disabled');
  if (typeof sign !== 'string' || !/^[a-f\d]{64}$/i.test(sign)) throw httpError(401, 'Invalid tracking signature');
  const expected = crypto.createHash('sha256').update(raw).update('/').update(key()).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(sign, 'hex'))) throw httpError(401, 'Invalid tracking signature');
  let payload;
  try { payload = JSON.parse(raw); } catch { throw httpError(400, 'Invalid JSON'); }
  const data = payload?.data;
  if (!data || typeof data.tag !== 'string' || !validNumber(number(data.number))) return;
  const row = db.shipments.get(data.tag);
  if (!row?.track17?.attempted_at || number(row.tracking) !== number(data.number) || row.status !== 'in_transit') return;
  if (!Number.isSafeInteger(data.carrier) || data.carrier <= 0 ||
      (row.track17.carrier && row.track17.carrier !== data.carrier)) return;
  if (payload.event === 'TRACKING_STOPPED') {
    db.shipments.update(row.id, { track17: { ...row.track17, stopped: true } });
    await db.flush();
    return;
  }
  if (payload.event !== 'TRACKING_UPDATED' || row.track?.status === 12) return;
  const latest = data.track_info?.latest_status;
  const event = data.track_info?.latest_event;
  const action = Object.hasOwn(statusActions, latest?.sub_status) ? statusActions[latest.sub_status]
    : Object.hasOwn(statusActions, latest?.status) ? statusActions[latest.status] : null;
  const ts = Date.parse(event?.time_utc || event?.time_iso || '');
  if (!action || !Number.isFinite(ts)) return;
  const at = new Date(ts).toISOString().slice(0, 19).replace('T', ' ');
  const events = row.track?.events || [];
  const head = events[0];
  const previousAt = head?.at ? Date.parse(head.at.includes('T') ? head.at : head.at.replace(' ', 'T') + 'Z') : NaN;
  if ((Number.isFinite(previousAt) && ts < previousAt) || events.some((x) => x.at === at && x.action === action[0])) return;

  db.shipments.update(row.id, { track17: { ...row.track17, registered: true, carrier: data.carrier, stopped: false } });
  require('./tracking').updateShipmentTracking(row, [{ at, action: action[0], text: action[1], place: '' }, ...events].slice(0, 40), '17track');
  await db.flush();
}

module.exports = { registerOpen, webhook };
