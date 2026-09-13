// Phase 2 checkpoint, through the HTTP API only: queue runs, poll them, watch the trace grow.
// Needs three things running:  npm run target,  npm run api,  npm run worker
// Then:  npm run seed -- --reset  &&  npm run phase2

import { db } from '../src/db.mjs';

const api = process.env.ANVIL_API ?? `http://127.0.0.1:${process.env.PORT ?? 3310}`;
const site = process.env.TARGET_URL || process.env.TARGET_FORWARD || 'http://localhost:4310';
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const banner = (s) => console.log(`\n${'-'.repeat(8)} ${s} ${'-'.repeat(Math.max(0, 60 - s.length))}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body) {
  const res = await fetch(new URL(path, api), {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function admin(path, body) {
  const res = await fetch(new URL(path, site), {
    method: 'POST',
    headers: { 'x-admin-token': process.env.TARGET_ADMIN_TOKEN ?? '', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`target admin ${path} said ${res.status}: ${json.error}`);
  return json;
}

// Polls once a second, printing only events it has not seen. Returns the final row.
async function watch(kind, id) {
  let after = 0;
  let polls = 0;
  for (;;) {
    polls++;
    const { status, json } = await call('GET', `/api/${kind}s/${id}?after=${after}`);
    if (status !== 200) throw new Error(`poll ${kind} ${id} said ${status}: ${json.error}`);
    for (const e of json.trace) console.log(`${stamp()}  #${String(e.seq).padStart(2)} ${e.kind.padEnd(9)} ${e.label}`);
    if (json.trace.length) {
      after = json.trace.at(-1).seq;
      console.log(`${stamp()}  (poll ${polls}: ${json.trace.length} new, ${after} trace events so far)`);
    }
    const row = json[kind];
    const done = kind === 'run' ? !['queued', 'running'].includes(row.status) : !['queued', 'running'].includes(row.outcome);
    if (done) return { row, capability: json.capability, events: after, polls };
    await sleep(1000);
  }
}

async function run(inputs) {
  const { status, json } = await call('POST', '/api/runs', { capabilityId: 'reserve-room', inputs });
  console.log(`${stamp()}  POST /api/runs -> ${status} ${JSON.stringify(json)}`);
  if (status !== 202) process.exit(1);
  const out = await watch('run', json.id);
  console.log(`${stamp()}  run ${out.row.status}${out.row.failureKind ? ` (${out.row.failureKind})` : ''}, ${out.events} events over ${out.polls} polls, capability ${out.capability.status} on plan v${out.capability.plan.version}`);
  return out;
}

const alice = { name: 'Priya Raman', email: 'priya.raman@example.com', seats: '3' };
const bob = { name: 'Tomas Ortega', email: 'tomas.ortega@example.com', seats: 5 };

banner('setup');
await admin('/_admin/reset');
const cap = await db.capability.findUnique({ where: { id: 'reserve-room' }, include: { plan: true } });
if (!cap || cap.contractId || cap.plan.version !== 1) {
  console.log('capability is not fresh. run  npm run seed -- --reset  first');
  process.exit(1);
}
console.log(`${stamp()}  target reset, capability fresh on hand-written plan v1`);

banner('bad requests are refused before anything is queued');
for (const [what, body] of [
  ['unknown capability', { capabilityId: 'nope', inputs: alice }],
  ['missing input', { capabilityId: 'reserve-room', inputs: { name: 'x', email: 'y' } }],
  ['seats not a number', { capabilityId: 'reserve-room', inputs: { ...alice, seats: 'three' } }],
]) {
  const { status, json } = await call('POST', '/api/runs', body);
  console.log(`${stamp()}  ${what.padEnd(20)} -> ${status} ${json.error}`);
}

banner('run 1: first success learns the contract');
const r1 = await run(alice);
if (r1.row.status !== 'succeeded') process.exit(1);

banner('run 2: cached plan');
const r2 = await run(bob);
if (r2.row.status !== 'succeeded') process.exit(1);

banner('break: rename the email field');
const broke = await admin('/_admin/break', { kind: 'rename-field', key: 'email' });
console.log(`${stamp()}  ${broke.detail} (site config v${broke.config.version})`);

banner('run 3: same plan against the changed site');
const r3 = await run(alice);
if (r3.row.status !== 'failed' || r3.row.failureKind !== 'structural' || !r3.row.result.repairId) {
  console.log('expected a structural failure that queued a repair');
  process.exit(2);
}

banner(`repair ${r3.row.result.repairId} (queued by the worker, not by this script)`);
const fix = await watch('repair', r3.row.result.repairId);
console.log(`${stamp()}  repair ${fix.row.outcome}, ${fix.events} events over ${fix.polls} polls, capability ${fix.capability.status} on plan v${fix.capability.plan.version}`);
if (fix.row.outcome !== 'repaired') process.exit(2);

banner('run 4: identical run after repair');
const r4 = await run(bob);

banner('what is in the database now');
const runs = await db.run.findMany({ where: { capabilityId: 'reserve-room' }, orderBy: { createdAt: 'asc' }, include: { _count: { select: { trace: true } }, plan: { select: { version: true } } } });
for (const r of runs) console.log(`  run    ${r.id}  ${r.status.padEnd(9)} ${String(r.failureKind ?? '').padEnd(10)} plan v${r.plan?.version}  ${r._count.trace} trace events`);
const repairs = await db.repairAttempt.findMany({ where: { capabilityId: 'reserve-room' }, include: { _count: { select: { trace: true } } } });
for (const r of repairs) console.log(`  repair ${r.id}  ${r.outcome.padEnd(9)} ${r.trigger.padEnd(10)} ${r._count.trace} trace events  diagnosis: ${r.diagnosis}`);
const plans = await db.plan.findMany({ where: { capabilityId: 'reserve-room' }, orderBy: { version: 'asc' } });
for (const p of plans) console.log(`  plan   v${p.version} ${p.active ? 'active  ' : 'inactive'} ${p.origin}  derivedFrom ${p.derivedFrom}`);
const jobs = await db.job.groupBy({ by: ['kind', 'status'], _count: true });
console.log(`  jobs   ${jobs.map((j) => `${j.kind}/${j.status}: ${j._count}`).join(', ')}`);
const spent = await db.creditSpend.aggregate({ where: { createdAt: { gte: new Date(t0) } }, _sum: { credits: true }, _count: true });
console.log(`  anakin ${spent._count} metered calls, ${spent._sum.credits ?? 0} credits by published price during this script`);

await db.$disconnect();
process.exit(r4.row.status === 'succeeded' ? 0 : 3);
