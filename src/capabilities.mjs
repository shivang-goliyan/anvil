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

const slug = (s) => s.toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// A Tier A capability starts with no plan. The derive job gives it one.
export async function createReadCapability({ url, goal, name }) {
  const host = new URL(url).hostname;
  const id = `${slug(host)}-${Math.random().toString(36).slice(2, 7)}`;
  return db.$transaction(async (tx) => {
    const cap = await tx.capability.create({
      data: { id, name: name || goal.slice(0, 60), goal, entryUrl: url, targetUrl: url, inputSchema: {}, canary: '', engine: 'scrape', status: 'deriving' },
    });
    const derivation = await tx.derivation.create({ data: { capabilityId: id, entryUrl: url } });
    await tx.job.create({ data: { kind: 'derive', refId: derivation.id } });
    await tx.traceEvent.create({ data: { derivationId: derivation.id, seq: 1, kind: 'queued', label: `derivation queued for ${url}`, detail: { goal, url } } });
    return { cap, derivation };
  });
}

// First working plan for a capability, with the contract learned from the same result.
export async function adoptFirstPlan(capId, { engine, targetUrl, canary, steps, origin, contract, snapshot }) {
  return db.$transaction(async (tx) => {
    await tx.pageSnapshot.upsert({ where: { hash: snapshot.hash }, create: { hash: snapshot.hash, url: targetUrl, shape: snapshot.shape }, update: {} });
    const plan = await tx.plan.create({ data: { capabilityId: capId, steps, origin, derivedFrom: snapshot.hash, version: 1, active: true } });
    const row = await tx.contract.create({
      data: {
        capabilityId: capId,
        goldenSample: { inputs: {}, records: contract.goldenSample },
        requiredFields: contract.requiredFields,
        fieldTypes: contract.fieldTypes,
        minRecords: contract.minRecords,
        bounds: contract.bounds,
        echoes: contract.echoes,
      },
    });
    await tx.capability.update({ where: { id: capId }, data: { engine, targetUrl, canary, planId: plan.id, contractId: row.id, status: 'healthy' } });
    return { plan, contract: row };
  });
}
