// Phase 3 checkpoint: read capabilities for sites the system has never seen, through the API only.
// Needs  npm run api  and  npm run worker.  Sites must be on ALLOWED_SITES.
//
//   npm run phase3                                  (the default sites below)
//   npm run phase3 -- "https://example.org/|the goal in words"  ...

import { db } from '../src/db.mjs';

const api = process.env.ANVIL_API ?? `http://127.0.0.1:${process.env.PORT ?? 3310}`;
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const banner = (s) => console.log(`\n${'-'.repeat(8)} ${s} ${'-'.repeat(Math.max(0, 70 - s.length))}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_SITES = [
  ['https://www.python.org/', 'upcoming Python community events, with the event name, date and location'],
  ['https://www.x-rates.com/', 'current exchange rates of the US dollar against other currencies, with the currency name and the rate'],
  ['https://www.scrapethissite.com/pages/', 'every country listed with its name, capital, population and area'],
];
const sites = process.argv.slice(2).length ? process.argv.slice(2).map((a) => a.split('|')) : DEFAULT_SITES;

async function call(method, path, body) {
  const res = await fetch(new URL(path, api), { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() };
}

async function watch(path, done) {
  let after = 0;
  for (;;) {
    const { status, json } = await call('GET', `${path}?after=${after}`);
    if (status !== 200) throw new Error(`${path} said ${status}: ${json.error}`);
    for (const e of json.trace) console.log(`${stamp()}  #${String(e.seq).padStart(2)} ${e.kind.padEnd(9)} ${e.label}`);
    if (json.trace.length) after = json.trace.at(-1).seq;
    if (done(json)) return json;
    await sleep(1000);
  }
}

const results = [];
for (const [url, goal] of sites) {
  banner(new URL(url).hostname);
  const row = { site: new URL(url).hostname, derived: '-', via: '-', run: '-', records: 0 };
  results.push(row);
  const created = await call('POST', '/api/capabilities', { url, goal });
  console.log(`${stamp()}  POST /api/capabilities -> ${created.status} ${JSON.stringify(created.json)}`);
  if (created.status !== 202) {
    row.derived = `refused (${created.status})`;
    continue;
  }
  const d = await watch(`/api/derivations/${created.json.derivationId}`, (j) => !['queued', 'running'].includes(j.derivation.outcome));
  row.derived = d.derivation.outcome;
  row.via = d.derivation.via ?? '-';
  if (d.derivation.outcome !== 'derived') {
    console.log(`${stamp()}  derivation ${d.derivation.outcome}: ${d.derivation.diagnosis}`);
    continue;
  }
  const cap = (await call('GET', `/api/capabilities/${created.json.capabilityId}`)).json;
  console.log(`${stamp()}  capability ${cap.id}: engine ${cap.engine}, page ${cap.targetUrl}, plan v${cap.plan.version} (${cap.plan.origin})`);
  console.log(`${stamp()}  contract: required ${cap.contract.requiredFields.join(', ')}; types ${JSON.stringify(cap.contract.fieldTypes)}; at least ${cap.contract.minRecords} records`);

  // a second, ordinary run on the cached plan is what proves the capability works
  const run = await call('POST', '/api/runs', { capabilityId: cap.id, inputs: {} });
  console.log(`${stamp()}  POST /api/runs -> ${run.status} ${JSON.stringify(run.json)}`);
  if (run.status !== 202) continue;
  const r = await watch(`/api/runs/${run.json.id}`, (j) => !['queued', 'running'].includes(j.run.status));
  row.run = r.run.status + (r.run.failureKind ? ` (${r.run.failureKind})` : '');
  row.records = r.run.result?.records?.length ?? 0;
  console.log(`${stamp()}  run ${row.run}, ${row.records} records. first three:`);
  for (const rec of (r.run.result?.records ?? []).slice(0, 3)) console.log(`           ${JSON.stringify(rec)}`);
}

banner('summary');
for (const r of results) console.log(`  ${r.site.padEnd(26)} derivation ${String(r.derived).padEnd(14)} via ${r.via.padEnd(8)} run ${String(r.run).padEnd(22)} ${r.records} records`);
const spent = await db.creditSpend.aggregate({ where: { createdAt: { gte: new Date(t0) } }, _sum: { credits: true }, _count: true });
console.log(`  anakin: ${spent._count} metered calls, ${spent._sum.credits ?? 0} credits by published price, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
await db.$disconnect();
process.exit(results.filter((r) => r.derived === 'derived' && r.run === 'succeeded').length >= 3 ? 0 : 1);
