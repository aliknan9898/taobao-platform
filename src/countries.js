// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/** Delivery countries (ISO 3166-1 alpha-2). Arab markets first, then others Kinan commonly ships to. */
const COUNTRIES = [
  ['SA', 'Saudi Arabia'], ['AE', 'United Arab Emirates'], ['KW', 'Kuwait'], ['QA', 'Qatar'], ['BH', 'Bahrain'], ['OM', 'Oman'],
  ['JO', 'Jordan'], ['IQ', 'Iraq'], ['LB', 'Lebanon'], ['PS', 'Palestine'], ['SY', 'Syria'], ['YE', 'Yemen'],
  ['EG', 'Egypt'], ['LY', 'Libya'], ['TN', 'Tunisia'], ['DZ', 'Algeria'], ['MA', 'Morocco'], ['SD', 'Sudan'], ['MR', 'Mauritania'],
  ['TR', 'Turkey'], ['MT', 'Malta'], ['GB', 'United Kingdom'], ['DE', 'Germany'], ['FR', 'France'], ['IT', 'Italy'], ['ES', 'Spain'],
  ['NL', 'Netherlands'], ['BE', 'Belgium'], ['SE', 'Sweden'], ['NO', 'Norway'], ['DK', 'Denmark'], ['AT', 'Austria'], ['CH', 'Switzerland'],
  ['IE', 'Ireland'], ['PL', 'Poland'], ['GR', 'Greece'], ['CY', 'Cyprus'], ['US', 'United States'], ['CA', 'Canada'], ['AU', 'Australia'],
  ['MY', 'Malaysia'], ['ID', 'Indonesia'], ['PK', 'Pakistan']
];
const BY_CODE = new Map(COUNTRIES);
const BY_NAME = new Map(COUNTRIES.map(([c, n]) => [n.toLowerCase(), c]));
const ALIASES = { uae: 'AE', emirates: 'AE', ksa: 'SA', saudi: 'SA', uk: 'GB', 'great britain': 'GB', england: 'GB', usa: 'US', 'united states of america': 'US', 'السعودية': 'SA', 'الإمارات': 'AE', 'الامارات': 'AE', 'الكويت': 'KW', 'قطر': 'QA', 'البحرين': 'BH', 'عمان': 'OM', 'عُمان': 'OM', 'الأردن': 'JO', 'الاردن': 'JO', 'العراق': 'IQ', 'لبنان': 'LB', 'فلسطين': 'PS', 'سوريا': 'SY', 'اليمن': 'YE', 'مصر': 'EG', 'ليبيا': 'LY', 'تونس': 'TN', 'الجزائر': 'DZ', 'المغرب': 'MA', 'السودان': 'SD', 'تركيا': 'TR', 'مالطا': 'MT' };

/** Best-effort ISO code for a code or a free-text country name. */
function countryCode(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (/^[A-Za-z]{2}$/.test(s) && BY_CODE.has(s.toUpperCase())) return s.toUpperCase();
  return BY_NAME.get(s.toLowerCase()) || ALIASES[s.toLowerCase()] || ALIASES[s] || null;
}
const countryName = (code) => BY_CODE.get(code) || code;

module.exports = { COUNTRIES, countryCode, countryName };
