// A private copy of the demo per visitor. A sandbox id is ten lowercase letters and digits; the shared demo is ''.
import { randomBytes } from 'node:crypto';

export const SHARED = '';
const ID = /^[a-z0-9]{10}$/;
const DEMO_HOST = 'harbor-lane.anvil.test';
// the demo capabilities every sandbox gets its own copy of; real-site read capabilities stay shared
export const DEMO_CAPS = ['reserve-room', 'harbor-events'];

export const validSandbox = (value) => (typeof value === 'string' && ID.test(value) ? value : null);

export function newSandbox() {
  const letters = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(randomBytes(10), (b) => letters[b % letters.length]).join('');
}

// reserve-room in sandbox abc → reserve-room~abc; the shared demo keeps the plain id
export const capId = (base, sandbox) => (sandbox ? `${base}~${sandbox}` : base);

export function splitCapId(id) {
  const [base, sandbox = SHARED] = String(id).split('~');
  return { base, sandbox: validSandbox(sandbox) ?? SHARED };
}

export const sandboxHost = (sandbox) => (sandbox ? `${sandbox}.${DEMO_HOST}` : DEMO_HOST);

export function sandboxOfHost(hostname) {
  const m = String(hostname).match(/^([a-z0-9]{10})\.harbor-lane\.anvil\.test$/);
  return m ? m[1] : SHARED;
}

export function cookieValue(header, name) {
  for (const part of String(header ?? '').split(/;\s*/)) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at) === name) return decodeURIComponent(part.slice(at + 1));
  }
  return null;
}

// the demo site's public read-only view reaches a sandbox's copy under /t/<id>/
export function sandboxOfPath(pathname) {
  const m = String(pathname).match(/^\/t\/([a-z0-9]{10})(\/.*)?$/);
  return m ? { sandbox: m[1], path: m[2] || '/' } : null;
}
