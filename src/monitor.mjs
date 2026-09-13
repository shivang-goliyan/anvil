// Anakin Website Monitoring from the API process, which stays clear of the browser library.
import { checkBudget, recordSpend } from './budget.mjs';

const API = 'https://api.anakin.io/v1/monitors';

async function call(method, path = '') {
  const res = await fetch(`${API}/${process.env.ANAKIN_MONITOR_ID}${path}`, {
    method,
    headers: { 'X-API-Key': process.env.ANAKIN_API_KEY?.trim() ?? '' },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!res) throw Object.assign(new Error('Anakin Website Monitoring is not answering right now'), { status: 502 });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`Anakin Website Monitoring said ${res.status}${json.error ? ` (${json.error})` : ''}`), { status: 502 });
  return json;
}

const newest = async (what) => (await call('GET', `/${what}`))[what]?.[0]?.id ?? null;

// A full-page check costs 2 credits. A check asked for this way does not move the monitor's lastCheckedAt,
// so what is remembered is the newest snapshot and change, and a new one of either means it landed.
export async function askForCheck(credits = 2) {
  await checkBudget(credits);
  const before = { snapshot: await newest('snapshots'), change: await newest('changes') };
  await call('POST', '/run');
  await recordSpend('monitor', credits, 'check asked for from the page');
  return before;
}

export async function checkLanded(before) {
  const [snapshot, change] = [await newest('snapshots'), await newest('changes')];
  const changed = change !== before.change;
  return { landed: changed || snapshot !== before.snapshot, changed };
}
