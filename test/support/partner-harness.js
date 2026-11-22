'use strict';
/* Shared helpers for the PostgreSQL partner tests: drop the partner tables (newest migration first) and call the
   HTTP API while checking every answer against docs/partner-api/openapi.json. */
const fs = require('fs');
const path = require('path');
const assert = require('node:assert');

const MIG = path.join(__dirname, '..', '..', 'src', 'partner', 'migrations');
/** Drop every partner table in the dedicated test database (runs the .down.sql files, newest first). */
async function resetPartnerSchema(pool) {
  const downs = fs.readdirSync(MIG).filter((f) => f.endsWith('.down.sql')).sort().reverse();
  for (const f of downs) for (const stmt of fs.readFileSync(path.join(MIG, f), 'utf8').replace(/--.*$/gm, '').split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await pool.query(stmt);
}

const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'partner-api', 'openapi.json'), 'utf8'));
const resolveRef = (r) => r.replace(/^#\//, '').split('/').reduce((o, k) => o[k], SPEC);
function validate(schema, v, at = '$') {
  if (schema.$ref) return validate(resolveRef(schema.$ref), v, at);
  const types = schema.type ? [].concat(schema.type) : null;
  const typeOf = (x) => (x === null ? 'null' : Array.isArray(x) ? 'array' : Number.isInteger(x) ? 'integer' : typeof x);
  if (types && !types.some((ty) => ty === typeOf(v) || (ty === 'number' && typeOf(v) === 'integer'))) throw new Error(`${at}: expected ${types} got ${typeOf(v)}`);
  if (schema.const !== undefined && v !== schema.const) throw new Error(`${at}: const`);
  if (schema.enum && !schema.enum.includes(v)) throw new Error(`${at}: ${v} not in enum`);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of schema.required || []) if (!(k in v)) throw new Error(`${at}: missing ${k}`);
    for (const [k, val] of Object.entries(v)) { if (schema.properties?.[k]) validate(schema.properties[k], val, `${at}.${k}`); else if (schema.additionalProperties === false) throw new Error(`${at}: unexpected ${k}`); }
  }
  if (Array.isArray(v) && schema.items) v.forEach((x, i) => validate(schema.items, x, `${at}[${i}]`));
}

/** Returns call(key, method, path, body?, headers?) → { status, body, headers, raw? } with contract checks. */
function client(base) {
  return async function call(key, method, p, body, headers = {}) {
    const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const rel = p.replace('/api/partner/v1', '').split('?')[0];
    const tpl = Object.keys(SPEC.paths).find((x) => new RegExp(`^${x.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(rel));
    assert.ok(tpl, `${rel} documented`);
    const op = SPEC.paths[tpl][method.toLowerCase()]; assert.ok(op, `${method} ${tpl} documented`);
    const resp = op.responses[String(r.status)];
    assert.ok(resp, `${method} ${rel} ${r.status} documented`);
    const def = resp.$ref ? resolveRef(resp.$ref) : resp; const ct = Object.keys(def.content)[0];
    assert.ok(String(r.headers.get('content-type')).startsWith(ct.replace('+json', '')) || String(r.headers.get('content-type')).startsWith(ct), `${method} ${rel}: content type ${r.headers.get('content-type')} vs ${ct}`);
    assert.ok(r.headers.get('x-request-id'), 'X-Request-Id');
    if (ct === 'application/pdf') return { status: r.status, raw: Buffer.from(await r.arrayBuffer()), headers: r.headers };
    const json = await r.json();
    validate(def.content[ct].schema, json, `${method} ${rel}`);
    return { status: r.status, body: json, headers: r.headers };
  };
}

module.exports = { resetPartnerSchema, validate, client, SPEC };
