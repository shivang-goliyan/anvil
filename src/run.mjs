import { openBrowser } from './anakin.mjs';
import { runPlan } from './plan.mjs';
import { deriveContract, checkContract } from './contract.mjs';
import { pageShape } from './page-shape.mjs';
import { triage } from './triage.mjs';
import { saveCapability } from './store.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const sessionOptions = (cap) => (cap.forward ? { origin: new URL(cap.targetUrl).origin, forward: cap.forward } : {});

async function attempt(cap, inputs, log) {
  let session;
  try {
    session = await openBrowser({ ...sessionOptions(cap), log });
  } catch (error) {
    return { result: null, error, canaryPresent: false, pageText: '' };
  }
  log('browser', 'opened remote browser session');
  let result = null;
  let error = null;
  try {
    try {
      result = await runPlan(cap.plan, inputs, session, {
        baseUrl: cap.targetUrl,
        onStep: (i, s) => log('step', `${i + 1}. ${s.kind}${s.selector ? ` ${s.selector}` : s.url ? ` ${s.url}` : ''}`),
      });
    } catch (err) {
      error = err;
    }
    const canaryPresent = (await session.page.locator(cap.canary).count().catch(() => 0)) > 0;
    const pageText = error ? await session.page.innerText('body').catch(() => '') : '';
    return { result, error, canaryPresent, pageText };
  } finally {
    const ms = await session.close();
    log('browser', `closed session after ${(ms / 1000).toFixed(1)}s`);
  }
}

// One run of a capability with concrete inputs. Retries transient trouble, never repairs.
export async function runCapability(cap, inputs, { log }) {
  for (let tryNo = 1; tryNo <= 3; tryNo++) {
    log('run', `run with plan v${cap.plan.version}${tryNo > 1 ? ` (retry ${tryNo - 1})` : ''}`);
    const { result, error, canaryPresent, pageText } = await attempt(cap, inputs, log);
    const records = result?.records ?? [];
    if (records.length) log('result', JSON.stringify(records));

    if (!error && !cap.contract) {
      const incomplete = records.length === 0 || Object.values(records[0]).some((v) => v === null);
      if (incomplete) return { ok: false, failureKind: 'structural', why: 'first run came back incomplete, nothing to learn a contract from', records };
      cap.contract = deriveContract(records, inputs);
      cap.snapshot = pageShape(result.entryHtml);
      cap.plan.derivedFrom = cap.snapshot.hash;
      await saveCapability(cap);
      log('contract', `golden sample captured. required: ${cap.contract.requiredFields.join(', ')}; echoes: ${JSON.stringify(cap.contract.echoes)}`);
      return { ok: true, records };
    }

    const contractCheck = error ? null : checkContract(cap.contract, records, inputs);
    if (contractCheck) log('contract', contractCheck.pass ? 'contract passed' : `contract failed: ${contractCheck.problems.join('; ')}`);
    const verdict = triage({ error, contractCheck, records, canaryPresent, pageText });
    if (error) log('error', error.message);

    if (verdict.kind === 'ok' || verdict.kind === 'empty') return { ok: true, records, empty: verdict.kind === 'empty' };
    log('triage', `${verdict.kind}: ${verdict.why}`);

    if (verdict.kind === 'transient' && tryNo < 3) {
      await sleep(1000 * 2 ** tryNo);
      continue;
    }
    if (verdict.kind === 'blocked') {
      cap.status = 'degraded';
      await saveCapability(cap);
    }
    return { ok: false, failureKind: verdict.kind, why: verdict.why, error, records };
  }
}
