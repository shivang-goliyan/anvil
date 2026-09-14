import { parse } from 'node-html-parser';
import { runReadPlan } from './read-plan.mjs';
import { scrapeFetcher } from './read-engines.mjs';
import { checkContract } from './contract.mjs';
import { pageShape, diffShapes, compactHtml } from './page-shape.mjs';
import { deriveReadPlan } from './derive.mjs';
import { dryRun } from './derive-read.mjs';
import { OverBudget } from './errors.mjs';
import { db } from './db.mjs';
import { setStatus, promotePlan } from './capabilities.mjs';

const MAX_ATTEMPTS = 3;
const CHECK_FIRST = new Set(['monitor', 'manual', 'check']);

const count = (root, selector) => {
  try {
    return root.querySelectorAll(selector).length;
  } catch {
    return null;
  }
};

// What the saved selectors find on the page as it is now, in words the model and a person can both use.
export function selectorReport(steps, html) {
  const root = parse(html);
  const out = [];
  for (const s of steps) {
    if (s.kind === 'assert' && count(root, s.selector) === 0) out.push(`the saved check "${s.selector}" matches nothing on the live page`);
    if (s.kind === 'extract' && s.each) {
      const n = count(root, s.each);
      if (n !== null) out.push(`"${s.each}", one element per record, matches ${n} element${n === 1 ? '' : 's'} on the live page`);
    }
  }
  return out;
}

// Replace a read plan that stopped working: read the page fresh, derive against it, dry-run the candidate on that
// same page and hold the records to the contract. Reading has no side effects, so there is nothing to rehearse.
export async function repairRead(cap, rec, { failure }, log, finish) {
  const previous = cap.plan;
  const statusBefore = cap.status === 'repairing' ? 'healthy' : cap.status;
  const render = previous.steps.some((s) => s.kind === 'navigate' && s.render);
  const fetchPage = scrapeFetcher(log, { render });
  try {
    if (CHECK_FIRST.has(rec.trigger)) {
      log('fit', `checking whether the saved steps (v${previous.version}) still read the page, before asking any model for new ones`, { stage: 'start', read: true });
      let fit;
      try {
        const out = await runReadPlan(previous, { baseUrl: cap.targetUrl, fetchPage });
        const check = checkContract(cap.contract, out.records, {});
        log('validate', check.pass ? `read ${out.records.length} records with the saved steps, and they passed the check` : `read the page with the saved steps, but the check failed: ${check.problems.join('; ')}`, {
          records: out.records.slice(0, 8),
          count: out.records.length,
          problems: check.problems,
          fit: true,
          read: true,
        });
        fit = check.pass ? { fits: true, html: out.entryHtml } : { why: `the result broke the check: ${check.problems.join('; ')}` };
      } catch (err) {
        if (err instanceof OverBudget) throw err;
        fit = { why: err.message };
      }
      if (fit.fits) {
        const now = pageShape(fit.html ?? '');
        await db.$transaction([
          db.pageSnapshot.upsert({ where: { hash: now.hash }, create: { hash: now.hash, url: cap.targetUrl, shape: now.shape }, update: {} }),
          db.plan.update({ where: { id: previous.id }, data: { derivedFrom: now.hash } }),
        ]);
        if (cap.status === 'degraded') await setStatus(cap.id, 'healthy');
        log('fit', 'the saved steps still read the page correctly, so there is nothing to fix. No model was asked', { verdict: 'fits', recovered: cap.status === 'degraded' });
        return finish('not-needed', { diagnosis: 'saved steps still read the page' });
      }
      log('fit', `the saved steps no longer read the page: ${fit.why}`, { verdict: 'stale', why: fit.why });
      failure = [failure, `Reading the page with the saved steps showed that ${fit.why}.`].filter(Boolean).join(' ');
    }

    await setStatus(cap.id, 'repairing');
    log('repair', `repair started (${rec.trigger}), setting plan v${previous.version} aside`, { fromPlanId: previous.id, failure: failure ?? null, read: true });
    log('health', 'capability marked repairing', { status: 'repairing' });

    const page = await fetchPage(cap.targetUrl);
    const now = pageShape(page.html);
    log('read', `re-read the live page via url scraper${page.cached ? ' (cached)' : ''}`, { before: cap.snapshot?.hash ?? null, after: now.hash, read: true });
    const changes = [...diffShapes(cap.snapshot?.shape, now.shape).filter((c) => !/no structural change/.test(c)), ...selectorReport(previous.steps, page.html)];
    for (const c of changes) log('diff', c);

    const html = compactHtml(page.html);
    // every field the old steps read, including ones the contract could not require (not on every record)
    const planFields = Object.fromEntries(previous.steps.filter((s) => s.kind === 'extract').flatMap((s) => Object.entries(s.fields ?? {}).map(([k, f]) => [k, f.type ?? 'string'])));
    const want = { ...planFields, ...cap.contract.fieldTypes };
    const rejections = [];
    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
      log('attempt', `attempt ${n} of ${MAX_ATTEMPTS}`, { attempt: n });
      const feedback = [
        'THIS IS A REPAIR: the page changed and the plan below stopped working. Write a plan for the page as it is now.',
        `PREVIOUS PLAN: ${JSON.stringify(previous.steps)}`,
        failure && `HOW IT FAILED: ${failure}`,
        `WHAT IS DIFFERENT: ${changes.join('; ')}`,
        `Keep exactly these output fields, with these types: ${JSON.stringify(want)}`,
        rejections.length && `EARLIER ATTEMPTS THAT FAILED, DO NOT REPEAT THEM: ${rejections.join(' | ')}`,
      ]
        .filter(Boolean)
        .join('\n');
      const d = await deriveReadPlan({ goal: cap.goal, url: cap.targetUrl, markdown: (page.markdown ?? '').slice(0, 5000), html, feedback });
      for (const s of d.skipped) log('derive', `skipped model ${s}`);
      log('derive', `new plan from ${d.model} in ${(d.ms / 1000).toFixed(1)}s`, { model: d.model, ms: d.ms, promptChars: d.promptChars });
      d.plan.steps = Array.isArray(d.plan.steps) ? d.plan.steps : [];
      const nav = d.plan.steps.find((s) => s.kind === 'navigate');
      if (nav) Object.assign(nav, { url: cap.targetUrl }, render && { render: true });

      const dry = dryRun(d, page, cap.targetUrl);
      const missing = Object.keys(want).filter((k) => !(k in (d.fields ?? {})));
      if (missing.length) dry.problems.push(`the output fields have to stay ${Object.keys(want).join(', ')}, and ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing`);
      if (dry.problems.length) {
        rejections.push(`attempt ${n}: ${dry.problems.join('; ')}`);
        log('reject', `The plan did not work on the page: ${dry.problems.join('; ')}`, { problems: dry.problems, steps: d.plan.steps });
        continue;
      }
      log('plan', `candidate plan has ${d.plan.steps.length} steps`, { steps: d.plan.steps, read: true });
      const check = checkContract(cap.contract, dry.records, {});
      log('validate', check.pass ? `the new steps read ${dry.records.length} records from the live page, and they passed the check` : `the new steps read the page, but the check failed: ${check.problems.join('; ')}`, {
        records: dry.records.slice(0, 8),
        count: dry.records.length,
        problems: check.problems,
        read: true,
      });
      if (!check.pass) {
        rejections.push(`attempt ${n} read ${dry.records.length} records but broke the contract: ${check.problems.join('; ')}. First records: ${JSON.stringify(dry.records.slice(0, 2))}`);
        continue;
      }
      const plan = await promotePlan(cap, { steps: d.plan.steps, origin: `repair (${d.model})`, snapshot: now });
      if (d.canary && d.canary !== cap.canary) await db.capability.update({ where: { id: cap.id }, data: { canary: d.canary } });
      log('promote', `plan v${plan.version} promoted, capability healthy`, { planId: plan.id, version: plan.version });
      return finish('repaired', { toPlanId: plan.id, diagnosis: changes.join('; ') });
    }

    await setStatus(cap.id, 'degraded');
    log('rollback', `all ${MAX_ATTEMPTS} attempts failed, kept plan v${previous.version}, capability degraded`, { planId: previous.id, status: 'degraded' });
    return finish('degraded', { diagnosis: [...changes, ...rejections].join('; ') });
  } catch (err) {
    if (!(err instanceof OverBudget || err.quota)) throw err;
    await setStatus(cap.id, statusBefore);
    log('budget', `${err.message}. Stopping the repair and leaving plan v${previous.version} in place`, { used: err.used ?? null, cap: err.cap ?? null, modelQuota: !!err.quota });
    return finish('capped', { diagnosis: err.message });
  }
}
