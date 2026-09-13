import { chromium } from 'playwright-core';
import { checkBudget, recordSpend, creditsUsed, hourlyCap } from './budget.mjs';
import { AnakinError } from './errors.mjs';

export { AnakinError };

const API = 'https://api.anakin.io/v1';
const BROWSER_WS = 'wss://api.anakin.io/v1/browser-connect';

function key() {
  const k = process.env.ANAKIN_API_KEY?.trim();
  if (!k) throw new Error('ANAKIN_API_KEY is missing');
  return k;
}

async function request(method, path, body, timeoutMs = 120_000) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: { 'X-API-Key': key(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new AnakinError(`could not reach Anakin: ${err.message}`, { code: 'network' });
  }
  const json = await res.json().catch(() => ({}));
  if (res.status >= 400) throw new AnakinError(json.message ?? json.error ?? `Anakin said ${res.status}`, { status: res.status, code: json.error });
  return { status: res.status, json };
}

// Inline scrape, falling back to polling when the 90s inline window runs out (202).
export async function scrape(url, { log } = {}) {
  const { used, cap } = await checkBudget(1);
  let { status, json } = await request('POST', '/url-scraper/scrape', { url });
  for (let i = 0; status === 202 || json.status === 'pending' || json.status === 'processing'; i++) {
    if (i > 60) throw new AnakinError(`scrape of ${url} never finished`, { code: 'timeout' });
    await new Promise((r) => setTimeout(r, 2000));
    ({ status, json } = await request('GET', `/url-scraper/${json.id}`));
  }
  if (json.status === 'failed') throw new AnakinError(json.error ?? 'scrape failed', { code: 'job_failed' });
  // cached answers are free
  const cost = json.cached ? 0 : 1;
  await recordSpend('scrape', cost, url);
  log?.('anakin', `url scraper, ${cost} credit${cost === 1 ? '' : 's'} (${used + cost}/${cap} this hour)`, { call: 'scrape', credits: cost, cached: !!json.cached });
  return json;
}

// Anakin sometimes has no warm browser ready (ws close 1013) or hiccups with a 503. Worth a retry.
async function connect(log) {
  for (let n = 1; ; n++) {
    await checkBudget(1);
    try {
      return await chromium.connectOverCDP(BROWSER_WS, { headers: { 'X-API-Key': key() }, timeout: 60_000 });
    } catch (err) {
      const reason = err.message.match(/reason=([^\n\x1b]+)/)?.[1] ?? err.message.split('\n')[0];
      // "session ended" shows up now and then right at connect; seen 2026-09-13, a later reconnect works
      const busy = /no warm task|session ended|code=1013|503|ECONNRESET|socket hang up/i.test(err.message);
      if (/401|403|invalid_api_key/.test(err.message)) throw new AnakinError(`browser connect refused: ${reason}`, { status: 401, code: 'auth' });
      if (/402|insufficient credits/i.test(err.message)) throw new AnakinError('out of Anakin credits', { status: 402, code: 'credits' });
      if (!busy || n === 4) throw new AnakinError(`could not get a remote browser after ${n} tries: ${reason}`, { code: 'browser_unavailable' });
      log?.('browser', `no browser yet (${reason}), trying again in ${2 * n}s`);
      await new Promise((r) => setTimeout(r, 2000 * n));
    }
  }
}

// A remote browser session. When `forward` is set, requests to `origin` are answered by
// fetching the same path from a local server, over the CDP connection we already hold.
// That lets the cloud browser drive a site that is not on the public internet yet.
export async function openBrowser({ origin, forward, log } = {}) {
  const browser = await connect(log);
  await recordSpend('browser', 1, 'session opened');
  log?.('anakin', `browser session opened, 1 credit (${await creditsUsed()}/${hourlyCap()} this hour)`, { call: 'browser', credits: 1 });
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  if (forward && origin) {
    await context.route(`${origin}/**`, async (route) => {
      const req = route.request();
      const path = req.url().slice(origin.length) || '/';
      let res;
      try {
        res = await fetch(`${forward}${path}`, {
          method: req.method(),
          headers: { 'content-type': req.headers()['content-type'] ?? 'text/plain' },
          body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postData() ?? '',
          redirect: 'manual',
        });
      } catch {
        return route.abort('connectionrefused');
      }
      const headers = Object.fromEntries(res.headers);
      if (headers.location?.startsWith('/')) headers.location = `${origin}${headers.location}`;
      await route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
    });
  }

  let lastDocStatus = null;
  page.on('response', (r) => {
    if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) lastDocStatus = r.status();
  });

  const started = Date.now();
  return {
    browser,
    page,
    docStatus: () => lastDocStatus,
    async close() {
      await browser.close().catch(() => {});
      const ms = Date.now() - started;
      // billed per started 2 minutes, the first one was recorded on connect
      const extra = Math.ceil(ms / 120_000) - 1;
      if (extra > 0) {
        await recordSpend('browser', extra, `session ran ${Math.round(ms / 1000)}s`);
        log?.('anakin', `session ran past 2 minutes, ${extra} more credit${extra === 1 ? '' : 's'}`, { call: 'browser', credits: extra });
      }
      return ms;
    },
  };
}

// Keeps a session from hitting the ~2 min idle disconnect while we wait on something slow.
export function keepAlive(page, everyMs = 30_000) {
  const t = setInterval(() => page.evaluate(() => 0).catch(() => {}), everyMs);
  return () => clearInterval(t);
}
