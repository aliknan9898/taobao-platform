'use strict';

const { createClient, environment, LOCATION_KEY, MARKETS, stageError } = require('../src/services/ebayPublisher');

function plan(env = process.env) {
  const marketplace = env.EBAY_MARKETPLACE || 'EBAY_GB';
  if (!Object.hasOwn(MARKETS, marketplace)) throw stageError('configuration', 'Unsupported marketplace', 400);
  const address = {
    addressLine1: (env.EBAY_LOC_ADDRESS1 ?? '').trim(),
    city: (env.EBAY_LOC_CITY ?? 'Naxxar').trim(),
    postalCode: (env.EBAY_LOC_POSTAL ?? 'NXR 6015').trim(),
    country: (env.EBAY_LOC_COUNTRY ?? 'MT').trim().toUpperCase()
  };
  const phone = (env.EBAY_LOC_PHONE ?? '').trim();
  if (!address.city || !address.postalCode || !/^[A-Z]{2}$/.test(address.country) || (phone && !/^\+[\d ]{7,18}$/.test(phone))) {
    throw stageError('validation', 'Invalid inventory location address or phone', 400);
  }
  return { environment: environment(env), marketplace,
    merchantLocationKey: env.EBAY_MERCHANT_LOCATION_KEY || LOCATION_KEY,
    location: { location: { address }, name: 'Kinan Shop', merchantLocationStatus: 'ENABLED', locationTypes: ['WAREHOUSE'], phone } };
}

async function run(args = process.argv.slice(2), { env = process.env, client } = {}) {
  if (args.length > 1 || args.some((flag) => flag !== '--dry-run' && flag !== '--execute')) {
    throw stageError('configuration', 'Usage: node scripts/ebay-setup-malta.js [--dry-run|--execute]', 400);
  }
  const intended = plan(env);
  if (!/^(?!\.{1,2}$)[\w.-]{1,50}$/.test(intended.merchantLocationKey)) throw stageError('validation', 'Invalid inventory location key', 400);
  if (!args.includes('--execute')) return { dryRun: true, ...intended };
  if (!intended.location.location.address.addressLine1 || !intended.location.phone) {
    throw stageError('configuration', 'Set EBAY_LOC_ADDRESS1 and EBAY_LOC_PHONE before executing', 400);
  }
  client ||= createClient({ env });
  const { marketplace, merchantLocationKey } = intended;
  const path = '/sell/inventory/v1/location/' + encodeURIComponent(merchantLocationKey);
  const found = await client.request('location', 'GET', path, { marketplace }).catch((error) => {
    if (error.ebayStatus === 404) return null;
    throw error;
  });
  if (!found) await client.request('location', 'POST', path, { body: intended.location, marketplace });

  const policies = {};
  for (const kind of ['fulfillment', 'payment', 'return']) {
    const data = await client.request('policy', 'GET', '/sell/account/v1/' + kind + '_policy', {
      marketplace, query: { marketplace_id: marketplace }
    });
    policies[kind] = (data[kind + 'Policies'] || []).map((policy) => ({ id: policy[kind + 'PolicyId'], name: policy.name }));
  }
  return { dryRun: false, marketplace, merchantLocationKey, existing: Boolean(found), policies };
}

if (require.main === module) {
  run().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(error.stage ? error.message : 'eBay setup failed');
    process.exitCode = 1;
  });
}
module.exports = { plan, run };
