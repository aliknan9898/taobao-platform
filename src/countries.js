// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * The one list of delivery countries (ISO 3166-1 alpha-2) used by the storefront, the API, Admin and the supplier imports.
 * Each entry: [code, English name, Arabic name, region].
 *
 * Markets: every European country (including the United Kingdom as GB), Canada, Australia, New Zealand, the United States,
 * Libya (LY, its dedicated catalogue comes in a later release), and the countries Kinan already served before this list
 * (Arab markets, Turkey, Malaysia, Indonesia, Pakistan), kept at the owner's request.
 *
 * Territory exceptions (documented, not selectable): Russia (RU) and Belarus (BY) are left out (sanctions and supplier
 * restrictions); Kosovo has no ISO 3166-1 code (XK is a user-assigned code that suppliers do not share); the Crown
 * dependencies and overseas territories (GI, IM, JE, GG, FO, GL, AX) are not separate markets. Transcontinental Caucasus
 * states (GE, AM, AZ) and Kazakhstan are not included. Supplier-specific codes are mapped in supplierCode().
 */
const MARKETS = [
  // Europe
  ['AL', 'Albania', 'ألبانيا', 'europe'], ['AD', 'Andorra', 'أندورا', 'europe'], ['AT', 'Austria', 'النمسا', 'europe'],
  ['BA', 'Bosnia and Herzegovina', 'البوسنة والهرسك', 'europe'], ['BE', 'Belgium', 'بلجيكا', 'europe'], ['BG', 'Bulgaria', 'بلغاريا', 'europe'],
  ['HR', 'Croatia', 'كرواتيا', 'europe'], ['CY', 'Cyprus', 'قبرص', 'europe'], ['CZ', 'Czechia', 'التشيك', 'europe'],
  ['DK', 'Denmark', 'الدنمارك', 'europe'], ['EE', 'Estonia', 'إستونيا', 'europe'], ['FI', 'Finland', 'فنلندا', 'europe'],
  ['FR', 'France', 'فرنسا', 'europe'], ['DE', 'Germany', 'ألمانيا', 'europe'], ['GR', 'Greece', 'اليونان', 'europe'],
  ['HU', 'Hungary', 'المجر', 'europe'], ['IS', 'Iceland', 'آيسلندا', 'europe'], ['IE', 'Ireland', 'أيرلندا', 'europe'],
  ['IT', 'Italy', 'إيطاليا', 'europe'], ['LV', 'Latvia', 'لاتفيا', 'europe'], ['LI', 'Liechtenstein', 'ليختنشتاين', 'europe'],
  ['LT', 'Lithuania', 'ليتوانيا', 'europe'], ['LU', 'Luxembourg', 'لوكسمبورغ', 'europe'], ['MT', 'Malta', 'مالطا', 'europe'],
  ['MD', 'Moldova', 'مولدوفا', 'europe'], ['MC', 'Monaco', 'موناكو', 'europe'], ['ME', 'Montenegro', 'الجبل الأسود', 'europe'],
  ['NL', 'Netherlands', 'هولندا', 'europe'], ['MK', 'North Macedonia', 'مقدونيا الشمالية', 'europe'], ['NO', 'Norway', 'النرويج', 'europe'],
  ['PL', 'Poland', 'بولندا', 'europe'], ['PT', 'Portugal', 'البرتغال', 'europe'], ['RO', 'Romania', 'رومانيا', 'europe'],
  ['SM', 'San Marino', 'سان مارينو', 'europe'], ['RS', 'Serbia', 'صربيا', 'europe'], ['SK', 'Slovakia', 'سلوفاكيا', 'europe'],
  ['SI', 'Slovenia', 'سلوفينيا', 'europe'], ['ES', 'Spain', 'إسبانيا', 'europe'], ['SE', 'Sweden', 'السويد', 'europe'],
  ['CH', 'Switzerland', 'سويسرا', 'europe'], ['UA', 'Ukraine', 'أوكرانيا', 'europe'], ['GB', 'United Kingdom', 'المملكة المتحدة', 'europe'],
  ['VA', 'Vatican City', 'الفاتيكان', 'europe'],
  // North America and Oceania
  ['CA', 'Canada', 'كندا', 'americas'], ['US', 'United States', 'الولايات المتحدة', 'americas'],
  ['AU', 'Australia', 'أستراليا', 'oceania'], ['NZ', 'New Zealand', 'نيوزيلندا', 'oceania'],
  // Libya (dedicated market)
  ['LY', 'Libya', 'ليبيا', 'libya'],
  // Countries served before this list (kept)
  ['SA', 'Saudi Arabia', 'السعودية', 'other'], ['AE', 'United Arab Emirates', 'الإمارات', 'other'], ['KW', 'Kuwait', 'الكويت', 'other'],
  ['QA', 'Qatar', 'قطر', 'other'], ['BH', 'Bahrain', 'البحرين', 'other'], ['OM', 'Oman', 'عُمان', 'other'],
  ['JO', 'Jordan', 'الأردن', 'other'], ['IQ', 'Iraq', 'العراق', 'other'], ['LB', 'Lebanon', 'لبنان', 'other'],
  ['PS', 'Palestine', 'فلسطين', 'other'], ['SY', 'Syria', 'سوريا', 'other'], ['YE', 'Yemen', 'اليمن', 'other'],
  ['EG', 'Egypt', 'مصر', 'other'], ['TN', 'Tunisia', 'تونس', 'other'], ['DZ', 'Algeria', 'الجزائر', 'other'],
  ['MA', 'Morocco', 'المغرب', 'other'], ['SD', 'Sudan', 'السودان', 'other'], ['MR', 'Mauritania', 'موريتانيا', 'other'],
  ['TR', 'Turkey', 'تركيا', 'other'], ['MY', 'Malaysia', 'ماليزيا', 'other'], ['ID', 'Indonesia', 'إندونيسيا', 'other'],
  ['PK', 'Pakistan', 'باكستان', 'other']
];
/** [code, English name] pairs (the shape older callers use). */
const COUNTRIES = MARKETS.map(([code, en]) => [code, en]);
const BY_CODE = new Map(COUNTRIES);
const AR_BY_CODE = new Map(MARKETS.map(([code, , ar]) => [code, ar]));
const BY_NAME = new Map([...COUNTRIES.map(([c, n]) => [n.toLowerCase(), c]), ...MARKETS.map(([c, , ar]) => [ar, c])]);
const ALIASES = { uae: 'AE', emirates: 'AE', ksa: 'SA', saudi: 'SA', uk: 'GB', 'great britain': 'GB', england: 'GB', scotland: 'GB', wales: 'GB', 'northern ireland': 'GB',
  usa: 'US', 'united states of america': 'US', 'czech republic': 'CZ', holland: 'NL', 'the netherlands': 'NL', macedonia: 'MK', 'holy see': 'VA', 'bosnia': 'BA',
  turkiye: 'TR', 'türkiye': 'TR', 'الامارات': 'AE', 'الاردن': 'JO', 'عمان': 'OM', 'بريطانيا': 'GB', 'امريكا': 'US', 'أمريكا': 'US' };

/** Best-effort ISO code for a code or a free-text country name; null when it is not a Kinan market. */
function countryCode(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (/^[A-Za-z]{2}$/.test(s)) { const up = s.toUpperCase(); if (up === 'UK') return 'GB'; return BY_CODE.has(up) ? up : null; }
  return BY_NAME.get(s.toLowerCase()) || BY_NAME.get(s) || ALIASES[s.toLowerCase()] || ALIASES[s] || null;
}
const countryName = (code) => BY_CODE.get(code) || code;
const countryNameAr = (code) => AR_BY_CODE.get(code) || countryName(code);
const isMarket = (code) => BY_CODE.has(String(code || '').toUpperCase());
const regionOf = (code) => (MARKETS.find(([c]) => c === code) || [])[3] || null;

/**
 * The country code a supplier expects, mapped at the integration boundary. KINAN uses ISO codes (GB for the UK) everywhere.
 * CJ, AliExpress and Banggood currently accept the ISO codes Kinan sends (the live imports already quote "GB"); add an
 * entry here if a supplier needs another spelling (for example AliExpress "UK"). See docs/DELIVERY_COUNTRY.md.
 */
const SUPPLIER_CODES = {};
const supplierCode = (supplier, code) => (SUPPLIER_CODES[supplier] && SUPPLIER_CODES[supplier][code]) || code;

module.exports = { MARKETS, COUNTRIES, countryCode, countryName, countryNameAr, isMarket, regionOf, supplierCode };
