// Real redesigns nobody scripted: Anvil learns a reading task on a real site as the Wayback Machine kept it
// years ago, then runs those steps on the live site today. Where the site changed, the normal run → triage →
// repair path takes over, through Anakin's URL Scraper and the same code the deployed app uses.
//
//   node --env-file=.env scripts/redesigns.mjs [--json out.json] [site names]
//
// Costs Anakin credits (about 4 a site) and model calls.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SITES = [
  { name: 'Hacker News', url: 'https://news.ycombinator.com/', at: '20190101004439', goal: 'the front page stories with their title, link and points' },
  { name: 'GitHub Trending', url: 'https://github.com/trending', at: '20190101095445', goal: 'the trending repositories with their name, description and total stars' },
  { name: 'Python events', url: 'https://www.python.org/events/python-events/', at: '20180129122303', goal: 'upcoming Python events with their name, date and location' },
  { name: 'Rust blog', url: 'https://blog.rust-lang.org/', at: '20190117003348', goal: 'the blog posts with their title, date and link' },
  { name: 'kernel.org', url: 'https://www.kernel.org/', at: '20180101024002', goal: 'the kernel releases with their release type, version and release date' },
  { name: 'LWN', url: 'https://lwn.net/', at: '20180101034306', goal: 'the front page articles with their title and link' },
];

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const jsonOut = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : null;
const only = args.length ? new Set(args) : null;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(`${tmpdir()}/anvil-redesigns-`);
process.env.DATABASE_URL = `file:${dir}/redesigns.db`;
process.env.ALLOWED_SITES = ['web.archive.org', ...SITES.map((s) => new URL(s.url).hostname.replace(/^www\./, ''))].join(',');
process.env.ANAKIN_HOURLY_CREDITS ??= '80';
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { cwd: ROOT, env: process.env, stdio: 'ignore' });

const { db } = await import('../src/db.mjs');
const { tracer } = await import('../src/trace.mjs');
const { scrape } = await import('../src/anakin.mjs');
const { mayFetch } = await import('../src/conduct.mjs');
const { deriveReadPlan } = await import('../src/derive.mjs');
const { dryRun } = await import('../src/derive-read.mjs');
const { deriveContract } = await import('../src/contract.mjs');
const { pageShape, compactHtml } = await import('../src/page-shape.mjs');
const { adoptFirstPlan } = await import('../src/capabilities.mjs');
const { executeRun } = await import('../src/run.mjs');
const { executeRepair } = await import('../src/repair.mjs');
const { creditsUsed } = await import('../src/budget.mjs');

async function learnOnArchive(site, id) {
  const archived = `https://web.archive.org/web/${site.at}id_/${site.url}`;
  await mayFetch(archived);
  const page = await scrape(archived, { formats: ['markdown', 'html'] });
  if (!page.html) throw new Error('the Wayback copy came back without html');
  let feedback = null;
  for (let n = 1; n <= 3; n++) {
    const d = await deriveReadPlan({ goal: site.goal, url: site.url, markdown: (page.markdown ?? '').slice(0, 5000), html: compactHtml(page.html), feedback });
    d.plan.steps = Array.isArray(d.plan.steps) ? d.plan.steps : [];
    const nav = d.plan.steps.find((s) => s.kind === 'navigate');
    if (nav) nav.url = site.url;
    const dry = dryRun(d, page, site.url);
    if (!dry.problems.length) {
      const contract = deriveContract(dry.records, {});
      await db.capability.create({ data: { id, name: site.name, goal: site.goal, entryUrl: site.url, targetUrl: site.url, inputSchema: {}, canary: '', engine: 'scrape', status: 'deriving' } });
      await adoptFirstPlan(id, { engine: 'scrape', targetUrl: site.url, canary: d.canary, steps: d.plan.steps, origin: `learned on the ${site.at.slice(0, 4)} Wayback copy (${d.model})`, contract, snapshot: pageShape(page.html) });
      return { tries: n, model: d.model, records: dry.records.length, sample: dry.records[0], steps: d.plan.steps };
    }
    feedback = dry.problems.join('; ');
  }
  throw new Error(`no working plan for the Wayback copy in 3 tries (${feedback})`);
}

async function runLive(id) {
  const run = await db.run.create({ data: { capabilityId: id, inputs: {} } });
  const log = await tracer({ runId: run.id }, { echo: false });
  await executeRun(run.id, log);
  await log.flush();
  const done = await db.run.findUnique({ where: { id: run.id } });
  const trace = await db.traceEvent.findMany({ where: { runId: run.id }, orderBy: { seq: 'asc' } });
  const why = trace.find((e) => e.kind === 'triage')?.label ?? null;
  const amended = trace.find((e) => e.kind === 'contract' && e.detail?.amended)?.detail.amended.join('; ') ?? null;
  return { run: done, amended, why: why && (why.length > 300 ? `${why.slice(0, 300)}…` : why) };
}

const results = [];
for (const site of SITES.filter((s) => !only || only.has(s.name))) {
  const id = site.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const row = { site: site.name, url: site.url, snapshot: `${site.at.slice(0, 4)}-${site.at.slice(4, 6)}-${site.at.slice(6, 8)}`, goal: site.goal };
  results.push(row);
  const t0 = Date.now();
  const credits0 = await creditsUsed();
  try {
    row.learned = await learnOnArchive(site, id);
    const live = await runLive(id);
    row.live = { status: live.run.status, failureKind: live.run.failureKind, records: live.run.result?.records?.length ?? 0, why: live.why, amended: live.amended };
    if (live.run.result?.repairId) {
      const repairId = live.run.result.repairId;
      const job = await db.job.findFirst({ where: { kind: 'repair', refId: repairId } });
      const log = await tracer({ repairId }, { echo: false });
      const t = Date.now();
      await executeRepair(repairId, job.payload ?? {}, log);
      await log.flush();
      const rep = await db.repairAttempt.findUnique({ where: { id: repairId } });
      const trace = await db.traceEvent.findMany({ where: { repairId }, orderBy: { seq: 'asc' } });
      row.repair = {
        outcome: rep.outcome,
        tries: trace.filter((e) => e.kind === 'attempt').length,
        seconds: Math.round((Date.now() - t) / 1000),
        changed: trace.filter((e) => e.kind === 'diff').map((e) => e.label),
        rejected: trace.filter((e) => ['reject', 'validate'].includes(e.kind) && e.detail?.problems?.length).map((e) => e.label),
        models: trace.filter((e) => e.kind === 'derive' && e.detail?.model).map((e) => e.detail.model),
      };
      if (rep.outcome === 'repaired') {
        const again = await runLive(id);
        row.after = { status: again.run.status, records: again.run.result?.records?.length ?? 0, sample: again.run.result?.records?.[0] ?? null, steps: (await db.plan.findFirst({ where: { capabilityId: id, active: true } })).steps };
      }
    }
  } catch (err) {
    row.error = err.message;
  }
  row.seconds = Math.round((Date.now() - t0) / 1000);
  row.credits = (await creditsUsed()) - credits0;
  const verdict = row.error
    ? `error: ${row.error.slice(0, 120)}`
    : row.live.status === 'succeeded'
      ? `old steps still work today (${row.live.records} records)`
      : `old steps broke (${row.live.failureKind}) → repair ${row.repair?.outcome ?? '-'} in ${row.repair?.tries ?? 0} tr${row.repair?.tries === 1 ? 'y' : 'ies'}, ${row.repair?.seconds ?? 0}s → ${row.after ? `${row.after.status}, ${row.after.records} records` : 'not run again'}`;
  console.log(`${site.name.padEnd(16)} learned on ${row.snapshot} (${row.learned?.records ?? 0} records, ${row.learned?.tries ?? 0} tries) | ${verdict} | ${row.credits} credits, ${row.seconds}s`);
  if (row.repair?.changed?.length) console.log(`    what changed: ${row.repair.changed.join(' | ').slice(0, 400)}`);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
}
await db.$disconnect();
