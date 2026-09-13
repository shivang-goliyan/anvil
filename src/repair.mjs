import { openBrowser, scrape, keepAlive } from './anakin.mjs';
import { runPlan, checkPlanShape } from './plan.mjs';
import { checkContract } from './contract.mjs';
import { pageShape, formMarkup, diffShapes } from './page-shape.mjs';
import { derivePlan } from './derive.mjs';
import { sessionOptions } from './run.mjs';
import { saveCapability } from './store.mjs';

const MAX_ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readEntryPage(cap, session) {
  if (!cap.forward) {
    // the scraper caches for 24h, so a throwaway query param forces a fresh read
    const url = new URL(cap.targetUrl);
    url.searchParams.set('_anvil', Date.now().toString(36));
    const r = await scrape(url.toString());
    return { html: r.html, via: `url scraper (cached=${r.cached})` };
  }
  await session.page.goto(cap.targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  return { html: await session.page.content(), via: 'browser session (target not public yet)' };
}

// Replace a broken plan. Promotes only on a passing contract, otherwise rolls back and degrades.
export async function repair(cap, { trigger, failure, inputs, log }) {
  if (cap.status === 'degraded' && trigger !== 'manual') {
    log('repair', 'capability is degraded, not repairing without a manual trigger');
    return { outcome: 'skipped' };
  }
  if (!cap.contract) {
    log('repair', 'no contract yet, so there is nothing to validate a new plan against');
    return { outcome: 'skipped' };
  }

  const record = { trigger, startedAt: new Date().toISOString(), fromVersion: cap.plan.version, attempts: [] };
  const previous = cap.plan;
  cap.status = 'repairing';
  await saveCapability(cap);
  log('repair', `repair started (${trigger}), discarding plan v${previous.version}`);

  let feedback = null;
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    if (n > 1) {
      const wait = 2000 * 2 ** (n - 2);
      log('repair', `backing off ${wait / 1000}s before attempt ${n}`);
      await sleep(wait);
    }
    log('repair', `attempt ${n} of ${MAX_ATTEMPTS}`);
    const note = { n };
    record.attempts.push(note);

    let session;
    try {
      session = await openBrowser({ ...sessionOptions(cap), log });
      const live = await readEntryPage(cap, session);
      const now = pageShape(live.html);
      const changes = diffShapes(cap.snapshot?.shape, now.shape);
      log('read', `re-read live page via ${live.via}, structure hash ${cap.snapshot?.hash ?? 'none'} -> ${now.hash}`);
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
      log('derive', `new plan from ${derived.model} in ${(derived.ms / 1000).toFixed(1)}s (${derived.promptChars} prompt chars)`);
      note.plan = derived.plan;

      const shapeProblems = checkPlanShape(derived.plan, { outputFields: Object.keys(cap.contract.fieldTypes), inputKeys: Object.keys(cap.inputSchema) });
      if (shapeProblems.length) {
        feedback = `The plan was not runnable: ${shapeProblems.join('; ')}`;
        note.rejected = feedback;
        log('reject', feedback);
        continue;
      }
      for (const [i, s] of derived.plan.steps.entries())
        log('plan', `${i + 1}. ${s.kind} ${s.selector ?? s.url ?? Object.keys(s.fields ?? {}).join(',')}`);

      let result;
      try {
        result = await runPlan(derived.plan, inputs, session, { baseUrl: cap.targetUrl });
      } catch (err) {
        const where = await session.page.content().catch(() => '');
        feedback = `Running it failed: ${err.message}. The page at that moment had this structure: ${JSON.stringify(pageShape(where).shape)}`;
        note.rejected = err.message;
        log('execute', `new plan failed: ${err.message}`);
        continue;
      }

      const check = checkContract(cap.contract, result.records, inputs);
      log('validate', check.pass ? `contract passed with ${JSON.stringify(result.records)}` : `contract failed: ${check.problems.join('; ')}`);
      if (!check.pass) {
        feedback = `It ran, but the result broke the contract: ${check.problems.join('; ')}. Result was ${JSON.stringify(result.records)}`;
        note.rejected = feedback;
        continue;
      }

      cap.planHistory.push(previous);
      cap.plan = { version: previous.version + 1, origin: `repair (${derived.model})`, derivedFrom: now.hash, steps: derived.plan.steps };
      cap.snapshot = now;
      cap.status = 'healthy';
      record.outcome = 'repaired';
      record.toVersion = cap.plan.version;
      record.diagnosis = changes.join('; ');
      record.endedAt = new Date().toISOString();
      cap.repairs.push(record);
      await saveCapability(cap);
      log('promote', `plan v${cap.plan.version} promoted, capability healthy`);
      return { outcome: 'repaired', records: result.records, version: cap.plan.version };
    } catch (err) {
      feedback = `Attempt crashed: ${err.message}`;
      note.rejected = err.message;
      log('error', `attempt ${n} crashed: ${err.message}`);
    } finally {
      await session?.close();
    }
  }

  cap.plan = previous;
  cap.status = 'degraded';
  record.outcome = 'degraded';
  record.endedAt = new Date().toISOString();
  cap.repairs.push(record);
  await saveCapability(cap);
  log('rollback', `all ${MAX_ATTEMPTS} attempts failed, rolled back to plan v${previous.version}, capability degraded`);
  return { outcome: 'degraded' };
}
