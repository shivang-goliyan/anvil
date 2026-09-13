import { db } from './db.mjs';

const ACTIVE_RUN = { in: ['queued', 'running'] };

export class Busy extends Error {
  constructor(message, existing) {
    super(message);
    this.existing = existing;
  }
}

// Checks inputs against the capability's inputSchema. Numbers may arrive as strings from a form.
export function cleanInputs(schema, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'inputs should be an object' };
  const inputs = {};
  for (const [k, type] of Object.entries(schema)) {
    let v = raw[k];
    if (v === undefined || v === null || v === '') return { error: `"${k}" is missing` };
    if (type === 'number') {
      v = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `"${k}" should be a number` };
    } else {
      if (typeof v !== 'string') return { error: `"${k}" should be text` };
      v = v.trim();
      if (v.length > 200) return { error: `"${k}" is too long` };
    }
    inputs[k] = v;
  }
  const extra = Object.keys(raw).filter((k) => !(k in schema));
  if (extra.length) return { error: `unexpected input ${extra.map((k) => `"${k}"`).join(', ')}` };
  return { inputs };
}

// One active run per capability. The worker does one thing at a time anyway, and this keeps
// a shared demo from piling up a queue of credit-burning runs.
export async function queueRun(capabilityId, inputs) {
  const busy = await db.run.findFirst({ where: { capabilityId, status: ACTIVE_RUN }, select: { id: true } });
  if (busy) throw new Busy('a run for this capability is already in progress', { runId: busy.id });

  return db.$transaction(async (tx) => {
    const run = await tx.run.create({ data: { capabilityId, inputs } });
    await tx.job.create({ data: { kind: 'run', refId: run.id } });
    await tx.traceEvent.create({ data: { runId: run.id, seq: 1, kind: 'queued', label: 'run queued, waiting for the worker', detail: { inputs } } });
    return run;
  });
}

export async function queueRepair(capabilityId, { trigger, failure, inputs, runId, stuckOn } = {}) {
  const busy = await db.repairAttempt.findFirst({ where: { capabilityId, outcome: { in: ['queued', 'running'] } }, select: { id: true } });
  if (busy) throw new Busy('a repair for this capability is already queued or running', { repairId: busy.id });

  return db.$transaction(async (tx) => {
    const cap = await tx.capability.findUnique({ where: { id: capabilityId }, select: { planId: true } });
    const repair = await tx.repairAttempt.create({ data: { capabilityId, trigger, fromPlanId: cap?.planId } });
    await tx.job.create({ data: { kind: 'repair', refId: repair.id, payload: { failure, inputs, runId, stuckOn: stuckOn ?? null } } });
    await tx.traceEvent.create({
      data: { repairId: repair.id, seq: 1, kind: 'queued', label: `repair queued (${trigger})`, detail: { trigger, runId: runId ?? null } },
    });
    return repair;
  });
}
