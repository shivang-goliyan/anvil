// The repair bench: the real API, worker and repair loop against a local copy of the demo site, driven
// through a local Chrome instead of Anakin's browser. Free, and it measures instead of assuming.
//
//   npm run bench -- [cases] [--repeat N] [--json out.json]
//   cases: comma-separated change kinds (default: every scripted kind, a typed change and 3 surprises)
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
const cases = (args[0] ?? 'rename-field,add-step,reorder-steps,restyle-confirmation,custom,surprise,surprise,surprise').split(',').flatMap((k) => Array(repeat).fill(k));

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
  { name: 'Priya Raman', email: 'priya.raman@example.com', seats: 3 },
  { name: 'Tomas Ortega', email: 'tomas.ortega@example.com', seats: 5 },
];
let turn = 0;
async function book() {
  const q = await call('POST', '/api/runs', { capabilityId: 'reserve-room', inputs: people[turn++ % 2] });
  if (q.status !== 202) return { status: `refused ${q.status}`, why: q.json.error };
  for (;;) {
    const { json } = await call('GET', `/api/runs/${q.json.id}`);
    if (!['queued', 'running'].includes(json.run.status)) return { ...json.run, repairId: json.run.result?.repairId };
    await sleep(700);
  }
}
async function waitRepair(id) {
  const t = Date.now();
  for (;;) {
    const { json } = await call('GET', `/api/repairs/${id}`);
    if (!['queued', 'running'].includes(json.repair.outcome)) {
      const tries = json.trace.filter((e) => e.kind === 'attempt').length;
      const models = json.trace.filter((e) => e.kind === 'derive' && e.detail?.model).map((e) => e.detail.model);
      return { outcome: json.repair.outcome, tries, seconds: Math.round((Date.now() - t) / 1000), models, diagnosis: json.repair.diagnosis };
    }
    await sleep(1000);
  }
}

const results = [];
const t0 = Date.now();
for (const kind of cases) {
  const row = { kind, first: '-', broken: '-', repair: '-', tries: 0, seconds: 0, after: '-', note: '' };
  results.push(row);
  await call('POST', '/api/target/reset', {});
  row.first = (await book()).status;
  const b = await call('POST', '/api/target/break', kind === 'custom' ? CUSTOM : { kind });
  row.note = String(b.json.detail ?? b.json.error ?? '').slice(0, 90);
  const broken = await book();
  row.broken = broken.failureKind ? `${broken.status}/${broken.failureKind}` : broken.status;
  if (broken.repairId) {
    const r = await waitRepair(broken.repairId);
    Object.assign(row, { repair: r.outcome, tries: r.tries, seconds: r.seconds, models: r.models });
    if (r.outcome === 'repaired') row.after = (await book()).status;
    else row.note = String(r.diagnosis ?? '').slice(0, 120);
  }
  const ok = row.first === 'succeeded' && (row.after === 'succeeded' || row.broken === 'succeeded');
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${kind.padEnd(21)} first ${row.first.padEnd(9)} changed ${String(row.broken).padEnd(17)} repair ${String(row.repair).padEnd(9)} tries ${row.tries} ${String(row.seconds).padStart(3)}s  after ${row.after}  ${row.note}`);
  row.pass = ok;
}

const passed = results.filter((r) => r.pass).length;
const repairs = results.filter((r) => r.repair !== '-');
const secs = repairs.map((r) => r.seconds).sort((a, b) => a - b);
console.log(`\n${passed}/${results.length} passed · ${repairs.filter((r) => r.repair === 'repaired').length}/${repairs.length} repairs promoted · median repair ${secs[Math.floor(secs.length / 2)] ?? '-'}s · ${Math.round((Date.now() - t0) / 1000)}s total`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ at: new Date().toISOString(), model: process.env.LLM_MODEL ?? null, results }, null, 1));
stopAll();
process.exit(passed === results.length ? 0 : 1);
