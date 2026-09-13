import { openBrowser, scrape, keepAlive } from './anakin.mjs';
import { runPlan, checkPlanShape } from './plan.mjs';
import { checkContract } from './contract.mjs';
import { pageShape, formMarkup, diffShapes, compactHtml } from './page-shape.mjs';
import { derivePlan } from './derive.mjs';
import { OverBudget } from './errors.mjs';
import { db } from './db.mjs';
import { loadCapability, sessionOptions, setStatus, promotePlan } from './capabilities.mjs';
import { shooter } from './shots.mjs';

const MAX_ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Anakin's browser can go away under a long attempt; that is infrastructure, not a bad plan
const SESSION_GONE = /Target page, context or browser has been closed|browser has disconnected|Browser closed|WebSocket is not open|session ended|stopped answering/i;

async function readEntryPage(cap, session, log) {
  if (!sessionOptions(cap).forward) {
    // the scraper caches for 24h, so a throwaway query param forces a fresh read
    const url = new URL(cap.targetUrl);
    url.searchParams.set('_anvil', Date.now().toString(36));
    const r = await scrape(url.toString(), { log });
    return { html: r.html, via: `url scraper (cached=${r.cached})` };
  }
  await session.page.goto(cap.targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  return { html: await session.within(10_000, session.page.content(), 'reading the entry page'), via: 'browser session (target not public yet)' };
}

// Replace a broken plan. Promotes only on a passing contract, otherwise rolls back and degrades.
export async function executeRepair(repairId, { failure, inputs, stuckOn } = {}, log) {
  const rec = await db.repairAttempt.findUnique({ where: { id: repairId } });
  if (!rec) return log('error', 'this repair no longer exists (the capability was probably reset)');
  const cap = await loadCapability(rec.capabilityId);
  const finish = async (outcome, data = {}) => {
    await log.flush();
    return db.repairAttempt.update({ where: { id: repairId }, data: { outcome, ...data } });
  };

  if (cap.status === 'degraded' && rec.trigger !== 'manual') {
    log('repair', 'capability is degraded, not repairing without a manual trigger', { circuitBreaker: true });
    return finish('skipped', { diagnosis: 'circuit breaker: capability is degraded' });
  }
  if (!cap.contract) {
    log('repair', 'no contract yet, so there is nothing to validate a new plan against');
    return finish('skipped', { diagnosis: 'no contract to validate against' });
  }

  inputs ??= cap.contract.goldenSample.inputs;
  const previous = cap.plan;
  const statusBefore = cap.status === 'repairing' ? 'healthy' : cap.status;
  await db.repairAttempt.update({ where: { id: repairId }, data: { outcome: 'running', fromPlanId: previous.id } });
  await setStatus(cap.id, 'repairing');
  log('repair', `repair started (${rec.trigger}), setting plan v${previous.version} aside`, { fromPlanId: previous.id, failure: failure ?? null });
  log('health', 'capability marked repairing', { status: 'repairing' });

  let changes = [];
  let ending = null;
  const rejections = [];
  // Every page any attempt has seen, so a later attempt never forgets a page an earlier one found.
  const pages = new Map();
  if (stuckOn?.html) pages.set(stuckOn.url, stuckOn.html);
  const remember = async (session) => {
    const html = await session.within(5000, session.page.content(), 'reading the page').catch(() => '');
    if (html) pages.set(session.page.url(), compactHtml(html, 8000));
    return html;
  };
  for (let n = 1; n <= MAX_ATTEMPTS && !ending; n++) {
    if (n > 1) {
      const wait = 2000 * 2 ** (n - 2);
      log('repair', `backing off ${wait / 1000}s before attempt ${n}`, { wait });
      await sleep(wait);
    }
    log('attempt', `attempt ${n} of ${MAX_ATTEMPTS}`, { attempt: n });

    let session;
    try {
      session = await openBrowser({ ...sessionOptions(cap), log });
      const live = await readEntryPage(cap, session, log);
      const now = pageShape(live.html);
      changes = diffShapes(cap.snapshot?.shape, now.shape);
      log('read', `re-read the live page via ${live.via}`, { before: cap.snapshot?.hash ?? null, after: now.hash });
      for (const c of changes) log('diff', c);

      const stopKeepAlive = keepAlive(session.page);
      let derived;
      try {
        derived = await derivePlan({
          goal: cap.goal,
          entryUrl: cap.targetUrl,
          inputKeys: Object.keys(cap.inputSchema),
          outputFields: cap.contract.fieldTypes,
          previousPlan: previous,
          failure,
          pages: [...pages].slice(-4).map(([url, html]) => ({ url, html })),
          changes,
          shape: now.shape,
          markup: formMarkup(live.html),
          rejections,
        });
      } finally {
        stopKeepAlive();
      }
      for (const s of derived.skipped) log('derive', `skipped model ${s}`);
      log('derive', `new plan from ${derived.model} in ${(derived.ms / 1000).toFixed(1)}s`, { model: derived.model, ms: derived.ms, promptChars: derived.promptChars });

      const shapeProblems = checkPlanShape(derived.plan, { outputFields: Object.keys(cap.contract.fieldTypes), inputKeys: Object.keys(cap.inputSchema) });
      if (shapeProblems.length) {
        rejections.push(`attempt ${n} was not runnable: ${shapeProblems.join('; ')}`);
        log('reject', `The plan was not runnable: ${shapeProblems.join('; ')}`, { problems: shapeProblems, steps: derived.plan.steps ?? null });
        continue;
      }
      log('plan', `candidate plan has ${derived.plan.steps.length} steps`, { steps: derived.plan.steps });

      const execute = () => {
        const snap = shooter(session, log);
        return session.within(
          120_000,
          runPlan(derived.plan, inputs, session, {
            baseUrl: cap.targetUrl,
            onStep: (i, s) => log('step', `${i + 1}. ${s.kind} ${s.selector ?? s.url ?? Object.keys(s.fields ?? {}).join(', ')}`, { index: i, step: s }),
            beforePress: (i, s) => snap(`page before step ${i + 1}`, { index: i, kind: s.kind }),
            afterStep: (i, s) => snap(`page after step ${i + 1}`, { index: i, kind: s.kind, after: true }),
          }),
          'running the candidate plan',
        );
      };
      let result;
      try {
        try {
          result = await execute();
        } catch (err) {
          if (!SESSION_GONE.test(err.message)) throw err;
          log('browser', 'the remote browser went away mid-attempt, opening a new one and running the same plan again');
          await session.close();
          session = await openBrowser({ ...sessionOptions(cap), log });
          result = await execute();
        }
      } catch (err) {
        // reopening the browser can hit the credit cap; that ends the repair, it is not a bad plan
        if (err instanceof OverBudget) throw err;
        await shooter(session, log)('page where it got stuck', { index: err.index ?? null, stuck: true });
        const html = await remember(session);
        rejections.push(`attempt ${n} got stuck on ${session.page.url()}: ${err.message}`);
        log('execute', `candidate plan failed: ${err.message}`, { url: err.url ?? null, docStatus: err.docStatus ?? null, pageAtFailure: pageShape(html).shape });
        continue;
      }

      const check = checkContract(cap.contract, result.records, inputs);
      log('validate', check.pass ? 'contract passed' : `contract failed: ${check.problems.join('; ')}`, { records: result.records, problems: check.problems });
      if (!check.pass) {
        await remember(session);
        rejections.push(`attempt ${n} ran, but the result broke the contract: ${check.problems.join('; ')}. It read ${JSON.stringify(result.records)}`);
        continue;
      }

      const plan = await promotePlan(cap, { steps: derived.plan.steps, origin: `repair (${derived.model})`, snapshot: now });
      log('promote', `plan v${plan.version} promoted, capability healthy`, { planId: plan.id, version: plan.version });
      ending = ['repaired', { toPlanId: plan.id, diagnosis: changes.join('; ') }];
    } catch (err) {
      if (err instanceof OverBudget || err.quota) {
        // out of credits or out of model requests says nothing about the site, so no degrading
        await setStatus(cap.id, statusBefore);
        log('budget', `${err.message}. Stopping the repair and leaving plan v${previous.version} in place`, { used: err.used ?? null, cap: err.cap ?? null, modelQuota: !!err.quota });
        ending = ['capped', { diagnosis: err.message }];
      } else {
        rejections.push(`attempt ${n} crashed: ${err.message}`);
        log('error', `attempt ${n} crashed: ${err.message}`);
      }
    } finally {
      await session?.close();
    }
  }

  if (ending) return finish(...ending);

  await setStatus(cap.id, 'degraded');
  log('rollback', `all ${MAX_ATTEMPTS} attempts failed, kept plan v${previous.version}, capability degraded`, { planId: previous.id, status: 'degraded' });
  return finish('degraded', { diagnosis: [...changes, ...rejections].join('; ') });
}
