'use strict';
const SUPPLIERS = Object.freeze(['taobao','aliexpress','cj','1688','buckydrop','hiobuy','banggood']);
const DEFAULTS = Object.freeze({minSales:1000,maxShippingDays:20,minMargin:0.30,externalAI:false,autoPublish:false});
function review(product, policy = {}) {
  const p = {...DEFAULTS,...policy};
  if (!SUPPLIERS.includes(product.source)) throw new Error('Unknown supplier');
  const reasons = [], missing = [];
  if (!product.id) missing.push('id');
  if (product.duplicate) reasons.push('duplicate');
  if (product.prohibited) reasons.push('prohibited');
  for (const [key,limit,low] of [['sales',p.minSales,true],['shippingDays',p.maxShippingDays,false],['margin',p.minMargin,true]]) {
    const value = product[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) missing.push(key);
    else if (low ? value < limit : value > limit) reasons.push(key);
  }
  if (!Array.isArray(product.images) || !product.images.length) missing.push('images');
  if (!String(product.title || '').trim()) missing.push('title');
  if (product.imageReview !== 'pass') missing.push('imageReview');
  if (product.complianceReview !== 'pass') missing.push('complianceReview');
  return {status:reasons.length?'rejected':missing.length?'review':'eligible',reasons,missing,externalAI:false};
}
function listingSource(listing) {
  return listing.source || (listing.taobao_item_id || listing.mp_id ? 'taobao' : null);
}

const gateEnabled = () => process.env.SMART_IMPORT_V2_ENABLED === '1';

// All catalogue writes pass through this guard, including old bulk imports, AI release and resync.
function gateListing(next, previous) {
  if (!gateEnabled() || !SUPPLIERS.includes(listingSource(next)) || next.status !== 'active' ||
      previous?.status === 'active') return next;
  return {
    ...next,
    status: 'pending_review',
    review: { state: 'pending', submitted_at: Date.now(), note: 'Smart Import V2 publication is disabled' }
  };
}

module.exports = { SUPPLIERS, DEFAULTS, review, listingSource, gateEnabled, gateListing };
