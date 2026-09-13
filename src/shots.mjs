import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// What the remote browser actually showed at a few moments of a run, so someone watching can see
// the website Anvil worked on instead of taking the trace's word for it.
export const SHOTS = fileURLToPath(new URL('../state/shots/', import.meta.url));
export const SHOT_NAME = /^[0-9a-z]{8}-[0-9a-f]{8}\.jpg$/;
const KEEP = 400;
let saved = 0;

async function prune() {
  const names = (await readdir(SHOTS).catch(() => [])).filter((n) => SHOT_NAME.test(n)).sort();
  for (const n of names.slice(0, Math.max(0, names.length - KEEP))) await unlink(SHOTS + n).catch(() => {});
}

export function shooter(session, log) {
  return async (label, detail = {}) => {
    try {
      const jpg = await session.within(8000, session.page.screenshot({ type: 'jpeg', quality: 60, timeout: 7000 }), 'taking a screenshot');
      await mkdir(SHOTS, { recursive: true });
      const name = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}.jpg`;
      await writeFile(SHOTS + name, jpg);
      log('shot', label, { src: `/api/shots/${name}`, ...detail });
      if (++saved % 20 === 0) prune();
    } catch {
      // no screenshot is a pity, never a reason to fail the run
    }
  };
}
