import { db } from './db.mjs';

// Returns log(kind, label, detail) for one run, repair or derivation. Calls can be fired without awaiting;
// they are numbered on the spot and written in order. await log.flush() before finishing up.
export async function tracer(owner, { echo = true } = {}) {
  const where = owner.runId ? { runId: owner.runId } : owner.repairId ? { repairId: owner.repairId } : { derivationId: owner.derivationId };
  const last = await db.traceEvent.findFirst({ where, orderBy: { seq: 'desc' }, select: { seq: true } });
  let seq = last?.seq ?? 0;
  let chain = Promise.resolve();
  const [ownerKind, ownerId] = Object.entries(where)[0];
  const tag = `${ownerKind.replace('Id', '')} ${ownerId.slice(-6)}`;

  const log = (kind, label, detail) => {
    const n = ++seq;
    if (echo) console.log(`[${tag}] ${String(n).padStart(3)} ${kind.padEnd(9)} ${label}`);
    chain = chain
      .then(() => db.traceEvent.create({ data: { ...where, seq: n, kind, label, detail: detail ?? undefined } }))
      .catch((err) => console.error(`[${tag}] lost trace event ${n}: ${err.message}`));
    return chain;
  };
  log.flush = () => chain;
  return log;
}
