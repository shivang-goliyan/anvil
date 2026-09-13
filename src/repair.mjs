import { openBrowser, scrape, keepAlive } from './anakin.mjs';
import { runPlan, checkPlanShape } from './plan.mjs';
import { checkContract } from './contract.mjs';
import { pageShape, formMarkup, diffShapes } from './page-shape.mjs';
import { derivePlan } from './derive.mjs';
import { OverBudget } from './errors.mjs';
import { db } from './db.mjs';
import { loadCapability, sessionOptions, setStatus, promotePlan } from './capabilities.mjs';

const MAX_ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readEntryPage(cap, session, log) {
  if (!sessionOptions(cap).forward) {
    // the scraper caches for 24h, so a throwaway query param forces a fresh read
    const url = new URL(cap.targetUrl);
    url.searchParams.set('_anvil', Date.now().toString(36));
    const r = await scrape(url.toString(), { log });
    return { html: r.html, via: `url scraper (cached=${r.cached})` };
  }
  await session.page.goto(cap.targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  return { html: await session.page.content(), via: 'browser session (target not public yet)' };
}

// Replace a broken plan. Promotes only on a passing contract, otherwise rolls back and degrades.
export async function executeRepair(repairId, { failure, inputs } = {}, log) {
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

  let feedback = null;
  let changes = [];
  let ending = null;
  const rejections = [];
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
          changes,
          shape: now.shape,
          markup: formMarkup(live.html),
          feedback,
        });
      } finally {
        stopKeepAlive();
      }
      for (const s of derived.skipped) log('derive', `skipped model ${s}`);
      log('derive', `new plan from ${derived.model} in ${(derived.ms / 1000).toFixed(1)}s`, { model: derived.model, ms: derived.ms, promptChars: derived.promptChars });

      const shapeProblems = checkPlanShape(derived.plan, { outputFields: Object.keys(cap.contract.fieldTypes), inputKeys: Object.keys(cap.inputSchema) });
      if (shapeProblems.length) {
        feedback = `The plan was not runnable: ${shapeProblems.join('; ')}`;
        rejections.push(`attempt ${n}: ${shapeProblems.join('; ')}`);
        log('reject', feedback, { problems: shapeProblems, steps: derived.plan.steps ?? null });
        continue;
      }
      log('plan', `candidate plan has ${derived.plan.steps.length} steps`, { steps: derived.plan.steps });

      let result;
      try {
        result = await runPlan(derived.plan, inputs, session, {
          baseUrl: cap.targetUrl,
          onStep: (i, s) => log('step', `${i + 1}. ${s.kind} ${s.selector ?? s.url ?? Object.keys(s.fields ?? {}).join(', ')}`, { index: i, step: s }),
        });
      } catch (err) {
        const then = pageShape(await session.page.content().catch(() => '')).shape;
        feedback = `Running it failed: ${err.message}. The page at that moment had this structure: ${JSON.stringify(then)}`;
        rejections.push(`attempt ${n}: ${err.message}`);
        log('execute', `candidate plan failed: ${err.message}`, { url: err.url ?? null, docStatus: err.docStatus ?? null, pageAtFailure: then });
        continue;
      }

      const check = checkContract(cap.contract, result.records, inputs);
      log('validate', check.pass ? 'contract passed' : `contract failed: ${check.problems.join('; ')}`, { records: result.records, problems: check.problems });
      if (!check.pass) {
        feedback = `It ran, but the result broke the contract: ${check.problems.join('; ')}. Result was ${JSON.stringify(result.records)}`;
        rejections.push(`attempt ${n}: ${check.problems.join('; ')}`);
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
        feedback = `Attempt crashed: ${err.message}`;
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
