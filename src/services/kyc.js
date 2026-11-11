// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Seller identity verification (KYC).
 * A new seller (Google or email sign-up) fills in their details, uploads an identity document and takes a
 * live selfie. The shop stays "pending" until an admin approves it; a rejected application can be corrected
 * and sent again. Document photos are kept in their own collection and only admins can open them.
 */
const db = require('../db');
const { httpError } = require('../auth');

const IMG_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_IMG = 1.2 * 1024 * 1024; // base64 length per photo (~900 KB image)
const ID_TYPES = { passport: 'Passport', national_id: 'National ID card', residence_permit: 'Residence permit', driving_licence: 'Driving licence' };
const BUSINESS = { individual: 'Individual', company: 'Company' };
const s = (v, n) => String(v ?? '').trim().slice(0, n);

function img(v, what, required = true) {
  if (!v) { if (required) throw httpError(400, `Add the ${what}`); return null; }
  if (!IMG_RE.test(v)) throw httpError(400, `The ${what} must be a photo (JPG or PNG)`);
  if (v.length > MAX_IMG) throw httpError(413, `The ${what} is too large — try again`);
  return v;
}

/** What the seller sees about their own application (no photos). */
function view(seller) {
  const k = seller.kyc || {};
  return {
    state: k.state || 'none', submitted_at: k.submitted_at || null, decided_at: k.decided_at || null, reason: k.reason || null,
    details: k.details || null, has: { id_front: Boolean(k.docs?.id_front), id_back: Boolean(k.docs?.id_back), selfie: Boolean(k.docs?.selfie) }
  };
}

function submit(seller, user, b = {}) {
  if (seller.status === 'suspended') throw httpError(403, 'This shop is suspended — contact Kinan support');
  if (seller.kyc?.state === 'approved') throw httpError(409, 'Your identity is already verified');
  const d = {
    full_name: s(b.full_name, 100), date_of_birth: s(b.date_of_birth, 10), nationality: s(b.nationality, 2).toUpperCase(),
    country: s(b.country, 2).toUpperCase(), city: s(b.city, 80), address: s(b.address, 300), postal_code: s(b.postal_code, 20),
    phone: s(b.phone, 30), shop_name: s(b.shop_name, 80), business_type: BUSINESS[b.business_type] ? b.business_type : 'individual',
    company_name: s(b.company_name, 120), company_number: s(b.company_number, 60),
    id_type: ID_TYPES[b.id_type] ? b.id_type : '', id_number: s(b.id_number, 40), id_expiry: s(b.id_expiry, 10),
    products: s(b.products, 300)
  };
  const miss = [['full_name', 'full name'], ['date_of_birth', 'date of birth'], ['nationality', 'nationality'], ['country', 'country'], ['city', 'city'], ['address', 'address'], ['phone', 'phone number'], ['shop_name', 'shop name'], ['id_type', 'document type'], ['id_number', 'document number']]
    .filter(([k]) => !d[k]).map(([, t]) => t);
  if (miss.length) throw httpError(400, `Please fill in: ${miss.join(', ')}`);
  if (d.full_name.split(/\s+/).length < 2) throw httpError(400, 'Write your full name as on your document (first and last name)');
  const dob = new Date(d.date_of_birth);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date_of_birth) || Number.isNaN(dob.getTime())) throw httpError(400, 'Invalid date of birth');
  const age = (Date.now() - dob.getTime()) / (365.25 * 86400e3);
  if (age < 18) throw httpError(400, 'You must be 18 or older to sell on Kinan');
  if (age > 110) throw httpError(400, 'Invalid date of birth');
  if (d.id_expiry && /^\d{4}-\d{2}-\d{2}$/.test(d.id_expiry) && new Date(d.id_expiry).getTime() < Date.now() - 86400e3) throw httpError(400, 'Your document has expired — use a valid document');
  if (!/^\+?[0-9 ()-]{7,30}$/.test(d.phone)) throw httpError(400, 'Invalid phone number');
  if (d.business_type === 'company' && !d.company_name) throw httpError(400, 'Add the company name');
  if (!b.agree) throw httpError(400, 'Please confirm that the information is true');

  const ref = seller.kyc?.docs || {}; const old = Object.fromEntries(Object.entries(ref).map(([k, id]) => [k, id ? db.kyc_docs.get(id)?.data || null : null]));
  // Photos sent again replace the old ones; on a correction the seller may keep earlier photos
  const docs = {
    id_front: img(b.id_front, 'front of your document', !old.id_front) || old.id_front,
    id_back: img(b.id_back, 'back of your document', d.id_type !== 'passport' && !old.id_back) || old.id_back || null,
    selfie: img(b.selfie, 'selfie', !old.selfie) || old.selfie
  };
  if (b.selfie && b.selfie_live !== true) throw httpError(400, 'Take the selfie with your camera now');
  const store = (key, data) => { if (!data) return null; const id = `kyc_${seller.id}_${key}`; const doc = { seller_id: seller.id, kind: key, data, at: Date.now() }; db.kyc_docs.get(id) ? db.kyc_docs.update(id, doc) : db.kyc_docs.insert({ id, ...doc }); return id; };
  const refs = { id_front: store('id_front', docs.id_front), id_back: store('id_back', docs.id_back), selfie: store('selfie', docs.selfie) };
  const kyc = { state: 'submitted', details: d, docs: refs, submitted_at: Date.now(), decided_at: null, reason: null, history: [...(seller.kyc?.history || []), { at: Date.now(), event: 'submitted' }].slice(-20) };
  const out = db.sellers.update(seller.id, { kyc, shop_name: d.shop_name, status: seller.status === 'active' ? 'active' : 'pending' });
  if (user && d.full_name && user.name !== d.full_name) db.users.update(user.id, { name: d.full_name });
  try { require('../notify').sellerUnderReview(out); } catch (e) { console.error('[kyc] mail', e.message); }
  try { require('../push').telegram(`🆕 Seller verification to review: ${d.shop_name} (${d.full_name}, ${d.country}). Open Admin → Sellers.`); } catch { /* optional */ }
  return view(out);
}

/** Admin list helper: short summary for the sellers table. */
function summary(seller) {
  const k = seller.kyc || {};
  return { state: k.state || 'none', submitted_at: k.submitted_at || null, name: k.details?.full_name || null, country: k.details?.country || null };
}

/** Admin: full application with photo links. */
function adminView(seller) {
  const k = seller.kyc || {};
  return { seller_id: seller.id, shop_name: seller.shop_name, status: seller.status, email: db.users.get(seller.user_id)?.email || null, ...view(seller), id_type_label: ID_TYPES[k.details?.id_type] || null, history: k.history || [] };
}

function photo(seller, kind) {
  const ref = seller.kyc?.docs?.[kind];
  const d = ref && db.kyc_docs.get(ref);
  if (!d) return null;
  const m = d.data.match(/^data:(image\/\w+);base64,(.+)$/);
  return m ? { type: m[1], body: Buffer.from(m[2], 'base64') } : null;
}

function decide(sellerId, { approve, reason } = {}, by) {
  const seller = db.sellers.get(sellerId);
  if (!seller) throw httpError(404, 'Seller not found');
  const k = seller.kyc || {};
  if (k.state !== 'submitted' && !(approve && k.state === 'rejected')) throw httpError(409, 'There is no application waiting for review');
  if (!approve && !s(reason, 500)) throw httpError(400, 'Write what the seller must correct');
  const kyc = { ...k, state: approve ? 'approved' : 'rejected', decided_at: Date.now(), decided_by: by || null, reason: approve ? null : s(reason, 500), history: [...(k.history || []), { at: Date.now(), event: approve ? 'approved' : 'rejected', by }].slice(-20) };
  const out = db.sellers.update(seller.id, { kyc, ...(approve ? { status: 'active' } : {}) });
  const notify = require('../notify');
  if (approve && seller.status !== 'active') notify.sellerApproved(out);
  else if (!approve) notify.sellerKycRejected(out, kyc.reason);
  return adminView(out);
}

/** Every seller except the owner's own shop must be verified: shops opened before verification existed go back to "pending" until they send it. */
function enforce() {
  const { isOwner } = require('../auth');
  let n = 0;
  for (const sl of db.sellers.all((x) => !x.system && x.status === 'active' && x.kyc?.state !== 'approved')) {
    if (isOwner(db.users.get(sl.user_id))) continue;
    db.sellers.update(sl.id, { status: 'pending', kyc_required_at: Date.now() }); n++;
  }
  if (n) console.log(`[kyc] ${n} unverified shop(s) moved to pending until they verify`);
  return n;
}

module.exports = { enforce, view, submit, summary, adminView, photo, decide, ID_TYPES };
