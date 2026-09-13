// HTTP API. Never does the long work itself: it writes rows and the worker picks them up.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db } from './db.mjs';
import { cleanInputs, queueRun, queueRepair, Busy } from './jobs.mjs';
import { createReadCapability, seedCapability } from './capabilities.mjs';
import { onAllowlist, allowedSites } from './conduct.mjs';
import { creditsUsed, hourlyCap } from './budget.mjs';
import { reserveRoom } from '../capabilities/reserve-room.mjs';

const PORT = Number(process.env.PORT ?? 3310);
const HOST = process.env.HOST ?? '127.0.0.1';
const TARGET_ADMIN = process.env.TARGET_ADMIN_URL || process.env.TARGET_FORWARD || 'http://localhost:4310';
const WEB = new URL('../web/', import.meta.url);
const DEMO = new URL('../demo/recorded.json', import.meta.url);
// [requests, window] per IP. Breaking the demo site is the one people will want to spam.
const LIMITS = { read: [300, 60_000], write: [12, 60_000], break: [6, 10 * 60_000] };

const hits = new Map();
function tooMany(ip, bucket) {
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

async function targetAdmin(path, body) {
  const res = await fetch(new URL(path, TARGET_ADMIN), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-admin-token': process.env.TARGET_ADMIN_TOKEN ?? '', 'content-type': 'application/json' },
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

async function busyTierB() {
  const id = reserveRoom().id;
  const run = await db.run.findFirst({ where: { capabilityId: id, status: { in: ['queued', 'running'] } }, select: { id: true } });
  const repair = await db.repairAttempt.findFirst({ where: { capabilityId: id, outcome: { in: ['queued', 'running'] } }, select: { id: true } });
  return run ? { runId: run.id } : repair ? { repairId: repair.id } : null;
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
  const cap = await db.capability.findUnique({ where: { id }, include: { plan: { select: { id: true, version: true, origin: true } } } });
  return cap && { id: cap.id, name: cap.name, status: cap.status, engine: cap.engine, targetUrl: cap.targetUrl, plan: cap.plan };
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
    async (req, res) => {
      const caps = await db.capability.findMany({ orderBy: { createdAt: 'asc' }, include: { plan: { select: { version: true, origin: true } } } });
      return send(res, 200, {
        capabilities: caps.map((c) => ({ id: c.id, name: c.name, goal: c.goal, engine: c.engine, status: c.status, targetUrl: c.targetUrl, inputSchema: c.inputSchema, plan: c.plan })),
        allowedSites: allowedSites(),
      });
    },
  ],
  ['GET', /^\/api\/budget$/, async (req, res) => send(res, 200, await budget())],
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
    async (req, res) => {
      const c = await targetAdmin('/_admin/config');
      return send(res, 200, { ...c.described, kinds: c.kinds, owned: OWNED, busy: await busyTierB(), monitor: monitorInfo() });
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
        const repair = await queueRepair(reserveRoom().id, { trigger: 'monitor', failure: `Anakin Website Monitoring saw the page change${summary}. No run has failed yet.` });
        return send(res, 202, { repairId: repair.id });
      } catch (err) {
        if (err instanceof Busy) return send(res, 200, { ...err.existing, note: 'a repair was already on its way' });
        throw err;
      }
    },
  ],
  [
    'GET',
    /^\/api\/activity$/,
    async (req, res, m, url) => {
      const since = new Date(Number(url.searchParams.get('since')) || Date.now() - 60_000);
      const repairs = await db.repairAttempt.findMany({ where: { createdAt: { gt: since } }, orderBy: { createdAt: 'asc' }, select: { id: true, capabilityId: true, trigger: true, outcome: true, createdAt: true } });
      return send(res, 200, { now: Date.now(), repairs });
    },
  ],
  [
    'POST',
    /^\/api\/target\/(break|reset)$/,
    async (req, res, [action], url, ip) => {
      if (tooMany(ip, 'break')) return send(res, 429, { error: 'you have broken the site a lot in the last ten minutes, give it a rest for a bit' }, { 'retry-after': '600' });
      const body = await readJson(req);
      const busy = await busyTierB();
      if (busy) return send(res, 409, { error: 'a run or repair is in flight on the demo site, wait for it to finish', ...busy });
      if (action === 'reset') {
        const c = await targetAdmin('/_admin/reset', {});
        await seedCapability(reserveRoom(), { reset: true });
        return send(res, 200, { detail: 'the site and the capability are back to how they started', ...c.described });
      }
      const c = await targetAdmin('/_admin/break', { kind: body.kind, key: 'email' });
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
    async (req, res, [id]) => {
      const cap = await db.capability.findUnique({ where: { id }, include: { plan: true, contract: true } });
      if (!cap) return send(res, 404, { error: 'no capability with that id' });
      const { contract, plan, ...rest } = cap;
      return send(res, 200, {
        ...rest,
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
    async (req, res) => {
      const body = await readJson(req);
      const cap = typeof body.capabilityId === 'string' && (await db.capability.findUnique({ where: { id: body.capabilityId } }));
      if (!cap) return send(res, 404, { error: 'no capability with that id' });
      if (!cap.planId) return send(res, 409, { error: cap.status === 'deriving' ? 'this capability is still being worked out' : 'this capability has no plan to run' });
      const { inputs, error } = cleanInputs(cap.inputSchema, body.inputs);
      if (error) return send(res, 400, { error });
      const b = await budget();
      if (b.capped) return cappedReply(res, b);
      try {
        const run = await queueRun(cap.id, inputs);
        return send(res, 202, { id: run.id, status: run.status, poll: `/api/runs/${run.id}` });
      } catch (err) {
        if (err instanceof Busy) return send(res, 409, { error: err.message, ...err.existing });
        throw err;
      }
    },
  ],
  [
    'GET',
    /^\/api\/runs\/([\w-]+)$/,
    async (req, res, [id], url) => {
      const run = await db.run.findUnique({ where: { id } });
      if (!run) return send(res, 404, { error: 'no run with that id' });
      const [capability, trace] = await Promise.all([capabilitySummary(run.capabilityId), traceSince({ runId: id }, afterSeq(url))]);
      return send(res, 200, { run, capability, trace });
    },
  ],
  [
    'POST',
    /^\/api\/repairs$/,
    async (req, res) => {
      const body = await readJson(req);
      const cap = typeof body.capabilityId === 'string' && (await db.capability.findUnique({ where: { id: body.capabilityId } }));
      if (!cap) return send(res, 404, { error: 'no capability with that id' });
      if (!cap.contractId) return send(res, 409, { error: 'this capability has never had a good run, so there is no contract to repair against yet' });
      if (cap.engine !== 'browser') return send(res, 409, { error: 'repair is only wired up for browser capabilities so far' });
      try {
        const repair = await queueRepair(cap.id, { trigger: 'manual' });
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
    async (req, res, [id], url) => {
      const repair = await db.repairAttempt.findUnique({ where: { id } });
      if (!repair) return send(res, 404, { error: 'no repair with that id' });
      const [capability, trace] = await Promise.all([capabilitySummary(repair.capabilityId), traceSince({ repairId: id }, afterSeq(url))]);
      return send(res, 200, { repair, capability, trace });
    },
  ],
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://anvil.local');
  const ip = clientIp(req);
  try {
    if (tooMany(ip, req.method === 'GET' ? 'read' : 'write')) return send(res, 429, { error: 'too many requests from you in the last minute, give it a moment' }, { 'retry-after': '60' });
    for (const [method, pattern, handler] of routes) {
      const m = url.pathname.match(pattern);
      if (!m) continue;
      if (req.method !== method) continue;
      return await handler(req, res, m.slice(1), url, ip);
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
