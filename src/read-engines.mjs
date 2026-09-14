// The two ways a read capability gets its data: scraping the page, or a prebuilt Wire action.

import { scrape, wireTask } from './anakin.mjs';
import { mayFetch, NotAllowed } from './conduct.mjs';
import { sandboxOfHost } from './tenants.mjs';

// Page fetcher for runReadPlan. Runs want today's page, so the scraper's 24h cache is skipped
// with a throwaway query param, unless robots.txt objects to query strings. `render` asks Anakin to
// run the page's JavaScript first: plans are derived from a browser-rendered page (the screenshot
// format turns the browser on), so runs have to see the same page or JS-built content is missing.
export function scrapeFetcher(log, { fresh = true, render = false } = {}) {
  return async (url) => {
    if (new URL(url).hostname.endsWith('.anvil.test')) {
      const { pathname, search } = new URL(url);
      const sandbox = sandboxOfHost(new URL(url).hostname);
      const res = await fetch(`${process.env.TARGET_FORWARD || 'http://localhost:4310'}${pathname}${search}`, { headers: sandbox ? { 'x-anvil-tenant': sandbox } : {}, signal: AbortSignal.timeout(15_000) });
      const html = await res.text();
      log?.('anakin', 'read the demo site directly (local bench, no credits)', { call: 'scrape', credits: 0, url });
      return { html, url, markdown: html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), cached: false };
    }
    let target = url;
    if (fresh) {
      const busted = new URL(url);
      busted.searchParams.set('_anvil', Date.now().toString(36));
      try {
        await mayFetch(busted.toString());
        target = busted.toString();
      } catch (err) {
        if (!(err instanceof NotAllowed)) throw err;
        log?.('conduct', 'robots.txt does not want query strings here, so this read may come from the 24h cache');
      }
    }
    const job = await scrape(target, { log, useBrowser: render });
    return { html: job.html ?? '', url, markdown: job.markdown ?? '', cached: !!job.cached };
  };
}

const scalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const ENVELOPE = new Set(['status', 'error', 'ok', 'success', 'message', 'code']);

// The biggest list of objects anywhere in the result, a few levels down at most.
function biggestList(value, path = '', depth = 0) {
  if (depth > 4 || !value || typeof value !== 'object') return null;
  let best = Array.isArray(value) && value.some((x) => x && typeof x === 'object' && !Array.isArray(x)) ? { path, list: value } : null;
  const entries = Array.isArray(value) ? [] : Object.entries(value);
  for (const [k, v] of entries) {
    const found = biggestList(v, path ? `${path}.${k}` : k, depth + 1);
    if (found && (!best || found.list.length > best.list.length)) best = found;
  }
  return best;
}

// Wire results come wrapped ({status, data: {..., stories: [...]}, meta}) and shaped per action.
// Records are the biggest list of objects in there, plain values only, so a contract can type-check them.
export function wireRecords(data, path) {
  let value = data;
  let used = path ?? null;
  if (used) for (const k of used.split('.')) value = value?.[k];
  else {
    const found = biggestList(data);
    if (found) [used, value] = [found.path, found.list];
    else if (data?.data && typeof data.data === 'object') [used, value] = ['data', data.data];
  }
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  const records = rows.slice(0, 50).map((r) => (r && typeof r === 'object' ? Object.fromEntries(Object.entries(r).filter(([, v]) => scalar(v))) : { value: r }));
  return { records, path: used };
}

// {status: "ok", error: null} is a reply, not data.
export const hasRealFields = (records) => records.length > 0 && Object.keys(records[0]).filter((k) => !ENVELOPE.has(k)).length >= 2;

export async function runWireStep(step, { log, siteUrl }) {
  const job = await wireTask(step.actionId, step.params ?? {}, { credits: step.credits ?? 1, siteUrl, log });
  const { records, path } = wireRecords(job.data, step.recordsPath);
  return { records, path, ms: job.execution_ms ?? null, creditsUsed: job.credits_used ?? null };
}
