// Runs read-only plans (navigate, assert, extract) against HTML from the URL Scraper instead of a
// live browser. Same plan format as the browser runner, plus `each` for lists.

import { parse } from 'node-html-parser';
import { StepError } from './plan.mjs';

const MAX_RECORDS = 50;

export function coerce(raw, type) {
  const v = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (type === 'number') {
    const n = Number(v.replace(/[^0-9.\-]/g, ''));
    return v === '' || Number.isNaN(n) ? null : n;
  }
  return v === '' ? null : v;
}

function pick(scope, spec, pageUrl) {
  const el = !spec.selector || spec.selector === ':scope' ? scope : scope.querySelector(spec.selector);
  if (!el) return null;
  let raw = spec.attr ? el.getAttribute(spec.attr) : el.text;
  if (raw && ['href', 'src'].includes(spec.attr)) {
    try {
      raw = new URL(raw, pageUrl).toString();
    } catch {}
  }
  return coerce(raw, spec.type);
}

// Pure: html in, records out. Throws on selectors css-select cannot parse.
export function extract(html, step, pageUrl) {
  const root = parse(html);
  const scopes = step.each ? root.querySelectorAll(step.each).slice(0, MAX_RECORDS) : [root];
  return scopes.map((scope) => Object.fromEntries(Object.entries(step.fields ?? {}).map(([name, spec]) => [name, pick(scope, spec, pageUrl)])));
}

export const hasSelector = (html, selector) => {
  try {
    return !!selector && !!parse(html).querySelector(selector);
  } catch {
    return false;
  }
};

// fetchPage(url) -> { html, url }. Returns records plus the page the extraction ran on.
export async function runReadPlan(plan, { baseUrl, fetchPage, onStep = () => {} }) {
  let page = null;
  let entryHtml = null;
  const records = [];
  for (const [index, step] of plan.steps.entries()) {
    const fail = (reason, message) => new StepError(`step ${index + 1} (${step.kind}${step.selector ? ` ${step.selector}` : ''}) failed: ${message}`, { index, step, reason, url: page?.url ?? null, docStatus: null });
    onStep(index, step);
    if (step.kind === 'navigate') {
      try {
        page = await fetchPage(new URL(step.url, baseUrl).toString());
      } catch (err) {
        err.index ??= index;
        throw err;
      }
      entryHtml ??= page.html;
    } else if (!page) {
      throw fail('error', 'nothing has been loaded yet');
    } else if (step.kind === 'assert') {
      if (!hasSelector(page.html, step.selector)) throw fail('selector-missing', `no element matches ${step.selector}`);
    } else if (step.kind === 'extract') {
      try {
        records.push(...extract(page.html, step, page.url));
      } catch (err) {
        throw fail('error', `bad selector: ${err.message}`);
      }
    } else {
      throw fail('error', `a read-only plan cannot ${step.kind}`);
    }
  }
  return { records, entryHtml, finalHtml: page?.html ?? null, url: page?.url ?? null };
}
