const KINDS = new Set(['navigate', 'fill', 'click', 'submit', 'assert', 'extract']);
const STEP_TIMEOUT = 6000;

export class StepError extends Error {
  constructor(message, { index, step, reason, url, docStatus }) {
    super(message);
    Object.assign(this, { index, step, reason, url, docStatus });
  }
}

// Returns a list of problems. Empty list means the plan is runnable.
export function checkPlanShape(plan, { outputFields = [], inputKeys = [] } = {}) {
  const problems = [];
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return ['plan has no steps'];
  plan.steps.forEach((s, i) => {
    if (!KINDS.has(s?.kind)) problems.push(`step ${i + 1} has unknown kind "${s?.kind}"`);
    if (s?.kind === 'navigate' && typeof s.url !== 'string') problems.push(`step ${i + 1} navigate needs a url`);
    if (['fill', 'click', 'submit', 'assert'].includes(s?.kind) && !s.selector) problems.push(`step ${i + 1} ${s.kind} needs a selector`);
    if (s?.kind === 'fill') {
      for (const ref of String(s.value ?? '').matchAll(/\{\{\s*(\w+)\s*\}\}/g))
        if (!inputKeys.includes(ref[1])) problems.push(`step ${i + 1} uses unknown input "${ref[1]}"`);
    }
  });
  if (plan.steps[0]?.kind !== 'navigate') problems.push('first step must be navigate');
  const extract = plan.steps.find((s) => s.kind === 'extract');
  if (!extract) problems.push('plan never extracts anything');
  else for (const f of outputFields) if (!extract.fields?.[f]) problems.push(`extract step does not produce "${f}"`);
  return problems;
}

const fillIn = (value, inputs) => String(value ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(inputs[k] ?? ''));

function coerce(raw, type) {
  const v = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (type === 'number') {
    const n = Number(v.replace(/[^0-9.\-]/g, ''));
    return v === '' || Number.isNaN(n) ? null : n;
  }
  return v === '' ? null : v;
}

export async function runPlan(plan, inputs, session, { baseUrl, onStep = () => {}, beforePress = async () => {}, afterStep = async () => {} } = {}) {
  const { page } = session;
  const records = [];
  let entryHtml = null;

  for (const [index, step] of plan.steps.entries()) {
    const fail = (reason, err) =>
      new StepError(`step ${index + 1} (${step.kind}${step.selector ? ` ${step.selector}` : ''}) failed: ${err?.message?.split('\n')[0] ?? reason}`, {
        index,
        step,
        reason,
        url: page.url(),
        docStatus: session.docStatus(),
      });

    onStep(index, step);
    // the moments worth a picture: a filled-in page just before it is sent, and the page a result is read from
    if (['click', 'submit', 'extract'].includes(step.kind)) await beforePress(index, step);
    try {
      if (step.kind === 'navigate') {
        const url = new URL(step.url, baseUrl).toString();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        if (entryHtml === null) entryHtml = await page.content();
        await afterStep(index, step);
      } else if (step.kind === 'fill') {
        await page.fill(step.selector, fillIn(step.value, inputs), { timeout: STEP_TIMEOUT });
        await afterStep(index, step);
      } else if (step.kind === 'click') {
        await page.click(step.selector, { timeout: STEP_TIMEOUT });
      } else if (step.kind === 'submit') {
        await Promise.all([page.waitForEvent('framenavigated', { timeout: 20_000 }), page.click(step.selector, { timeout: STEP_TIMEOUT })]);
        await page.waitForLoadState('domcontentloaded');
      } else if (step.kind === 'assert') {
        await page.waitForSelector(step.selector, { state: 'visible', timeout: STEP_TIMEOUT });
      } else if (step.kind === 'extract') {
        const record = {};
        for (const [field, spec] of Object.entries(step.fields ?? {})) {
          const el = page.locator(spec.selector).first();
          const raw = (await el.count()) ? (spec.attr ? await el.getAttribute(spec.attr) : await el.innerText()) : null;
          record[field] = coerce(raw, spec.type);
        }
        records.push(record);
      }
    } catch (err) {
      if (err instanceof StepError) throw err;
      const missing = /waiting for (locator|selector)|Timeout .* exceeded/i.test(err.message) && step.kind !== 'navigate';
      throw fail(missing ? 'selector-missing' : step.kind === 'navigate' ? 'navigation' : 'error', err);
    }
  }
  return { records, entryHtml, finalHtml: await page.content().catch(() => null) };
}
