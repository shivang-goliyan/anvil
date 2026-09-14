// The only process that talks to Anakin or the model. Polls the Job table and does one job at a time.

import { db } from './db.mjs';
import { tracer } from './trace.mjs';
import { executeRun } from './run.mjs';
import { executeRepair } from './repair.mjs';
import { executeDerive } from './derive-read.mjs';
import { hourlyCap, creditsUsed } from './budget.mjs';
import { pickJob, yieldsTo } from './job-order.mjs';

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 1000);
// A working worker touches lockedAt every BEAT_MS. A running job nobody has touched for LEASE_MS
// is treated as abandoned. Without this, a second worker would steal jobs that are still alive.
const BEAT_MS = 10_000;
const LEASE_MS = 45_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const owner = (job) => ({ run: { runId: job.refId }, repair: { repairId: job.refId }, derive: { derivationId: job.refId } })[job.kind];

let stopping = false;

// Mark the run or repair as finished badly, so nobody polls it forever.
async function giveUp(job, why) {
  const log = await tracer(owner(job));
  await log('error', why);
  await db.job.update({ where: { id: job.id }, data: { status: 'failed', error: why.slice(0, 2000) } });
  if (job.kind === 'run') {
    await db.run.updateMany({ where: { id: job.refId, status: { in: ['queued', 'running'] } }, data: { status: 'failed', endedAt: new Date(), result: { why } } });
  } else if (job.kind === 'derive') {
    const d = await db.derivation.findUnique({ where: { id: job.refId } });
    if (d && ['queued', 'running'].includes(d.outcome)) {
      await db.derivation.update({ where: { id: d.id }, data: { outcome: 'failed', diagnosis: why } });
      await db.capability.updateMany({ where: { id: d.capabilityId, status: 'deriving' }, data: { status: 'degraded' } });
    }
  } else {
    const rec = await db.repairAttempt.findUnique({ where: { id: job.refId } });
    if (rec && ['queued', 'running'].includes(rec.outcome)) {
      await db.repairAttempt.update({ where: { id: rec.id }, data: { outcome: 'failed', diagnosis: why } });
      // half-finished repair: don't pretend the capability is fine
      await db.capability.updateMany({ where: { id: rec.capabilityId, status: 'repairing' }, data: { status: 'degraded' } });
    }
  }
}

async function reclaimAbandoned() {
  const stale = await db.job.findMany({ where: { status: 'running', lockedAt: { lt: new Date(Date.now() - LEASE_MS) } } });
  for (const job of stale) {
    if (job.tries >= 2) {
      await giveUp(job, `a worker died twice while doing this ${job.kind}, giving up on it`);
      continue;
    }
    // only if nobody else got to it first
    const { count } = await db.job.updateMany({ where: { id: job.id, status: 'running', lockedAt: job.lockedAt }, data: { status: 'queued', lockedAt: null } });
    if (!count) continue;
    const log = await tracer(owner(job));
    await log('worker', `the worker doing this went quiet ${Math.round((Date.now() - job.lockedAt) / 1000)}s ago, starting it again`);
    console.log(`reclaimed abandoned ${job.kind} ${job.refId}`);
  }
}

// Which capability a job works on. Jobs for the same capability run one at a time, whichever worker has them.
const capabilities = new Map();
async function capabilityOf(job) {
  if (!capabilities.has(job.id)) {
    const find = { run: () => db.run.findUnique({ where: { id: job.refId } }), repair: () => db.repairAttempt.findUnique({ where: { id: job.refId } }), derive: () => db.derivation.findUnique({ where: { id: job.refId } }) }[job.kind];
    capabilities.set(job.id, (await find?.())?.capabilityId ?? `job:${job.id}`);
  }
  return capabilities.get(job.id);
}


async function claim() {
  const queued = await db.job.findMany({ where: { status: 'queued', runAfter: { lte: new Date() } }, orderBy: [{ runAfter: 'asc' }, { createdAt: 'asc' }], take: 25 });
  if (!queued.length) return null;
  const running = await db.job.findMany({ where: { status: 'running' } });
  const busy = new Set(await Promise.all(running.map(capabilityOf)));
  for (const j of queued) j.capabilityId = await capabilityOf(j);
  const next = pickJob(queued, busy);
  if (!next) return null;
  const { count } = await db.job.updateMany({
    where: { id: next.id, status: 'queued' },
    data: { status: 'running', lockedAt: new Date(), tries: { increment: 1 } },
  });
  if (count !== 1) return null;
  // another worker may have claimed a job for the same capability in the same moment; the older job keeps going
  const others = (await db.job.findMany({ where: { status: 'running', id: { not: next.id } } })).filter((o) => o.kind && o.refId);
  for (const o of others) {
    if ((await capabilityOf(o)) === next.capabilityId && yieldsTo(next, o)) {
      await db.job.updateMany({ where: { id: next.id, status: 'running' }, data: { status: 'queued', lockedAt: null, tries: { decrement: 1 } } });
      return null;
    }
  }
  return next;
}

async function work(job) {
  const log = await tracer(owner(job));
  const started = Date.now();
  console.log(`picked up ${job.kind} ${job.refId}`);
  const beat = setInterval(() => db.job.updateMany({ where: { id: job.id, status: 'running' }, data: { lockedAt: new Date() } }).catch(() => {}), BEAT_MS);
  try {
    if (job.kind === 'run') await executeRun(job.refId, log, job.payload ?? {});
    else if (job.kind === 'repair') await executeRepair(job.refId, job.payload ?? {}, log);
    else if (job.kind === 'derive') await executeDerive(job.refId, log);
    else throw new Error(`no idea how to do a "${job.kind}" job`);
    await log.flush();
    await db.job.update({ where: { id: job.id }, data: { status: 'done' } });
    console.log(`finished ${job.kind} ${job.refId} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (err) {
    console.error(`${job.kind} ${job.refId} blew up:`, err);
    await log.flush();
    await giveUp(job, `the worker hit an error it did not expect: ${err.message}`);
  } finally {
    clearInterval(beat);
    capabilities.delete(job.id);
  }
}

let current = null;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(current ? `${sig}: finishing the current job first (send again to quit now)` : `${sig}: stopping`);
  });
}

console.log(`worker${process.env.WORKER_NAME ? ` ${process.env.WORKER_NAME}` : ''} up. polling every ${POLL_MS}ms, Anakin cap ${hourlyCap()} credits/hour, ${await creditsUsed()} used in the last hour`);

let lastReclaim = 0;
while (!stopping) {
  let job = null;
  try {
    if (Date.now() - lastReclaim > BEAT_MS) {
      lastReclaim = Date.now();
      await reclaimAbandoned();
    }
    job = await claim();
  } catch (err) {
    console.error('could not read the job queue:', err.message);
  }
  if (!job) {
    await sleep(POLL_MS);
    continue;
  }
  current = work(job);
  await current;
  current = null;
}

await db.$disconnect();
console.log('worker stopped');
