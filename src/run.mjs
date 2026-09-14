import { openBrowser } from './anakin.mjs';
import { runPlan, contentWithFrames } from './plan.mjs';
import { deriveContract, checkContract, amendContract } from './contract.mjs';
import { pageShape, compactHtml } from './page-shape.mjs';
import { triage } from './triage.mjs';
import { OverBudget } from './errors.mjs';
import { db } from './db.mjs';
import { loadCapability, sessionOptions, learnContract, setStatus, amendContractRow } from './capabilities.mjs';
import { queueRepair, Busy } from './jobs.mjs';
import { runReadPlan, hasSelector } from './read-plan.mjs';
import { shooter } from './shots.mjs';
import { scrapeFetcher, runWireStep } from './read-engines.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a healthy booking takes about 10s; every step inside has its own shorter timeout too
const PLAN_DEADLINE = 120_000;

// a capability that needed a person gets one fresh repair on a failure this long after its last repair
const COOLDOWN_MIN = Number(process.env.ANVIL_COOLDOWN_MINUTES ?? 20);
async function cooledDown(capabilityId) {
  const last = await db.repairAttempt.findFirst({ where: { capabilityId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  return !last || Date.now() - last.createdAt.getTime() >= COOLDOWN_MIN * 60_000;
}

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
    // a redesign can take the canary with it; a page with plenty of text on it still rendered
    const rendered = (last?.markdown ?? '').trim().length > 200;
    return { result: null, error, canaryPresent: hasSelector(html, cap.canary), rendered, pageText: last?.markdown ?? '', pageAtFailure: html ? pageShape(html).shape : null };
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
        afterStep: (i, s) => snap(`page after step ${i + 1}`, { index: i, kind: s.kind, after: true }),
      });
      result = await session.within(PLAN_DEADLINE, plan, 'running the plan');
    } catch (err) {
      error = err;
      await snap('page where it got stuck', { index: err.index ?? null, stuck: true });
    }
    const canaryPresent = (await session.within(5000, session.page.locator(cap.canary).count(), 'looking for the page canary').catch(() => 0)) > 0;
    const pageText = error ? await session.within(5000, session.page.innerText('body'), 'reading the page text').catch(() => '') : '';
    // structure only in the trace; the trimmed markup goes to the repair job, never to the UI
    const failedHtml = error ? await session.within(5000, contentWithFrames(session.page), 'reading the page').catch(() => '') : '';
    const pageAtFailure = error ? pageShape(failedHtml).shape : null;
    const stuckOn = error ? { url: session.page.url(), html: compactHtml(failedHtml, 8000), committed: !!error.committed, afterCommitUrl: error.afterCommitUrl ?? null, ...(error.committed && { shape: pageAtFailure }) } : null;
    return { result, error, canaryPresent, pageText, pageAtFailure, stuckOn, sent: result?.sent ?? null, committed: result?.committed ?? !!error?.committed, afterCommitUrl: result?.afterCommitUrl ?? error?.afterCommitUrl ?? null };
  } finally {
    const ms = await session.close();
    log('browser', `closed session after ${(ms / 1000).toFixed(1)}s`, { ms });
  }
}

// One run of a capability with concrete inputs. Retries transient trouble, never repairs.
async function runCapability(cap, inputs, log) {
  for (let tryNo = 1; tryNo <= 3; tryNo++) {
    log('run', `running plan v${cap.plan.version}${tryNo > 1 ? ` (retry ${tryNo - 1})` : ''}`, { planId: cap.plan.id, version: cap.plan.version, try: tryNo });
    const { result, error, canaryPresent, rendered, pageText, pageAtFailure, stuckOn, sent, committed, afterCommitUrl } = await attempt(cap, inputs, log);
    if (sent) log('sent', sent.missing.length ? `before booking, the page did not hold: ${sent.missing.join(', ')}` : `before booking, the page held every detail asked for (${sent.found.join(', ')})`, sent);

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
      if (afterCommitUrl) result.afterCommitUrl = afterCommitUrl;
      log('contract', `golden sample captured. required: ${contract.requiredFields.join(', ')}`, {
        requiredFields: contract.requiredFields,
        fieldTypes: contract.fieldTypes,
        bounds: contract.bounds,
        echoes: contract.echoes,
      });
      return { status: 'succeeded', records, afterCommitUrl };
    }

    const contractCheck = error ? null : checkContract(cap.contract, records, inputs);
    if (contractCheck)
      log('contract', contractCheck.pass ? 'contract passed' : `contract failed: ${contractCheck.problems.join('; ')}`, { problems: contractCheck.problems, drift: contractCheck.drift });
    // every invariant held, only a learned detail moved (a new reference format, a wider range): learn it
    if (contractCheck?.pass && contractCheck.drift.length) {
      const next = amendContract(cap.contract, records, contractCheck.drift);
      await amendContractRow(cap.contract.id, next);
      log('contract', `check updated: ${next.changes.join('; ')}`, { amended: next.changes, drift: contractCheck.drift });
    }
    if (error)
      log('error', error.message, {
        reason: error.reason ?? error.code ?? null,
        step: error.index ?? null,
        url: error.url ?? null,
        docStatus: error.docStatus ?? error.status ?? null,
        pageAtFailure,
      });

    const verdict = triage({ error, contractCheck, records, canaryPresent, rendered, pageText, sent });
    if (verdict.kind === 'ok') return { status: 'succeeded', records, afterCommitUrl };
    log('triage', `${verdict.kind}: ${verdict.why}`, { kind: verdict.kind, canaryPresent });

    if (verdict.kind === 'empty') return { status: 'succeeded', records, empty: true };
    if (verdict.kind === 'mismatch') {
      log('health', 'the website booked something other than what was asked. A new plan cannot fix that, so no repair: this needs a person at the website', { mismatch: contractCheck.problems });
      return { status: 'failed', failureKind: 'mismatch', why: verdict.why, records };
    }
    // a retry after the booking step already ran would book a second time
    if (verdict.kind === 'transient' && committed) {
      log('retry', 'not trying again: the booking step already ran, and a second try could book twice', { committed: true });
      return { status: 'failed', failureKind: verdict.kind, why: verdict.why, records, stuckOn: stuckOn ?? { url: afterCommitUrl, committed: true, afterCommitUrl } };
    }
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
    return { status: 'failed', failureKind: verdict.kind, why: verdict.why, records, stuckOn: stuckOn ?? (committed ? { url: afterCommitUrl, committed: true, afterCommitUrl } : null) };
  }
}

export async function executeRun(runId, log, { afterRepair = null } = {}) {
  const run = await db.run.findUnique({ where: { id: runId } });
  if (!run) return log('error', 'this run no longer exists (the capability was probably reset)');
  const cap = await loadCapability(run.capabilityId);
  if (!cap?.plan) {
    log('error', 'capability has no active plan');
    return db.run.update({ where: { id: runId }, data: { status: 'failed', endedAt: new Date(), result: { why: 'no active plan' } } });
  }

  await db.run.update({ where: { id: runId }, data: { status: 'running', startedAt: new Date(), planId: cap.plan.id } });
  const out = await runCapability(cap, run.inputs, log);
  // afterCommitUrl: where a booking's confirmation lives, so a later repair can test reading steps on it without booking
  const result = { records: out.records ?? [], ...(out.empty && { empty: true }), ...(out.why && { why: out.why }), ...(out.afterCommitUrl && { afterCommitUrl: out.afterCommitUrl }) };

  if (out.failureKind === 'structural') {
    const fresh = await loadCapability(cap.id);
    if (cap.engine === 'wire') {
      log('repair', 'this capability runs a ready-made Wire action, so there are no steps of ours to repair');
    } else if (!fresh.contract) {
      log('repair', 'no contract yet, so a repaired plan would have nothing to be checked against. Not repairing');
    } else if (afterRepair) {
      await setStatus(cap.id, 'degraded');
      log('repair', 'this was the one real booking after a repair, and it still did not pass. Not repairing again: marked as needing a person', { afterRepair, status: 'degraded' });
    } else if (fresh.status === 'degraded' && !(await cooledDown(cap.id))) {
      log('repair', `capability is degraded, so it will not auto-repair until ${COOLDOWN_MIN} minutes after its last repair. A manual repair, or a change Anakin Website Monitoring spots, can still start one`, { circuitBreaker: true });
    } else {
      const trigger = fresh.status === 'degraded' ? 'cooldown' : 'run-failure';
      if (trigger === 'cooldown') log('repair', `it needed a person, but ${COOLDOWN_MIN} minutes have passed since its last repair, and the website may have changed again since. One fresh repair`, { cooldown: COOLDOWN_MIN });
      try {
        const repair = await queueRepair(cap.id, { trigger, failure: out.why, inputs: run.inputs, runId, stuckOn: out.stuckOn });
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
