/* Kinan shared helpers for every interface. */
'use strict';
const K = (() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n, cur = 'usd') => {
    try { return (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: String(cur).toUpperCase() }); }
    catch { return `${(Number(n) || 0).toFixed(2)} ${String(cur).toUpperCase()}`; }
  };
  const num = (n) => (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const date = (t, withTime = true) => t ? new Date(Number(t)).toLocaleString('en-GB', withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }) : '—';
  const plain = (html) => String(html || '').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

  let onUnauthorized = null;
  async function api(path, method = 'GET', body) {
    const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && onUnauthorized) onUnauthorized();
    if (!r.ok) throw Object.assign(new Error(j.error || r.statusText || 'Request failed'), { status: r.status });
    return j;
  }

  let toastTimer;
  function toast(msg) {
    let t = $('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
    t.textContent = msg; t.classList.remove('hide');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hide'), 2800);
  }

  const LOGO = '<svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="#0e7c66"/><path d="M20 15h8v14l13-14h10L36.5 30.5 52 49H41.5L28 33v16h-8z" fill="#fff"/><circle cx="49" cy="15" r="6" fill="#f4b400"/></svg>';
  const brand = (sub) => `<a class="brand" href="${sub === 'Seller Center' ? '/seller' : sub === 'Admin' ? '/admin' : sub === 'Warehouse' ? '/warehouse' : '/'}">${LOGO}<span>kinan</span>${sub ? `<small>${esc(sub)}</small>` : ''}</a>`;

  const ORDER_STATUS = {
    pending_payment: ['Awaiting payment', 'warn'], paid: ['Paid', 'ok'], procuring: ['Buying from supplier', 'warn'],
    awaiting_parcels: ['At our China warehouse soon', 'warn'], ready_to_ship: ['Packed, ready to ship', 'ok'],
    shipped: ['Shipped', 'ok'], delivered: ['Delivered', 'ok'], cancelled: ['Cancelled', 'bad'], refunded: ['Refunded', 'bad'], attention: ['Being reviewed', 'warn']
  };
  const pill = (label, cls = '') => `<span class="pill ${cls}">${esc(label)}</span>`;

  const ICONS = {
    shop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h16l-1.5 10.5a1 1 0 0 1-1 .5h-11a1 1 0 0 1-1-.5z"/><path d="M8.5 9V7a3.5 3.5 0 0 1 7 0v2"/></svg>',
    cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1.3"/><circle cx="18" cy="20" r="1.3"/><path d="M2.5 3.5h2.8l2.4 12h11l2-8.5H6.4"/></svg>',
    box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
    wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M16 15h2"/><path d="M6 6l9-3 1 3"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>',
    back: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>'
  };

  function registerSW() {
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  return { $, $$, esc, money, num, date, plain, api, toast, brand, LOGO, ORDER_STATUS, pill, ICONS, registerSW, set onUnauthorized(f) { onUnauthorized = f; } };
})();
