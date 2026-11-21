// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/** After a restore: compare the restored store with the backup (counts, a product with its photos, an order). */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function reconcile(store, snap) {
  const problems = [];
  for (const [name, docs] of Object.entries(snap.collections)) {
    const coll = store[name === 'oauth_states' ? 'oauthStates' : name]; if (!coll) continue;
    if (coll.all().length !== docs.length) problems.push(`${name}: ${coll.all().length} restored, ${docs.length} in the backup`);
  }
  const product = (snap.collections.listings || []).find((l) => (l.images || []).length) || null;
  let productCheck = null;
  if (product) {
    const r = store.listings.get(product.id);
    const photos = (product.images || []).map((u) => ({ url: u, kinan_copy: (snap.collections.media || []).find((m) => m.url === u)?.hosted || null }));
    productCheck = { id: product.id, title: String(product.title || '').slice(0, 60), price_ok: Boolean(r) && same(r.skus, product.skus), photos_ok: Boolean(r) && same(r.images, product.images), photos: photos.slice(0, 3) };
    if (!productCheck.price_ok || !productCheck.photos_ok) problems.push(`product ${product.id} differs`);
  }
  const order = (snap.collections.orders || []).slice(-1)[0] || null;
  let orderCheck = null;
  if (order) {
    const r = store.orders.get(order.id);
    const ledger = (snap.collections.ledger || []).filter((x) => x.order_id === order.id).length;
    orderCheck = { id: order.id, status: r?.status, total_ok: Boolean(r) && r.total === order.total && r.status === order.status, lines_ok: Boolean(r) && same(r.lines, order.lines), ledger_lines: ledger, ledger_ok: store.ledger.all((x) => x.order_id === order.id).length === ledger };
    if (!orderCheck.total_ok || !orderCheck.lines_ok || !orderCheck.ledger_ok) problems.push(`order ${order.id} differs`);
  }
  return { ok: problems.length === 0, problems, product: productCheck, order: orderCheck };
}

module.exports = { reconcile };
