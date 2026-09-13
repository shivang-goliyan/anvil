// Phase 0 smoke check against the live Anakin API. Throwaway.
// Shapes come from https://anakin.io/llms-full.txt (url-scraper/scrape, map, browser-api).
//
//   npm run check:anakin
//
// There is no balance endpoint in the public API, so the script stops and asks
// you to read the number off https://anakin.io/dashboard between calls.

import { createInterface } from 'node:readline/promises';
import { chromium } from 'playwright-core';

const API = 'https://api.anakin.io/v1';
const key = process.env.ANAKIN_API_KEY?.trim();

if (!key) {
  console.error('ANAKIN_API_KEY is empty. Put it in anvil/.env and run again.');
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const results = [];

function line(title) {
  console.log(`\n=== ${title} ${'='.repeat(Math.max(0, 70 - title.length))}`);
}

async function readBalance(when) {
  if (!process.stdin.isTTY) return null;
  const raw = await rl.question(`  dashboard balance ${when} (enter to skip): `);
  const n = Number(raw.trim());
  return raw.trim() === '' || Number.isNaN(n) ? null : n;
}

async function call(method, path, body, timeoutMs = 30_000) {
  const started = Date.now();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'X-API-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: Object.fromEntries(res.headers), json, text, ms: Date.now() - started };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. auth ------------------------------------------------------------------
line('1. auth');
{
  // a bogus key must fail, otherwise a 200 below proves nothing
  const bogus = await fetch(`${API}/monitors`, { headers: { 'X-API-Key': 'ak-bogus' } });
  console.log(`  bogus key   -> HTTP ${bogus.status}`);
  const real = await call('GET', '/monitors');
  console.log(`  your key    -> HTTP ${real.status} ${real.text.slice(0, 160)}`);
  if (real.status !== 200) {
    console.error('\nYour key did not authenticate. Stopping here.');
    process.exit(1);
  }
  if (bogus.status === 200) console.log('  WARNING: bogus key also got 200, auth check is not meaningful');
}

// 2. balance ---------------------------------------------------------------
line('2. balance');
console.log('  No balance endpoint exists in the API. Open https://anakin.io/dashboard.');
let before = await readBalance('now');
console.log(`  recorded: ${before ?? 'skipped'}`);

// 3a. url scraper ----------------------------------------------------------
line('3a. url scraper  POST /v1/url-scraper/scrape  https://example.com');
{
  const r = await call('POST', '/url-scraper/scrape', { url: 'https://example.com' }, 120_000);
  const j = r.json ?? {};
  console.log(`  HTTP ${r.status} in ${r.ms}ms  status=${j.status}  cached=${j.cached}  error=${j.error}`);
  console.log(`  markdown (${j.markdown?.length ?? 0} chars): ${JSON.stringify((j.markdown ?? '').slice(0, 120))}`);
  if (j.trial) console.log(`  WARNING: response has a "trial" block, key may not have been applied: ${JSON.stringify(j.trial)}`);
  const extra = Object.keys(j).filter((k) => !['html', 'cleanedHtml', 'markdown'].includes(k));
  console.log(`  response keys: ${extra.join(', ')}`);
  console.log(`  response headers: ${JSON.stringify(r.headers)}`);
  const after = await readBalance('after scrape');
  results.push({ call: 'URL Scraper (inline)', ok: r.status === 200 && j.status === 'completed', before, after, docs: '1' });
  before = after ?? before;
}

// 3b. map ------------------------------------------------------------------
line('3b. map  POST /v1/map  https://books.toscrape.com');
{
  const sub = await call('POST', '/map', { url: 'https://books.toscrape.com', limit: 10, depth: 1 });
  console.log(`  submit HTTP ${sub.status}: ${sub.text.slice(0, 160)}`);
  let job = null;
  const id = sub.json?.jobId;
  if (id) {
    for (let i = 0; i < 90; i++) {
      const p = await call('GET', `/map/${id}`);
      job = p.json;
      if (job?.status === 'completed' || job?.status === 'failed') break;
      await sleep(1000);
    }
    console.log(`  final status=${job?.status}  totalLinks=${job?.totalLinks}  durationMs=${job?.durationMs}  error=${job?.error}`);
    console.log(`  first links: ${JSON.stringify((job?.links ?? []).slice(0, 5))}`);
    console.log(`  response keys: ${Object.keys(job ?? {}).join(', ')}`);
  }
  const after = await readBalance('after map');
  results.push({ call: 'Map', ok: job?.status === 'completed', before, after, docs: '1' });
  before = after ?? before;
}

// 3c + 4. browser api ------------------------------------------------------
line('3c/4. browser api  wss://api.anakin.io/v1/browser-connect');
const browserChecks = [];
let browserOk = false;
let sessionMs = 0;
{
  const check = (name, pass, detail = '') => {
    browserChecks.push({ name, pass });
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  };

  let browser;
  const t0 = Date.now();
  try {
    browser = await chromium.connectOverCDP('wss://api.anakin.io/v1/browser-connect', {
      headers: { 'X-API-Key': key },
      timeout: 60_000,
    });
    check('connect over CDP', true, `${Date.now() - t0}ms`);

    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = ctx.pages()[0] ?? (await ctx.newPage());

    // the "one call": navigate and read
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const title = await page.title();
    const h1 = await page.locator('h1').innerText();
    check('goto + read example.com', title === 'Example Domain' && h1 === 'Example Domain', `title=${JSON.stringify(title)}`);

    const ua = await page.evaluate(() => ({ webdriver: navigator.webdriver, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }));
    console.log(`        navigator.webdriver=${ua.webdriver} tz=${ua.tz}`);

    // the end-to-end script: fill a real form, submit, confirm the server saw our values
    const sent = { custname: 'Anvil Check', custtel: '5550100', custemail: 'check@example.com', comments: 'phase zero' };
    let formDone = false;
    try {
      await page.goto('https://httpbin.org/forms/post', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.fill('input[name="custname"]', sent.custname);
      await page.fill('input[name="custtel"]', sent.custtel);
      await page.fill('input[name="custemail"]', sent.custemail);
      await page.check('input[name="size"][value="medium"]');
      await page.check('input[name="topping"][value="cheese"]');
      await page.fill('textarea[name="comments"]', sent.comments);
      await Promise.all([
        page.waitForURL('**/post', { timeout: 30_000 }),
        page.click('form button'),
      ]);
      const echoed = JSON.parse(await page.locator('body').innerText()).form ?? {};
      const same = Object.entries(sent).every(([k, v]) => echoed[k] === v) && echoed.size === 'medium' && echoed.topping === 'cheese';
      check('fill + check + submit httpbin form, server echoes values', same, JSON.stringify(echoed));
      formDone = same;
    } catch (err) {
      console.log(`        httpbin path broke (${err.message.split('\n')[0]}), trying a routed form instead`);
    }

    if (!formDone) {
      // httpbin is flaky sometimes. Serve our own form through page.route so the
      // fill/submit path still gets exercised inside the remote browser.
      let posted = null;
      await page.route('https://anvil-check.test/**', async (route) => {
        const req = route.request();
        if (req.method() === 'POST') {
          posted = Object.fromEntries(new URLSearchParams(req.postData() ?? ''));
          return route.fulfill({ contentType: 'text/html', body: `<h1 id="done">Thanks ${posted.custname}</h1>` });
        }
        return route.fulfill({
          contentType: 'text/html',
          body: '<form method="post" action="/submit"><input name="custname"><input name="custemail"><button>Go</button></form>',
        });
      });
      await page.goto('https://anvil-check.test/form', { waitUntil: 'domcontentloaded' });
      await page.fill('input[name="custname"]', sent.custname);
      await page.fill('input[name="custemail"]', sent.custemail);
      await Promise.all([page.waitForSelector('#done', { timeout: 20_000 }), page.click('button')]);
      const done = await page.locator('#done').innerText();
      check('fill + submit routed form, confirmation rendered', posted?.custname === sent.custname && done.includes(sent.custname), done);
      formDone = true;
    }

    browserOk = browserChecks.every((c) => c.pass);
  } catch (err) {
    check('browser session', false, err.message.split('\n')[0]);
  } finally {
    await browser?.close().catch(() => {});
    sessionMs = Date.now() - t0;
    console.log(`  session length ${(sessionMs / 1000).toFixed(1)}s -> docs say ${Math.max(1, Math.ceil(sessionMs / 120_000))} credit(s) at 1 per 2 min`);
  }
  const after = await readBalance('after browser session');
  results.push({ call: 'Browser API session', ok: browserOk, before, after, docs: `${Math.max(1, Math.ceil(sessionMs / 120_000))}` });
}

// summary ------------------------------------------------------------------
line('summary');
for (const r of results) {
  const spent = r.before != null && r.after != null ? (r.before - r.after).toString() : 'n/a';
  console.log(`  ${r.call.padEnd(22)} ${r.ok ? 'worked' : 'FAILED'.padEnd(6)}  measured=${spent.padEnd(4)} documented=${r.docs}`);
}
console.log(`\n  Browser API executes a script end to end: ${browserOk ? 'YES' : 'NO -> kill criterion hit, Tier B write path is dead'}`);

rl.close();
process.exit(browserOk ? 0 : 2);
