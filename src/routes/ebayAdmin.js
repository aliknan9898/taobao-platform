'use strict';

const sync = require('../services/ebaySyncBatch');

function register(route, roles, { readJson, send }) {
  const base = '/api/admin/ebay';
  const action = (method) => async ({ req, res, params }) => {
    try {
      const body = req.method === 'POST' ? await readJson(req) : {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'Expected a JSON object' });
      return send(res, 200, await method({ body, params }));
    } catch (error) {
      if (!error.stage) throw error;
      return send(res, error.status, { error: error.message, stage: error.stage, details: error.details });
    }
  };
  route('GET', base + '/validate/:listingId', roles, action(({ params }) => sync.validation(params.listingId)));
  route('POST', base + '/publish/:listingId', roles, action(({ params, body }) =>
    body.dryRun === true ? sync.validation(params.listingId) : sync.publishOne(params.listingId)));
  route('POST', base + '/sync-batch', roles, action(({ body }) => sync.syncBatch({ ...body, dryRun: body.dryRun !== false })));
}

module.exports = { register };
