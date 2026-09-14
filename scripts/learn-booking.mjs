// Learns Harbor Lane's booking from its one sentence, on a local copy of the demo site in a local Chrome
// (no Anakin credits), and saves what was learned to demo/learned-booking.json. Reset and seeding give the
// booking capability that plan. Needs a model key in .env.
//
//   node --env-file=.env scripts/learn-booking.mjs [--dry]     --dry learns but does not write the file

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const dry = process.argv.includes('--dry');
const port = Number(process.env.LEARN_TARGET_PORT ?? 4460);
const dir = mkdtempSync(`${tmpdir()}/anvil-learn-`);
Object.assign(process.env, {
  DATABASE_URL: `file:${dir}/learn.db`,
  ANVIL_BROWSER: 'local',
  TARGET_PORT: String(port),
  TARGET_FORWARD: `http://localhost:${port}`,
  TARGET_ADMIN_URL: `http://localhost:${port}`,
  TARGET_ADMIN_TOKEN: 'learn-token',
  ANAKIN_HOURLY_CREDITS: '1000',
  TARGET_URL: '',
});
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { cwd: ROOT, env: process.env, stdio: 'ignore' });
const site = spawn(process.execPath, ['target/server.mjs'], { cwd: ROOT, env: process.env, stdio: ['ignore', 'ignore', 'inherit'] });
process.on('exit', () => site.kill());
await new Promise((r) => setTimeout(r, 800));

const { db } = await import('../src/db.mjs');
const { tracer } = await import('../src/trace.mjs');
const { queueLearn } = await import('../src/capabilities.mjs');
const { executeLearn } = await import('../src/learn.mjs');
const { reserveRoom } = await import('../capabilities/reserve-room.mjs');

const def = reserveRoom();
await db.capability.create({ data: { id: def.id, name: def.name, goal: def.goal, targetUrl: def.targetUrl, inputSchema: def.inputSchema, canary: def.canary, status: 'deriving' } });
const payload = def.learn();
const derivation = await queueLearn(def.id, payload);
const log = await tracer({ derivationId: derivation.id });
const out = await executeLearn(derivation.id, payload, log);
await log.flush();
const row = await db.derivation.findUnique({ where: { id: derivation.id } });
console.log(`\noutcome: ${row.outcome}${row.diagnosis ? ` (${row.diagnosis.slice(0, 400)})` : ''}`);
if (row.outcome === 'derived' && out?.steps) {
  const saved = { goal: def.goal, url: new URL(def.targetUrl).pathname, inputs: out.inputs, outputs: def.outputs, steps: out.steps, model: out.model, attempts: out.attempts, bookingsWhileLearning: out.during, records: out.records, learnedAt: new Date().toISOString() };
  if (!dry) writeFileSync(new URL('../demo/learned-booking.json', import.meta.url), `${JSON.stringify(saved, null, 1)}\n`);
  console.log(`${dry ? 'not saved (--dry)' : 'saved demo/learned-booking.json'}: ${out.steps.length} steps by ${out.model}, ${out.attempts} tries, ${out.during} booking(s) made while learning`);
}
await db.$disconnect();
process.exit(row.outcome === 'derived' ? 0 : 1);
