// The repair bench: the real API, worker and repair loop against a local copy of the demo site, driven
// through a local Chrome instead of Anakin's browser. Free, and it measures instead of assuming.
//
//   npm run bench -- [cases] [--repeat N] [--json out.json]
//   cases: comma-separated change kinds (default: every scripted kind, a typed change and 3 surprises).
//   "check:<kind>" makes the change and then asks Anvil to check the website, instead of booking into it.
//   "cosmetic" always goes through the check, and has to end with nothing to fix and no model asked.
//   "needs-person:check" and "needs-person:booking" start from a capability marked as needing a person:
//   a check that finds the steps still fit clears that, and a failed booking after the cooldown repairs once.
//
// Needs a model key in .env (it uses the same LLM_MODEL chain as production).

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const repeat = Number(flag('--repeat', 1));
const jsonOut = flag('--json', null);
const CUSTOM = { kind: 'custom', field: 'email', label: 'Where should we write?', button: 'Grab my room' };
const cases = (args[0] ?? 'rename-field,add-step,reorder-steps,restyle-confirmation,custom,wrong-room,new-reference-format,cosmetic,check:rename-field,check:restyle-confirmation,needs-person:check,needs-person:booking,surprise,surprise,surprise').split(',').flatMap((k) => Array(repeat).fill(k));

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(`${tmpdir()}/anvil-bench-`);
const ports = { target: 4420, api: 3420 };
const env = {
  ...process.env,
  DATABASE_URL: `file:${dir}/bench.db`,
  TARGET_PORT: String(ports.target),
  PORT: String(ports.api),
  TARGET_FORWARD: `http://localhost:${ports.target}`,
  TARGET_ADMIN_URL: `http://localhost:${ports.target}`,
  TARGET_ADMIN_TOKEN: 'bench-token',
  ANVIL_BENCH: '1',
  ANVIL_BROWSER: 'local',
  ANAKIN_HOURLY_CREDITS: '1000',
  TRUST_PROXY: '',
  ANAKIN_MONITOR_ID: '',
};
const children = [];
const start = (file) => {
  const child = spawn(process.execPath, ['--env-file=.env', file], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (d) => process.env.BENCH_VERBOSE && process.stderr.write(`[${file}] ${d}`));
  children.push(child);
};
const stopAll = () => children.forEach((c) => c.kill());
process.on('exit', stopAll);
process.on('SIGINT', () => process.exit(130));

execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] });
execFileSync(process.execPath, ['--env-file=.env', 'scripts/seed.mjs'], { cwd: ROOT, env, stdio: 'ignore' });
start('target/server.mjs');
start('src/api.mjs');
start('src/worker.mjs');

const api = `http://127.0.0.1:${ports.api}`;
// the bench reads and marks the capability's status directly, to start a case from "needs a person"
process.env.DATABASE_URL = env.DATABASE_URL;
const { db } = await import('../src/db.mjs');
const status = async () => (await db.capability.findUnique({ where: { id: 'reserve-room' }, select: { status: true } })).status;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, body) {
  const res = await fetch(api + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
for (let i = 0; ; i++) {
  if ((await call('GET', '/api/budget').catch(() => ({ status: 0 }))).status === 200) break;
  if (i > 60) throw new Error('the bench API never came up');
  await sleep(500);
}

const people = [
  { name: 'Priya Raman', email: 'priya.raman@example.com', seats: 3, room: 'Quiet room', date: '2026-09-21', time: '11:00' },
  { name: 'Tomas Ortega', email: 'tomas.ortega@example.com', seats: 5, room: 'Group room', date: '2026-09-22', time: '14:00' },
];
let turn = 0;
async function waitRun(id) {
  for (;;) {
    const { json } = await call('GET', `/api/runs/${id}`);
    if (!['queued', 'running'].includes(json.run.status))
      return { ...json.run, repairId: json.run.result?.repairId, amended: json.trace.some((e) => e.label.startsWith('check updated')) };
    await sleep(700);
  }
}
async function book() {
  const q = await call('POST', '/api/runs', { capabilityId: 'reserve-room', inputs: people[turn++ % 2] });
  if (q.status !== 202) return { status: `refused ${q.status}`, why: q.json.error };
  return waitRun(q.json.id);
}
const bookings = async () => (await (await fetch(`http://127.0.0.1:${ports.target}/_admin/stats`, { headers: { 'x-admin-token': 'bench-token' } })).json()).bookings;
async function waitRepair(id) {
  const t = Date.now();
  for (;;) {
    const { json } = await call('GET', `/api/repairs/${id}`);
    if (!['queued', 'running'].includes(json.repair.outcome)) {
      const tries = json.trace.filter((e) => e.kind === 'attempt').length;
      const models = json.trace.filter((e) => e.kind === 'derive' && e.detail?.model).map((e) => e.detail.model);
      const retryRun = json.trace.find((e) => e.kind === 'retry' && e.detail?.runId && e.label.startsWith('now making'))?.detail.runId;
      const during = json.trace.find((e) => e.kind === 'ledger')?.detail.during ?? null;
      const why = json.trace.filter((e) => ['reject', 'execute', 'rehearse', 'validate', 'error', 'fit'].includes(e.kind)).map((e) => `    ${e.kind}: ${e.label.slice(0, 400)}`);
      const fit = json.trace.find((e) => e.kind === 'fit' && e.detail?.verdict)?.detail.verdict ?? null;
      return { why, outcome: json.repair.outcome, tries, seconds: Math.round((Date.now() - t) / 1000), models, diagnosis: json.repair.diagnosis, retryRun, during, fit };
    }
    await sleep(1000);
  }
}

const results = [];
const t0 = Date.now();
for (const kind of cases) {
  const row = { kind, first: '-', broken: '-', repair: '-', tries: 0, seconds: 0, retry: '-', during: '-', after: '-', note: '' };
  results.push(row);
  await call('POST', '/api/target/reset', {});
  row.first = (await book()).status;
  if (kind.startsWith('needs-person:')) {
    // as if its last repair had given up: the cooldown is measured from the last repair, and here there is none
    await db.capability.update({ where: { id: 'reserve-room' }, data: { status: 'degraded' } });
    const how = kind.split(':')[1];
    const b = await call('POST', '/api/target/break', { kind: how === 'check' ? 'cosmetic' : 'rename-field' });
    row.note = String(b.json.detail ?? b.json.error ?? '').slice(0, 60);
    const before = await bookings();
    let r = null;
    if (how === 'check') {
      const c = await call('POST', '/api/check', {});
      row.broken = c.status === 202 ? 'checked' : `refused ${c.status}`;
      if (c.json.repairId) r = await waitRepair(c.json.repairId);
    } else {
      const broken = await book();
      row.broken = broken.failureKind ? `${broken.status}/${broken.failureKind}` : broken.status;
      if (broken.repairId) {
        r = await waitRepair(broken.repairId);
        row.trigger = (await call('GET', `/api/repairs/${broken.repairId}`)).json.repair.trigger;
        if (r.retryRun) row.retry = (await waitRun(r.retryRun)).status;
      }
    }
    if (r) Object.assign(row, { why: r.why, repair: r.outcome, tries: r.tries, seconds: r.seconds, models: r.models, fit: r.fit });
    row.during = (await bookings()) - before - (row.retry === 'succeeded' ? 1 : 0);
    row.status = await status();
    row.after = (await book()).status;
    let ok = row.first === 'succeeded' && row.status === 'healthy' && row.during === 0 && row.after === 'succeeded';
    if (how === 'check') ok &&= row.repair === 'not-needed' && row.models?.length === 0;
    else ok &&= row.trigger === 'cooldown' && row.repair === 'repaired' && row.retry === 'succeeded';
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${kind.padEnd(26)} first ${row.first.padEnd(9)} ${String(row.broken).padEnd(17)} ${row.trigger ? `trigger ${row.trigger} ` : ''}repair ${String(row.repair).padEnd(10)} models asked ${row.models?.length ?? '-'} ${String(row.seconds).padStart(3)}s  status now ${row.status}  booked-while-repairing ${row.during}  retry ${row.retry}  after ${row.after}  ${row.note}`);
    row.pass = ok;
    if (!ok && row.why?.length) console.log(row.why.join('\n'));
    continue;
  }
  const change = kind.replace(/^check:/, '');
  const b = await call('POST', '/api/target/break', change === 'custom' ? CUSTOM : { kind: change });
  row.note = String(b.json.detail ?? b.json.error ?? '').slice(0, 90);
  if (kind === 'cosmetic' || kind.startsWith('check:')) {
    // nothing has failed: somebody asks Anvil to check the website, and only a real change may cost a model call
    const before = await bookings();
    const c = await call('POST', '/api/check', {});
    row.broken = c.status === 202 ? 'checked' : `refused ${c.status}`;
    if (c.json.repairId) {
      const r = await waitRepair(c.json.repairId);
      Object.assign(row, { why: r.why, repair: r.outcome, tries: r.tries, seconds: r.seconds, models: r.models, fit: r.fit, retry: r.retryRun ? 'queued' : '-' });
      row.during = (await bookings()) - before;
      if (r.outcome !== 'repaired' && r.outcome !== 'not-needed') row.note = String(r.diagnosis ?? '').slice(0, 120);
    }
    row.after = (await book()).status;
    row.bookings = await bookings();
    let ok = row.first === 'succeeded' && row.during === 0 && row.retry === '-' && row.after === 'succeeded';
    if (kind === 'cosmetic') ok &&= row.repair === 'not-needed' && row.fit === 'fits' && row.models.length === 0 && row.tries === 0;
    else ok &&= row.repair === 'repaired' && row.fit === 'stale';
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${kind.padEnd(26)} first ${row.first.padEnd(9)} ${String(row.broken).padEnd(8)} fit ${String(row.fit).padEnd(6)} repair ${String(row.repair).padEnd(10)} models asked ${row.models?.length ?? '-'} tries ${row.tries} ${String(row.seconds).padStart(3)}s  booked-while-checking ${row.during}  after ${row.after}  ${row.note}`);
    row.pass = ok;
    if (!ok && row.why?.length) console.log(row.why.join('\n'));
    continue;
  }
  const broken = await book();
  row.broken = broken.failureKind ? `${broken.status}/${broken.failureKind}` : broken.status;
  if (broken.repairId) {
    const r = await waitRepair(broken.repairId);
    Object.assign(row, { why: r.why, repair: r.outcome, tries: r.tries, seconds: r.seconds, models: r.models, during: r.during ?? '?' });
    if (r.outcome === 'repaired') {
      if (r.retryRun) row.retry = (await waitRun(r.retryRun)).status;
      row.after = (await book()).status;
    } else row.note = String(r.diagnosis ?? '').slice(0, 120);
  } else if (broken.status === 'succeeded') {
    row.amended = broken.amended;
    row.after = (await book()).status;
  }
  row.bookings = await bookings();
  let ok = row.first === 'succeeded';
  // the site booked the wrong room: caught, and not "repaired" into looking fine
  if (kind === 'wrong-room') ok &&= row.broken === 'failed/mismatch' && row.repair === '-';
  else if (kind === 'new-reference-format') ok &&= row.broken === 'succeeded' && row.amended && row.after === 'succeeded';
  // a repair may not book anything itself, and the one retry booking has to go through
  else ok &&= row.repair === 'repaired' && row.during === 0 && ['succeeded', '-'].includes(row.retry) && row.after === 'succeeded';
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${kind.padEnd(21)} first ${row.first.padEnd(9)} changed ${String(row.broken).padEnd(17)} repair ${String(row.repair).padEnd(9)} tries ${row.tries} ${String(row.seconds).padStart(3)}s  booked-while-repairing ${row.during}  retry ${row.retry}  after ${row.after}${row.amended ? '  (check updated)' : ''}  ${row.note}`,
  );
  row.pass = ok;
  if (!ok && row.why?.length) console.log(row.why.join('\n'));
}

const passed = results.filter((r) => r.pass).length;
const repairs = results.filter((r) => !['-', 'not-needed'].includes(r.repair));
const fine = results.filter((r) => r.repair === 'not-needed').length;
const secs = repairs.map((r) => r.seconds).sort((a, b) => a - b);
console.log(`\n${passed}/${results.length} passed · ${repairs.filter((r) => r.repair === 'repaired').length}/${repairs.length} repairs promoted · median repair ${secs[Math.floor(secs.length / 2)] ?? '-'}s · ${fine} checks found nothing to fix · ${Math.round((Date.now() - t0) / 1000)}s total`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ at: new Date().toISOString(), model: process.env.LLM_MODEL ?? null, results }, null, 1));
stopAll();
await db.$disconnect();
process.exit(passed === results.length ? 0 : 1);
