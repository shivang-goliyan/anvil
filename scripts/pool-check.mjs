// Worker pool check, no browser and no credits: three workers, runs for two sandboxes' read capabilities
// queued straight into the job table, every read slowed down by a proxy so overlaps show. Jobs for one
// capability must never overlap; jobs for different capabilities should.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(`${tmpdir()}/anvil-pool-`);
const ports = { target: Number(process.env.BENCH_TARGET_PORT ?? 4485), slow: Number(process.env.BENCH_TARGET_PORT ?? 4485) - 1 };
process.env.DATABASE_URL = `file:${dir}/pool.db`;
const env = { ...process.env, TARGET_PORT: String(ports.target), TARGET_FORWARD: `http://localhost:${ports.slow}`, TARGET_ADMIN_URL: `http://localhost:${ports.target}`, TARGET_ADMIN_TOKEN: 'pool', DEMO_PUBLIC_URL: '', WORKERS: '3', WORKER_POLL_MS: '200' };
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { cwd: ROOT, env, stdio: 'ignore' });

const kids = [];
process.on('exit', () => kids.forEach((k) => k.kill()));
kids.push(spawn(process.execPath, ['target/server.mjs'], { cwd: ROOT, env, stdio: 'ignore' }));
// every request to the demo site takes a second longer
createServer((req, res) => {
  setTimeout(async () => {
    const r = await fetch(`http://localhost:${ports.target}${req.url}`, { headers: { 'x-anvil-tenant': req.headers['x-anvil-tenant'] ?? '' } });
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'text/html' });
    res.end(Buffer.from(await r.arrayBuffer()));
  }, 1000);
}).listen(ports.slow);

const { db } = await import('../src/db.mjs');
const { seedCapability } = await import('../src/capabilities.mjs');
const { harborEvents } = await import('../capabilities/harbor-events.mjs');
const sandboxes = ['poolaaaaa1', 'poolbbbbb2'];
for (const s of sandboxes) await seedCapability(harborEvents(s));
await new Promise((r) => setTimeout(r, 800));
// three runs per capability, queued at once, which queueRun would refuse; the pool has to keep them apart
for (let i = 0; i < 3; i++)
  for (const s of sandboxes) {
    const run = await db.run.create({ data: { capabilityId: harborEvents(s).id, inputs: {} } });
    await db.job.create({ data: { kind: 'run', refId: run.id } });
  }
kids.push(spawn(process.execPath, ['--env-file=.env', 'scripts/workers.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'inherit'] }));
kids.at(-1).stdout.on('data', (d) => process.env.POOL_VERBOSE && process.stdout.write(d));

const t0 = Date.now();
for (;;) {
  const left = await db.job.count({ where: { status: { in: ['queued', 'running'] } } });
  if (!left) break;
  if (Date.now() - t0 > 120_000) throw new Error('the pool did not finish in two minutes');
  await new Promise((r) => setTimeout(r, 300));
}
const runs = await db.run.findMany({ orderBy: { startedAt: 'asc' } });
const overlap = (a, b) => a.startedAt < b.endedAt && b.startedAt < a.endedAt;
let same = 0;
let across = 0;
for (let i = 0; i < runs.length; i++)
  for (let j = i + 1; j < runs.length; j++) {
    if (!overlap(runs[i], runs[j])) continue;
    if (runs[i].capabilityId === runs[j].capabilityId) same++;
    else across++;
  }
for (const r of runs) console.log(`${r.capabilityId.padEnd(26)} ${r.status.padEnd(9)} ${(r.startedAt - t0) / 1000}s → ${(r.endedAt - t0) / 1000}s`);
console.log(`\n${runs.length} runs in ${((Date.now() - t0) / 1000).toFixed(1)}s · overlapping pairs on the same capability: ${same} · on different capabilities: ${across} · all succeeded: ${runs.every((r) => r.status === 'succeeded')}`);
await db.$disconnect();
process.exit(same === 0 && across > 0 && runs.every((r) => r.status === 'succeeded') ? 0 : 1);
