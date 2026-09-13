const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  try {
    const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  } catch {
    return { status: 0, json: { error: 'could not reach Anvil, check your connection' } };
  }
}

function h(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
  return node;
}

function notice(id, text, bad = false) {
  $(id).textContent = text ?? '';
  $(id).classList.toggle('bad', bad);
}

const fmt = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// every [data-since] element shows the time elapsed since that moment
setInterval(() => {
  for (const node of document.querySelectorAll('[data-since]')) node.textContent = fmt(Date.now() - Number(node.dataset.since));
}, 500);

const PATRONS = [
  { name: 'Priya Raman', email: 'priya.raman@example.com', seats: 3 },
  { name: 'Tomas Ortega', email: 'tomas.ortega@example.com', seats: 5 },
  { name: 'Amara Okafor', email: 'amara.okafor@example.com', seats: 2 },
  { name: 'Lena Vogel', email: 'lena.vogel@example.com', seats: 4 },
];
let patron = 0;
let capabilities = [];
let selected = null;

// ------------------------------------------------------------------ plans in words

function stepText(s) {
  if (!s) return '';
  if (s.kind === 'navigate') return `open ${s.url}`;
  if (s.kind === 'fill') return `fill ${s.selector}  ←  ${s.value}`;
  if (s.kind === 'click') return `click ${s.selector}`;
  if (s.kind === 'submit') return `submit ${s.selector}`;
  if (s.kind === 'assert') return `expect ${s.selector}`;
  if (s.kind === 'extract') return `read ${s.each ? `each ${s.each}: ` : ''}${Object.entries(s.fields ?? {}).map(([k, f]) => (s.each ? k : `${k} ${f.selector}`)).join(', ')}`;
  if (s.kind === 'wire') return `Wire action ${s.actionId}`;
  return s.kind;
}

// longest common subsequence, so a rewritten plan reads as kept / added / removed lines
function diffSteps(before = [], after = []) {
  const a = before.map(stepText);
  const b = after.map(stepText);
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ op: 'keep', step: after[j], n: j + 1 });
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || dp[i][j + 1] >= dp[i + 1][j])) {
      out.push({ op: 'add', step: after[j], n: j + 1 });
      j++;
    } else {
      out.push({ op: 'del', step: before[i], n: '' });
      i++;
    }
  }
  return out;
}

function diffView(before, after) {
  const rows = diffSteps(before, after);
  const added = rows.filter((r) => r.op === 'add').length;
  const removed = rows.filter((r) => r.op === 'del').length;
  return h(
    'div',
    {},
    h('div', { class: 'diff' }, rows.map((r) => h('div', { class: r.op }, h('span', { class: 'm', text: r.op === 'add' ? '+' : r.op === 'del' ? '−' : '' }), h('span', { class: 'n', text: r.n }), h('span', { class: 's', text: stepText(r.step) })))),
    h('p', { class: 'diff-legend', text: before?.length ? `${added} step${added === 1 ? '' : 's'} added, ${removed} removed, ${rows.length - added - removed} kept from the old plan` : `${after.length} steps` }),
  );
}

function recordsView(records, limit = 8) {
  if (!records?.length) return h('p', { class: 'card-note', text: 'No records came back.' });
  const cols = [...new Set(records.flatMap((r) => Object.keys(r)))].slice(0, 6);
  return h(
    'div',
    { class: 'records' },
    h('table', {}, h('thead', {}, h('tr', {}, cols.map((c) => h('th', { text: c })))), h('tbody', {}, records.slice(0, limit).map((r) => h('tr', {}, cols.map((c) => h('td', { text: r[c] === null || r[c] === undefined ? '—' : String(r[c]) })))))),
    records.length > limit ? h('div', { class: 'more', text: `and ${records.length - limit} more` }) : null,
  );
}

// ------------------------------------------------------------------ timeline plumbing

const timeline = $('timeline');
const following = new Set();

function place(node, { scroll = false } = {}) {
  $('empty')?.remove();
  timeline.append(node);
  if (scroll) requestAnimationFrame(() => node.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function marker(title, small, info = false) {
  place(h('div', { class: `marker${info ? ' info' : ''}` }, h('span', { class: 'bolt', text: info ? '◎' : '⚡' }), h('p', {}, title, small ? h('small', { text: small }) : null)));
}

function jobCard(title, { forge = false } = {}) {
  const chip = h('span', { class: 'chip queued live', text: 'queued' });
  const clock = h('span', { class: 'clock', 'data-since': Date.now() });
  const sub = h('span', { class: 'sub' });
  const body = h('div');
  const next = h('div', { class: 'next' });
  const rawList = h('ol');
  const rawSummary = h('summary', { text: 'raw trace' });
  const node = h('article', { class: `job${forge ? ' forge' : ''}`, style: 'scroll-margin-top: 96px' }, h('div', { class: 'job-head' }, h('h3', { text: title }), sub, h('div', { class: 'right' }, clock, chip)), body, next, h('details', { class: 'raw' }, rawSummary, rawList));
  return { node, chip, clock, sub, body, next, rawList, rawSummary, count: 0 };
}

function setChip(card, text, tone, live = false) {
  card.chip.className = `chip ${tone}${live ? ' live' : ''}`;
  card.chip.textContent = text;
}

function stopClock(card, ms) {
  card.clock.removeAttribute('data-since');
  if (ms !== undefined && !Number.isNaN(ms)) card.clock.textContent = fmt(ms);
}

function rawEvent(card, e, start) {
  card.count++;
  card.rawSummary.textContent = `raw trace · ${card.count} event${card.count === 1 ? '' : 's'}`;
  card.rawList.append(h('li', {}, h('time', { text: `+${((Date.parse(e.createdAt) - start) / 1000).toFixed(1)}s` }), h('b', { text: e.kind }), h('span', { text: e.label })));
}

function stepItem(list, { icon = '·', tone = '', title, text, extra } = {}) {
  const li = h('li', { class: tone }, h('span', { class: 'ico', text: icon }), h('div', {}, h('h4', { text: title }), text ? h('p', { text }) : null, extra ?? null));
  list.append(li);
  return li;
}

// the "what is it doing right now" row, with a live clock, at the bottom of a stepper
function liveRow(view, title, hint) {
  view.live?.remove();
  view.live = h('li', { class: 'live warm' }, h('span', { class: 'ico', text: '◐' }), h('div', {}, h('h4', {}, title, h('span', { class: 'thinking' }, h('i'), h('i'), h('i'))), h('p', {}, h('span', { 'data-since': Date.now() }), hint ? ` · ${hint}` : '')));
  view.stepper.append(view.live);
}
function endLive(view) {
  view.live?.remove();
  view.live = null;
}

const MODEL_HINT = 'free models usually take 10 to 90 seconds';
const cap1 = (s) => String(s ?? '').replace(/^./, (c) => c.toUpperCase());

// Playwright and network errors, said the way a person would
const humanize = (s) =>
  String(s ?? '')
    .replace(/page\.(fill|click|waitForSelector|goto): Timeout (\d+)ms exceeded\.?/g, (_, verb, ms) => `nothing on the page matched within ${Number(ms) / 1000}s`)
    .replace(/net::ERR_CONNECTION_REFUSED/g, 'the site did not answer')
    .replace(/net::ERR_HTTP_RESPONSE_CODE_FAILURE/g, 'the site answered with an error page')
    .replace(/\.\.+/g, '.')
    .replace(/\s+at https?:\/\/\S+/g, '');
const short = (s, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ------------------------------------------------------------------ run view

const VERDICTS = {
  structural: (why) => ['Structural failure', `The page loaded fine, but the plan no longer fits it: ${why}. This is the one kind of failure Anvil repairs.`],
  transient: (why) => ['Looks like a hiccup', `${cap1(why)}. Retried without touching the plan.`],
  blocked: (why) => ['Blocked', `${cap1(why)}. A new plan cannot fix a block, so Anvil marks the capability degraded instead of repairing.`],
  empty: () => ['Nothing to return', 'The page rendered and there were simply no records. That counts as a success.'],
};

function runView(card, capability) {
  const bar = h('i');
  const now = h('div', { class: 'now', text: 'waiting for the worker' });
  const progress = h('div', { class: 'progress' }, h('div', { class: 'bar' }, bar), now);
  card.body.append(progress);
  let total = capability?.plan?.stepCount ?? null;
  return {
    event(e) {
      const d = e.detail ?? {};
      if (e.kind === 'run') {
        card.sub.textContent = `plan v${d.version}${d.try > 1 ? ` · retry ${d.try - 1}` : ''}`;
        setChip(card, 'running', 'run', true);
        bar.style.width = '4%';
      } else if (e.kind === 'anakin') {
        now.textContent = e.label;
      } else if (e.kind === 'step') {
        total ??= 7;
        bar.style.width = `${Math.min(100, ((d.index + 1) / total) * 100)}%`;
        now.textContent = short(`${d.index + 1}/${total} · ${stepText(d.step)}`, 110);
      } else if (e.kind === 'triage') {
        const [title, text] = (VERDICTS[d.kind] ?? VERDICTS.transient)(humanize(e.label.replace(/^\w+: /, '')).replace(/\.$/, ''));
        card.body.append(h('div', { class: `verdict ${d.kind}` }, h('h4', { text: `Triage · ${title}` }), h('p', { text })));
      } else if (e.kind === 'retry') {
        now.textContent = e.label;
        bar.style.width = '0';
      } else if (e.kind === 'contract' && d.requiredFields) {
        const echoes = Object.keys(d.echoes ?? {});
        card.body.append(h('div', { class: 'verdict transient' }, h('h4', { text: 'Contract learned from this first good run' }), h('p', { text: `From now on, a plan only counts if ${d.requiredFields.join(', ')} come back filled in with the same types${echoes.length ? `, and ${echoes.join(', ')} match what was typed in` : ''}.` })));
      } else if (e.kind === 'budget') {
        card.body.append(h('div', { class: 'verdict capped' }, h('h4', { text: 'Credit budget reached' }), h('p', { text: e.label })));
      } else if (e.kind === 'repair' && d.circuitBreaker) {
        card.body.append(h('div', { class: 'verdict blocked' }, h('h4', { text: 'Not repairing automatically' }), h('p', { text: e.label })));
      }
    },
    finish(json, { replay }) {
      progress.remove();
      const r = json.run;
      stopClock(card, r.endedAt && r.startedAt ? Date.parse(r.endedAt) - Date.parse(r.startedAt) : undefined);
      const records = r.result?.records ?? [];
      if (r.status === 'succeeded') {
        const rec = records[0];
        setChip(card, rec?.reference ? 'booked' : r.result?.empty ? 'nothing to return' : 'succeeded', 'good');
        if (rec?.reference) {
          card.body.prepend(
            h('div', { class: 'booked' }, h('div', { class: 'ref' }, h('small', { text: 'Booking reference' }), rec.reference), h('div', { class: 'vals' }, ['name', 'email', 'seats'].filter((k) => rec[k] !== undefined).map((k) => h('span', { text: k === 'seats' ? `${rec[k]} seats` : String(rec[k]) })))),
          );
        } else {
          card.body.prepend(recordsView(records));
        }
      } else if (r.status === 'capped') {
        setChip(card, 'budget used up', 'warm');
        if (!card.body.querySelector('.verdict')) card.body.append(h('div', { class: 'verdict capped' }, h('h4', { text: 'Credit budget reached' }), h('p', { text: r.result?.why ?? '' })));
        if (!replay) playRecording('This run hit the hourly Anakin budget.');
      } else {
        setChip(card, r.failureKind ? `failed · ${r.failureKind}` : 'failed', 'bad');
        if (!card.body.querySelector('.verdict')) card.body.append(h('div', { class: 'verdict' }, h('h4', { text: 'Failed' }), h('p', { text: humanize(r.result?.why) })));
        if (r.result?.repairId && !replay) follow('repair', r.result.repairId);
      }
    },
  };
}

// ------------------------------------------------------------------ repair view (the dark one)

function repairView(card) {
  const view = { stepper: h('ol', { class: 'stepper' }), live: null };
  card.body.append(view.stepper);
  let fromSteps = null;
  let changes = null;
  let running = null;
  let skipped = 0;
  const add = (opts) => {
    endLive(view);
    return stepItem(view.stepper, opts);
  };
  const outcome = (tone, big, text) => {
    endLive(view);
    card.body.querySelector('.outcome')?.remove();
    view.stepper.after(h('div', { class: `outcome ${tone}` }, h('span', { class: 'big', text: big }), h('p', { text })));
  };
  return {
    context(json) {
      fromSteps ??= json.fromPlan?.steps ?? null;
    },
    event(e) {
      const d = e.detail ?? {};
      if (e.kind === 'queued') {
        card.sub.textContent = d.trigger === 'monitor' ? 'started by Anakin Website Monitoring' : d.trigger === 'manual' ? 'started by hand' : 'started by the failed run';
      } else if (e.kind === 'repair' && d.fromPlanId !== undefined) {
        setChip(card, 'repairing', 'warm', true);
        add({ icon: '⌫', title: cap1(e.label.replace(/^repair started \([^)]*\), /, '')), text: d.failure ? `Why: ${humanize(d.failure)}` : null });
      } else if (e.kind === 'repair' && /backing off/.test(e.label)) {
        endLive(view);
      } else if (e.kind === 'repair') {
        add({ icon: '!', tone: 'bad', title: cap1(e.label) });
      } else if (e.kind === 'attempt') {
        endLive(view);
        changes = null;
        view.stepper.append(h('li', { class: 'attempt' }, h('span', { text: e.label })));
      } else if (e.kind === 'read') {
        add({ icon: '↻', title: 'Re-read the live page', text: e.label.replace(/^re-read the live page /, '') });
      } else if (e.kind === 'diff') {
        if (!changes) {
          changes = h('ul', { class: 'changes' });
          add({ icon: 'Δ', tone: 'warm', title: 'What changed on the page', extra: changes });
        }
        changes.append(h('li', { text: /no structural change/.test(e.label) ? 'The first page looks the same, so the change is further into the flow.' : e.label }));
        liveRow(view, 'Asking the model for a new plan', MODEL_HINT);
      } else if (e.kind === 'derive' && /^skipped/.test(e.label)) {
        skipped++;
      } else if (e.kind === 'derive') {
        add({ icon: '✎', title: `New plan written in ${(d.ms / 1000).toFixed(1)}s`, text: `${d.model}${skipped ? ` · after skipping ${skipped} unavailable` : ''}` });
        skipped = 0;
      } else if (e.kind === 'plan') {
        add({ icon: '≡', tone: 'good', title: 'The plan, rewritten', extra: diffView(fromSteps ?? [], d.steps ?? []) });
        running = add({ icon: '▶', title: 'Running it for real', text: 'in the same remote browser' });
        liveRow(view, 'Running the new plan', 'Anakin Browser API');
      } else if (e.kind === 'step' && running) {
        running.querySelector('p').textContent = short(`step ${d.index + 1}: ${stepText(d.step)}`);
      } else if (e.kind === 'reject') {
        add({ icon: '✕', tone: 'bad', title: 'Plan rejected before running it', text: e.label });
      } else if (e.kind === 'execute') {
        add({ icon: '✕', tone: 'bad', title: 'It got stuck', text: `${cap1(humanize(e.label.replace(/^candidate plan failed: /, '')).replace(/\.$/, ''))}. The next attempt gets to see that page.` });
      } else if (e.kind === 'validate') {
        const bad = d.problems?.length;
        const rec = d.records?.[0] ?? {};
        const extra = bad ? h('ul', { class: 'checks' }, d.problems.map((p) => h('li', { class: 'miss', text: p }))) : h('ul', { class: 'checks' }, Object.entries(rec).map(([k, v]) => h('li', {}, h('b', { text: k }), `✓ ${v}`)));
        add({ icon: bad ? '✕' : '✓', tone: bad ? 'bad' : 'good', title: bad ? 'Contract check failed' : 'Contract check passed', extra });
      } else if (e.kind === 'promote') {
        outcome('', `Plan v${d.version}`, 'promoted. The result passed the contract, so this is now the plan every run uses.');
      } else if (e.kind === 'rollback') {
        outcome('bad', 'Rolled back', `${cap1(e.label)}. It says so instead of pretending.`);
      } else if (e.kind === 'budget') {
        outcome('warm', 'Stopped', e.label);
      } else if (e.kind === 'error') {
        add({ icon: '!', tone: 'bad', title: 'Attempt crashed', text: e.label });
      }
    },
    finish(json, { replay }) {
      endLive(view);
      stopClock(card);
      const r = json.repair;
      const tones = { repaired: ['repaired', 'good'], degraded: ['degraded', 'bad'], capped: ['stopped · budget', 'warm'], skipped: ['skipped', 'warm'], failed: ['failed', 'bad'] };
      const [text, tone] = tones[r.outcome] ?? [r.outcome, ''];
      setChip(card, text, tone);
      if (r.outcome === 'skipped' && !card.body.querySelector('.outcome')) outcome('warm', 'Skipped', r.diagnosis ?? '');
      if (r.outcome === 'repaired' && !replay) card.next.append(h('button', { type: 'button', class: 'btn blue', text: 'Run it again →', onclick: () => $('run-button').click() }));
    },
  };
}

// ------------------------------------------------------------------ derivation view

function derivationView(card) {
  const view = { stepper: h('ol', { class: 'stepper' }), live: null };
  card.body.append(view.stepper);
  let group = null;
  let groupKind = null;
  const add = (opts) => {
    endLive(view);
    groupKind = null;
    return stepItem(view.stepper, opts);
  };
  const grouped = (kind, title, icon, text) => {
    if (groupKind !== kind) {
      endLive(view);
      const li = stepItem(view.stepper, { icon, title });
      group = li.querySelector('div');
      groupKind = kind;
    }
    group.append(h('p', { text }));
    return group.closest('li');
  };
  return {
    event(e) {
      const d = e.detail ?? {};
      if (e.kind === 'derive' && d.goal) {
        card.sub.textContent = new URL(d.url).hostname;
        setChip(card, 'working', 'run', true);
      } else if (e.kind === 'conduct') {
        const refused = /^not fetching/.test(e.label);
        const li = grouped('conduct', refused ? 'Not allowed to read it' : 'Allowed to read it', '§', e.label);
        if (refused) li.className = 'bad';
      } else if (e.kind === 'wire') {
        grouped('wire', "Checked Anakin's Wire catalog first", 'W', e.label);
      } else if (e.kind === 'discover') {
        grouped('discover', 'Found the pages with Map and Crawl', '⌕', e.label);
      } else if (e.kind === 'pick') {
        add({ icon: '✓', tone: 'good', title: 'Picked the page that holds the data', text: e.label.replace(/^operative page: /, '') });
      } else if (e.kind === 'read') {
        add({ icon: '↓', title: 'Scraped it with Anakin URL Scraper', text: e.label });
        liveRow(view, 'Asking the model for a plan', MODEL_HINT);
      } else if (e.kind === 'derive' && d.steps) {
        add({ icon: '✎', title: `Plan from ${d.model}`, extra: diffView([], d.steps) });
      } else if (e.kind === 'check') {
        add({ icon: '✓', tone: 'good', title: 'Dry run on the scraped page worked', text: e.label.replace(/^dry run on the scraped page: /, ''), extra: recordsView(d.sample, 3) });
        liveRow(view, 'Reading the live page through the runner', 'fresh scrape');
      } else if (e.kind === 'reject') {
        add({ icon: '✕', tone: 'bad', title: 'Plan rejected, asking again', text: e.label });
        liveRow(view, 'Asking the model again', MODEL_HINT);
      } else if (e.kind === 'result') {
        add({ icon: '▦', tone: 'good', title: cap1(e.label), extra: recordsView(d.records, 5) });
      } else if (e.kind === 'contract') {
        add({ icon: '✓', tone: 'good', title: 'Contract learned', extra: h('ul', { class: 'checks' }, (d.requiredFields ?? []).map((f) => h('li', {}, h('b', { text: f }), d.fieldTypes?.[f] ?? ''))) });
      } else if (e.kind === 'done') {
        endLive(view);
      } else if (e.kind === 'budget' || e.kind === 'error') {
        add({ icon: '!', tone: 'bad', title: e.kind === 'budget' ? 'Stopped: budget' : 'Error', text: e.label });
      }
    },
    finish(json, { replay }) {
      endLive(view);
      stopClock(card);
      const d = json.derivation;
      if (d.outcome === 'derived') {
        setChip(card, d.via === 'wire' ? 'ready · Wire action' : 'ready', 'good');
        if (d.screenshot) card.body.append(h('details', { class: 'raw' }, h('summary', { text: 'screenshot Anakin took of the page' }), h('img', { class: 'shot', src: d.screenshot, alt: `Screenshot of ${d.operativeUrl}`, loading: 'lazy' })));
        if (!replay)
          card.next.append(
            h('button', {
              type: 'button',
              class: 'btn blue',
              text: 'Run it →',
              onclick: async () => {
                await refreshCapabilities(d.capabilityId);
                renderComposer(current());
                run();
              },
            }),
          );
      } else {
        setChip(card, d.outcome, d.outcome === 'capped' ? 'warm' : 'bad');
        card.body.append(h('div', { class: 'outcome bad' }, h('span', { class: 'big', text: 'No plan' }), h('p', { text: d.diagnosis ?? '' })));
      }
    },
  };
}

const VIEWS = { run: runView, repair: repairView, derivation: derivationView };
const TITLES = { run: 'Run', repair: 'Repair', derivation: 'New read capability' };

// ------------------------------------------------------------------ following jobs

async function follow(type, id, { scroll = true } = {}) {
  const key = `${type}:${id}`;
  if (following.has(key)) return;
  following.add(key);
  const card = jobCard(TITLES[type], { forge: type === 'repair' });
  place(card.node, { scroll });
  let view = null;
  let after = 0;
  let start = null;
  const path = type === 'derivation' ? `/api/derivations/${id}` : `/api/${type}s/${id}`;
  for (;;) {
    const { status, json } = await api('GET', `${path}?after=${after}`);
    if (status === 404) {
      setChip(card, 'gone · the demo was reset', '');
      stopClock(card);
      break;
    }
    if (status !== 200) {
      await sleep(2500);
      continue;
    }
    view ??= VIEWS[type](card, json.capability);
    view.context?.(json);
    for (const e of json.trace) {
      start ??= Date.parse(e.createdAt);
      view.event(e);
      rawEvent(card, e, start);
      after = e.seq;
    }
    const row = json[type];
    const state = row.status ?? row.outcome;
    if (!['queued', 'running'].includes(state)) {
      view.finish(json, { replay: false });
      break;
    }
    await sleep(1000);
  }
  await refreshCapabilities();
  loadTarget();
  loadBudget();
}

// A real run recorded earlier, replayed with its real events. Long waits are squeezed, and it says so.
let replaying = false;
async function playRecording(reason) {
  if (replaying) return;
  const { status, json } = await api('GET', '/api/demo');
  if (status !== 200) return notice('run-notice', 'No recording is saved on this deployment.', true);
  replaying = true;
  $('replay-button').disabled = true;
  const when = new Date(json.recordedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  place(h('div', { class: 'banner' }, h('b', { text: 'Recording' }), h('p', { text: `${reason} This is a real run from ${when}, replayed with its real events and the long waits shortened. None of it is happening right now.` })), { scroll: true });
  for (const job of json.jobs) {
    if (job.type === 'run' && /changed/.test(job.note ?? '')) marker('The demo site was changed', cap1(job.note.replace(/^Then the demo site was changed: /, '').replace(/\. Same plan.*$/, '')));
    const card = jobCard(TITLES[job.type], { forge: job.type === 'repair' });
    card.sub.textContent = 'recorded';
    place(card.node);
    const view = VIEWS[job.type](card, job.final.capability);
    view.context?.(job.final);
    const start = Date.parse(job.trace[0]?.createdAt ?? json.recordedAt);
    let last = start;
    for (const e of job.trace) {
      await sleep(Math.min(Date.parse(e.createdAt) - last, 900));
      last = Date.parse(e.createdAt);
      view.event(e);
      rawEvent(card, e, start);
    }
    view.finish(job.final, { replay: true });
    card.sub.textContent = `recorded · ${card.sub.textContent.replace(/^recorded ?·? ?/, '')}`.replace(/ · $/, '');
    await sleep(600);
  }
  replaying = false;
  $('replay-button').disabled = false;
}

// ------------------------------------------------------------------ capability, composer, health

const current = () => capabilities.find((c) => c.id === selected);

const measure = document.createElement('canvas').getContext('2d');
const sizeInput = (input) => {
  const style = getComputedStyle(input);
  measure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const w = measure.measureText(input.value || input.placeholder || 'xx').width;
  input.style.width = `${Math.ceil(w) + (input.type === 'number' ? 22 : 14)}px`;
};
// fonts arrive after first paint; size again once they have
document.fonts?.ready.then(() => document.querySelectorAll('.sentence input').forEach(sizeInput));

function renderComposer(cap) {
  const box = $('sentence');
  box.replaceChildren();
  if (!cap) return;
  const input = (key, type, value) => {
    const el = h('input', { name: key, type: type === 'number' ? 'number' : key === 'email' ? 'email' : 'text', value: value ?? '', required: true, 'aria-label': key, min: type === 'number' ? 1 : null, max: type === 'number' ? 8 : null, oninput: (e) => sizeInput(e.target) });
    sizeInput(el);
    return el;
  };
  const schema = cap.inputSchema ?? {};
  const sample = PATRONS[patron % PATRONS.length];
  if (cap.engine === 'browser' && schema.name && schema.email && schema.seats) {
    $('composer-kicker').textContent = 'Live on the demo site';
    box.append('Book a study room for ', input('name', 'string', sample.name), ' at ', input('email', 'string', sample.email), ' for ', input('seats', 'number', sample.seats), ' people.');
  } else if (Object.keys(schema).length) {
    $('composer-kicker').textContent = cap.name;
    for (const [k, t] of Object.entries(schema)) box.append(`${k} `, input(k, t, ''), ' ');
  } else {
    $('composer-kicker').textContent = `Read capability · ${new URL(cap.targetUrl).hostname}`;
    box.append(h('span', { text: `Read ${cap.goal}.` }), h('span', { class: 'quiet', text: `from ${cap.targetUrl}` }));
  }
}

function renderHealth(cap) {
  $('health').replaceChildren();
  if (!cap) return;
  $('health').append(h('i', { class: `dot ${cap.status}` }), `${cap.status}${cap.plan ? ` · plan v${cap.plan.version}` : ''}`);
  $('run-button').disabled = !cap.plan;
  $('nav-run').disabled = !cap.plan;
  $('repair-button').hidden = !(cap.engine === 'browser' && cap.status === 'degraded');
  $('site-card').hidden = cap.engine !== 'browser';
}

async function renderPlans(cap) {
  if (!cap) return;
  const { status, json } = await api('GET', `/api/capabilities/${cap.id}`);
  if (status !== 200) return;
  const plans = [...(json.plans ?? [])].reverse();
  $('plans-count').textContent = `${plans.length} version${plans.length === 1 ? '' : 's'}`;
  const nice = (o) => o.replace(/^repair \((.*)\)$/, 'repaired by $1').replace(/^derived \((.*)\)$/, 'derived by $1').replace(/^wire \((.*)\)$/, 'Wire action $1');
  $('plans').replaceChildren(
    ...(plans.length
      ? plans.slice(0, 6).map((p) => h('li', { class: p.active ? 'active' : '' }, h('span', { class: 'v', text: `v${p.version}` }), h('span', { class: 'o', text: nice(p.origin), title: p.origin }), h('time', { text: new Date(p.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })))
      : [h('li', {}, h('span', { class: 'v', text: '—' }), h('span', { class: 'o', text: 'no plan yet' }), h('time'))]),
  );
}

async function refreshCapabilities(select) {
  const { status, json } = await api('GET', '/api/capabilities');
  if (status !== 200) return;
  capabilities = json.capabilities.filter((c) => c.plan || c.status === 'deriving').sort((a, b) => (a.engine === 'browser' ? -1 : 0) - (b.engine === 'browser' ? -1 : 0) || json.capabilities.indexOf(b) - json.capabilities.indexOf(a));
  $('allowed').textContent = json.allowedSites.length ? json.allowedSites.join(', ') : 'none on this deployment';
  const before = current();
  const beforeKey = before && `${before.id}:${before.status}:${before.plan?.version}`;
  selected = select ?? (capabilities.some((c) => c.id === selected) ? selected : capabilities[0]?.id);
  $('capability').replaceChildren(...capabilities.map((c) => h('option', { value: c.id, selected: c.id === selected, text: c.engine === 'browser' ? c.name : `${c.name.slice(0, 40)} — ${new URL(c.targetUrl).hostname}` })));
  const cap = current();
  if (before?.id !== selected) renderComposer(cap);
  renderHealth(cap);
  if (beforeKey !== (cap && `${cap.id}:${cap.status}:${cap.plan?.version}`)) renderPlans(cap);
}

$('capability').addEventListener('change', (e) => {
  selected = e.target.value;
  const cap = current();
  renderComposer(cap);
  renderHealth(cap);
  renderPlans(cap);
  loadTarget();
});

async function run() {
  const cap = current();
  if (!cap?.plan) return;
  const form = $('run-form');
  if (!form.reportValidity()) return;
  const inputs = Object.fromEntries(new FormData(form).entries());
  $('run-button').disabled = true;
  notice('run-notice', '');
  const { status, json } = await api('POST', '/api/runs', { capabilityId: cap.id, inputs });
  $('run-button').disabled = false;
  if (status === 202) {
    patron++;
    renderComposer(cap);
    follow('run', json.id);
  } else if (status === 409 && json.runId) {
    notice('run-notice', 'Someone else is running this right now. Following their run instead.');
    follow('run', json.runId);
  } else if (status === 503 && json.capped) {
    notice('run-notice', json.error, true);
    playRecording(`${json.error}.`);
  } else {
    notice('run-notice', json.error ?? `that did not work (${status})`, true);
  }
}

$('run-form').addEventListener('submit', (e) => {
  e.preventDefault();
  run();
});
$('nav-run').addEventListener('click', () => run());
$('replay-button').addEventListener('click', () => playRecording('You asked for a recorded run.'));
$('repair-button').addEventListener('click', async () => {
  const { status, json } = await api('POST', '/api/repairs', { capabilityId: selected });
  if (status === 202) follow('repair', json.id);
  else if (status === 409 && json.repairId) follow('repair', json.repairId);
  else notice('run-notice', json.error, true);
});

// ------------------------------------------------------------------ the demo site card

const ORIGINAL_NAMES = { name: 'full_name', email: 'email', seats: 'seats' };
const BREAK_ICONS = { 'rename-field': 'Aa', 'add-step': '+', 'reorder-steps': '⇅', 'restyle-confirmation': '▤', surprise: '✦' };
const BREAK_SHORT = { 'rename-field': 'Rename the email field', 'add-step': 'Add a review step', 'reorder-steps': 'Ask seats first', 'restyle-confirmation': 'Rebuild confirmation', surprise: 'Surprise me: a random change' };
// these can be applied again and again, each time differently
const REPEATABLE = new Set(['surprise']);

function miniField(f) {
  const renamed = ORIGINAL_NAMES[f.key] && ORIGINAL_NAMES[f.key] !== f.name;
  return h('div', { class: `fld${renamed ? ' changed' : ''}` }, h('span', { text: f.label }), h('code', { text: `name="${f.name}"` }), h('b'));
}

function renderBrowser(t) {
  const s = t.site;
  const by = Object.fromEntries(s.fields.map((f) => [f.key, f]));
  const page = (title, kids, { changed, flag } = {}) => h('div', { class: `mini${changed ? ' changed' : ''}` }, flag ? h('span', { class: 'flag', text: flag }) : null, h('h5', { text: title }), kids);
  const pages = [];
  if (s.seatsFirst) {
    pages.push(page('Page 1', [miniField(by.seats), h('span', { class: 'go', text: 'Continue' })], { changed: true, flag: 'reordered' }));
    pages.push(page('Page 2', [miniField(by.name), miniField(by.email), h('span', { class: 'go', text: s.submitLabel })]));
  } else {
    const formChanged = s.formId && s.formId !== 'reserve-form';
    pages.push(page('Form', [formChanged ? h('code', { class: 'ref', text: `#${s.formId}` }) : null, s.fields.map(miniField), h('span', { class: 'go', text: s.submitLabel })], { changed: formChanged || s.fields.map((f) => f.key).join() !== 'name,email,seats', flag: formChanged ? 'changed' : s.fields.map((f) => f.key).join() !== 'name,email,seats' ? 'shuffled' : null }));
  }
  if (s.reviewStep) pages.push(page('Review', [h('div', { class: 'rows' }, h('i'), h('i'), h('i')), h('span', { class: 'go', text: 'Confirm' })], { changed: true, flag: 'new step' }));
  const refId = s.confirm?.reference ?? 'reference';
  pages.push(
    page('Confirmation', [h('div', { class: 'rows' }, h('i'), h('i'), s.receiptLayout ? h('i') : null), h('code', { class: 'ref', text: s.receiptLayout ? '.booking-code' : `#${refId}` })], {
      changed: s.receiptLayout || refId !== 'reference',
      flag: s.receiptLayout ? 'rebuilt' : refId !== 'reference' ? 'renamed' : null,
    }),
  );
  const row = pages.flatMap((p, i) => (i ? [h('span', { class: 'arrow', text: '→' }), p] : [p]));
  $('browser').replaceChildren(h('div', { class: 'chrome' }, h('i'), h('i'), h('i'), h('span', { text: `${s.org} · the copy Anakin's browser drives` })), h('div', { class: 'pages' }, row));
}

async function loadTarget() {
  if (current() && current().engine !== 'browser') return;
  const { status, json } = await api('GET', '/api/target');
  if (status !== 200) return notice('site-notice', json.error ?? 'the demo site is not answering', true);
  renderBrowser(json);
  $('site-version').textContent = `site v${json.version}`;
  $('owned').textContent = json.owned;
  $('monitor').hidden = !json.monitor;
  if (json.monitor) {
    const hours = json.monitor.everyMinutes / 60;
    $('monitor').replaceChildren('Anakin Website Monitoring watches ', h('a', { href: json.monitor.page, target: '_blank', rel: 'noopener', text: 'this page' }), ` every ${hours >= 1 ? `${hours} hour${hours === 1 ? '' : 's'}` : `${json.monitor.everyMinutes} minutes`}. When it changes, a repair starts on its own and shows up in the trace.`);
  }
  const applied = new Set(json.breaks.map((b) => b.kind));
  const busy = !!json.busy;
  $('breaks').replaceChildren(
    ...Object.keys(json.kinds).sort((a, b) => REPEATABLE.has(b) - REPEATABLE.has(a)).map((kind) =>
      h(
        'button',
        { type: 'button', class: `brk${REPEATABLE.has(kind) ? ' wild' : applied.has(kind) ? ' done' : ''}`, disabled: busy || (applied.has(kind) && !REPEATABLE.has(kind)), title: json.kinds[kind], onclick: () => breakSite(kind, json.kinds[kind]) },
        h('span', { class: 'ico', text: applied.has(kind) && !REPEATABLE.has(kind) ? '✓' : BREAK_ICONS[kind] ?? '•' }),
        BREAK_SHORT[kind] ?? json.kinds[kind],
      ),
    ),
    h('button', { type: 'button', class: 'brk reset', disabled: busy, onclick: () => breakSite(null) }, 'Reset the site and Anvil'),
  );
  if (busy) notice('site-notice', 'A run or repair is in flight. Breaking waits until it finishes.');
  else if (/in flight/.test($('site-notice').textContent)) notice('site-notice', '');
}

async function breakSite(kind, label) {
  notice('site-notice', kind ? 'Breaking it…' : 'Resetting…');
  const { status, json } = kind ? await api('POST', '/api/target/break', { kind }) : await api('POST', '/api/target/reset', {});
  if (status === 200) {
    notice('site-notice', kind ? 'Done. Now run it again.' : '');
    if (kind) marker(`You broke the site: ${label.replace(/^./, (c) => c.toLowerCase())}`, `${cap1(json.detail)}. The cached plan doesn't know yet.`);
    else marker('Reset', 'The site and Anvil are back to how they started: hand-written plan v1, no contract yet.', true);
  } else {
    notice('site-notice', json.error ?? `that did not work (${status})`, true);
  }
  await loadTarget();
  await refreshCapabilities();
}

// ------------------------------------------------------------------ budget

async function loadBudget() {
  const { status, json } = await api('GET', '/api/budget');
  if (status !== 200) return;
  $('credits').textContent = `${json.used} / ${json.cap} credits`;
  const pct = Math.min(100, (json.used / json.cap) * 100);
  $('credit-bar').style.width = `${pct}%`;
  $('credit-bar').classList.toggle('warm', pct > 70);
}

// ------------------------------------------------------------------ read another site

$('read-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  notice('read-notice', '');
  const { status, json } = await api('POST', '/api/capabilities', body);
  if (status === 202) {
    notice('read-notice', 'Queued. It shows up in the trace.');
    await refreshCapabilities();
    follow('derivation', json.derivationId);
  } else if (status === 503 && json.capped) {
    notice('read-notice', json.error, true);
    playRecording(`${json.error}.`);
  } else {
    notice('read-notice', json.error ?? `that did not work (${status})`, true);
  }
});

// ------------------------------------------------------------------ repairs nobody here asked for

let seenSince = Date.now();
async function watchActivity() {
  const { status, json } = await api('GET', `/api/activity?since=${seenSince}`);
  if (status !== 200) return;
  seenSince = json.now;
  for (const r of json.repairs) {
    if (r.trigger !== 'monitor' || following.has(`repair:${r.id}`)) continue;
    marker('Anakin Website Monitoring saw the site change', 'Nobody pressed anything and no run has failed. Anvil is repairing ahead of time.', true);
    follow('repair', r.id);
  }
}

await refreshCapabilities();
renderComposer(current());
renderPlans(current());
await loadTarget();
loadBudget();
setInterval(() => {
  refreshCapabilities();
  loadTarget();
  loadBudget();
}, 6000);
setInterval(watchActivity, 4000);
