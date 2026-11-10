// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * International couriers.
 *  - Tracking links for common carriers (customers tap to follow their parcel).
 *  - Live rates and labels from DHL Express (MyDHL API) and Aramex (Shipping API v2) when their
 *    credentials are set. Field names follow the public API references; marked VERIFY where the
 *    exact shape should be confirmed with the first real response.
 */
const { config } = require('../config');
const { httpError } = require('../auth');

const e = process.env;
const money = (n) => Math.round(Number(n) * 100) / 100;

// ---------------- Tracking links ----------------
const CARRIERS = [
  ['dhl', 'DHL Express', /dhl/i, 'https://www.dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id={n}'],
  ['aramex', 'Aramex', /aramex/i, 'https://www.aramex.com/track/results?ShipmentNumber={n}'],
  ['fedex', 'FedEx', /fedex/i, 'https://www.fedex.com/fedextrack/?trknbr={n}'],
  ['ups', 'UPS', /\bups\b/i, 'https://www.ups.com/track?tracknum={n}'],
  ['smsa', 'SMSA', /smsa/i, 'https://www.smsaexpress.com/trackingdetails?tracknumbers={n}'],
  ['cainiao', 'Cainiao', /cainiao|菜鸟/i, 'https://global.cainiao.com/newDetail.htm?mailNoList={n}'],
  ['yunexpress', 'YunExpress', /yun/i, 'https://www.yuntrack.com/parcelTracking?id={n}'],
  ['4px', '4PX', /4px/i, 'https://track.4px.com/#/result/0/{n}'],
  ['ems', 'EMS / China Post', /ems|china ?post/i, 'https://t.17track.net/en#nums={n}'],
  ['other', 'Other', /.*/, 'https://t.17track.net/en#nums={n}']
];
const carrierKey = (name) => (CARRIERS.find(([k, label, re]) => k === name || label === name || re.test(String(name || ''))) || CARRIERS[CARRIERS.length - 1])[0];
function trackingUrl(carrier, number) {
  if (!number) return null;
  const c = CARRIERS.find(([k]) => k === carrierKey(carrier));
  return c[3].replace('{n}', encodeURIComponent(String(number).trim()));
}

// ---------------- API carriers ----------------
const dhlOn = () => Boolean(e.DHL_API_KEY && e.DHL_API_SECRET && e.DHL_ACCOUNT);
const aramexOn = () => Boolean(e.ARAMEX_USERNAME && e.ARAMEX_PASSWORD && e.ARAMEX_ACCOUNT && e.ARAMEX_PIN);
const DHL_BASE = () => (e.DHL_TEST === '1' ? 'https://express.api.dhl.com/mydhlapi/test' : 'https://express.api.dhl.com/mydhlapi');
const ARAMEX_BASE = () => e.ARAMEX_API_URL || 'https://ws.aramex.net/ShippingAPI.V2';

function status() {
  return { dhl: dhlOn(), aramex: aramexOn(), carriers: CARRIERS.map(([key, label]) => ({ key, label })) };
}

async function http(url, opts) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 300) }; }
  return { ok: r.ok, status: r.status, body: j };
}

const wh = () => config.warehouse;
function parcel({ weight_g, length_cm, width_cm, height_cm }) {
  const kg = Math.max(0.1, Math.round((Number(weight_g) || 500) / 100) / 10);
  return { kg, l: Math.max(1, Number(length_cm) || 30), w: Math.max(1, Number(width_cm) || 20), h: Math.max(1, Number(height_cm) || 10) };
}
const tomorrow = () => { const d = new Date(Date.now() + 86400e3); d.setUTCHours(8, 0, 0, 0); return d; };

// ---- DHL Express ----
const dhlAuth = () => 'Basic ' + Buffer.from(`${e.DHL_API_KEY}:${e.DHL_API_SECRET}`).toString('base64');
async function dhlRates(order, p) {
  const a = order.shipping_address;
  const q = new URLSearchParams({
    accountNumber: e.DHL_ACCOUNT, originCountryCode: 'CN', originCityName: wh().city || 'Guangzhou', originPostalCode: wh().zip || '',
    destinationCountryCode: a.country_code || '', destinationCityName: a.city, destinationPostalCode: a.postal_code || '',
    weight: String(p.kg), length: String(p.l), width: String(p.w), height: String(p.h),
    plannedShippingDate: tomorrow().toISOString().slice(0, 10), isCustomsDeclarable: 'true', unitOfMeasurement: 'metric'
  });
  const r = await http(`${DHL_BASE()}/rates?${q}`, { headers: { Authorization: dhlAuth(), Accept: 'application/json' } });
  if (!r.ok) throw httpError(502, `DHL: ${r.body.detail || r.body.title || r.body.message || r.status}`);
  return (r.body.products || []).map((x) => {
    const price = (x.totalPrice || []).find((t) => t.currencyType === 'BILLC') || (x.totalPrice || [])[0] || {};
    return { carrier: 'dhl', carrier_label: 'DHL Express', service: x.productName, code: x.productCode, price: money(price.price), currency: price.priceCurrency || '', eta: x.deliveryCapabilities?.estimatedDeliveryDateAndTime || null };
  }).filter((x) => x.price > 0);
}

async function dhlLabel(order, p, productCode) {
  const a = order.shipping_address; const w = wh();
  const value = money(order.subtotal);
  const body = {
    plannedShippingDateAndTime: tomorrow().toISOString().replace(/\.\d+Z$/, ' GMT+00:00').replace('T', 'T'),
    pickup: { isRequested: false }, productCode,
    accounts: [{ typeCode: 'shipper', number: e.DHL_ACCOUNT }],
    customerDetails: {
      shipperDetails: { postalAddress: { postalCode: w.zip || '', cityName: w.city, countryCode: 'CN', addressLine1: w.detail_address || w.city }, contactInformation: { phone: w.mobile, companyName: config.operator.tradingName || 'Kinan', fullName: w.name } },
      receiverDetails: { postalAddress: { postalCode: a.postal_code || '', cityName: a.city, countryCode: a.country_code, addressLine1: a.line1, addressLine2: a.line2 || undefined }, contactInformation: { phone: a.phone, companyName: a.name, fullName: a.name } }
    },
    content: {
      packages: [{ weight: p.kg, dimensions: { length: p.l, width: p.w, height: p.h } }],
      isCustomsDeclarable: true, declaredValue: value, declaredValueCurrency: String(order.currency).toUpperCase(), description: 'Consumer goods', incoterm: 'DAP', unitOfMeasurement: 'metric',
      exportDeclaration: { lineItems: order.lines.slice(0, 50).map((l, i) => ({ number: i + 1, description: String(l.title).slice(0, 70), price: money(l.price), quantity: { value: l.qty, unitOfMeasurement: 'PCS' }, exportReasonType: 'permanent', manufacturerCountry: 'CN', weight: { netValue: money(p.kg / order.lines.length), grossValue: money(p.kg / order.lines.length) } })), invoice: { number: order.id.slice(-12).toUpperCase(), date: new Date().toISOString().slice(0, 10) } }
    },
    outputImageProperties: { imageOptions: [{ typeCode: 'label', templateName: 'ECOM26_84_001', isRequested: true }] } // VERIFY template for your account
  };
  const r = await http(`${DHL_BASE()}/shipments`, { method: 'POST', headers: { Authorization: dhlAuth(), 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw httpError(502, `DHL: ${r.body.detail || r.body.title || r.body.message || r.status}`);
  const doc = (r.body.documents || []).find((d) => d.typeCode === 'label') || (r.body.documents || [])[0];
  const charge = (r.body.shipmentCharges || []).find((t) => t.currencyType === 'BILLC') || (r.body.shipmentCharges || [])[0] || {};
  return { carrier: 'DHL', tracking: r.body.shipmentTrackingNumber, cost: money(charge.price || 0) || null, label: doc ? { type: 'pdf', data: doc.content } : null };
}

// ---- Aramex ----
const aramexClient = () => ({ UserName: e.ARAMEX_USERNAME, Password: e.ARAMEX_PASSWORD, Version: 'v1.0', AccountNumber: e.ARAMEX_ACCOUNT, AccountPin: e.ARAMEX_PIN, AccountEntity: e.ARAMEX_ENTITY || '', AccountCountryCode: e.ARAMEX_COUNTRY || '', Source: 24 });
const aramexErr = (b) => (b.Notifications || []).map((n) => n.Message).join('; ') || 'request failed';
async function aramexRates(order, p) {
  const a = order.shipping_address;
  const body = {
    ClientInfo: aramexClient(),
    OriginAddress: { City: wh().city, CountryCode: 'CN', PostCode: wh().zip || '' },
    DestinationAddress: { City: a.city, CountryCode: a.country_code, PostCode: a.postal_code || '' },
    ShipmentDetails: { Dimensions: { Length: p.l, Width: p.w, Height: p.h, Unit: 'CM' }, ActualWeight: { Unit: 'KG', Value: p.kg }, ChargeableWeight: { Unit: 'KG', Value: p.kg }, NumberOfPieces: 1, ProductGroup: 'EXP', ProductType: 'PPX', PaymentType: 'P' },
    PreferredCurrencyCode: String(order.currency).toUpperCase()
  };
  const r = await http(`${ARAMEX_BASE()}/RateCalculator/Service_1_0.svc/json/CalculateRate`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok || r.body.HasErrors) throw httpError(502, `Aramex: ${aramexErr(r.body)}`);
  const t = r.body.TotalAmount || {};
  return [{ carrier: 'aramex', carrier_label: 'Aramex', service: 'Priority Parcel Express', code: 'PPX', price: money(t.Value), currency: t.CurrencyCode || '', eta: null }].filter((x) => x.price > 0);
}

async function aramexLabel(order, p) {
  const a = order.shipping_address; const w = wh();
  const when = `/Date(${tomorrow().getTime()})/`;
  const body = {
    ClientInfo: aramexClient(), LabelInfo: { ReportID: 9201, ReportType: 'URL' },
    Shipments: [{
      Reference1: order.id.slice(-12).toUpperCase(),
      Shipper: { AccountNumber: e.ARAMEX_ACCOUNT, PartyAddress: { Line1: w.detail_address || w.city, City: w.city, CountryCode: 'CN', PostCode: w.zip || '' }, Contact: { PersonName: w.name, CompanyName: config.operator.tradingName || 'Kinan', PhoneNumber1: w.mobile, CellPhone: w.mobile, EmailAddress: config.operator.email || '' } },
      Consignee: { PartyAddress: { Line1: a.line1, Line2: a.line2 || '', City: a.city, CountryCode: a.country_code, PostCode: a.postal_code || '' }, Contact: { PersonName: a.name, CompanyName: a.name, PhoneNumber1: a.phone, CellPhone: a.phone, EmailAddress: '' } },
      ShippingDateTime: when, DueDate: when,
      Details: { Dimensions: { Length: p.l, Width: p.w, Height: p.h, Unit: 'CM' }, ActualWeight: { Unit: 'KG', Value: p.kg }, NumberOfPieces: 1, ProductGroup: 'EXP', ProductType: 'PPX', PaymentType: 'P', DescriptionOfGoods: 'Consumer goods', GoodsOriginCountry: 'CN', CustomsValueAmount: { CurrencyCode: String(order.currency).toUpperCase(), Value: money(order.subtotal) } }
    }]
  };
  const r = await http(`${ARAMEX_BASE()}/Shipping/Service_1_0.svc/json/CreateShipments`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  const s = (r.body.Shipments || [])[0];
  if (!r.ok || r.body.HasErrors || !s || s.HasErrors) throw httpError(502, `Aramex: ${aramexErr(s || r.body)}`);
  return { carrier: 'Aramex', tracking: s.ID, cost: null, label: s.ShipmentLabel?.LabelURL ? { type: 'url', url: s.ShipmentLabel.LabelURL } : null };
}

/** Live prices from every configured courier. Errors from one courier don't hide the others. */
async function rates(order, dims) {
  if (!order.shipping_address?.country_code) throw httpError(400, 'The customer’s country is not recognised — ship this one by hand');
  const p = parcel(dims); const out = []; const errors = [];
  for (const [on, fn, name] of [[dhlOn, dhlRates, 'DHL'], [aramexOn, aramexRates, 'Aramex']]) {
    if (!on()) continue;
    try { out.push(...await fn(order, p)); } catch (err) { errors.push(`${name}: ${err.message.replace(/^\w+: /, '')}`); }
  }
  if (!dhlOn() && !aramexOn()) throw httpError(503, 'No courier account is connected — enter the tracking number by hand');
  return { parcel: p, rates: out.sort((x, y) => x.price - y.price), errors };
}

/** Book the shipment and get the label. Returns { carrier, tracking, cost, label }. */
async function label(order, { carrier, code, price }, dims) {
  const p = parcel(dims);
  let out;
  if (carrier === 'dhl' && dhlOn()) out = await dhlLabel(order, p, code || 'P');
  else if (carrier === 'aramex' && aramexOn()) out = await aramexLabel(order, p);
  else throw httpError(400, 'That courier is not connected');
  if (!out.tracking) throw httpError(502, 'The courier did not return a tracking number');
  if (!out.cost && Number(price) > 0) out.cost = money(price);
  return out;
}

module.exports = { CARRIERS, carrierKey, trackingUrl, status, rates, label, parcel };
