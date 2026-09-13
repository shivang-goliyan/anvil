// Saves a real run -> failed run -> repair -> run sequence from the database as demo/recorded.json.
// The UI replays it, labelled as a recording, when the hourly credit cap is hit.
//
//   node --env-file=.env scripts/record-demo.mjs [repairId] ["what was changed on the site"]

import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { db } from '../src/db.mjs';
import { SHOTS, SHOT_NAME } from '../src/shots.mjs';

const pick = { seq: true, kind: true, label: true, detail: true, createdAt: true };

const [repairId, changeNote] = process.argv.slice(2);
const repair = repairId
  ? await db.repairAttempt.findUnique({ where: { id: repairId } })
  : await db.repairAttempt.findFirst({ where: { outcome: 'repaired', trigger: 'run-failure' }, orderBy: { createdAt: 'desc' } });
if (!repair) {
  console.error('no repaired repair found to record');
  process.exit(1);
}
const job = await db.job.findFirst({ where: { kind: 'repair', refId: repair.id } });
const failed = job?.payload?.runId && (await db.run.findUnique({ where: { id: job.payload.runId } }));
if (!failed) {
  console.error('could not find the run that triggered that repair');
  process.exit(1);
}
const before = await db.run.findFirst({ where: { capabilityId: repair.capabilityId, status: 'succeeded', createdAt: { lt: failed.createdAt } }, orderBy: { createdAt: 'desc' } });
const after = await db.run.findFirst({ where: { capabilityId: repair.capabilityId, status: 'succeeded', createdAt: { gt: repair.createdAt } }, orderBy: { createdAt: 'asc' } });
const cap = await db.capability.findUnique({ where: { id: repair.capabilityId } });
const planOf = async (id) => (id ? (await db.plan.findUnique({ where: { id }, select: { version: true, origin: true, steps: true } })) : null);

async function runJob(run, note) {
  const trace = await db.traceEvent.findMany({ where: { runId: run.id }, orderBy: { seq: 'asc' }, select: pick });
  return { type: 'run', note, subtitle: `plan v${(await planOf(run.planId))?.version}`, trace, final: { run, capability: { name: cap.name, plan: await planOf(run.planId) } } };
}

const jobs = [];
if (before) jobs.push(await runJob(before, 'A normal run on the cached plan.'));
jobs.push(await runJob(failed, `Then the demo site was changed: ${changeNote ?? repair.diagnosis}. Same plan, same kind of run:`));
jobs.push({
  type: 'repair',
  subtitle: `from plan v${(await planOf(repair.fromPlanId))?.version}`,
  trace: await db.traceEvent.findMany({ where: { repairId: repair.id }, orderBy: { seq: 'asc' }, select: pick }),
  final: { repair, capability: { name: cap.name, plan: await planOf(repair.toPlanId) }, fromPlan: await planOf(repair.fromPlanId), toPlan: await planOf(repair.toPlanId) },
});
if (after) jobs.push(await runJob(after, 'And the next run on the repaired plan:'));

// screenshots in state/ get cleared out over time, so the recording keeps its own copies
await mkdir(new URL('../demo/shots/', import.meta.url), { recursive: true });
let copied = 0;
for (const e of jobs.flatMap((j) => j.trace)) {
  const name = e.kind === 'shot' && e.detail?.src?.split('/').pop();
  if (!name || !SHOT_NAME.test(name)) continue;
  try {
    await copyFile(SHOTS + name, new URL(`../demo/shots/${name}`, import.meta.url));
    e.detail = { ...e.detail, src: `/api/demo/shots/${name}` };
    copied++;
  } catch {
    e.kind = 'shot-missing';
  }
}

const out = { recordedAt: (before ?? failed).createdAt, capability: cap.name, jobs };
console.log(`kept ${copied} screenshots with the recording`);
await mkdir(new URL('../demo/', import.meta.url), { recursive: true });
await writeFile(new URL('../demo/recorded.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(`recorded ${jobs.length} jobs (${jobs.reduce((n, j) => n + j.trace.length, 0)} trace events) from ${out.recordedAt.toISOString()} into demo/recorded.json`);
await db.$disconnect();
