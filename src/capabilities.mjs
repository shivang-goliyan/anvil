import { db } from './db.mjs';

export async function loadCapability(id) {
  const cap = await db.capability.findUnique({ where: { id }, include: { plan: true, contract: true } });
  if (!cap) return null;
  const snapshot = cap.plan?.derivedFrom ? await db.pageSnapshot.findUnique({ where: { hash: cap.plan.derivedFrom } }) : null;
  return { ...cap, snapshot };
}

// *.anvil.test only exists inside the remote browser. openBrowser answers it from TARGET_FORWARD.
export function sessionOptions(cap) {
  const { hostname, origin } = new URL(cap.targetUrl);
  if (!hostname.endsWith('.anvil.test')) return {};
  return { origin, forward: process.env.TARGET_FORWARD || 'http://localhost:4310' };
}

export const setStatus = (id, status) => db.capability.update({ where: { id }, data: { status } });

const snapshotUpsert = (url, snap) =>
  db.pageSnapshot.upsert({ where: { hash: snap.hash }, create: { hash: snap.hash, url, shape: snap.shape }, update: {} });

// First good result: it becomes the golden sample, and the page it came from becomes the plan's snapshot.
export async function learnContract(cap, { contract, inputs, snapshot }) {
  const [row] = await db.$transaction([
    db.contract.create({
      data: {
        capabilityId: cap.id,
        goldenSample: { inputs, records: contract.goldenSample },
        requiredFields: contract.requiredFields,
        fieldTypes: contract.fieldTypes,
        minRecords: contract.minRecords,
        bounds: contract.bounds,
        echoes: contract.echoes,
      },
    }),
    snapshotUpsert(cap.targetUrl, snapshot),
    db.plan.update({ where: { id: cap.planId }, data: { derivedFrom: snapshot.hash } }),
  ]);
  await db.capability.update({ where: { id: cap.id }, data: { contractId: row.id } });
  return row;
}

export async function promotePlan(cap, { steps, origin, snapshot }) {
  const next = await db.$transaction(async (tx) => {
    await tx.pageSnapshot.upsert({ where: { hash: snapshot.hash }, create: { hash: snapshot.hash, url: cap.targetUrl, shape: snapshot.shape }, update: {} });
    await tx.plan.updateMany({ where: { capabilityId: cap.id, active: true }, data: { active: false } });
    const top = await tx.plan.aggregate({ where: { capabilityId: cap.id }, _max: { version: true } });
    const plan = await tx.plan.create({
      data: { capabilityId: cap.id, steps, origin, derivedFrom: snapshot.hash, version: (top._max.version ?? 0) + 1, active: true },
    });
    await tx.capability.update({ where: { id: cap.id }, data: { planId: plan.id, status: 'healthy' } });
    return plan;
  });
  return next;
}

// Puts a capability back to its hand-written first plan with nothing learned. Used by seeding.
export async function seedCapability(def, { reset = false } = {}) {
  const existing = await db.capability.findUnique({ where: { id: def.id } });
  if (existing && !reset) return { created: false };
  if (existing) {
    const where = { capabilityId: def.id };
    const ids = [...(await db.run.findMany({ where, select: { id: true } })), ...(await db.repairAttempt.findMany({ where, select: { id: true } }))];
    await db.job.deleteMany({ where: { refId: { in: ids.map((r) => r.id) } } });
    await db.capability.update({ where: { id: def.id }, data: { planId: null, contractId: null } });
    await db.capability.delete({ where: { id: def.id } });
  }
  await db.capability.create({
    data: { id: def.id, name: def.name, goal: def.goal, targetUrl: def.targetUrl, inputSchema: def.inputSchema, canary: def.canary },
  });
  const plan = await db.plan.create({ data: { capabilityId: def.id, steps: def.steps, origin: 'hand-written', version: 1, active: true } });
  await db.capability.update({ where: { id: def.id }, data: { planId: plan.id } });
  return { created: true };
}
