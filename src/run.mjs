import { openBrowser } from './anakin.mjs';
import { runPlan } from './plan.mjs';
import { deriveContract, checkContract } from './contract.mjs';
import { pageShape, compactHtml } from './page-shape.mjs';
import { triage } from './triage.mjs';
import { OverBudget } from './errors.mjs';
import { db } from './db.mjs';
import { loadCapability, sessionOptions, learnContract, setStatus } from './capabilities.mjs';
import { queueRepair, Busy } from './jobs.mjs';
import { runReadPlan, hasSelector } from './read-plan.mjs';
import { shooter } from './shots.mjs';
import { scrapeFetcher, runWireStep } from './read-engines.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a healthy booking takes about 10s; every step inside has its own shorter timeout too
const PLAN_DEADLINE = 120_000;

const stepLabel = (i, s) => `${i + 1}. ${s.kind}${s.selector ? ` ${s.selector}` : s.url ? ` ${s.url}` : s.fields ? ` ${Object.keys(s.fields).join(', ')}` : ''}`;

async function readAttempt(cap, log) {
  let last = null;
  // plans derived before JS rendering was switched on keep reading the plain page
  const fetchPage = scrapeFetcher(log, { render: cap.plan.steps.some((s) => s.kind === 'navigate' && s.render) });
  try {
    const result = await runReadPlan(cap.plan, {
      baseUrl: cap.targetUrl,
      fetchPage: async (url) => (last = await fetchPage(url)),
      onStep: (i, s) => log('step', stepLabel(i, s), { index: i, step: s }),
    });
    return { result, error: null, canaryPresent: hasSelector(result.finalHtml, cap.canary), pageText: '' };
  } catch (error) {
    const html = last?.html ?? '';
    return { result: null, error, canaryPresent: hasSelector(html, cap.canary), pageText: last?.markdown ?? '', pageAtFailure: html ? pageShape(html).shape : null };
  }
}

async function wireAttempt(cap, log) {
  const step = cap.plan.steps[0];
  try {
    const out = await runWireStep(step, { log, siteUrl: cap.targetUrl });
    // a completed Wire job means the site answered; there is no page to look for a canary on
    return { result: { records: out.records }, error: null, canaryPresent: true, pageText: '' };
  } catch (error) {
    return { result: null, error, canaryPresent: false, pageText: '' };
  }
}

async function attempt(cap, inputs, log) {
  if (cap.engine === 'scrape') return readAttempt(cap, log);
  if (cap.engine === 'wire') return wireAttempt(cap, log);
  let session;
  try {
    session = await openBrowser({ ...sessionOptions(cap), log });
  } catch (error) {
    return { result: null, error, canaryPresent: false, pageText: '' };
  }
  let result = null;
  let error = null;
  const snap = shooter(session, log);
  try {
    try {
      const plan = runPlan(cap.plan, inputs, session, {
        baseUrl: cap.targetUrl,
        onStep: (i, s) => log('step', stepLabel(i, s), { index: i, step: s }),
        beforePress: (i, s) => snap(`page before step ${i + 1}`, { index: i, kind: s.kind }),
      });
      result = await session.within(PLAN_DEADLINE, plan, 'running the plan');
    } catch (err) {
      error = err;
      await snap('page where it got stuck', { index: err.index ?? null, stuck: true });
    }
    const canaryPresent = (await session.within(5000, session.page.locator(cap.canary).count(), 'looking for the page canary').catch(() => 0)) > 0;
    const pageText = error ? await session.within(5000, session.page.innerText('body'), 'reading the page text').catch(() => '') : '';
    // structure only in the trace; the trimmed markup goes to the repair job, never to the UI
    const failedHtml = error ? await session.within(5000, session.page.content(), 'reading the page').catch(() => '') : '';
    const pageAtFailure = error ? pageShape(failedHtml).shape : null;
    const stuckOn = error ? { url: session.page.url(), html: compactHtml(failedHtml, 8000) } : null;
    return { result, error, canaryPresent, pageText, pageAtFailure, stuckOn };
  } finally {
    const ms = await session.close();
    log('browser', `closed session after ${(ms / 1000).toFixed(1)}s`, { ms });
  }
}

// One run of a capability with concrete inputs. Retries transient trouble, never repairs.
async function runCapability(cap, inputs, log) {
  for (let tryNo = 1; tryNo <= 3; tryNo++) {
    log('run', `running plan v${cap.plan.version}${tryNo > 1 ? ` (retry ${tryNo - 1})` : ''}`, { planId: cap.plan.id, version: cap.plan.version, try: tryNo });
    const { result, error, canaryPresent, pageText, pageAtFailure, stuckOn } = await attempt(cap, inputs, log);

    if (error instanceof OverBudget) {
      log('budget', `${error.message}. Not calling Anakin.`, { used: error.used, cap: error.cap });
      return { status: 'capped', why: error.message };
    }

    const records = result?.records ?? [];
    if (records.length) log('result', `extracted ${records.length} record${records.length === 1 ? '' : 's'}`, { records });

    if (!error && !cap.contract) {
      const incomplete = records.length === 0 || Object.values(records[0]).some((v) => v === null);
      if (incomplete) {
        log('contract', 'first run came back incomplete, nothing to learn a contract from', { records });
        return { status: 'failed', failureKind: 'structural', why: 'first run came back incomplete', records };
      }
      const contract = deriveContract(records, inputs);
      await learnContract(cap, { contract, inputs, snapshot: pageShape(result.entryHtml) });
      log('contract', `golden sample captured. required: ${contract.requiredFields.join(', ')}`, {
        requiredFields: contract.requiredFields,
        fieldTypes: contract.fieldTypes,
        bounds: contract.bounds,
        echoes: contract.echoes,
      });
      return { status: 'succeeded', records };
    }

    const contractCheck = error ? null : checkContract(cap.contract, records, inputs);
    if (contractCheck)
      log('contract', contractCheck.pass ? 'contract passed' : `contract failed: ${contractCheck.problems.join('; ')}`, { problems: contractCheck.problems });
    if (error)
      log('error', error.message, {
        reason: error.reason ?? error.code ?? null,
        step: error.index ?? null,
        url: error.url ?? null,
        docStatus: error.docStatus ?? error.status ?? null,
        pageAtFailure,
      });

    const verdict = triage({ error, contractCheck, records, canaryPresent, pageText });
    if (verdict.kind === 'ok') return { status: 'succeeded', records };
    log('triage', `${verdict.kind}: ${verdict.why}`, { kind: verdict.kind, canaryPresent });

    if (verdict.kind === 'empty') return { status: 'succeeded', records, empty: true };
    if (verdict.kind === 'transient' && tryNo < 3) {
      const wait = 1000 * 2 ** tryNo;
      log('retry', `transient, not touching the plan. trying again in ${wait / 1000}s`, { wait });
      await sleep(wait);
      continue;
    }
    if (verdict.kind === 'blocked') {
      await setStatus(cap.id, 'degraded');
      log('health', 'capability marked degraded. A new plan cannot fix a block, so no repair', { status: 'degraded' });
    }
    return { status: 'failed', failureKind: verdict.kind, why: verdict.why, records, stuckOn };
  }
}

export async function executeRun(runId, log) {
  const run = await db.run.findUnique({ where: { id: runId } });
  if (!run) return log('error', 'this run no longer exists (the capability was probably reset)');
  const cap = await loadCapability(run.capabilityId);
  if (!cap?.plan) {
    log('error', 'capability has no active plan');
    return db.run.update({ where: { id: runId }, data: { status: 'failed', endedAt: new Date(), result: { why: 'no active plan' } } });
  }

  await db.run.update({ where: { id: runId }, data: { status: 'running', startedAt: new Date(), planId: cap.plan.id } });
  const out = await runCapability(cap, run.inputs, log);
  const result = { records: out.records ?? [], ...(out.empty && { empty: true }), ...(out.why && { why: out.why }) };

  if (out.failureKind === 'structural') {
    const fresh = await loadCapability(cap.id);
    if (cap.engine !== 'browser') {
      log('repair', 'automatic repair is only wired up for browser capabilities so far, so this read capability stays as it is');
    } else if (!fresh.contract) {
      log('repair', 'no contract yet, so a repaired plan would have nothing to be checked against. Not repairing');
    } else if (fresh.status === 'degraded') {
      log('repair', 'capability is degraded, so it will not auto-repair. A manual repair can still be triggered', { circuitBreaker: true });
    } else {
      try {
        const repair = await queueRepair(cap.id, { trigger: 'run-failure', failure: out.why, inputs: run.inputs, runId, stuckOn: out.stuckOn });
        result.repairId = repair.id;
        log('repair', 'structural failure, queued a repair', { repairId: repair.id });
      } catch (err) {
        if (!(err instanceof Busy)) throw err;
        result.repairId = err.existing.repairId;
        log('repair', 'a repair is already on the way for this capability', { repairId: err.existing.repairId });
      }
    }
  }

  // trace first, so anyone polling sees the whole story by the time the status flips
  await log('done', out.status === 'succeeded' ? `run succeeded${out.empty ? ' with an empty result' : ''}` : out.status === 'capped' ? 'run skipped, credit cap' : `run failed (${out.failureKind})`, {
    status: out.status,
    failureKind: out.failureKind ?? null,
  });
  await db.run.update({ where: { id: runId }, data: { status: out.status, failureKind: out.failureKind ?? null, result, endedAt: new Date() } });
}
