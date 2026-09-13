// Phase 1 checkpoint in a terminal: run -> break -> run (fails) -> repair -> run (works).
//
//   node --env-file=.env target/server.mjs      (in one terminal)
//   npm run phase1                              (in another)

import { reserveRoom } from '../capabilities/reserve-room.mjs';
import { loadCapability, saveCapability, forgetCapability } from '../src/store.mjs';
import { runCapability } from '../src/run.mjs';
import { repair } from '../src/repair.mjs';

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const log = (kind, label) => console.log(`${stamp()}  ${kind.padEnd(9)} ${label}`);
const banner = (s) => console.log(`\n${'-'.repeat(8)} ${s} ${'-'.repeat(Math.max(0, 60 - s.length))}`);

const siteBase = process.env.TARGET_URL || process.env.TARGET_FORWARD || 'http://localhost:4310';

async function admin(path, body) {
  const res = await fetch(new URL(path, siteBase), {
    method: 'POST',
    headers: { 'x-admin-token': process.env.TARGET_ADMIN_TOKEN ?? '', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`target admin ${path} said ${res.status}: ${json.error}`);
  return json;
}

const alice = { name: 'Priya Raman', email: 'priya.raman@example.com', seats: 3 };
const bob = { name: 'Tomas Ortega', email: 'tomas.ortega@example.com', seats: 5 };

banner('setup');
await admin('/_admin/reset');
await forgetCapability('reserve-room');
const cap = await loadCapability(reserveRoom());
await saveCapability(cap);
log('setup', `target reset, fresh capability "${cap.id}" with hand-written plan v${cap.plan.version}`);

banner('run 1: first success learns the contract');
const r1 = await runCapability(cap, alice, { log });
log('outcome', r1.ok ? 'succeeded' : `FAILED (${r1.failureKind}): ${r1.why}`);
if (!r1.ok) process.exit(1);

banner('run 2: cached plan, fast path');
const r2 = await runCapability(cap, bob, { log });
log('outcome', r2.ok ? 'succeeded' : `FAILED (${r2.failureKind}): ${r2.why}`);
if (!r2.ok) process.exit(1);

banner('break: rename the email field');
const broke = await admin('/_admin/break', { kind: 'rename-field', key: 'email' });
log('break', `${broke.detail} (site config v${broke.config.version})`);

banner('run 3: same plan against the changed site');
const r3 = await runCapability(cap, alice, { log });
log('outcome', r3.ok ? 'succeeded (the break did not break anything?)' : `FAILED (${r3.failureKind}): ${r3.why}`);
if (r3.ok) process.exit(1);

if (r3.failureKind === 'structural') {
  banner('repair');
  const fix = await repair(cap, { trigger: 'run-failure', failure: r3.why, inputs: alice, log });
  log('outcome', `repair ${fix.outcome}`);
  if (fix.outcome !== 'repaired') process.exit(2);
} else {
  log('repair', `not repairing a ${r3.failureKind} failure`);
  process.exit(2);
}

banner('run 4: identical run after repair');
const r4 = await runCapability(cap, bob, { log });
log('outcome', r4.ok ? `succeeded on plan v${cap.plan.version}` : `FAILED (${r4.failureKind}): ${r4.why}`);

banner('summary');
console.log(`  status ${cap.status}, plan v${cap.plan.version} (${cap.plan.origin}), ${cap.repairs.length} repair(s) on record`);
process.exit(r4.ok ? 0 : 3);
