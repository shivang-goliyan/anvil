// Tier A: from a URL and a goal to a working read capability.
// Wire first. If no prebuilt action fits: Map, Crawl, pick the page, scrape it, derive, run, learn.

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mapSite, crawl, scrape, screenshot, wireCatalogs, wireCatalog, wireResolve } from './anakin.mjs';
import { mayFetch, NotAllowed } from './conduct.mjs';
import { checkPlanShape } from './plan.mjs';
import { runReadPlan, extract, hasSelector } from './read-plan.mjs';
import { scrapeFetcher, runWireStep, hasRealFields } from './read-engines.mjs';
import { deriveContract } from './contract.mjs';
import { pageShape, compactHtml } from './page-shape.mjs';
import { pickPage, deriveReadPlan, chooseWireAction, shortlistLinks } from './derive.mjs';
import { OverBudget } from './errors.mjs';
import { db } from './db.mjs';
import { adoptFirstPlan } from './capabilities.mjs';

const SHOTS = fileURLToPath(new URL('../state/screenshots/', import.meta.url));
const TYPES = new Set(['string', 'number']);
const STOP = new Set('the and for with from that this these those list get show find all each every their its what which who how page site data into about more most than then them they have has also only just like over under your you give return returns want need'.split(' '));

const same = (a, b) => a.replace(/\/$/, '') === b.replace(/\/$/, '');

// [anchor text](href) pairs from scraped markdown, resolved against the page they came from.
export function markdownLinks(markdown, base) {
  const out = [];
  for (const m of String(markdown).matchAll(/(?<!!)\[([^\]\n]{1,160})\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    try {
      out.push({ url: new URL(m[2], base).toString(), text: m[1].replace(/[*_`]/g, '').trim() });
    } catch {}
  }
  return out;
}

const words = (s) => [...new Set(String(s).toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].filter((w) => !STOP.has(w));

// Cheap first cut over the Map result: same host, not a file, path mentions words from the goal.
export function rankLinks(links, goal, entryUrl, max = 6) {
  const ws = words(goal);
  const entry = new URL(entryUrl);
  const seen = new Set([entry.toString()]);
  return links
    .map((l) => {
      try {
        return new URL(l);
      } catch {
        return null;
      }
    })
    .filter((u) => u && u.hostname === entry.hostname && !/\.(png|jpe?g|gif|svg|webp|pdf|zip|css|js|xml|ico|rss)$/i.test(u.pathname))
    .map((u) => {
      const path = decodeURIComponent(`${u.pathname}${u.search}`).toLowerCase();
      return { url: u.toString(), score: ws.filter((w) => path.includes(w)).length };
    })
    .filter((x) => x.score > 0 && !seen.has(x.url) && seen.add(x.url))
    .sort((a, b) => b.score - a.score || a.url.length - b.url.length)
    .slice(0, max);
}

async function tryWire(cap, log) {
  const host = new URL(cap.entryUrl).hostname.replace(/^www\./, '');
  const catalogs = await wireCatalogs();
  const covering = catalogs.filter((c) => c.domain && c.status !== 'pending_review' && (host === c.domain || host.endsWith(`.${c.domain}`)));
  if (!covering.length) {
    log('wire', `none of the ${catalogs.length} Wire catalogs covers ${host}, deriving a plan instead`, { host, catalogs: catalogs.length });
    return null;
  }
  log('wire', `Wire covers ${host}: ${covering.map((c) => `${c.slug} (${c.action_count} actions)`).join(', ')}`, { catalogs: covering.map((c) => c.slug) });

  const ranked = (await wireResolve(cap.goal)).map((r) => r.action_id);
  const actions = [];
  for (const c of covering.slice(0, 2)) {
    const detail = await wireCatalog(c.slug);
    for (const a of detail.actions ?? [])
      if (a.type === 'read' && a.auth_mode === 'none' && (a.status ?? 'active') === 'active')
        actions.push({ action_id: a.action_id, name: a.name, description: a.description, parameters: a.parameters ?? [], credits: a.credits_per_call ?? 1 });
  }
  const rank = (id) => (ranked.includes(id) ? ranked.indexOf(id) : 999);
  actions.sort((a, b) => rank(a.action_id) - rank(b.action_id));
  const hits = actions.filter((a) => ranked.includes(a.action_id)).map((a) => a.action_id);
  log('wire', `${actions.length} read actions that need no login. resolve-actions ranks ${hits.length ? hits.join(', ') : 'none of them'} for this goal`, {
    actions: actions.map((a) => a.action_id),
    resolved: ranked,
  });
  if (!actions.length) return null;

  const choice = await chooseWireAction({ goal: cap.goal, url: cap.entryUrl, actions: actions.slice(0, 15) });
  for (const s of choice.skipped) log('model', `skipped ${s}`);
  const action = actions.find((a) => a.action_id === choice.actionId);
  if (!action) {
    log('wire', `no prebuilt action fits the goal (${choice.model}: ${choice.why || 'no reason given'})`, { model: choice.model });
    return null;
  }
  log('wire', `prebuilt action ${action.action_id} fits: ${choice.why}`, { actionId: action.action_id, params: choice.params, model: choice.model });
  return { action, params: choice.params };
}

async function viaWire(cap, derivation, wire, log) {
  const step = { kind: 'wire', actionId: wire.action.action_id, params: wire.params, credits: wire.action.credits };
  const out = await runWireStep(step, { log, siteUrl: cap.entryUrl });
  log('result', `${wire.action.action_id} returned ${out.records.length} record${out.records.length === 1 ? '' : 's'}${out.path ? ` from "${out.path}"` : ''}`, {
    records: out.records.slice(0, 5),
    ms: out.ms,
  });
  if (!hasRealFields(out.records)) return null;
  step.recordsPath = out.path;
  const contract = deriveContract(out.records, {});
  const snapshot = { hash: `wire:${step.actionId}`, shape: { wire: step.actionId, params: step.params } };
  const { plan } = await adoptFirstPlan(cap.id, { engine: 'wire', targetUrl: cap.entryUrl, canary: '', steps: [step], origin: `wire (${step.actionId})`, contract, snapshot });
  log('contract', `golden sample captured from ${out.records.length} records. required: ${contract.requiredFields.join(', ')}`, contractDetail(contract));
  await db.derivation.update({ where: { id: derivation.id }, data: { via: 'wire', operativeUrl: cap.entryUrl } });
  return plan;
}

const contractDetail = (c) => ({ requiredFields: c.requiredFields, fieldTypes: c.fieldTypes, minRecords: c.minRecords, bounds: c.bounds });

async function findOperativePage(cap, log) {
  const map = await mapSite(cap.entryUrl, { limit: 150, depth: 1, log });
  const ranked = rankLinks(map.links ?? [], cap.goal, cap.entryUrl);
  log('discover', `map found ${map.links?.length ?? 0} links. ${ranked.length ? `closest to the goal by their paths: ${ranked.map((r) => new URL(r.url).pathname).join(', ')}` : 'none of their paths mention the goal'}`, {
    links: map.links?.length ?? 0,
    ranked,
  });
  // Paths often say nothing (/pages/simple/, /table/?from=USD) but the words people click on do.
  // So when path words find fewer than two pages, crawl from the page given, read its links with
  // their anchor text, and let the model shortlist from those.
  let sampled = null;
  const anchors = new Map();
  if (ranked.length < 2 && map.links?.length) {
    const host = new URL(cap.entryUrl).hostname;
    const crawled = await crawl(cap.entryUrl, { maxPages: 3, log });
    sampled = (crawled.results ?? []).filter((p) => p.status === 'completed' && p.markdown);
    log('discover', `crawl sampled ${sampled.length} page${sampled.length === 1 ? '' : 's'} from ${cap.entryUrl}: ${sampled.map((p) => p.url).join(', ')}`, {
      pages: sampled.map((p) => ({ url: p.url, chars: p.markdown.length })),
    });
    const entryPage = sampled.find((p) => same(p.url, cap.entryUrl)) ?? sampled[0];
    for (const l of markdownLinks(entryPage?.markdown ?? '', entryPage?.url ?? cap.entryUrl)) if (new URL(l.url).hostname === host && !anchors.has(l.url)) anchors.set(l.url, l.text);
    const mapped = map.links.filter((l) => URL.canParse(l) && new URL(l).hostname === host && ![...anchors.keys()].some((a) => same(a, l)));
    const links = [...[...anchors].map(([url, text]) => ({ url, text })), ...[...new Set(mapped)].map((url) => ({ url }))].slice(0, 150);
    const short = await shortlistLinks({ goal: cap.goal, entryUrl: cap.entryUrl, links });
    for (const s of short.skipped) log('model', `skipped ${s}`);
    for (const u of short.urls) if (!ranked.some((r) => same(r.url, u))) ranked.push({ url: u, score: 0 });
    log('discover', short.urls.length ? `from ${anchors.size} labelled links the model shortlisted ${short.urls.map((u) => `${u}${anchors.get(u) ? ` ("${anchors.get(u)}")` : ''}`).join(', ')} (${short.why})` : `the model found nothing better in the link list (${short.why})`, {
      model: short.model,
      urls: short.urls,
    });
  }

  const candidates = [];
  for (const r of ranked) {
    try {
      await mayFetch(r.url);
      candidates.push(r.url);
    } catch (err) {
      if (!(err instanceof NotAllowed)) throw err;
      log('conduct', `leaving out ${r.url}: ${err.message}`);
    }
    if (candidates.length === 2) break;
  }
  if (!candidates.length) {
    log('discover', 'nothing on the map looks closer to the goal than the page given, so that is the page');
    return cap.entryUrl;
  }

  // Crawl only filters the first few links it finds, so includePatterns cannot reach a deep page
  // (seen on python.org 2026-09-13). Starting the crawl at the best candidate always samples it.
  let pages = sampled;
  if (!pages) {
    const crawled = await crawl(candidates[0], { maxPages: 3, log });
    pages = (crawled.results ?? []).filter((p) => p.status === 'completed' && p.markdown);
    log('discover', `crawl sampled ${pages.length} page${pages.length === 1 ? '' : 's'} from ${candidates[0]}: ${pages.map((p) => p.url).join(', ')}`, {
      pages: pages.map((p) => ({ url: p.url, chars: p.markdown.length })),
    });
  }

  // pages the crawl did not bring back still go to the model, by URL and link text
  const options = [
    ...pages.map((p) => ({ url: p.url, excerpt: p.markdown.slice(0, 1800) })),
    ...[...candidates, cap.entryUrl]
      .filter((u, i, all) => all.indexOf(u) === i && !pages.some((p) => same(p.url, u)))
      .map((u) => ({ url: u, excerpt: anchors.get(u) ? `(not sampled; the site links to it as "${anchors.get(u)}")` : '(not sampled, judge by the URL)' })),
  ];
  if (options.length < 2) return options[0]?.url ?? cap.entryUrl;

  const pick = await pickPage({ goal: cap.goal, candidates: options });
  for (const s of pick.skipped) log('model', `skipped ${s}`);
  const chosen = options.find((o) => same(o.url, String(pick.url ?? '')))?.url;
  log('pick', chosen ? `operative page: ${chosen} (${pick.why})` : `model named a page that was not a candidate (${pick.url}), keeping ${cap.entryUrl}`, { model: pick.model, url: pick.url });
  return chosen ?? cap.entryUrl;
}

// Checks a derived plan against the page we already have, before spending a credit on running it.
// Models write "fields" as {name: "string"} or {name: {type: "string"}}; either is fine. Without it,
// the extract step's own field types say the same thing.
function outputFields(derived) {
  const ex = (derived.plan.steps ?? []).find((s) => s.kind === 'extract');
  const raw = derived.fields && typeof derived.fields === 'object' && Object.keys(derived.fields).length ? derived.fields : ex?.fields ?? {};
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === 'object' && v ? v.type ?? ex?.fields?.[k]?.type : v]));
}

function dryRun(derived, page, url) {
  const problems = [];
  const fields = (derived.fields = outputFields(derived));
  const names = Object.keys(fields);
  if (!names.length) problems.push('no output fields');
  for (const [k, t] of Object.entries(fields)) if (!TYPES.has(t)) problems.push(`field "${k}" has type ${JSON.stringify(t)}, use "string" or "number"`);
  problems.push(...checkPlanShape(derived.plan, { outputFields: names }));
  const bad = (derived.plan.steps ?? []).filter((s) => !['navigate', 'assert', 'extract'].includes(s.kind));
  if (bad.length) problems.push(`read-only plans cannot ${bad.map((s) => s.kind).join(', ')}`);
  if (!derived.canary || !hasSelector(page.html, derived.canary)) problems.push(`canary "${derived.canary}" matches nothing on the page`);
  if (problems.length) return { problems };

  const ex = derived.plan.steps.find((s) => s.kind === 'extract');
  const assert = derived.plan.steps.find((s) => s.kind === 'assert');
  if (assert && !hasSelector(page.html, assert.selector)) problems.push(`assert selector "${assert.selector}" matches nothing`);
  let records = [];
  try {
    records = extract(page.html, ex, url);
  } catch (err) {
    return { problems: [`extract selectors do not parse: ${err.message}`] };
  }
  if (!records.length) problems.push(ex.each ? `"each" selector "${ex.each}" matches nothing` : 'extract produced nothing');
  for (const name of names) {
    const filled = records.filter((r) => r[name] !== null).length;
    if (records.length && filled < Math.ceil(records.length * 0.8)) problems.push(`field "${name}" came back empty in ${records.length - filled} of ${records.length} records (selector "${ex.fields?.[name]?.selector}")`);
    const wrong = records.find((r) => r[name] !== null && typeof r[name] !== fields[name]);
    if (wrong) problems.push(`field "${name}" should be ${fields[name]} but got ${JSON.stringify(wrong[name])}`);
  }
  return { problems, records };
}

async function viaDerivation(cap, derivation, log) {
  const operative = await findOperativePage(cap, log);
  await mayFetch(operative, { log });

  const page = await scrape(operative, { formats: ['markdown', 'html', 'screenshot'], log });
  if (!page.html) throw new Error('the scraper returned no html for the operative page');
  let shotPath = null;
  if (page.screenshotUrl) {
    try {
      const png = await screenshot(page.id);
      await mkdir(SHOTS, { recursive: true });
      shotPath = `${SHOTS}${derivation.id}.png`;
      await writeFile(shotPath, png);
      log('read', `scraped ${operative}: ${page.markdown?.length ?? 0} chars of markdown, a ${Math.round(png.length / 1024)} KB screenshot saved`, { url: operative, screenshot: true });
    } catch (err) {
      log('read', `scraped ${operative}, but the screenshot did not download: ${err.message}`, { url: operative, screenshot: false });
    }
  } else {
    log('read', `scraped ${operative}: ${page.markdown?.length ?? 0} chars of markdown, no screenshot came back`, { url: operative, screenshot: false });
  }
  await db.derivation.update({ where: { id: derivation.id }, data: { operativeUrl: operative, screenshot: shotPath } });

  const html = compactHtml(page.html);
  let feedback = null;
  let derived = null;
  for (let n = 1; n <= 3; n++) {
    const d = await deriveReadPlan({ goal: cap.goal, url: operative, markdown: (page.markdown ?? '').slice(0, 5000), html, feedback });
    for (const s of d.skipped) log('model', `skipped ${s}`);
    d.plan.steps = Array.isArray(d.plan.steps) ? d.plan.steps : [];
    const nav = d.plan.steps.find((s) => s.kind === 'navigate');
    if (nav) nav.url = operative;
    const check = dryRun(d, page, operative);
    log('derive', `attempt ${n}: plan from ${d.model} in ${(d.ms / 1000).toFixed(1)}s`, { model: d.model, fields: d.fields, canary: d.canary, steps: d.plan.steps, promptChars: d.promptChars });
    if (!check.problems.length) {
      log('check', `dry run on the scraped page: ${check.records.length} records, every field filled`, { sample: check.records.slice(0, 3) });
      derived = d;
      break;
    }
    feedback = `${check.problems.join('; ')}.${check.records?.length ? ` First records it produced: ${JSON.stringify(check.records.slice(0, 3))}` : ''}`;
    log('reject', check.problems.join('; '), { problems: check.problems });
  }
  if (!derived) return { failed: 'the model did not produce a plan that extracts the data after 3 tries' };

  // the real thing: a fresh read through the same runner every later run uses
  const result = await runReadPlan(derived.plan, {
    baseUrl: operative,
    fetchPage: scrapeFetcher(log),
    onStep: (i, s) => log('step', `${i + 1}. ${s.kind} ${s.kind === 'navigate' ? s.url : s.each ?? s.selector ?? ''}`, { index: i, step: s }),
  });
  const empties = Object.keys(derived.fields).filter((f) => result.records.some((r) => r[f] === null));
  log('result', `extracted ${result.records.length} records from the live page${empties.length ? `, some empty values in ${empties.join(', ')}` : ''}`, { records: result.records.slice(0, 5) });
  if (!result.records.length) return { failed: 'the plan worked on the sampled page but found nothing on the fresh read' };

  const contract = deriveContract(result.records, {});
  if (!contract.requiredFields.length) return { failed: 'no field was filled on every record, nothing to hold a contract to' };
  const snapshot = pageShape(result.entryHtml ?? page.html);
  const { plan } = await adoptFirstPlan(cap.id, {
    engine: 'scrape',
    targetUrl: operative,
    canary: derived.canary,
    steps: derived.plan.steps,
    origin: `derived (${derived.model})`,
    contract,
    snapshot,
  });
  log('contract', `golden sample captured from ${result.records.length} records. required: ${contract.requiredFields.join(', ')}; at least ${contract.minRecords} records`, contractDetail(contract));
  await db.derivation.update({ where: { id: derivation.id }, data: { via: 'derived' } });
  return { plan };
}

export async function executeDerive(derivationId, log) {
  const derivation = await db.derivation.findUnique({ where: { id: derivationId } });
  if (!derivation) return log('error', 'this derivation no longer exists');
  const cap = await db.capability.findUnique({ where: { id: derivation.capabilityId } });
  const finish = async (outcome, capStatus, diagnosis) => {
    await log.flush();
    await db.derivation.update({ where: { id: derivationId }, data: { outcome, diagnosis } });
    if (capStatus) await db.capability.update({ where: { id: cap.id }, data: { status: capStatus } });
  };

  await db.derivation.update({ where: { id: derivationId }, data: { outcome: 'running' } });
  log('derive', `goal: ${cap.goal}`, { goal: cap.goal, url: cap.entryUrl });
  try {
    await mayFetch(cap.entryUrl, { log });

    const wire = await tryWire(cap, log);
    if (wire) {
      try {
        const plan = await viaWire(cap, derivation, wire, log);
        if (plan) {
          await log('done', `capability ready on prebuilt action ${wire.action.action_id}, no plan derivation needed`, { via: 'wire', planId: plan.id });
          return finish('derived', null, `wire action ${wire.action.action_id}`);
        }
        log('wire', 'the prebuilt action came back without usable records, deriving a plan instead');
      } catch (err) {
        if (err instanceof OverBudget || err instanceof NotAllowed) throw err;
        log('wire', `the prebuilt action failed (${err.message}), deriving a plan instead`);
      }
    }

    const out = await viaDerivation(cap, derivation, log);
    if (out.failed) {
      await log('done', `could not derive a working plan: ${out.failed}`, { failed: true });
      return finish('failed', 'degraded', out.failed);
    }
    await log('done', `capability ready on derived plan v${out.plan.version}`, { via: 'derived', planId: out.plan.id });
    return finish('derived', null, null);
  } catch (err) {
    if (err instanceof OverBudget) {
      await log('budget', `${err.message}. Stopped before calling Anakin again`, { used: err.used, cap: err.cap });
      return finish('capped', 'degraded', err.message);
    }
    if (err.quota) {
      await log('budget', `${err.message}. Stopped here`, { modelQuota: true });
      return finish('capped', 'degraded', err.message);
    }
    if (err instanceof NotAllowed) {
      await log('conduct', `not fetching: ${err.message}`, { url: err.url, rule: err.rule ?? null });
      return finish('failed', 'degraded', err.message);
    }
    throw err;
  }
}
