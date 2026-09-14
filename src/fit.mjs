import { openBrowser } from './anakin.mjs';
import { runPlan, StepError, contentWithFrames } from './plan.mjs';
import { checkContract } from './contract.mjs';
import { pageShape, diffShapes, compactHtml } from './page-shape.mjs';
import { triage, BLOCK_WORDS } from './triage.mjs';
import { OverBudget } from './errors.mjs';
import { db } from './db.mjs';
import { sessionOptions, booksSomething } from './capabilities.mjs';
import { shooter } from './shots.mjs';

// The saved steps that act on the first page: after the opening navigate, up to and including the first press.
export function firstPageSelectors(steps = []) {
  const out = [];
  for (const [i, s] of steps.entries()) {
    if (s.kind === 'navigate') {
      if (i === 0) continue;
      break;
    }
    if (s.selector) out.push({ index: i, selector: s.selector, frame: s.frame });
    if (s.kind === 'click' || s.kind === 'submit') break;
  }
  return out;
}

// Does the saved plan still do the job on the website as it is right now? Asks no model and books nothing:
// the saved selectors are looked for on the live page, the steps are rehearsed up to the booking button,
// and the steps after it are run on the last good booking. Returns { fits } or { fits: false, why, stuckOn },
// with blocked or unsure set when the answer says nothing about the plan.
export async function fitCheck(cap, log) {
  const steps = cap.plan.steps;
  const write = booksSomething(cap);
  const inputs = cap.contract.goldenSample?.inputs ?? {};
  log('fit', `checking whether the saved steps (v${cap.plan.version}) still fit the website, before asking any model for new ones`, { stage: 'start', write });

  const session = await openBrowser({ ...sessionOptions(cap), log });
  const snap = shooter(session, log);
  const page = session.page;
  const pageHtml = () => session.within(5000, contentWithFrames(page), 'reading the page').catch(() => '');
  const pageText = () => session.within(5000, page.innerText('body'), 'reading the page text').catch(() => '');
  let changes = [];

  // one way out for every stage that finds a problem: blocked and "could not tell" are not reasons to repair
  const stop = async (why, err) => {
    await snap('page where the saved steps stopped fitting', { index: err?.index ?? null, stuck: true, fit: true });
    const canaryPresent = (await session.within(5000, page.locator(cap.canary).count(), 'looking for the page canary').catch(() => 0)) > 0;
    const verdict = err instanceof Error ? triage({ error: err, contractCheck: null, records: [], canaryPresent, pageText: await pageText() }) : { kind: 'structural' };
    const html = await pageHtml();
    return {
      fits: false,
      why,
      changes,
      blocked: verdict.kind === 'blocked',
      unsure: verdict.kind === 'transient',
      verdict: verdict.why ?? null,
      stuckOn: { url: page.url(), html: compactHtml(html, 8000), committed: false, afterCommitUrl: null },
    };
  };

  try {
    // 1. the first page, compared with the one the steps were saved against, and every selector they need there
    const entry = steps[0]?.kind === 'navigate' ? new URL(steps[0].url, cap.targetUrl).toString() : cap.targetUrl;
    try {
      await page.goto(entry, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (err) {
      return await stop(`the first page did not load: ${err.message.split('\n')[0]}`, new StepError(err.message, { index: 0, reason: 'navigation', url: entry, docStatus: session.docStatus() }));
    }
    await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
    const now = pageShape(await pageHtml());
    changes = diffShapes(cap.snapshot?.shape, now.shape);
    for (const c of changes) log('diff', c);

    const wanted = firstPageSelectors(steps);
    const gone = [];
    for (const w of wanted) {
      const scope = w.frame ? page.frameLocator(w.frame) : page;
      // pages built in JavaScript can add their form a moment after loading
      const there = await session
        .within(6000, scope.locator(w.selector).first().waitFor({ state: 'attached', timeout: 5000 }), 'looking for a saved selector')
        .then(() => true)
        .catch(() => false);
      if (!there) gone.push(w);
    }
    log('fit', gone.length ? `${gone.length} of ${wanted.length} saved selectors for the first page are gone: ${gone.map((g) => g.selector).join(', ')}` : `all ${wanted.length} saved selectors for the first page are still on it`, {
      stage: 'selectors',
      total: wanted.length,
      gone: gone.map((g) => g.selector),
    });
    if (gone.length) {
      const why = `the saved steps look for ${gone.map((g) => g.selector).join(', ')}, which the live page no longer has`;
      return await stop(why, new StepError(why, { index: gone[0].index, reason: 'selector-missing', url: page.url(), docStatus: session.docStatus() }));
    }

    // 2. every step up to the booking button, which is not pressed (a plan that books nothing runs in full)
    let result;
    try {
      result = await session.within(
        120_000,
        runPlan(cap.plan, inputs, session, { baseUrl: cap.targetUrl, rehearse: write, onStep: (i, s) => log('step', `${i + 1}. ${s.kind} ${s.selector ?? s.url ?? ''}`.trim(), { index: i, step: s, fit: true }) }),
        'rehearsing the saved steps',
      );
    } catch (err) {
      if (err instanceof OverBudget) throw err;
      return await stop(`the saved steps got stuck when rehearsed: ${err.message.split('\n')[0]}`, err);
    }

    if (!write) {
      const check = checkContract(cap.contract, result.records, inputs);
      log('validate', check.pass ? 'ran the saved steps and the result passed the check' : `ran the saved steps, but the check failed: ${check.problems.join('; ')}`, { records: result.records, problems: check.problems, fit: true });
      if (!check.pass) return await stop(`the saved steps ran, but the result broke the check: ${check.problems.join('; ')}`);
    } else {
      const missing = result.sent?.missing ?? Object.keys(inputs);
      log('rehearse', missing.length ? `rehearsed the saved steps up to the booking step, but the page did not hold: ${missing.join(', ')}` : `rehearsed the saved steps up to the booking step without booking: the page held every detail (${result.sent.found.join(', ')})`, {
        sent: result.sent,
        commitIndex: result.commitIndex,
        fit: true,
      });
      await snap('page right before the booking button, which was not pressed', { index: result.commitIndex, fit: true });
      if (missing.length) return await stop(`rehearsed up to the booking button, but the page did not hold ${missing.join(', ')}`);
      // a captcha next to the booking button passes every check above and still stops every real booking
      const words = (await pageText()).match(BLOCK_WORDS)?.[0];
      if (words) return await stop(`the page with the booking button asks "${words}"`, new StepError(`the booking page asks "${words}"`, { index: result.commitIndex, reason: 'blocked', url: page.url(), docStatus: session.docStatus() }));

      // 3. the steps after the booking button, on a booking that already exists
      const last = await db.run.findFirst({ where: { capabilityId: cap.id, status: 'succeeded' }, orderBy: { createdAt: 'desc' }, select: { inputs: true, result: true } });
      const url = last?.result?.afterCommitUrl ?? cap.contract.goldenSample?.afterCommitUrl;
      const opened = url ? await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null) : null;
      if (!url || !opened || opened.status() >= 400) {
        log('fit', url ? 'the last good booking is gone from the website, so the steps after the booking button are not checked this time' : 'there is no earlier booking to read back, so the steps after the booking button are not checked this time', { stage: 'after', skipped: true });
      } else {
        let after;
        try {
          after = await session.within(120_000, runPlan(cap.plan, last?.inputs ?? cap.contract.goldenSample.inputs, session, { baseUrl: cap.targetUrl, startAt: result.commitIndex + 1, startUrl: url }), 'reading the last good booking');
        } catch (err) {
          if (err instanceof OverBudget) throw err;
          return await stop(`the saved steps after booking got stuck on the last good booking: ${err.message.split('\n')[0]}`, err);
        }
        const check = checkContract(cap.contract, after.records, last?.inputs ?? cap.contract.goldenSample.inputs);
        log('validate', check.pass ? 'read the last good booking with the saved steps, and it passed the check' : `read the last good booking with the saved steps, but the check failed: ${check.problems.join('; ')}`, {
          records: after.records,
          problems: check.problems,
          existing: 'the last good booking',
          fit: true,
        });
        if (!check.pass) return await stop(`reading the last good booking with the saved steps broke the check: ${check.problems.join('; ')}`);
      }
      log('fit', 'what the booking button itself leads to can only be seen by pressing it, so that part is left to the next real booking', { stage: 'limit' });
    }

    // it fits: the page as it is now is what the saved steps belong to, so the next change is measured from here
    await db.$transaction([
      db.pageSnapshot.upsert({ where: { hash: now.hash }, create: { hash: now.hash, url: cap.targetUrl, shape: now.shape }, update: {} }),
      db.plan.update({ where: { id: cap.plan.id }, data: { derivedFrom: now.hash } }),
    ]);
    return { fits: true, changes };
  } finally {
    const ms = await session.close();
    log('browser', `closed session after ${(ms / 1000).toFixed(1)}s`, { ms });
  }
}
