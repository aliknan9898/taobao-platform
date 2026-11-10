// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Legal pages (Terms, Seller Terms, Privacy, Legal notice) rendered from public/legal/*.html
 * with the operator's details from config, so they stay correct when the company is registered.
 */
const fs = require('fs');
const path = require('path');
const { config } = require('./config');

const DIR = path.join(__dirname, '..', 'public', 'legal');
const UPDATED = '10 November 2026';
const PAGES = {
  '/terms': ['terms.html', 'Terms of Service'],
  '/seller-terms': ['seller-terms.html', 'Seller Terms'],
  '/privacy': ['privacy.html', 'Privacy Policy'],
  '/legal': ['notice.html', 'Legal notice']
};
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function footer() {
  const o = config.operator;
  return `<footer class="sitefoot"><div class="wrap">
    <nav aria-label="Legal"><a href="/terms">Terms</a><a href="/seller-terms">Seller Terms</a><a href="/privacy">Privacy</a><a href="/legal">Legal notice</a><a href="/seller">Sell on Kinan</a></nav>
    <p>© ${new Date().getFullYear()} ${esc(o.name)}. All rights reserved. Kinan is a trading name of ${esc(o.name)}.</p></div></footer>`;
}

function render(pathname) {
  const page = PAGES[pathname];
  if (!page) return null;
  const o = config.operator;
  const email = o.email ? `<a href="mailto:${esc(o.email)}">${esc(o.email)}</a>` : '<em>our support email (published before launch)</em>';
  const vars = {
    TITLE: page[1], UPDATED, YEAR: new Date().getFullYear(),
    OPERATOR: esc(o.name), TRADING: esc(o.tradingName), COUNTRY: esc(o.country),
    ADDRESS: esc(o.address || o.country), COMPANY: esc(o.companyNumber || 'Registration in progress'), VAT: esc(o.vatNumber || 'Not yet registered'),
    COMPANY_SENTENCE: o.companyNumber ? `Kinan is a trading name of ${esc(o.name)}, registered under number ${esc(o.companyNumber)}.` : '',
    EMAIL: email, CURRENCY: esc(config.currency.toUpperCase()),
    NAV: Object.entries(PAGES).map(([href, [, t]]) => `<a href="${href}"${href === pathname ? ' aria-current="page"' : ''}>${t}</a>`).join(''),
    FOOTER: footer()
  };
  const fill = (s) => s.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  vars.BODY = fill(fs.readFileSync(path.join(DIR, page[0]), 'utf8'));
  return fill(fs.readFileSync(path.join(DIR, '_shell.html'), 'utf8'));
}

module.exports = { render, footer, PAGES, UPDATED };
