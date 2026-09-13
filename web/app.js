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

const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
  }
  node.append(...kids.filter((k) => k !== null && k !== undefined));
  return node;
};

function notice(id, text, bad = false) {
  const n = $(id);
  n.textContent = text ?? '';
  n.classList.toggle('bad', bad);
}

const PATRONS = [
  { name: 'Priya Raman', email: 'priya.raman@example.com', seats: 3 },
  { name: 'Tomas Ortega', email: 'tomas.ortega@example.com', seats: 5 },
  { name: 'Amara Okafor', email: 'amara.okafor@example.com', seats: 2 },
  { name: 'Lena Vogel', email: 'lena.vogel@example.com', seats: 4 },
];
let patron = 0;

let capabilities = [];
let selected = null;

// ---------------------------------------------------------------- trace

const trace = $('trace');
const following = new Set();
const DIM = new Set(['queued', 'step', 'browser', 'anakin', 'conduct', 'model', 'run', 'attempt', 'worker', 'health']);

function nearBottom() {
  return window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
}

function addToTrace(node) {
  $('empty')?.remove();
  const stick = nearBottom();
  trace.append(node);
  if (stick) node.scrollIntoView({ block: 'end', behavior: 'smooth' });
}

function recordsTable(records) {
  if (!records?.length) return el('p', { class: 'small', text: 'No records.' });
  const cols = [...new Set(records.flatMap((r) => Object.keys(r)))].slice(0, 8);
  return el(
    'table',
    {},
    el('thead', {}, el('tr', {}, ...cols.map((c) => el('th', { text: c })))),
    el('tbody', {}, ...records.slice(0, 25).map((r) => el('tr', {}, ...cols.map((c) => el('td', { text: r[c] === null || r[c] === undefined ? '—' : String(r[c]) }))))),
  );
}

function eventRow(e, start) {
  const secs = ((Date.parse(e.createdAt) - start) / 1000).toFixed(1);
  const d = e.detail ?? {};
  const good = e.kind === 'done' && (d.status === 'succeeded' || d.via) && !d.failed;
  const bad = (e.kind === 'done' && (d.status === 'failed' || d.failed)) || (e.kind === 'conduct' && /^not fetching/.test(e.label)) || (e.kind === 'triage' && d.kind !== 'empty');
  const row = el(
    'li',
    { class: `ev k-${e.kind}${DIM.has(e.kind) ? ' dim' : ''}${good ? ' good' : ''}${bad ? ' bad' : ''}` },
    el('time', { text: `+${secs}s` }),
    el('span', { class: 'kind', text: e.kind }),
    el('span', { class: 'label', text: e.label }),
  );
  const steps = d.steps;
  if (Array.isArray(steps) && steps.length)
    row.append(el('details', {}, el('summary', { text: `the ${steps.length} steps` }), el('pre', { text: steps.map((s, i) => `${i + 1}. ${JSON.stringify(s)}`).join('\n') })));
  const records = d.records ?? d.sample;
  if (Array.isArray(records) && records.length && e.kind !== 'done')
    row.append(el('details', {}, el('summary', { text: `${records.length} record${records.length === 1 ? '' : 's'}` }), el('div', { class: 'result' }, recordsTable(records))));
  if (d.requiredFields) row.append(el('details', {}, el('summary', { text: 'the contract' }), el('pre', { text: JSON.stringify({ requiredFields: d.requiredFields, fieldTypes: d.fieldTypes, minRecords: d.minRecords, bounds: d.bounds, echoes: d.echoes }, null, 1) })));
  return row;
}

const TITLES = { run: 'Run', repair: 'Repair', derivation: 'Working out a plan' };

function jobBlock(type, subtitle) {
  const status = el('span', { class: 'status live', text: 'queued' });
  const meta = el('span', { class: 'meta', text: subtitle ?? '' });
  const events = el('ol', { class: 'events' });
  const result = el('div', { class: 'result' });
  const next = el('div', { class: 'next' });
  const node = el('article', { class: `job ${type}` }, el('header', {}, el('span', { class: 'what', text: TITLES[type] }), meta, status), events, result, next);
  addToTrace(node);
  return { node, status, meta, events, result, next };
}

function setStatus(block, text, live) {
  block.status.textContent = text;
  block.status.classList.toggle('live', !!live);
}

async function follow(type, id) {
  const key = `${type}:${id}`;
  if (following.has(key)) return;
  following.add(key);
  const block = jobBlock(type);
  // on a phone the trace sits under the controls, so take people to it
  if (window.innerWidth < 820) block.node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  let after = 0;
  let start = null;
  for (;;) {
    const { status, json } = await api('GET', `/api/${type === 'derivation' ? 'derivations' : `${type}s`}/${id}?after=${after}`);
    if (status === 404) {
      setStatus(block, 'gone (the demo was reset)');
      break;
    }
    if (status !== 200) {
      await sleep(3000);
      continue;
    }
    const stick = nearBottom();
    for (const e of json.trace) {
      start ??= Date.parse(e.createdAt);
      block.events.append(eventRow(e, start));
      after = e.seq;
    }
    if (json.trace.length && stick) block.node.scrollIntoView({ block: 'end' });
    const c = json.capability;
    if (c) block.meta.textContent = `${c.name}${c.plan ? ` · plan v${c.plan.version}` : ''}`;
    const row = json[type];
    const state = row.status ?? row.outcome;
    if (!['queued', 'running'].includes(state)) {
      setStatus(block, state);
      finish(type, block, json);
      break;
    }
    setStatus(block, state, true);
    await sleep(1000);
  }
  await refreshCapabilities();
  loadTarget();
}

function finish(type, block, json, { replay = false } = {}) {
  if (type === 'run') {
    const r = json.run;
    if (r.status === 'succeeded') {
      block.result.append(recordsTable(r.result?.records));
    } else if (r.status === 'capped') {
      block.result.append(el('p', { class: 'small', text: r.result?.why ?? 'credit budget used up' }));
      if (!replay) playDemo('This run hit the hourly Anakin budget.');
    } else {
      block.result.append(el('p', { class: 'small', text: `${r.failureKind ?? 'failed'}: ${r.result?.why ?? ''}` }));
      if (r.result?.repairId && !replay) follow('repair', r.result.repairId);
    }
  }
  if (type === 'repair') {
    const r = json.repair;
    const lines = {
      repaired: `New plan promoted as v${json.capability?.plan?.version}. Only because the result passed the contract.`,
      degraded: 'Three attempts failed. The old plan was kept and the capability is marked degraded, so it will not repair itself again until someone asks.',
      capped: `Stopped early: ${r.diagnosis}. The plan was left as it was.`,
      skipped: `Not attempted: ${r.diagnosis}.`,
    };
    block.result.append(el('p', { class: 'small', text: lines[r.outcome] ?? r.diagnosis ?? '' }));
    if (r.outcome === 'repaired' && !replay) block.next.append(el('button', { type: 'button', text: 'Run it again', onclick: () => $('run-button').click() }));
  }
  if (type === 'derivation') {
    const d = json.derivation;
    if (d.outcome === 'derived') {
      if (d.screenshot) block.result.append(el('details', {}, el('summary', { text: 'screenshot Anakin took of the page' }), el('img', { class: 'shot', src: d.screenshot, alt: `Screenshot of ${d.operativeUrl}`, loading: 'lazy' })));
      if (!replay)
        block.next.append(
          el('button', {
            type: 'button',
            text: 'Run it',
            onclick: async () => {
              await refreshCapabilities(d.capabilityId);
              $('run-button').click();
            },
          }),
        );
    } else {
      block.result.append(el('p', { class: 'small', text: `${d.outcome}: ${d.diagnosis ?? ''}` }));
    }
  }
}

// A recorded run from a real session, replayed at its own pace (long waits squeezed).
let replaying = false;
async function playDemo(reason) {
  if (replaying) return;
  const { status, json } = await api('GET', '/api/demo');
  if (status !== 200) return;
  replaying = true;
  const when = new Date(json.recordedAt).toLocaleString();
  addToTrace(el('p', { class: 'banner', text: `${reason} So what follows is a recording of a real run from ${when}, replayed. None of it is happening now.` }));
  for (const job of json.jobs) {
    if (job.note) addToTrace(el('p', { class: 'banner', text: job.note }));
    const block = jobBlock(job.type, `recorded · ${job.subtitle ?? ''}`);
    setStatus(block, 'replaying', true);
    const start = Date.parse(job.trace[0]?.createdAt ?? json.recordedAt);
    let last = start;
    for (const e of job.trace) {
      await sleep(Math.min(Date.parse(e.createdAt) - last, 1500));
      last = Date.parse(e.createdAt);
      block.events.append(eventRow(e, start));
      if (nearBottom()) block.node.scrollIntoView({ block: 'end' });
    }
    setStatus(block, `${job.final[job.type]?.status ?? job.final[job.type]?.outcome} (recorded)`);
    finish(job.type, block, job.final, { replay: true });
  }
  replaying = false;
}

// ---------------------------------------------------------------- capability

const current = () => capabilities.find((c) => c.id === selected);

function renderInputs(cap) {
  const box = $('inputs');
  box.replaceChildren();
  const sample = PATRONS[patron % PATRONS.length];
  for (const [key, type] of Object.entries(cap?.inputSchema ?? {})) {
    box.append(el('label', { class: 'field' }, el('span', { text: key }), el('input', { name: key, type: type === 'number' ? 'number' : key === 'email' ? 'email' : 'text', value: sample[key] ?? '', required: true })));
  }
}

function renderCapability() {
  const cap = current();
  if (!cap) return;
  const state = el('span', { class: `state ${cap.status}`, text: cap.status });
  $('health').replaceChildren(state, document.createTextNode(cap.plan ? ` · plan v${cap.plan.version} · ${cap.plan.origin}` : ' · no plan yet'));
  $('goal').textContent = cap.goal;
  $('site-block').hidden = cap.engine !== 'browser';
  $('repair-button').hidden = !(cap.engine === 'browser' && cap.status === 'degraded');
  $('run-button').disabled = !cap.plan;
}

async function refreshCapabilities(select) {
  const { status, json } = await api('GET', '/api/capabilities');
  if (status !== 200) return;
  // the breakable demo first, then read capabilities newest first
  capabilities = json.capabilities.filter((c) => c.plan || c.status === 'deriving').sort((a, b) => (a.engine === 'browser' ? -1 : 0) - (b.engine === 'browser' ? -1 : 0) || json.capabilities.indexOf(b) - json.capabilities.indexOf(a));
  $('allowed').textContent = json.allowedSites.length ? json.allowedSites.join(', ') : 'none on this deployment';
  const before = selected;
  selected = select ?? (capabilities.some((c) => c.id === selected) ? selected : capabilities[0]?.id);
  const pick = $('capability');
  pick.replaceChildren(...capabilities.map((c) => el('option', { value: c.id, text: `${c.name}${c.engine === 'browser' ? '' : ` — ${new URL(c.targetUrl).hostname}`}`, selected: c.id === selected })));
  if (before !== selected) renderInputs(current());
  renderCapability();
}

$('capability').addEventListener('change', (e) => {
  selected = e.target.value;
  renderInputs(current());
  renderCapability();
});

$('run-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cap = current();
  if (!cap) return;
  const inputs = Object.fromEntries(new FormData(e.target).entries());
  $('run-button').disabled = true;
  notice('run-notice', '');
  const { status, json } = await api('POST', '/api/runs', { capabilityId: cap.id, inputs });
  $('run-button').disabled = false;
  if (status === 202) {
    patron++;
    renderInputs(cap);
    follow('run', json.id);
  } else if (status === 409 && json.runId) {
    notice('run-notice', 'A run is already in flight on this capability, following that one instead.');
    follow('run', json.runId);
  } else if (status === 503 && json.capped) {
    notice('run-notice', json.error, true);
    playDemo(`${json.error}.`);
  } else {
    notice('run-notice', json.error ?? `that did not work (${status})`, true);
  }
});

$('repair-button').addEventListener('click', async () => {
  const { status, json } = await api('POST', '/api/repairs', { capabilityId: selected });
  if (status === 202) follow('repair', json.id);
  else if (status === 409 && json.repairId) follow('repair', json.repairId);
  else notice('run-notice', json.error, true);
});

// ---------------------------------------------------------------- demo site

async function loadTarget() {
  const { status, json } = await api('GET', '/api/target');
  if (status !== 200) {
    notice('site-notice', json.error ?? 'the demo site is not answering', true);
    return;
  }
  $('owned').textContent = json.owned;
  $('pages').replaceChildren(...json.pages.map((p) => el('li', { text: p })));
  const applied = new Set(json.breaks.map((b) => b.kind));
  const busy = !!json.busy;
  $('breaks').replaceChildren(
    ...Object.entries(json.kinds).map(([kind, label]) =>
      el('button', { type: 'button', class: 'quiet', disabled: busy || applied.has(kind), title: applied.has(kind) ? 'already broken this way' : '', text: applied.has(kind) ? `${label} ✓` : label, onclick: () => breakSite(kind) }),
    ),
    el('button', { type: 'button', disabled: busy, text: 'Reset site and Anvil', onclick: () => breakSite(null) }),
  );
  if (busy) notice('site-notice', 'Something is running on the demo site; breaking it waits until that finishes.');
  else if ($('site-notice').textContent.startsWith('Something is running')) notice('site-notice', '');
}

async function breakSite(kind) {
  notice('site-notice', kind ? 'Breaking…' : 'Resetting…');
  const { status, json } = kind ? await api('POST', '/api/target/break', { kind }) : await api('POST', '/api/target/reset', {});
  if (status === 200) notice('site-notice', `${kind ? 'Done: ' : ''}${json.detail}. ${kind ? 'Now run it again.' : ''}`);
  else notice('site-notice', json.error ?? `that did not work (${status})`, true);
  await loadTarget();
  await refreshCapabilities();
}

// ---------------------------------------------------------------- read another site

$('read-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  notice('read-notice', '');
  const { status, json } = await api('POST', '/api/capabilities', body);
  if (status === 202) {
    notice('read-notice', 'Queued. Follow along in the trace.');
    await refreshCapabilities();
    follow('derivation', json.derivationId);
  } else if (status === 503 && json.capped) {
    notice('read-notice', json.error, true);
    playDemo(`${json.error}.`);
  } else {
    notice('read-notice', json.error ?? `that did not work (${status})`, true);
  }
});

await refreshCapabilities();
renderInputs(current());
await loadTarget();
setInterval(() => {
  refreshCapabilities();
  loadTarget();
}, 6000);
