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

// Two pictures for a repair: what the last good run saw at the point in the flow where the broken
// run got stuck, and what the broken run saw there instead.
export function beforeAndAfter(goodTrace = [], failedTrace = []) {
  const shots = (trace) => trace.filter((e) => e.kind === 'shot' && e.detail?.src);
  const stuck = shots(failedTrace).find((e) => e.detail.stuck);
  const good = shots(goodTrace).filter((e) => !e.detail.stuck);
  if (!stuck || !good.length) return null;
  const at = stuck.detail.index ?? Infinity;
  const before = good.find((e) => (e.detail.index ?? -1) >= at) ?? good.at(-1);
  return { before: before.detail.src, after: stuck.detail.src };
}
