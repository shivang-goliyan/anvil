// Stacks every break kind on the demo site, one at a time, through the public API:
// run -> break -> run fails -> repair -> run works, then the next break on top of that.
// Needs  npm run target,  npm run api,  npm run worker.

const api = process.env.ANVIL_API ?? `http://127.0.0.1:${process.env.PORT ?? 3310}`;
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const banner = (s) => console.log(`\n${'-'.repeat(8)} ${s} ${'-'.repeat(Math.max(0, 66 - s.length))}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = new Set(['queued', 'step', 'browser']);

async function call(method, path, body) {
  const res = await fetch(new URL(path, api), { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() };
}

async function watch(path, done) {
  let after = 0;
  for (;;) {
    const { json } = await call('GET', `${path}?after=${after}`);
    for (const e of json.trace) if (!quiet.has(e.kind)) console.log(`${stamp()}  ${e.kind.padEnd(9)} ${e.label.slice(0, 220)}`);
    if (json.trace.length) after = json.trace.at(-1).seq;
    if (done(json)) return json;
    await sleep(1000);
  }
}

const people = [
  { name: 'Priya Raman', email: 'priya.raman@example.com', seats: 3 },
  { name: 'Tomas Ortega', email: 'tomas.ortega@example.com', seats: 5 },
];
let turn = 0;

async function run(label) {
  const inputs = people[turn++ % 2];
  const q = await call('POST', '/api/runs', { capabilityId: 'reserve-room', inputs });
  if (q.status !== 202) throw new Error(`${label}: POST /api/runs said ${q.status} ${JSON.stringify(q.json)}`);
  const r = await watch(`/api/runs/${q.json.id}`, (j) => !['queued', 'running'].includes(j.run.status));
  console.log(`${stamp()}  => ${label}: ${r.run.status}${r.run.failureKind ? ` (${r.run.failureKind})` : ''} on plan v${r.capability.plan.version}`);
  return r;
}

const results = [];
banner('reset');
const reset = await call('POST', '/api/target/reset', {});
console.log(`${stamp()}  ${reset.status} ${reset.json.detail ?? reset.json.error}`);
await run('learn the contract');

for (const kind of (process.argv[2] ?? 'add-step,reorder-steps,restyle-confirmation,rename-field').split(',')) {
  banner(kind);
  const b = await call('POST', '/api/target/break', { kind });
  console.log(`${stamp()}  break ${b.status}: ${b.json.detail ?? b.json.error}`);
  for (const p of b.json.pages ?? []) console.log(`           ${p}`);
  const failed = await run('run against the changed site');
  const row = { kind, failed: failed.run.failureKind ?? failed.run.status, repair: '-', after: '-' };
  results.push(row);
  const repairId = failed.run.result?.repairId;
  if (!repairId) continue;
  const rep = await watch(`/api/repairs/${repairId}`, (j) => !['queued', 'running'].includes(j.repair.outcome));
  row.repair = `${rep.repair.outcome} -> v${rep.capability.plan.version}`;
  console.log(`${stamp()}  => repair ${rep.repair.outcome}, capability ${rep.capability.status} on plan v${rep.capability.plan.version}`);
  if (rep.repair.outcome !== 'repaired') break;
  const again = await run('same run after repair');
  row.after = again.run.status;
  if (again.run.status !== 'succeeded') break;
}

banner('summary');
for (const r of results) console.log(`  ${r.kind.padEnd(22)} run after break: ${String(r.failed).padEnd(11)} repair: ${r.repair.padEnd(16)} run after repair: ${r.after}`);
console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exit(results.length && results.every((r) => r.after === 'succeeded') ? 0 : 1);
