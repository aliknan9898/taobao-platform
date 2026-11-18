'use strict';
// Low-impact, read-only performance probe. Run: node scripts/measure-response.js https://kinan.shop
// Only public GET endpoints; no authentication, mutations, or high concurrency.
const { performance } = require('node:perf_hooks');
const origin = process.argv[2];
if (!origin || !/^https?:\/\//.test(origin)) {
  console.error('Usage: node scripts/measure-response.js https://kinan.shop');
  process.exitCode = 2;
} else {
  const paths = ['/', '/api/categories', '/api/catalog?limit=20', '/api/catalog?limit=20&offset=20'];
  (async () => {
    for (const path of paths) {
      const samples = [];
      for (let n = 0; n < 3; n++) {
        const start = performance.now();
        try {
          const response = await fetch(new URL(path, origin), { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(12000), headers: { 'Cache-Control': 'no-cache' } });
          await response.arrayBuffer();
          samples.push({ ms: Math.round(performance.now() - start), status: response.status, cache: response.headers.get('cf-cache-status') || 'n/a' });
        } catch (e) { samples.push({ error: e.name || 'request failed' }); }
      }
      const values = samples.filter(x => x.ms !== undefined).map(x => x.ms).sort((a,b) => a-b);
      console.log(JSON.stringify({ path, median_ms: values.length ? values[Math.floor(values.length/2)] : null, samples }));
    }
  })().catch(e => { console.error(e.message); process.exitCode = 1; });
}
