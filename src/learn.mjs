// Learning a booking from one sentence: no steps to start from, only the page, the goal, the input fields and
// what a result must hold. Allowed on the project's own sites only, because learning it makes a real booking.

import { parse } from 'node-html-parser';
import { openBrowser, keepAlive } from './anakin.mjs';
import { runPlan, checkPlanShape, contentWithFrames } from './plan.mjs';
import { deriveContract } from './contract.mjs';
import { pageShape, formMarkup, compactHtml } from './page-shape.mjs';
import { derivePlan } from './derive.mjs';
import { firstParty } from './conduct.mjs';
import { OverBudget } from './errors.mjs';
import { db } from './db.mjs';
import { loadCapability, sessionOptions, ownedSiteBookings, adoptLearnedPlan } from './capabilities.mjs';
import { shooter } from './shots.mjs';

const MAX_ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

// Plain links on the entry page that sound like the goal ("Find my booking"). Opening one books nothing.
export function linksWorthOpening(html, goal, base, max = 2) {
  const words = new Set(String(goal).toLowerCase().match(/[a-z]{4,}/g) ?? []);
  const seen = new Set([new URL(base).pathname]);
  const origin = new URL(base).origin;
  return parse(html)
    .querySelectorAll('a[href]')
    .map((a) => {
      try {
        return { url: new URL(a.getAttribute('href'), base), text: a.textContent.replace(/\s+/g, ' ').trim() };
      } catch {
        return null;
      }
    })
    .filter((l) => l && l.url.origin === origin && !seen.has(l.url.pathname) && seen.add(l.url.pathname))
    .map((l) => ({ ...l, score: (`${l.text} ${l.url.pathname}`.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => words.has(w)).length }))
    .filter((l) => l.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((l) => ({ url: l.url.toString(), text: l.text }));
}

// What a booking has to show before its steps are kept: every field filled with the right type, what was
// typed in shown back, and the site's own record (stored_x) agreeing with the confirmation (x).
export function learnedProblems(records, inputs, outputs) {
  const r = records?.[0];
  if (!r) return ['nothing was read back'];
  const problems = [];
  for (const [f, type] of Object.entries(outputs)) {
    if (r[f] === null || r[f] === undefined || r[f] === '') problems.push(`"${f}" came back empty`);
    else if (typeof r[f] !== type) problems.push(`"${f}" should be a ${type} but is ${typeof r[f]} (${r[f]})`);
  }
  for (const [k, v] of Object.entries(inputs))
    for (const f of [k, `stored_${k}`]) if (f in outputs && r[f] != null && r[f] !== '' && !same(r[f], v)) problems.push(`"${f}" shows "${r[f]}", but "${v}" was typed in`);
  for (const f of Object.keys(outputs)) {
    const plain = f.replace(/^stored_/, '');
    if (plain !== f && plain in outputs && r[f] != null && r[plain] != null && !same(r[f], r[plain])) problems.push(`"${f}" (${r[f]}) does not agree with "${plain}" (${r[plain]})`);
  }
  return problems;
}

// Steps that open a page on the same site keep only the path, so they work wherever the site is served from.
export function pathsOnly(steps, base) {
  const origin = new URL(base).origin;
  return steps.map((s) => {
    if (s.kind !== 'navigate' || typeof s.url !== 'string') return s;
    try {
      const u = new URL(s.url, base);
      return u.origin === origin ? { ...s, url: `${u.pathname}${u.search}` } : s;
    } catch {
      return s;
    }
  });
}

// payload: { goal, url, inputs (one sample booking), outputs ({ field: type }) }
export async function executeLearn(derivationId, { goal, url, inputs, outputs } = {}, log) {
  const derivation = await db.derivation.findUnique({ where: { id: derivationId } });
  if (!derivation) return log('error', 'this learning job no longer exists (the capability was probably reset)');
  const cap = await loadCapability(derivation.capabilityId);
  const hadPlan = !!cap.plan;
  const finish = async (outcome, diagnosis) => {
    await log.flush();
    await db.derivation.update({ where: { id: derivationId }, data: { outcome, diagnosis, via: 'learned' } });
    if (!hadPlan && outcome !== 'derived') await db.capability.update({ where: { id: cap.id }, data: { status: 'degraded' } });
  };
  goal ??= cap.goal;
  url ??= cap.targetUrl;
  await db.derivation.update({ where: { id: derivationId }, data: { outcome: 'running', operativeUrl: url } });
  log('learn', `learning from one sentence: ${goal}`, { goal, url, inputs, outputs, learn: true });

  if (!firstParty(new URL(url).hostname)) {
    log('conduct', `not learning a booking on ${new URL(url).hostname}: learning one makes a real booking, so it is only done on sites this project owns`, { url, refused: true });
    return finish('failed', 'not a site this project owns');
  }
  if (!inputs || !outputs) {
    log('error', 'nothing to learn with: the sample booking details or the fields to read back are missing');
    return finish('failed', 'missing inputs or outputs');
  }

  const inputKeys = Object.keys(inputs);
  const bookingsBefore = await ownedSiteBookings(cap);
  const pages = new Map();
  const rejections = [];
  // once the one real booking has been made, later tries read it back instead of booking again
  let booked = null;
  let learned = null;

  try {
    for (let n = 1; n <= MAX_ATTEMPTS && !learned; n++) {
      if (n > 1) await sleep(2000);
      log('attempt', `attempt ${n} of ${MAX_ATTEMPTS}`, { attempt: n });
      let session;
      try {
        session = await openBrowser({ ...sessionOptions(cap), log });
        const page = session.page;
        // keyed by address and title: a lookup form and the record it shows can share one address
        const remember = async () => {
          const html = await session.within(5000, contentWithFrames(page), 'reading the page').catch(() => '');
          if (html) pages.set(`${page.url()} (page title "${pageShape(html).shape.title}")`, compactHtml(html, 8000));
        };
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
        const entryHtml = await session.within(10_000, contentWithFrames(page), 'reading the entry page');
        const shape = pageShape(entryHtml);
        if (n === 1) {
          pages.set(`${page.url()} (page title "${shape.shape.title}")`, compactHtml(entryHtml, 8000));
          log('read', `opened ${page.url()}: ${shape.shape.forms.length} form${shape.shape.forms.length === 1 ? '' : 's'}, ${shape.shape.forms.reduce((a, f) => a + f.fields.length, 0)} boxes`, { url: page.url() });
          for (const link of linksWorthOpening(entryHtml, goal, page.url())) {
            const opened = await page.goto(link.url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null);
            if (!opened?.ok()) continue;
            await remember();
            log('read', `also opened ${new URL(link.url).pathname} ("${link.text}"), a plain link on the page, which books nothing`, { url: link.url, explore: true });
          }
        }

        // steps that could never run are asked for again right away: a try on the website is only spent on runnable ones
        let derived;
        let problems = [];
        for (let ask = 1; ask <= 2; ask++) {
          const stopKeepAlive = keepAlive(page);
          try {
            derived = await derivePlan({
              goal,
              entryUrl: url,
              inputKeys,
              outputFields: outputs,
              failure: rejections.at(-1) ?? null,
              pages: [...pages].slice(-5).map(([u, html]) => ({ url: u, html })),
              shape: shape.shape,
              markup: formMarkup(entryHtml),
              rejections,
              attempt: n + ask - 1,
              write: true,
            });
          } finally {
            stopKeepAlive();
          }
          for (const s of derived.skipped) log('derive', `skipped model ${s}`);
          log('derive', `steps written by ${derived.model} in ${(derived.ms / 1000).toFixed(1)}s`, { model: derived.model, ms: derived.ms, promptChars: derived.promptChars });
          problems = checkPlanShape(derived.plan, { outputFields: Object.keys(outputs), inputKeys, write: true });
          if (!problems.length) break;
          rejections.push(`a plan written on attempt ${n} was not runnable: ${problems.join('; ')}`);
          log('reject', `The steps were not runnable: ${problems.join('; ')}`, { problems, steps: derived.plan.steps ?? null });
        }
        if (problems.length) continue;
        derived.plan.steps = pathsOnly(derived.plan.steps, url);
        log('plan', `candidate plan has ${derived.plan.steps.length} steps`, { steps: derived.plan.steps, learn: true });

        const snap = shooter(session, log);
        const execute = (opts, withInputs = inputs) =>
          session.within(
            150_000,
            runPlan(derived.plan, withInputs, session, {
              ...opts,
              baseUrl: url,
              onStep: (i, s) => log('step', `${i + 1}. ${s.kind} ${s.selector ?? s.url ?? Object.keys(s.fields ?? {}).join(', ')}`, { index: i, step: s }),
              // every page a result is read from is kept, so a later try has seen it even when this one fails
              beforePress: async (i, s) => {
                if (s.kind === 'extract') await remember();
                return snap(`page before step ${i + 1}`, { index: i, kind: s.kind });
              },
              afterStep: (i, s) => snap(`page after step ${i + 1}`, { index: i, kind: s.kind, after: true }),
            }),
            'running the learned steps',
          );

        // 1. everything up to the booking button, without pressing it
        let rehearsal;
        try {
          rehearsal = await execute({ rehearse: true });
        } catch (err) {
          if (err instanceof OverBudget) throw err;
          await remember();
          rejections.push(`attempt ${n} got stuck before the booking step on ${page.url()}: ${err.message.split('\n')[0]}`);
          log('execute', `the steps got stuck before the booking button: ${err.message.split('\n')[0]}`, { url: page.url() });
          continue;
        }
        await remember();
        const missing = rehearsal.sent?.missing ?? inputKeys;
        log('rehearse', missing.length ? `rehearsed up to the booking step, but the page did not hold: ${missing.join(', ')}` : `rehearsed up to the booking step without booking: the page held every detail (${rehearsal.sent.found.join(', ')})`, {
          sent: rehearsal.sent,
          commitIndex: rehearsal.commitIndex,
          learn: true,
        });
        if (missing.length) {
          rejections.push(`attempt ${n} filled the form, but these inputs were not on the page before booking: ${missing.join(', ')}`);
          continue;
        }

        // 2. the one real booking, or, if an earlier try already made it, the steps after booking on that one
        let result;
        let reused = false;
        if (booked && !booked.url) {
          log('execute', 'a booking was made on an earlier try, but its page could not be found again, so there is nothing to test the rest of the steps on without booking a second time. Stopping', { url: page.url() });
          break;
        }
        if (!booked) {
          log('commit', 'the rehearsal held every detail, so now the one real booking, with the sample details', { inputs, learn: true });
          const countBefore = await ownedSiteBookings(cap);
          try {
            result = await execute({});
            booked = { url: result.afterCommitUrl, inputs };
          } catch (err) {
            if (err instanceof OverBudget) throw err;
            await remember();
            // the site's own count says whether pressing it booked, not the fact that the button was pressed
            const countAfter = await ownedSiteBookings(cap);
            const made = countBefore !== null && countAfter !== null ? countAfter > countBefore : !!err.committed;
            if (made) booked = { url: err.afterCommitUrl ?? (/\/(reservations|bookings?)\//.test(page.url()) ? page.url() : null), inputs };
            rejections.push(`attempt ${n}: ${made ? 'the booking was made, but ' : err.committed ? 'pressing the booking button booked nothing, and ' : ''}the steps got stuck on ${page.url()}: ${err.message.split('\n')[0]}`);
            log('execute', `${made ? 'the booking went through, but the steps after it got stuck' : err.committed ? 'pressing the booking button booked nothing' : 'the steps got stuck'}: ${err.message.split('\n')[0]}`, { url: page.url(), committed: made });
            continue;
          }
        } else {
          try {
            result = await execute({ startAt: rehearsal.commitIndex + 1, startUrl: booked.url }, booked.inputs);
            reused = true;
          } catch (err) {
            if (err instanceof OverBudget) throw err;
            await remember();
            rejections.push(`attempt ${n}: the steps after booking failed on the booking already made: ${err.message.split('\n')[0]}`);
            log('execute', `the steps after booking failed on the booking already made: ${err.message.split('\n')[0]}`, { url: page.url(), existing: true });
            continue;
          }
        }

        const wrong = learnedProblems(result.records, booked.inputs, outputs);
        log('validate', wrong.length ? `read the booking back, but: ${wrong.join('; ')}` : 'read the booking back: every field is there, the typed details are shown back, and the library record agrees', {
          records: result.records,
          problems: wrong,
          learn: true,
          existing: reused ? 'the booking an earlier try made' : null,
        });
        if (wrong.length) {
          await remember();
          rejections.push(`attempt ${n} booked and read back ${JSON.stringify(result.records)}, but ${wrong.join('; ')}`);
          continue;
        }
        learned = { steps: derived.plan.steps, model: derived.model, records: result.records, snapshot: shape, attempts: n };
      } catch (err) {
        if (err instanceof OverBudget || err.quota) throw err;
        rejections.push(`attempt ${n} crashed: ${err.message}`);
        log('error', `attempt ${n} crashed: ${err.message}`);
      } finally {
        await session?.close();
      }
    }
  } catch (err) {
    if (!(err instanceof OverBudget || err.quota)) throw err;
    log('budget', `${err.message}. Stopped learning`, { used: err.used ?? null, cap: err.cap ?? null, modelQuota: !!err.quota });
    return finish('capped', err.message);
  }

  const bookingsAfter = await ownedSiteBookings(cap);
  const during = bookingsBefore !== null && bookingsAfter !== null ? bookingsAfter - bookingsBefore : null;
  if (during !== null) log('ledger', `bookings made while learning: ${during}`, { during, learn: true });

  if (!learned) {
    log('done', `could not learn a booking that passes in ${MAX_ATTEMPTS} tries`, { failed: true, attempts: MAX_ATTEMPTS });
    return finish('failed', rejections.join('; '));
  }
  const contract = deriveContract(learned.records, booked.inputs);
  const origin = `learned from a sentence on ${new Date().toISOString().slice(0, 10)} (${learned.model})`;
  const plan = await adoptLearnedPlan(cap, { steps: learned.steps, origin, contract, inputs: booked.inputs, afterCommitUrl: booked.url, snapshot: learned.snapshot });
  log('contract', `golden sample captured. required: ${contract.requiredFields.join(', ')}`, { requiredFields: contract.requiredFields, fieldTypes: contract.fieldTypes, echoes: contract.echoes, agreements: contract.agreements });
  log('done', `learned from the sentence in ${learned.attempts} tr${learned.attempts === 1 ? 'y' : 'ies'}, saved as steps v${plan.version}`, {
    via: 'learned',
    planId: plan.id,
    version: plan.version,
    model: learned.model,
    attempts: learned.attempts,
    bookings: during,
    steps: learned.steps,
  });
  await finish('derived', null);
  return { plan, model: learned.model, attempts: learned.attempts, during, inputs: booked.inputs, steps: learned.steps, records: learned.records };
}
