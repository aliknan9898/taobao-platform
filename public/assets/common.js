// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
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

  const G_LOGO = '<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.2-8.5 2.2-6.2 0-11.5-4.1-13.4-9.8l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>';
  /** "Continue with Google" button + divider, or '' when Google sign-in isn't configured. */
  function googleButton(cfg, app, next = '') {
    if (!cfg || !cfg.google_signin) return '';
    const href = `/auth/google?app=${app}${next ? `&next=${encodeURIComponent(next)}` : ''}`;
    return `<a class="btn gbtn block" href="${esc(href)}">${G_LOGO}<span>Continue with Google</span></a><div class="ordiv"><span>or with email</span></div>`;
  }
  /** Reads and clears ?login_error= set by the Google sign-in redirect. */
  function takeLoginError() {
    const q = new URLSearchParams(location.search); const m = q.get('login_error');
    if (m) { q.delete('login_error'); history.replaceState(null, '', location.pathname + (q.toString() ? `?${q}` : '') + location.hash); }
    return m || '';
  }

  function footer(owner = 'Ali Almadhoun Mohammed Kinan') {
    return `<footer class="sitefoot"><div class="wrap"><nav aria-label="Legal"><a href="/terms">Terms</a><a href="/seller-terms">Seller Terms</a><a href="/privacy">Privacy</a><a href="/legal">Legal notice</a></nav>
      <p>© ${new Date().getFullYear()} ${esc(owner)}. All rights reserved. Kinan is a trading name of ${esc(owner)}.</p></div></footer>`;
  }

  function registerSW() {
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  return { googleButton, takeLoginError, $, $$, esc, money, num, date, plain, api, toast, brand, LOGO, ORDER_STATUS, pill, ICONS, registerSW, footer, set onUnauthorized(f) { onUnauthorized = f; } };
})();
