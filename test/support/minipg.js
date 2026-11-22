'use strict';
/* Test-only PostgreSQL client (wire protocol v3, extended query, trust auth) with the small part of the `pg` API the
   partner order code uses: pool.connect() → client.query(text, params) → { rows, rowCount }, client.release(), pool.query().
   Production uses the real `pg` package; this exists because test machines may not have node_modules.
   Types are parsed like `pg`: int2/int4 → number, int8/numeric → string, bool, json/jsonb → object, timestamp → Date. */
const net = require('net');

function connectRaw({ host = '127.0.0.1', port = 5432, user, database }) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let buf = Buffer.alloc(0); const waiters = []; const queue = [];
    const msgs = () => { while (buf.length >= 5) { const len = buf.readInt32BE(1); if (buf.length < len + 1) break; queue.push({ type: String.fromCharCode(buf[0]), body: buf.subarray(5, len + 1) }); buf = buf.subarray(len + 1); } while (queue.length && waiters.length) waiters.shift()(queue.shift()); };
    sock.on('data', (d) => { buf = Buffer.concat([buf, d]); msgs(); });
    sock.on('error', (e) => { while (waiters.length) waiters.shift()({ type: 'X', err: e }); reject(e); });
    const next = () => new Promise((r) => { if (queue.length) r(queue.shift()); else waiters.push(r); });
    const params = Buffer.from(`user\0${user}\0database\0${database}\0\0`);
    const start = Buffer.alloc(8); start.writeInt32BE(8 + params.length, 0); start.writeInt32BE(196608, 4);
    sock.on('connect', async () => {
      sock.write(Buffer.concat([start, params]));
      for (;;) {
        const m = await next();
        if (m.type === 'R' && m.body.readInt32BE(0) !== 0) return reject(new Error('minipg: only trust authentication is supported'));
        if (m.type === 'E') return reject(pgError(m.body));
        if (m.type === 'Z') return resolve({ sock, next });
      }
    });
  });
}

function pgError(body) {
  const f = {}; let i = 0;
  while (i < body.length && body[i] !== 0) { const code = String.fromCharCode(body[i]); const end = body.indexOf(0, i + 1); f[code] = body.toString('utf8', i + 1, end); i = end + 1; }
  const e = new Error(f.M || 'PostgreSQL error'); e.code = f.C; e.detail = f.D; e.constraint = f.n; return e;
}
const cstr = (s) => Buffer.from(`${s}\0`);
function msg(type, ...parts) { const body = Buffer.concat(parts); const h = Buffer.alloc(5); h.write(type, 0); h.writeInt32BE(body.length + 4, 1); return Buffer.concat([h, body]); }
const i16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
function toText(v) { if (v === null || v === undefined) return null; if (v instanceof Date) return v.toISOString(); if (typeof v === 'object') return JSON.stringify(v); if (typeof v === 'boolean') return v ? 'true' : 'false'; return String(v); }
function parse(oid, s) {
  if (s === null) return null;
  switch (oid) { case 16: return s === 't'; case 21: case 23: case 26: return Number(s); case 114: case 3802: return JSON.parse(s); case 1114: case 1184: return new Date(s.replace(' ', 'T').replace(/\+(\d\d)$/, '+$1:00')); default: return s; }
}

class Client {
  constructor(raw) { this.raw = raw; this.busy = Promise.resolve(); }
  query(text, values = []) {
    const run = async () => {
      const { sock, next } = this.raw;
      const binds = values.map(toText);
      sock.write(Buffer.concat([
        msg('P', cstr(''), cstr(text), i16(0)),
        msg('B', cstr(''), cstr(''), i16(0), i16(binds.length), ...binds.map((v) => (v === null ? i32(-1) : Buffer.concat([i32(Buffer.byteLength(v)), Buffer.from(v)]))), i16(0)),
        msg('D', Buffer.from('P'), cstr('')), msg('E', cstr(''), i32(0)), msg('S')
      ]));
      let fields = []; const rows = []; let rowCount = 0; let err = null;
      for (;;) {
        const m = await next();
        if (m.err) throw m.err;
        if (m.type === 'T') {
          const n = m.body.readInt16BE(0); let o = 2; fields = [];
          for (let k = 0; k < n; k++) { const end = m.body.indexOf(0, o); const name = m.body.toString('utf8', o, end); o = end + 1; const oid = m.body.readInt32BE(o + 6); o += 18; fields.push({ name, oid }); }
        } else if (m.type === 'D') {
          const n = m.body.readInt16BE(0); let o = 2; const row = {};
          for (let k = 0; k < n; k++) { const len = m.body.readInt32BE(o); o += 4; const s = len < 0 ? null : m.body.toString('utf8', o, o + len); if (len > 0) o += len; row[fields[k].name] = parse(fields[k].oid, s); }
          rows.push(row);
        } else if (m.type === 'C') { const tag = m.body.toString('utf8', 0, m.body.length - 1); const num = tag.match(/(\d+)$/); rowCount = num ? Number(num[1]) : 0;
        } else if (m.type === 'E') { err = pgError(m.body);
        } else if (m.type === 'Z') { if (err) throw err; return { rows, rowCount }; }
      }
    };
    const p = this.busy.then(run, run); this.busy = p.catch(() => {}); return p;
  }
  release() { try { this.raw.sock.end(msg('X')); } catch { /* closed */ } }
}

function Pool(cfg) {
  return {
    async connect() { return new Client(await connectRaw(cfg)); },
    async query(text, values) { const c = await this.connect(); try { return await c.query(text, values); } finally { c.release(); } },
    end() {}
  };
}

module.exports = { Pool };
