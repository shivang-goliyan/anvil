// Runs several workers side by side for a local stack:  WORKERS=3 node --env-file=.env scripts/workers.mjs
// In production each one is its own unit: deploy/anvil-worker@.service.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const count = Math.max(1, Number(process.env.WORKERS ?? 3));
const worker = fileURLToPath(new URL('../src/worker.mjs', import.meta.url));
const kids = Array.from({ length: count }, (_, i) => spawn(process.execPath, [...process.execArgv, worker], { env: { ...process.env, WORKER_NAME: String(i + 1) }, stdio: 'inherit' }));
let left = kids.length;
for (const k of kids) k.on('exit', () => --left || process.exit(0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => kids.forEach((k) => k.kill(sig)));
