'use strict';

const PAGE_LIMIT = 4;
const number = (value) => (typeof value === 'number' || (typeof value === 'string' && value.trim()))
  && Number.isFinite(Number(value)) ? Number(value) : null;
const id = (value) => /^\d+$/.test(value || '') ? value : null;
const version = (value, fallback) => /^v\d+(\.\d+)?$/.test(value || '') ? value : fallback;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

async function request(url, options) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(4500) });
  if (!response.ok) {
    const error = new Error('Advertising API request failed');
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function pages(fetchPage) {
  const rows = [];
  let cursor;
  for (let page = 1; page <= PAGE_LIMIT; page++) {
    const result = await fetchPage(cursor, page);
    rows.push(...result.rows);
    cursor = result.cursor;
    if (!cursor) break;
  }
  return { rows, partial: Boolean(cursor) };
}

function metric(row, field, types) {
  if (!Array.isArray(row[field])) return null;
  for (const type of types) {
    const value = row[field].find((item) => item.action_type === type)?.value;
    if (value != null) return number(value);
  }
  return null;
}

async function meta(account, token, from, to) {
  const root = 'https://graph.facebook.com/' + version(process.env.META_ADS_API_VERSION, 'v27.0');
  const headers = { Authorization: 'Bearer ' + token };
  const purchases = ['omni_purchase', 'offsite_conversion.fb_pixel_purchase', 'purchase'];
  return pages(async (cursor) => {
    const query = new URLSearchParams({
      level: 'campaign', limit: '100', time_range: JSON.stringify({ since: from, until: to }),
      fields: 'account_name,account_currency,campaign_id,campaign_name,objective,spend,impressions,clicks,reach,inline_link_clicks,actions,action_values'
    });
    if (cursor) query.set('after', cursor);
    const data = await request(root + '/act_' + account + '/insights?' + query, { headers });
    return {
      rows: data.data.map((row) => ({
        id: row.campaign_id, name: row.campaign_name, account: row.account_name, currency: row.account_currency,
        objective: row.objective, spend: number(row.spend), impressions: number(row.impressions),
        clicks: number(row.clicks), linkClicks: number(row.inline_link_clicks), reach: number(row.reach),
        conversions: metric(row, 'actions', purchases), value: metric(row, 'action_values', purchases)
      })),
      cursor: data.paging?.next && data.paging?.cursors?.after
    };
  });
}

async function tiktok(account, token, from, to) {
  return pages(async (_, page) => {
    const query = new URLSearchParams({
      advertiser_id: account, service_type: 'AUCTION', report_type: 'BASIC', data_level: 'AUCTION_CAMPAIGN',
      dimensions: JSON.stringify(['campaign_id']),
      metrics: JSON.stringify(['campaign_name', 'objective_type', 'currency', 'spend', 'impressions', 'clicks', 'reach', 'complete_payment', 'complete_payment_roas']),
      start_date: from, end_date: to, page: String(page), page_size: '100'
    });
    const data = await request('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/?' + query,
      { headers: { 'Access-Token': token } });
    if (data.code !== 0) throw new Error('TikTok rejected the report');
    return {
      rows: data.data.list.map(({ dimensions, metrics: m }) => ({
        id: dimensions.campaign_id, name: m.campaign_name, currency: m.currency, objective: m.objective_type,
        spend: number(m.spend), impressions: number(m.impressions), clicks: number(m.clicks),
        reach: number(m.reach), conversions: number(m.complete_payment), value: null,
        roas: number(m.complete_payment_roas)
      })),
      cursor: page < data.data.page_info?.total_page
    };
  });
}

async function google(account, token, from, to) {
  const keywords = require('./keywords');
  const headers = {
    Authorization: 'Bearer ' + await keywords.accessToken(), 'developer-token': token,
    'Content-Type': 'application/json'
  };
  const manager = id(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/-/g, ''));
  if (manager) headers['login-customer-id'] = manager;
  const query = 'SELECT customer.descriptive_name, customer.currency_code, campaign.id, campaign.name, campaign.status, '
    + 'campaign.advertising_channel_type, metrics.cost_micros, metrics.impressions, metrics.clicks, '
    + 'metrics.conversions, metrics.conversions_value FROM campaign '
    + "WHERE segments.date BETWEEN '" + from + "' AND '" + to + "'";
  const endpoint = 'https://googleads.googleapis.com/' + version(process.env.GOOGLE_ADS_API_VERSION, 'v26')
    + '/customers/' + account + '/googleAds:search';
  return pages(async (pageToken) => {
    const data = await request(endpoint, { method: 'POST', headers, body: JSON.stringify({ query, pageToken }) });
    return {
      rows: (data.results || []).map(({ customer, campaign, metrics: m }) => ({
        id: campaign.id, name: campaign.name, account: customer.descriptiveName, currency: customer.currencyCode,
        status: campaign.status, objective: campaign.advertisingChannelType,
        spend: number(m.costMicros) === null ? null : Number(m.costMicros) / 1e6,
        impressions: number(m.impressions), clicks: number(m.clicks), conversions: number(m.conversions),
        value: number(m.conversionsValue)
      })),
      cursor: data.nextPageToken
    };
  });
}

const platforms = {
  meta: { report: meta, idEnv: 'META_ADS_ACCOUNT_ID', tokenEnv: 'META_ADS_ACCESS_TOKEN' },
  tiktok: { report: tiktok, idEnv: 'TIKTOK_ADS_ADVERTISER_ID', tokenEnv: 'TIKTOK_ADS_ACCESS_TOKEN' },
  google: { report: google, idEnv: 'GOOGLE_ADS_CUSTOMER_ID', tokenEnv: 'GOOGLE_ADS_DEVELOPER_TOKEN' }
};

function validRange(from, to) {
  if (!datePattern.test(from) || !datePattern.test(to)) return false;
  const a = new Date(from), b = new Date(to);
  return Number.isFinite(+a) && Number.isFinite(+b)
    && a.toISOString().slice(0, 10) === from && b.toISOString().slice(0, 10) === to
    && +b >= +a && +b - +a < 90 * 86400000;
}

function connections() {
  return Object.fromEntries(Object.entries(platforms).map(([key, { idEnv, tokenEnv }]) => {
    const account = id(process.env[idEnv]?.trim().replace(/^act_/, '').replace(/-/g, ''));
    const token = process.env[tokenEnv]?.trim();
    const missing = [!account && idEnv, !token && tokenEnv].filter(Boolean);
    const status = missing.length ? 'setup' : key === 'google' && !require('./keywords').connected() ? 'authorize' : 'configured';
    return [key, { status, account, missing }];
  }));
}

async function report(platform, from, to) {
  const { account, status } = connections()[platform];
  if (status !== 'configured') return { status };
  const { report: fetchReport, tokenEnv } = platforms[platform];
  try {
    return { status: 'ready', ...(await fetchReport(account, process.env[tokenEnv].trim(), from, to)), fetchedAt: new Date().toISOString() };
  } catch (error) {
    if ([401, 403].includes(error.status)) return { status: 'permission' };
    if (error.status === 429) return { status: 'rate_limit' };
    return { status: 'unavailable' };
  }
}

module.exports = { connections, report, validRange };
