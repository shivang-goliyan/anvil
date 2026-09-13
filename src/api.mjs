// HTTP API. Never does the long work itself: it writes rows and the worker picks them up.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { db } from './db.mjs';
import { cleanInputs, queueRun, queueRepair, Busy } from './jobs.mjs';
import { createReadCapability } from './capabilities.mjs';
import { onAllowlist, allowedSites } from './conduct.mjs';

const PORT = Number(process.env.PORT ?? 3310);
const HOST = process.env.HOST ?? '127.0.0.1';
const LIMITS = { write: 12, read: 300 }; // per IP per minute

const hits = new Map();
function tooMany(ip, bucket) {
  const key = `${bucket} ${ip}`;
  const now = Date.now();
  let h = hits.get(key);
  if (!h || now - h.start >= 60_000) hits.set(key, (h = { start: now, n: 0 }));
  return ++h.n > LIMITS[bucket];
}
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [k, h] of hits) if (h.start < cutoff) hits.delete(k);
}, 60_000).unref();

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
      return await handler(req, res, m.slice(1), url);
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
