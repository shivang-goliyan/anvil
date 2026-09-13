import { db } from './db.mjs';
import { OverBudget } from './errors.mjs';

const HOUR = 60 * 60 * 1000;

export const hourlyCap = () => Number(process.env.ANAKIN_HOURLY_CREDITS ?? 20);

export async function creditsUsed() {
  const { _sum } = await db.creditSpend.aggregate({
    where: { createdAt: { gte: new Date(Date.now() - HOUR) } },
    _sum: { credits: true },
  });
  return _sum.credits ?? 0;
}

// Called before every Anakin call. Throws instead of letting the call happen.
export async function checkBudget(credits = 1) {
  const used = await creditsUsed();
  const cap = hourlyCap();
  if (used + credits > cap) throw new OverBudget(used, cap, credits);
  return { used, cap };
}

// There is no balance endpoint, so these are the published prices, not a meter reading.
export async function recordSpend(kind, credits, note) {
  // negative rows are refunds (Wire gives credits back for a failed job)
  if (credits !== 0) await db.creditSpend.create({ data: { kind, credits, note } });
}
