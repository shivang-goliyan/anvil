import { StepError } from './plan.mjs';
import { AnakinError } from './errors.mjs';
import { NotAllowed } from './conduct.mjs';

const BLOCK_WORDS = /captcha|are you a robot|access denied|unusual traffic|verify you are human|cf-challenge/i;

// transient -> retry, blocked -> degraded, structural -> repair, empty -> fine.
export function triage({ error, contractCheck, records, canaryPresent, pageText = '', sent = null }) {
  if (error) {
    const status = error.docStatus ?? error.status;
    if (error instanceof NotAllowed) return { kind: 'blocked', why: `we may not fetch it: ${error.message}` };
    if (error instanceof AnakinError && ['auth', 'credits'].includes(error.code))
      return { kind: 'blocked', why: `our own Anakin account problem: ${error.message}` };
    if (error instanceof AnakinError && (['network', 'browser_unavailable'].includes(error.code) || error.status === 429 || error.status >= 500))
      return { kind: 'transient', why: `Anakin trouble: ${error.message}` };
    if (status === 403 || BLOCK_WORDS.test(pageText)) return { kind: 'blocked', why: `the site is refusing us (HTTP ${status ?? '?'})` };
    if (status === 429 || status >= 500) return { kind: 'transient', why: `the site answered HTTP ${status}` };
    if (error instanceof StepError && error.reason === 'navigation') return { kind: 'transient', why: error.message };
    if (error instanceof StepError && canaryPresent) return { kind: 'structural', why: `page rendered fine but ${error.message}` };
    if (error instanceof StepError) return { kind: 'transient', why: `page may not have rendered: ${error.message}` };
    return { kind: 'transient', why: error.message };
  }
  // The form held exactly what was asked, and only the site's own stored record disagrees: that is the
  // website getting it wrong, and no new plan can fix it.
  if (contractCheck && !contractCheck.pass && sent && !sent.missing.length && contractCheck.problems.every((p) => /^"stored_/.test(p)))
    return { kind: 'mismatch', why: `the website stored something different from what Anvil sent: ${contractCheck.problems.join('; ')}` };
  if (contractCheck && !contractCheck.pass) {
    if (records.length === 0 && canaryPresent && contractCheck.problems.every((p) => p.startsWith('got 0')))
      return { kind: 'empty', why: 'page rendered and there is simply nothing to return' };
    return { kind: 'structural', why: contractCheck.problems.join('; ') };
  }
  return { kind: 'ok', why: 'contract passed' };
}
