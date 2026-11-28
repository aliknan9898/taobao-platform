// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';

const db = require('../db');
const { httpError } = require('../auth');
const warehouse = require('./warehouse');
const couriers = require('./couriers');

// The document store has a single writer. Reserve all orders synchronously
// before awaiting the carrier, and persist that reservation before sending.
const active = new Map();

async function book(orderId, body, staff) {
  const withIds = Array.isArray(body.with)
    ? [...new Set(body.with.map(String))].filter((id) => id !== orderId).sort()
    : [];
  const request = {
    carrier: body.carrier, code: body.code, price: Number(body.price) || null,
    weight_g: Number(body.weight_g), length_cm: Number(body.length_cm ?? 30),
    width_cm: Number(body.width_cm ?? 20), height_cm: Number(body.height_cm ?? 10), with: withIds,
  };
  const signature = JSON.stringify(request);
  const existing = db.shipment_bookings.find((row) => row.order_id === orderId && row.status !== 'released');
  if (existing && existing.signature !== signature) throw httpError(409, 'A booking already exists with different parcel details');
  if (existing && active.has(existing.id)) return active.get(existing.id);
  if (existing) {
    const shipment = db.shipments.find((row) => row.booking_id === existing.id);
    if (shipment) { await db.flush(); return shipment; }
    if (existing.status !== 'booked') throw httpError(409, 'Booking outcome is unconfirmed. Check the carrier before issuing another label.');
  } else {
    const order = carrierOrder(warehouse.validateShipment(orderId, withIds));
    couriers.validateLabelRequest(order, request);
  }

  const booking = existing || db.shipment_bookings.insert({
    order_id: orderId, order_ids: [orderId, ...withIds], carrier: request.carrier,
    signature, status: 'pending', created_by: staff.id,
  });
  return run(booking, request, staff);
}

async function run(booking, request, staff) {
  const task = complete(booking, request, staff);
  active.set(booking.id, task);
  try { return await task; } finally { active.delete(booking.id); }
}

function carrierOrder([primary, ...others]) {
  if (!others.length) return primary;
  const group = [primary, ...others];
  if (others.some((order) => order.currency !== primary.currency)) {
    throw httpError(409, 'Combined carrier bookings require orders in the same currency');
  }
  return {
    ...primary,
    lines: group.flatMap((order) => order.lines),
    subtotal: group.reduce((sum, order) => sum + Number(order.subtotal), 0),
  };
}

async function complete(booking, request, staff) {
  let label = booking.carrier_result;
  if (!label) {
    await db.flush();
    let order;
    try {
      order = carrierOrder(warehouse.validateShipment(booking.order_id, request.with, booking.id));
      couriers.validateLabelRequest(order, request);
    } catch (error) {
      db.shipment_bookings.update(booking.id, { status: 'released' });
      await db.flush();
      throw error;
    }
    try {
      label = await couriers.label(order, request, request);
    } catch {
      db.shipment_bookings.update(booking.id, { status: 'uncertain' });
      await db.flush();
      throw httpError(502, 'Carrier booking outcome is unconfirmed. Review Warehouse exceptions before retrying.');
    }
    db.shipment_bookings.update(booking.id, { status: 'booked', carrier_result: label });
    await db.flush();
  }
  const shipment = warehouse.ship(booking.order_id, {
    ...label, with: request.with, weight_g: request.weight_g,
  }, staff, booking.id);
  db.shipment_bookings.update(booking.id, { status: 'completed', carrier_result: null });
  await db.flush();
  return shipment;
}

async function finalize(id, staff) {
  const booking = db.shipment_bookings.get(id);
  if (!booking) throw httpError(404, 'Booking not found');
  if (active.has(id)) return active.get(id);
  const shipment = db.shipments.find((row) => row.booking_id === id);
  if (shipment) { await db.flush(); return shipment; }
  if (booking.status !== 'booked' || !booking.carrier_result?.tracking) throw httpError(409, 'No confirmed carrier label to finalize');
  return run(booking, JSON.parse(booking.signature), staff);
}

function release(id, { confirmation, note } = {}, staff) {
  const booking = db.shipment_bookings.get(id);
  if (!booking) throw httpError(404, 'Booking not found');
  if (active.has(id) || !['pending', 'uncertain', 'booked'].includes(booking.status) ||
      db.shipments.find((row) => row.booking_id === id)) throw httpError(409, 'Booking cannot be released');
  if (confirmation !== 'CARRIER_CONFIRMED' || typeof note !== 'string' || !note.trim() || note.length > 300) {
    throw httpError(400, 'Confirm with the carrier that no active label exists and record the reference');
  }
  db.shipment_bookings.update(id, { status: 'released', released_by: staff.id, release_note: note.trim(), released_at: Date.now() });
  return db.flush().then(() => ({ ok: true }));
}

module.exports = { book, finalize, release };
