const KINDS = new Set(['navigate', 'fill', 'select', 'check', 'click', 'submit', 'assert', 'extract']);
const STEP_TIMEOUT = 6000;

export class StepError extends Error {
  constructor(message, { index, step, reason, url, docStatus, committed = false, afterCommitUrl = null }) {
    super(message);
    // committed: the booking step already ran, so doing it again would book twice
    Object.assign(this, { index, step, reason, url, docStatus, committed, afterCommitUrl });
  }
}

// Returns a list of problems. Empty list means the plan is runnable.
export function checkPlanShape(plan, { outputFields = [], inputKeys = [], write = false } = {}) {
  const problems = [];
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return ['plan has no steps'];
  const extractedSoFar = new Set();
  plan.steps.forEach((s, i) => {
    for (const ref of JSON.stringify(s ?? {}).matchAll(/\{\{\s*out\.(\w+)\s*\}\}/g))
      if (!extractedSoFar.has(ref[1])) problems.push(`step ${i + 1} uses {{out.${ref[1]}}} before any step extracts it`);
    if (s?.kind === 'extract') for (const f of Object.keys(s.fields ?? {})) extractedSoFar.add(f);
    if (!KINDS.has(s?.kind)) problems.push(`step ${i + 1} has unknown kind "${s?.kind}"`);
    if (s?.kind === 'navigate' && typeof s.url !== 'string') problems.push(`step ${i + 1} navigate needs a url`);
    if (['fill', 'select', 'check', 'click', 'submit', 'assert'].includes(s?.kind) && !s.selector) problems.push(`step ${i + 1} ${s.kind} needs a selector`);
    if (s?.frame !== undefined && typeof s.frame !== 'string') problems.push(`step ${i + 1} frame must be a css selector`);
    if (s?.kind === 'fill' || s?.kind === 'select') {
      for (const ref of String(s.value ?? '').matchAll(/\{\{\s*(\w+)\s*\}\}/g))
        if (!inputKeys.includes(ref[1])) problems.push(`step ${i + 1} uses unknown input "${ref[1]}"`);
    }
  });
  if (plan.steps[0]?.kind !== 'navigate') problems.push('first step must be navigate');
  const extracts = plan.steps.filter((s) => s.kind === 'extract');
  if (!extracts.length) problems.push('plan never extracts anything');
  else for (const f of outputFields) if (!extracts.some((e) => e.fields?.[f])) problems.push(`no extract step produces "${f}"`);
  if (write) {
    const commits = plan.steps.map((s, i) => (s.commit ? i : -1)).filter((i) => i >= 0);
    if (commits.length !== 1) problems.push(`a plan that books must mark exactly one step with "commit": true (found ${commits.length})`);
    else if (!['submit', 'click'].includes(plan.steps[commits[0]].kind)) problems.push('the commit step must be the submit or click that makes the booking');
    else if (!plan.steps.slice(commits[0]).some((s) => s.kind === 'extract')) problems.push('nothing is read after the commit step');
    else {
      // the booking step lands on the confirmation, which is read before anything else is pressed; a press in
      // between means the marked step only reached a review or confirm page and the real booking happens later
      const next = plan.steps.slice(commits[0] + 1);
      const between = next.slice(0, next.findIndex((s) => s.kind === 'extract')).filter((s) => s.kind !== 'assert');
      if (between.length) problems.push(`step ${commits[0] + 1} is marked commit, but step ${plan.steps.indexOf(between[0]) + 1} (${between[0].kind}) still acts on the page before the confirmation is read. Mark the button that actually makes the booking, such as the one on a review or confirm page`);
    }
  }
  return problems;
}

// the browser's own error page is never the website; no step may read it or act on it
async function makeSureItLoaded(page, session) {
  if (!page.url().startsWith('chrome-error://')) return;
  if (session.recover && (await session.recover())) return;
  throw Object.assign(new Error('the page did not load at all (the browser showed its own error page)'), { navigation: true });
}

const fillIn = (value, inputs, out = {}) =>
  String(value ?? '')
    .replace(/\{\{\s*out\.(\w+)\s*\}\}/g, (_, k) => String(out[k] ?? ''))
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(inputs[k] ?? ''));

// What is about to be sent: every form control's value in every frame, plus the visible text for review
// pages. Each input counts as found if a control holds exactly it, or failing that the page text shows it.
export async function readBack(page, inputs) {
  const controls = [];
  let text = '';
  for (const frame of page.frames()) {
    const part = await frame
      .evaluate(() => {
        const values = [];
        for (const el of document.querySelectorAll('input, textarea, select')) {
          if (el.type === 'hidden' || el.type === 'password') continue;
          if (el.tagName === 'SELECT') {
            const o = el.selectedOptions[0];
            if (o) values.push(o.value, o.textContent);
          } else if (['checkbox', 'radio'].includes(el.type)) {
            if (el.checked) values.push(el.value);
          } else values.push(el.value);
        }
        return { values, text: document.body?.innerText ?? '' };
      })
      .catch(() => null);
    if (!part) continue;
    controls.push(...part.values.map((v) => String(v ?? '').trim().toLowerCase()));
    text += `\n${part.text.toLowerCase()}`;
  }
  const found = [];
  const missing = [];
  for (const [k, v] of Object.entries(inputs)) {
    const want = String(v).trim().toLowerCase();
    (controls.includes(want) || text.includes(want) ? found : missing).push(k);
  }
  return { found, missing };
}

function coerce(raw, type) {
  const v = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (type === 'number') {
    const n = Number(v.replace(/[^0-9.\-]/g, ''));
    return v === '' || Number.isNaN(n) ? null : n;
  }
  return v === '' ? null : v;
}

// rehearse: stop right before the step marked commit and report what was about to be sent, without sending it.
// startAt + startUrl: pick up after a booking that already exists (a GET of its confirmation page) and run
// only the steps from there, which is how a repair tests new reading steps without booking again.
export async function runPlan(plan, inputs, session, { baseUrl, onStep = () => {}, beforePress = async () => {}, afterStep = async () => {}, rehearse = false, startAt = 0, startUrl = null } = {}) {
  const { page } = session;
  let committed = startAt > 0;
  let afterCommitUrl = startAt > 0 ? startUrl : null;
  if (startAt > 0) {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await makeSureItLoaded(page, session).catch(() => {});
  }
  const records = [];
  // plain extracts add to one record; lists come from read plans, not here
  const out = {};
  let entryHtml = null;
  let sent = null;
  // a form split over pages only shows each value on its own page, so every page counts as it is sent on
  const heldEarlier = new Set();

  for (const [index, step] of plan.steps.entries()) {
    if (index < startAt) continue;
    // a step can live inside an iframe; everything else about it stays the same
    const scope = step.frame ? page.frameLocator(step.frame) : page;
    const at = (selector) => scope.locator(selector).first();
    const fail = (reason, err) =>
      new StepError(`step ${index + 1} (${step.kind}${step.selector ? ` ${step.selector}` : ''}) failed: ${err?.message?.split('\n')[0] ?? reason}`, {
        index,
        step,
        reason,
        url: page.url(),
        docStatus: session.docStatus(),
        committed,
        afterCommitUrl,
      });

    if (step.commit) {
      sent = await readBack(page, inputs).catch(() => null);
      if (sent) sent = { found: Object.keys(inputs).filter((k) => heldEarlier.has(k) || sent.found.includes(k)), missing: sent.missing.filter((k) => !heldEarlier.has(k)) };
      if (rehearse) return { rehearsed: true, sent, commitIndex: index, records: [], entryHtml, finalHtml: null };
    }
    onStep(index, step);
    // the moments worth a picture: a filled-in page just before it is sent, and the page a result is read from
    if (['click', 'submit', 'extract'].includes(step.kind)) await beforePress(index, step);
    if (['click', 'submit'].includes(step.kind) && !committed && !step.commit) for (const k of (await readBack(page, inputs).catch(() => null))?.found ?? []) heldEarlier.add(k);
    try {
      if (step.kind === 'navigate') {
        const url = new URL(step.url, baseUrl).toString();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await makeSureItLoaded(page, session);
        if (entryHtml === null) entryHtml = await page.content();
        await afterStep(index, step);
      } else if (step.kind === 'fill') {
        await at(step.selector).fill(fillIn(step.value, inputs, out), { timeout: STEP_TIMEOUT });
        await afterStep(index, step);
      } else if (step.kind === 'select') {
        const wanted = fillIn(step.value, inputs, out);
        const box = at(step.selector);
        // options are matched by value first, then by the text people see
        await box.selectOption(wanted, { timeout: STEP_TIMEOUT }).catch(() => box.selectOption({ label: wanted }, { timeout: STEP_TIMEOUT }));
        await afterStep(index, step);
      } else if (step.kind === 'check') {
        await at(step.selector).check({ timeout: STEP_TIMEOUT });
      } else if (step.kind === 'click') {
        await at(step.selector).click({ timeout: STEP_TIMEOUT });
        if (step.waitFor) await at(step.waitFor).waitFor({ state: 'visible', timeout: 20_000 });
      } else if (step.kind === 'submit') {
        if (step.waitFor) {
          // pages built in JavaScript often update in place instead of loading a new page
          await at(step.selector).click({ timeout: STEP_TIMEOUT });
          await at(step.waitFor).waitFor({ state: 'visible', timeout: 20_000 });
        } else {
          const loaded = page.waitForEvent('framenavigated', { timeout: 20_000 });
          loaded.catch(() => {});
          await at(step.selector).click({ timeout: STEP_TIMEOUT });
          try {
            await loaded;
          } catch {
            throw new Error('pressed it, but no new page loaded; if this page updates in place, give the step a "waitFor" selector');
          }
          await page.waitForLoadState('domcontentloaded');
          await makeSureItLoaded(page, session);
        }
      } else if (step.kind === 'assert') {
        await makeSureItLoaded(page, session);
        await at(step.selector).waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      } else if (step.kind === 'extract') {
        await makeSureItLoaded(page, session);
        const record = {};
        for (const [field, spec] of Object.entries(step.fields ?? {})) {
          const el = at(spec.selector);
          const raw = (await el.count()) ? (spec.attr ? await el.getAttribute(spec.attr) : await el.innerText()) : null;
          record[field] = coerce(raw, spec.type);
        }
        Object.assign(out, record);
      }
      if (step.commit) {
        committed = true;
        afterCommitUrl = page.url();
      }
    } catch (err) {
      if (err instanceof StepError) throw err;
      if (step.commit) committed = true;
      if (err.navigation) throw fail('navigation', err);
      const missing = /waiting for (locator|selector)|Timeout .* exceeded|no new page loaded/i.test(err.message) && step.kind !== 'navigate';
      throw fail(missing ? 'selector-missing' : step.kind === 'navigate' ? 'navigation' : 'error', err);
    }
  }
  if (Object.keys(out).length) records.push(out);
  return { records, sent, committed, afterCommitUrl, entryHtml, finalHtml: await page.content().catch(() => null) };
}
