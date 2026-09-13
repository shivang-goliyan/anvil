import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const dir = new URL('../state/', import.meta.url).pathname;

export async function loadCapability(seed) {
  try {
    return JSON.parse(await readFile(join(dir, `${seed.id}.json`), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return structuredClone(seed);
  }
}

export async function saveCapability(cap) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${cap.id}.json`), JSON.stringify(cap, null, 2));
}

export async function forgetCapability(id) {
  await rm(join(dir, `${id}.json`), { force: true });
}
