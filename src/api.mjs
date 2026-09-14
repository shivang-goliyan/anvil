// HTTP API. Never does the long work itself: it writes rows and the worker picks them up.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db } from './db.mjs';
import { cleanInputs, queueRun, queueRepair, Busy } from './jobs.mjs';
import { createReadCapability, seedCapability, removeCapability, queueLearn } from './capabilities.mjs';
import { onAllowlist, allowedSites, firstParty } from './conduct.mjs';
import { creditsUsed, hourlyCap } from './budget.mjs';
import { reserveRoom } from '../capabilities/reserve-room.mjs';
import { harborEvents } from '../capabilities/harbor-events.mjs';
import { SHOTS, SHOT_NAME, beforeAndAfter } from './shots.mjs';
import { askForCheck, checkLanded } from './monitor.mjs';
import { SHARED, DEMO_CAPS, validSandbox, newSandbox, capId, splitCapId, cookieValue } from './tenants.mjs';

const PORT = Number(process.env.PORT ?? 3310);
const HOST = process.env.HOST ?? '127.0.0.1';
const TARGET_ADMIN = process.env.TARGET_ADMIN_URL || process.env.TARGET_FORWARD || 'http://localhost:4310';
const WEB = new URL('../web/', import.meta.url);
const DEMO = new URL('../demo/recorded.json', import.meta.url);
const REDESIGNS = new URL('../demo/redesigns.json', import.meta.url);
// [requests, window] per IP. Breaking the demo site is the one people will want to spam.
const LIMITS = { read: [300, 60_000], write: [12, 60_000], break: [6, 10 * 60_000], check: [3, 10 * 60_000] };
// a check through Anakin costs credits whoever asks, so there is one at a time for everyone; a check inside a
// sandbox goes straight to the fit check, once a minute
const CHECK_GAP_MS = 3 * 60_000;
const SANDBOX_CHECK_GAP_MS = 60_000;
const checks = new Map();
const shownCheck = (sandbox) => checks.get(sandbox) && (({ polled, before, ...rest }) => rest)(checks.get(sandbox));

// Every visitor gets a private copy of the demo: its own demo site and its own capabilities. The page hands out
// the cookie; calls without one (scripts, the bench, Anakin's webhook) use the shared demo.
const COOKIE = 'anvil_sandbox';
const MAX_SANDBOXES = Number(process.env.MAX_SANDBOXES ?? 40);
const SANDBOX_IDLE_MS = Number(process.env.SANDBOX_IDLE_MINUTES ?? 60) * 60_000;
const lastSeen = new Map();
const seeded = new Set();

function sandboxFor(req, res, url) {
  const set = (value) => res.setHeader('set-cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${process.env.TRUST_PROXY ? '; Secure' : ''}`);
  const page = url.pathname === '/';
  if (page && url.searchParams.has('shared')) {
    set('shared');
    return { id: SHARED, own: false, chose: true };
  }
  const raw = page && url.searchParams.has('own') ? null : cookieValue(req.headers.cookie, COOKIE);
  if (raw === 'shared') return { id: SHARED, own: false, chose: true };
  const known = validSandbox(raw);
  if (known && (lastSeen.has(known) || lastSeen.size < MAX_SANDBOXES)) {
    lastSeen.set(known, Date.now());
    return { id: known, own: true };
  }
  if (!page || lastSeen.size >= MAX_SANDBOXES) return { id: SHARED, own: false, full: lastSeen.size >= MAX_SANDBOXES };
  const id = newSandbox();
  lastSeen.set(id, Date.now());
  set(id);
  return { id, own: true };
}

async function ensureSandbox(id) {
  if (!id || seeded.has(id)) return;
  await seedCapability(reserveRoom(id));
  await seedCapability(harborEvents(id));
  seeded.add(id);
}

// what a visitor may see: their own copy of the demo capabilities, and the read capabilities everyone shares
function visible(capabilityId, sandbox) {
  const { base, sandbox: owner } = splitCapId(capabilityId);
  return DEMO_CAPS.includes(base) ? owner === sandbox : !String(capabilityId).includes('~');
}
const ownId = (id, sandbox) => (String(id).includes('~') ? null : DEMO_CAPS.includes(id) ? capId(id, sandbox) : id);
const shownId = (id) => splitCapId(id).base;

// A sandbox nobody has touched for an hour goes, demo site copy, capabilities, runs and all.
async function sweepSandboxes() {
  const idle = Date.now() - SANDBOX_IDLE_MS;
  const caps = await db.capability.findMany({ where: { id: { contains: '~' } }, select: { id: true, createdAt: true } });
  const found = new Map();
  for (const c of caps) {
    const { sandbox } = splitCapId(c.id);
    if (sandbox) found.set(sandbox, [...(found.get(sandbox) ?? []), c]);
  }
  for (const id of lastSeen.keys()) if (!found.has(id)) found.set(id, []);
  for (const [id, own] of found) {
    const ids = own.map((c) => c.id);
    const lastRun = ids.length ? await db.run.findFirst({ where: { capabilityId: { in: ids } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }) : null;
    const lastUse = Math.max(lastSeen.get(id) ?? 0, lastRun?.createdAt.getTime() ?? 0, ...own.map((c) => c.createdAt.getTime()));
    if (lastUse > idle) continue;
    const active = await db.job.count({ where: { status: { in: ['queued', 'running'] }, refId: { in: [...(await db.run.findMany({ where: { capabilityId: { in: ids } }, select: { id: true } })), ...(await db.repairAttempt.findMany({ where: { capabilityId: { in: ids } }, select: { id: true } }))].map((r) => r.id) } } });
    if (active) continue;
    for (const cid of ids) await removeCapability(cid);
    await targetAdmin('/_admin/drop', {}, id).catch(() => {});
    lastSeen.delete(id);
    seeded.delete(id);
    console.log(`cleared sandbox ${id}, idle since ${new Date(lastUse).toISOString()}`);
  }
}
setInterval(() => sweepSandboxes().catch((err) => console.error('sandbox sweep failed:', err.message)), Number(process.env.SANDBOX_SWEEP_SECONDS ?? 300) * 1000).unref();

const hits = new Map();
function tooMany(ip, bucket) {
  // the local bench hammers one demo site from one address on purpose
  if (process.env.ANVIL_BENCH === '1') return false;
  const [max, windowMs] = LIMITS[bucket];
  const key = `${bucket} ${ip}`;
  const now = Date.now();
  let h = hits.get(key);
  if (!h || now - h.start >= windowMs) hits.set(key, (h = { start: now, n: 0 }));
  return ++h.n > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (now - h.start > LIMITS[k.split(' ')[0]][1]) hits.delete(k);
}, 60_000).unref();

async function targetAdmin(path, body, sandbox = SHARED) {
  const res = await fetch(new URL(path, TARGET_ADMIN), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-admin-token': process.env.TARGET_ADMIN_TOKEN ?? '', 'content-type': 'application/json', ...(sandbox && { 'x-anvil-tenant': sandbox }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res) throw Object.assign(new Error('the demo site is not answering right now'), { status: 502 });
  const json = await res.json();
  if (!res.ok) throw Object.assign(new Error(json.error ?? 'the demo site refused that'), { status: res.status });
  return json;
}

const OWNED = 'Harbor Lane Library is a demo site that belongs to this project. Anvil can only be shown breaking and repairing on a site we control, because you cannot break a site you do not own.';

async function budget() {
  const [used, cap] = [await creditsUsed(), hourlyCap()];
  return { used, cap, capped: used >= cap };
}

const cappedReply = (res, b) =>
  send(res, 503, { capped: true, error: `Anvil has used its Anakin budget for this hour (${b.used} of ${b.cap} credits), so nothing live can run right now`, demo: '/api/demo' });

async function busyTierB(sandbox = SHARED) {
  const id = reserveRoom(sandbox).id;
  const run = await db.run.findFirst({ where: { capabilityId: id, status: { in: ['queued', 'running'] } }, select: { id: true } });
  const repair = await db.repairAttempt.findFirst({ where: { capabilityId: id, outcome: { in: ['queued', 'running'] } }, select: { id: true } });
  const learning = await db.derivation.findFirst({ where: { capabilityId: id, outcome: { in: ['queued', 'running'] } }, select: { id: true } });
  return run ? { runId: run.id } : repair ? { repairId: repair.id } : learning ? { derivationId: learning.id } : null;
}

// Anakin signs alerts as sha256=<hex HMAC of the raw body> with the monitor's secret.
function signedByAnakin(raw, header, secret) {
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
  const got = Buffer.from(String(header ?? ''));
  return got.length === want.length && timingSafeEqual(got, want);
}

async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64_000) throw Object.assign(new Error('that request body is too big'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// delivery ids stay the same when Anakin retries, so one change starts one repair
const deliveries = new Set();

const monitorInfo = () =>
  process.env.ANAKIN_MONITOR_ID ? { everyMinutes: Number(process.env.ANAKIN_MONITOR_MINUTES ?? 240), page: '/harbor-lane/' } : null;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// Behind Caddy + Cloudflare the socket address is always the proxy.
const clientIp = (req) =>
  process.env.TRUST_PROXY ? (req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for']?.split(',')[0].trim() ?? req.socket.remoteAddress) : req.socket.remoteAddress;

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 16_000) throw Object.assign(new Error('that request body is too big'), { status: 413 });
    chunks.push(c);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    throw Object.assign(new Error('could not read that as JSON'), { status: 400 });
  }
}

const afterSeq = (url) => Math.max(0, Number.parseInt(url.searchParams.get('after') ?? '0', 10) || 0);

async function capabilitySummary(id) {
  const cap = await db.capability.findUnique({ where: { id }, include: { plan: { select: { id: true, version: true, origin: true, steps: true } } } });
  if (!cap) return null;
  const plan = cap.plan && { id: cap.plan.id, version: cap.plan.version, origin: cap.plan.origin, stepCount: Array.isArray(cap.plan.steps) ? cap.plan.steps.length : null };
  return { id: shownId(cap.id), name: cap.name, status: cap.status, engine: cap.engine, targetUrl: cap.targetUrl, plan };
}

// the failed run that started a repair, next to the last good run on the same plan
async function compareFor(repair) {
  const job = await db.job.findFirst({ where: { kind: 'repair', refId: repair.id }, select: { payload: true } });
  const failed = job?.payload?.runId && (await db.run.findUnique({ where: { id: job.payload.runId }, select: { id: true, planId: true, createdAt: true } }));
  if (!failed) return null;
  const good = await db.run.findFirst({ where: { capabilityId: repair.capabilityId, planId: failed.planId, status: 'succeeded', createdAt: { lt: failed.createdAt } }, orderBy: { createdAt: 'desc' }, select: { id: true } });
  if (!good) return null;
  const shotsOf = (runId) => db.traceEvent.findMany({ where: { runId, kind: 'shot' }, orderBy: { seq: 'asc' }, select: { kind: true, detail: true } });
  const [goodTrace, failedTrace] = await Promise.all([shotsOf(good.id), shotsOf(failed.id)]);
  return beforeAndAfter(goodTrace, failedTrace);
}

const traceSince = (where, after) =>
  db.traceEvent.findMany({ where: { ...where, seq: { gt: after } }, orderBy: { seq: 'asc' }, select: { seq: true, kind: true, label: true, detail: true, createdAt: true } });

const routes = [
  [
    'GET',
    /^\/(|app\.js|style\.css|favicon\.svg)$/,
    async (req, res, [file]) => {
      const name = file || 'index.html';
      const body = await readFile(new URL(name, WEB)).catch(() => null);
      if (!body) return send(res, 404, { error: 'nothing here' });
      res.writeHead(200, { 'content-type': TYPES[name.slice(name.lastIndexOf('.'))], 'cache-control': 'no-store' });
      return res.end(body);
    },
  ],
  [
    'GET',
    /^\/api\/capabilities$/,
    async (req, res, m, url, ip, sb) => {
      const caps = await db.capability.findMany({ orderBy: { createdAt: 'asc' }, include: { plan: { select: { version: true, origin: true } } } });
      return send(res, 200, {
        capabilities: caps.filter((c) => visible(c.id, sb.id)).map((c) => ({ id: shownId(c.id), name: c.name, goal: c.goal, engine: c.engine, status: c.status, targetUrl: c.targetUrl, inputSchema: c.inputSchema, plan: c.plan })),
        allowedSites: allowedSites(),
      });
    },
  ],
  ['GET', /^\/api\/budget$/, async (req, res) => send(res, 200, await budget())],
  [
    'GET',
    /^\/api\/redesigns$/,
    async (req, res) => {
      const body = await readFile(REDESIGNS, 'utf8').catch(() => null);
      return body ? send(res, 200, JSON.parse(body)) : send(res, 404, { error: 'no redesign benchmark saved on this deployment' });
    },
  ],
  [
    'GET',
    /^\/api\/(demo\/)?shots\/([^/]+)$/,
    async (req, res, [demo, name]) => {
      const jpg = SHOT_NAME.test(name) && (await readFile(demo ? new URL(`shots/${name}`, DEMO) : SHOTS + name).catch(() => null));
      if (!jpg) return send(res, 404, { error: 'no screenshot by that name, old ones get cleared out' });
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400, immutable' });
      return res.end(jpg);
    },
  ],
  [
    // The side panel's preview of the demo site's first page. Sent as JSON because Cloudflare injects
    // its bot-detection script into HTML responses, and that script errors inside a sandboxed frame.
    'GET',
    /^\/api\/target\/page$/,
    async (req, res, m, url, ip, sb) => {
      const page = await fetch(new URL('/', TARGET_ADMIN), { headers: sb.id ? { 'x-anvil-tenant': sb.id } : {} }).catch(() => null);
      if (!page?.ok) return send(res, 502, { error: 'the demo site is not answering' });
      return send(res, 200, { html: await page.text() });
    },
  ],
  [
    // Caddy serves this read-only view in production. Same thing here, for running it locally.
    'GET',
    /^\/harbor-lane(\/.*)?$/,
    async (req, res, [path = '/'], url) => {
      // set the path on a URL for the demo site itself, so "//somewhere-else" cannot change the host
      const to = new URL(TARGET_ADMIN);
      to.pathname = path;
      to.search = url.search;
      if (/^\/+_admin/.test(to.pathname)) return send(res, 404, { error: 'nothing here' });
      const page = await fetch(to, { redirect: 'manual' }).catch(() => null);
      if (!page) return send(res, 502, { error: 'the demo site is not answering' });
      // the demo site's own redirects (to its sign-in page, say) stay inside this view
      const location = page.headers.get('location');
      res.writeHead(page.status, { 'content-type': page.headers.get('content-type') ?? 'text/html; charset=utf-8', 'cache-control': 'no-store', ...(location?.startsWith('/') && { location: `/harbor-lane${location}` }) });
      return res.end(Buffer.from(await page.arrayBuffer()));
    },
  ],
  [
    'GET',
    /^\/api\/demo$/,
    async (req, res) => {
      const body = await readFile(DEMO, 'utf8').catch(() => null);
      return body ? send(res, 200, JSON.parse(body)) : send(res, 404, { error: 'no recorded run has been saved on this deployment' });
    },
  ],
  [
    'GET',
    /^\/api\/target$/,
    async (req, res, m, url, ip, sb) => {
      const c = await targetAdmin('/_admin/config', undefined, sb.id);
      const site = { eventsTable: c.eventsLayout === 'table', cosmetic: !!c.banner, jsApp: c.jsApp, iframe: c.iframe, signIn: c.signIn, redesign: c.redesign, captcha: c.captcha, org: c.org, title: c.title, submitLabel: c.submitLabel, fields: c.fields, seatsFirst: c.seatsFirst, reviewStep: c.reviewStep, receiptLayout: c.receiptLayout, formId: c.formId, confirm: c.confirm, wrongRoom: c.wrongRoom, referenceStyle: c.referenceStyle };
      const sandbox = { own: sb.own, full: !!sb.full, view: sb.id ? `/harbor-lane/t/${sb.id}/` : '/harbor-lane/' };
      return send(res, 200, { ...c.described, site, kinds: c.kinds, owned: OWNED, busy: await busyTierB(sb.id), monitor: sb.id ? null : monitorInfo(), sandbox });
    },
  ],
  [
    'POST',
    /^\/api\/hooks\/site-changed$/,
    async (req, res) => {
      const secret = process.env.ANAKIN_WEBHOOK_SECRET;
      if (!secret) return send(res, 404, { error: 'nothing here' });
      const raw = await readRaw(req);
      if (!signedByAnakin(raw, req.headers['x-anakin-signature'], secret)) return send(res, 401, { error: 'bad signature' });
      const ts = Number(req.headers['x-anakin-timestamp']);
      if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 600) return send(res, 401, { error: 'missing or stale timestamp' });
      let alert;
      try {
        alert = JSON.parse(raw.toString('utf8'));
      } catch {
        return send(res, 400, { error: 'could not read that as JSON' });
      }
      const delivery = String(req.headers['x-anakin-delivery-id'] ?? '');
      console.log(`webhook ${alert.type ?? '?'} from monitor ${alert.monitorId ?? '?'} delivery ${delivery}`);
      if (alert.type !== 'monitor.change') return send(res, 200, { received: alert.type ?? 'unknown' });
      // the dashboard's test alert looks like a real change but carries no change id (delivery id "test")
      if (delivery === 'test' || !alert.changeId) return send(res, 200, { received: 'test alert, signature checks out, nothing to repair' });
      if (process.env.ANAKIN_MONITOR_ID && alert.monitorId !== process.env.ANAKIN_MONITOR_ID) return send(res, 200, { ignored: 'not a monitor this deployment set up' });
      if (delivery && deliveries.has(delivery)) return send(res, 200, { duplicate: true });
      if (delivery) deliveries.add(delivery);
      try {
        const summary = alert.summary ? `: ${alert.summary}` : '';
        const lastCheck = checks.get(SHARED);
        const asked = lastCheck?.via === 'anakin' && Date.now() - lastCheck.at < 10 * 60_000;
        const repair = await queueRepair(reserveRoom().id, { trigger: 'monitor', asked, failure: `Anakin Website Monitoring saw the page change${summary}. No run has failed yet.` });
        if (asked) lastCheck.repairId = repair.id;
        return send(res, 202, { repairId: repair.id });
      } catch (err) {
        if (err instanceof Busy) return send(res, 200, { ...err.existing, note: 'a repair was already on its way' });
        throw err;
      }
    },
  ],
  [
    // "Check the website now": through Anakin Website Monitoring when this deployment has a monitor, whose
    // alert then starts the check, or straight to the check when it has none (a local copy, the bench).
    'POST',
    /^\/api\/check$/,
    async (req, res, m, url, ip, sb) => {
      const cap = await db.capability.findUnique({ where: { id: reserveRoom(sb.id).id } });
      if (!cap?.contractId) return send(res, 409, { error: 'book a room first, so Anvil has a good booking to check the website against' });
      const lastCheck = checks.get(sb.id);
      const gap = sb.id ? SANDBOX_CHECK_GAP_MS : CHECK_GAP_MS;
      const wait = lastCheck && process.env.ANVIL_BENCH !== '1' ? gap - (Date.now() - lastCheck.at) : 0;
      if (wait > 0) return send(res, 429, { error: `a check was asked for ${Math.round((Date.now() - lastCheck.at) / 1000)}s ago. Try again in ${Math.ceil(wait / 1000)}s`, check: shownCheck(sb.id) }, { 'retry-after': String(Math.ceil(wait / 1000)) });
      if (tooMany(ip, 'check')) return send(res, 429, { error: 'you have asked for a lot of checks lately, give it ten minutes' }, { 'retry-after': '600' });
      const busy = await busyTierB(sb.id);
      if (busy) return send(res, 409, { error: 'Anvil is busy on the website right now, check again when that finishes', ...busy });
      const b = await budget();
      if (b.used + 3 > b.cap) return cappedReply(res, b);
      // Anakin's monitor watches the shared copy only; a private copy is checked directly
      if (process.env.ANAKIN_MONITOR_ID && !sb.id) {
        const before = await askForCheck();
        checks.set(sb.id, { via: 'anakin', at: Date.now(), before, repairId: null, landed: null });
        return send(res, 202, { via: 'anakin', check: shownCheck(sb.id) });
      }
      try {
        const repair = await queueRepair(cap.id, { trigger: 'check', failure: 'Someone asked Anvil to check the website now. No run has failed.' });
        checks.set(sb.id, { via: 'direct', at: Date.now(), repairId: repair.id });
        return send(res, 202, { via: 'direct', repairId: repair.id, check: shownCheck(sb.id) });
      } catch (err) {
        if (err instanceof Busy) return send(res, 409, { error: err.message, ...err.existing });
        throw err;
      }
    },
  ],
  [
    'GET',
    /^\/api\/check$/,
    async (req, res, m, url, ip, sb) => {
      const lastCheck = checks.get(sb.id);
      if (!lastCheck) return send(res, 200, { check: null });
      if (lastCheck.via === 'anakin' && !lastCheck.landed && !lastCheck.repairId && Date.now() - lastCheck.at < 10 * 60_000) {
        // the page polls this every few seconds; Anakin is asked at most every 5
        if (!lastCheck.polled || Date.now() - lastCheck.polled > 5000) {
          lastCheck.polled = Date.now();
          const seen = await checkLanded(lastCheck.before).catch(() => null);
          if (seen?.landed) lastCheck.landed = { at: Date.now(), changed: seen.changed };
        }
      }
      return send(res, 200, { check: shownCheck(sb.id) });
    },
  ],
  [
    // Learn the booking again from its one sentence, on the site as it is right now. Makes one real booking.
    'POST',
    /^\/api\/learn$/,
    async (req, res, m, url, ip, sb) => {
      if (tooMany(ip, 'break')) return send(res, 429, { error: 'that has been asked for a lot in the last ten minutes, give it a rest for a bit' }, { 'retry-after': '600' });
      const def = reserveRoom(sb.id);
      if (!firstParty(new URL(def.targetUrl).hostname)) return send(res, 403, { error: 'Anvil only learns bookings on sites this project owns' });
      const busy = await busyTierB(sb.id);
      if (busy) return send(res, 409, { error: 'Anvil is busy on the website right now, try again when that finishes', ...busy });
      const b = await budget();
      if (b.used + 6 > b.cap) return cappedReply(res, b);
      const d = await queueLearn(def.id, def.learn());
      return send(res, 202, { derivationId: d.id, poll: `/api/derivations/${d.id}` });
    },
  ],
  [
    'GET',
    /^\/api\/activity$/,
    async (req, res, m, url, ip, sb) => {
      const since = new Date(Number(url.searchParams.get('since')) || Date.now() - 60_000);
      const [repairs, runs, running] = await Promise.all([
        db.repairAttempt.findMany({ where: { createdAt: { gt: since } }, orderBy: { createdAt: 'asc' }, select: { id: true, capabilityId: true, trigger: true, outcome: true, createdAt: true } }),
        db.run.findMany({ where: { createdAt: { gt: since } }, orderBy: { createdAt: 'asc' }, take: 50, select: { id: true, capabilityId: true, status: true, createdAt: true } }),
        db.job.count({ where: { status: 'running' } }),
      ]);
      // only this visitor's own copy in detail; everyone else is a count
      const mine = (rows) => rows.filter((r) => visible(r.capabilityId, sb.id)).map((r) => ({ ...r, capabilityId: shownId(r.capabilityId) }));
      const recent = [...lastSeen.values()].filter((t) => Date.now() - t < 10 * 60_000).length;
      return send(res, 200, { now: Date.now(), repairs: mine(repairs), runs: mine(runs).slice(0, 20), live: { sandboxes: recent, running } });
    },
  ],
  [
    'POST',
    /^\/api\/target\/(break|reset)$/,
    async (req, res, [action], url, ip, sb) => {
      if (tooMany(ip, 'break')) return send(res, 429, { error: 'you have broken the site a lot in the last ten minutes, give it a rest for a bit' }, { 'retry-after': '600' });
      const body = await readJson(req);
      const busy = await busyTierB(sb.id);
      if (busy) return send(res, 409, { error: 'a run or repair is in flight on the demo site, wait for it to finish', ...busy });
      if (action === 'reset') {
        const c = await targetAdmin('/_admin/reset', {}, sb.id);
        const seeded = await seedCapability(reserveRoom(sb.id), { reset: true });
        await seedCapability(harborEvents(sb.id), { reset: true });
        return send(res, 200, { detail: seeded.learning ? 'the site is back to how it started, and Anvil is learning the booking from its sentence again' : 'the site and the capability are back to how they started', learning: !!seeded.learning, ...c.described });
      }
      const own = body.kind === 'custom' ? { field: body.field, label: body.label, button: body.button, order: body.order } : {};
      for (const [k, v] of Object.entries(own)) if (v !== undefined && typeof v !== 'string') return send(res, 400, { error: `"${k}" should be text` });
      const c = await targetAdmin('/_admin/break', { kind: body.kind, key: 'email', ...own }, sb.id);
      return send(res, 200, { changed: c.changed, detail: c.detail, ...c.described });
    },
  ],
  [
    'POST',
    /^\/api\/capabilities$/,
    async (req, res) => {
      const body = await readJson(req);
      let url;
      try {
        url = new URL(String(body.url ?? '').trim());
      } catch {
        return send(res, 400, { error: 'that does not look like a URL' });
      }
      if (!['http:', 'https:'].includes(url.protocol)) return send(res, 400, { error: 'only http and https pages' });
      const goal = String(body.goal ?? '').trim();
      if (goal.length < 10 || goal.length > 300) return send(res, 400, { error: 'describe the goal in 10 to 300 characters' });
      // the allowlist is cheap to check here; robots.txt is checked by the worker before it fetches anything
      if (!onAllowlist(url.toString())) return send(res, 403, { error: `${url.hostname} is not on this deployment's allowlist`, allowed: allowedSites() });
      const b = await budget();
      if (b.capped) return cappedReply(res, b);
      const busy = await db.derivation.count({ where: { outcome: { in: ['queued', 'running'] } } });
      if (busy >= 3) return send(res, 429, { error: 'a few capabilities are already being worked out, try again in a minute' });
      const { cap, derivation } = await createReadCapability({ url: url.toString(), goal, name: body.name });
      return send(res, 202, { capabilityId: cap.id, derivationId: derivation.id, poll: `/api/derivations/${derivation.id}` });
    },
  ],
  [
    'GET',
    /^\/api\/capabilities\/([\w-]+)$/,
    async (req, res, [asked], url, ip, sb) => {
      const id = ownId(asked, sb.id);
      const cap = id && (await db.capability.findUnique({ where: { id }, include: { plan: true, contract: true } }));
      if (!cap) return send(res, 404, { error: 'no capability with that id' });
      const { contract, plan, ...rest } = cap;
      rest.id = shownId(rest.id);
      const plans = await db.plan.findMany({ where: { capabilityId: id }, orderBy: { version: 'asc' }, select: { version: true, origin: true, active: true, createdAt: true } });
      return send(res, 200, {
        ...rest,
        plans,
        plan: plan && { id: plan.id, version: plan.version, origin: plan.origin, steps: plan.steps, createdAt: plan.createdAt },
        contract: contract && { requiredFields: contract.requiredFields, fieldTypes: contract.fieldTypes, minRecords: contract.minRecords, bounds: contract.bounds, sampleSize: contract.goldenSample?.records?.length ?? null },
      });
    },
  ],
  [
    'GET',
    /^\/api\/derivations\/([\w-]+)$/,
    async (req, res, [id], url) => {
      const derivation = await db.derivation.findUnique({ where: { id } });
      if (!derivation) return send(res, 404, { error: 'no derivation with that id' });
      const [capability, trace] = await Promise.all([capabilitySummary(derivation.capabilityId), traceSince({ derivationId: id }, afterSeq(url))]);
      const { screenshot, ...rest } = derivation;
      return send(res, 200, { derivation: { ...rest, screenshot: screenshot ? `/api/derivations/${id}/screenshot` : null }, capability, trace });
    },
  ],
  [
    'GET',
    /^\/api\/derivations\/([\w-]+)\/screenshot$/,
    async (req, res, [id]) => {
      const derivation = await db.derivation.findUnique({ where: { id }, select: { screenshot: true } });
      if (!derivation?.screenshot) return send(res, 404, { error: 'no screenshot for that derivation' });
      const png = await readFile(derivation.screenshot).catch(() => null);
      if (!png) return send(res, 404, { error: 'the screenshot file is gone' });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      return res.end(png);
    },
  ],
  [
    'POST',
    /^\/api\/runs$/,
    async (req, res, m, url, ip, sb) => {
      const body = await readJson(req);
      const id = typeof body.capabilityId === 'string' && ownId(body.capabilityId, sb.id);
      const cap = id && (await db.capability.findUnique({ where: { id } }));
      if (!cap) return send(res, 404, { error: 'no capability with that id' });
      if (!cap.planId) return send(res, 409, { error: cap.status === 'deriving' ? 'this capability is still being worked out' : 'this capability has no plan to run' });
      const { inputs, error } = cleanInputs(cap.inputSchema, body.inputs);
      if (error) return send(res, 400, { error });
      const b = await budget();
      if (b.capped) return cappedReply(res, b);
      try {
        const run = await queueRun(cap.id, inputs);
        return send(res, 202, { id: run.id, status: run.status, poll: `/api/runs/${run.id}`, sandbox: sb.own });
      } catch (err) {
        if (err instanceof Busy) return send(res, 409, { error: err.message, ...err.existing });
        throw err;
      }
    },
  ],
  [
    'GET',
    /^\/api\/runs\/([\w-]+)$/,
    async (req, res, [id], url, ip, sb) => {
      const run = await db.run.findUnique({ where: { id } });
      if (!run || !visible(run.capabilityId, sb.id)) return send(res, 404, { error: 'no run with that id' });
      run.capabilityId = shownId(run.capabilityId);
      const [capability, trace] = await Promise.all([capabilitySummary(ownId(run.capabilityId, sb.id)), traceSince({ runId: id }, afterSeq(url))]);
      return send(res, 200, { run, capability, trace });
    },
  ],
  [
    'POST',
    /^\/api\/repairs$/,
    async (req, res, m, url, ip, sb) => {
      const body = await readJson(req);
      const id = typeof body.capabilityId === 'string' && ownId(body.capabilityId, sb.id);
      const cap = id && (await db.capability.findUnique({ where: { id } }));
      if (!cap) return send(res, 404, { error: 'no capability with that id' });
      if (!cap.contractId) return send(res, 409, { error: 'this capability has never had a good run, so there is no contract to repair against yet' });
      if (cap.engine === 'wire') return send(res, 409, { error: 'this capability runs a ready-made Wire action, so there are no steps of ours to repair' });
      try {
        const repair = await queueRepair(cap.id, { trigger: 'manual', failure: 'Someone asked Anvil to repair itself. No run has failed.' });
        return send(res, 202, { id: repair.id, outcome: repair.outcome, poll: `/api/repairs/${repair.id}` });
      } catch (err) {
        if (err instanceof Busy) return send(res, 409, { error: err.message, ...err.existing });
        throw err;
      }
    },
  ],
  [
    'GET',
    /^\/api\/repairs\/([\w-]+)$/,
    async (req, res, [id], url, ip, sb) => {
      const repair = await db.repairAttempt.findUnique({ where: { id } });
      if (!repair || !visible(repair.capabilityId, sb.id)) return send(res, 404, { error: 'no repair with that id' });
      const planOf = (planId) => (planId ? db.plan.findUnique({ where: { id: planId }, select: { version: true, origin: true, steps: true } }) : null);
      const [capability, trace, fromPlan, toPlan] = await Promise.all([capabilitySummary(repair.capabilityId), traceSince({ repairId: id }, afterSeq(url)), planOf(repair.fromPlanId), planOf(repair.toPlanId)]);
      // only on the first poll: the page shows it once, at the top of the repair
      const compare = afterSeq(url) === 0 ? await compareFor(repair) : undefined;
      return send(res, 200, { repair: { ...repair, capabilityId: shownId(repair.capabilityId) }, capability, trace, fromPlan, toPlan, compare });
    },
  ],
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://anvil.local');
  const ip = clientIp(req);
  try {
    if (tooMany(ip, req.method === 'GET' ? 'read' : 'write')) return send(res, 429, { error: 'too many requests from you in the last minute, give it a moment' }, { 'retry-after': '60' });
    const sb = sandboxFor(req, res, url);
    if (sb.own) await ensureSandbox(sb.id);
    for (const [method, pattern, handler] of routes) {
      const m = url.pathname.match(pattern);
      if (!m) continue;
      if (req.method !== method) continue;
      return await handler(req, res, m.slice(1), url, ip, sb);
    }
    send(res, 404, { error: 'nothing here' });
  } catch (err) {
    if (err.status) return send(res, err.status, { error: err.message });
    console.error(`${req.method} ${url.pathname} failed:`, err);
    send(res, 500, { error: 'something went wrong on our side' });
  }
});

server.listen(PORT, HOST, () => console.log(`api listening on http://${HOST}:${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => {
    server.close();
    db.$disconnect().finally(() => process.exit(0));
  });
