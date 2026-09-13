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
// the demo site as it is right now, so plan steps can use the labels a visitor actually sees
let site = null;

const cap1 = (s) => String(s ?? '').replace(/^./, (c) => c.toUpperCase());
const low1 = (s) => String(s ?? '').replace(/^./, (c) => c.toLowerCase());
const short = (s, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const listWords = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const quoted = (v) => `“${v}”`;

// ------------------------------------------------------------------ plans, in code and in words

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

const FIELD_WORDS = { reference: 'the booking reference', name: 'the name', email: 'the email', seats: 'the number of seats' };

function boxLabel(selector) {
  // a recording ran against the site as it was then, so the labels on the site now could be wrong
  if (replaying) return null;
  const sel = String(selector ?? '');
  const name = sel.match(/name\s*=\s*["']?([\w-]+)/)?.[1] ?? sel.match(/#([\w-]+)/)?.[1];
  return site?.fields?.find((f) => f.name === name)?.label ?? null;
}

// a plan step the way you would say it to someone looking over your shoulder
function plainStep(s, inputs) {
  if (!s) return '';
  if (s.kind === 'navigate') {
    if (!s.url || s.url === '/') return 'Opened the booking page';
    try {
      const u = new URL(s.url);
      return `Opened ${u.hostname}${u.pathname === '/' ? '' : u.pathname}`;
    } catch {
      return `Opened ${s.url}`;
    }
  }
  if (s.kind === 'fill') {
    const key = String(s.value ?? '').match(/\{\{\s*(\w+)\s*\}\}/)?.[1];
    const what = key ? (inputs?.[key] !== undefined ? quoted(inputs[key]) : (FIELD_WORDS[key] ?? key)) : quoted(s.value);
    const label = boxLabel(s.selector);
    return `Typed ${what} into ${label ? `the ${quoted(label)} box` : key ? `the ${key} box` : 'a box'}`;
  }
  if (s.kind === 'click' || s.kind === 'submit') {
    const m = String(s.selector ?? '').match(/has-text\(\s*["'](.+?)["']\s*\)|text\s*=\s*["']?([^"'\]]+)/);
    const text = m?.[1] ?? m?.[2];
    return text ? `Pressed ${quoted(text.trim())}` : s.kind === 'submit' ? 'Pressed the button to send the page' : 'Clicked a button on the page';
  }
  if (s.kind === 'assert') return 'Checked the next page had loaded';
  if (s.kind === 'extract') {
    const words = Object.keys(s.fields ?? {}).map((k) => FIELD_WORDS[k] ?? k);
    return s.each ? `Read ${listWords(words)} for every item on the page` : `Read ${listWords(words)} off the page`;
  }
  if (s.kind === 'wire') return "Asked Anakin's Wire for the data";
  return s.kind;
}

// longest common subsequence, so a rewritten plan reads as kept / added / removed lines
function diffSteps(before = [], after = [], text = stepText) {
  const a = before.map(text);
  const b = after.map(text);
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ op: 'keep', step: after[j], was: before[i], n: j + 1 });
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

// The same diff in words, with the code one click away. Compared as words, so a step whose code
// changed but whose meaning did not stays "same", and a dropped step next to a new one reads as "changed".
function plainDiff(before, after) {
  const rows = diffSteps(before ?? [], after ?? [], (s) => plainStep(s));
  const lines = [];
  for (let i = 0; i < rows.length; ) {
    if (rows[i].op === 'keep') {
      // same words, different code: the step now looks somewhere else on the page
      const adjusted = stepText(rows[i].was) !== stepText(rows[i].step);
      lines.push({ op: adjusted ? 'adjust' : 'keep', text: plainStep(rows[i].step), note: adjusted ? 'same step, now aimed at a different part of the page' : null });
      i++;
      continue;
    }
    const dels = [];
    const adds = [];
    for (; i < rows.length && rows[i].op !== 'keep'; i++) (rows[i].op === 'del' ? dels : adds).push(plainStep(rows[i].step));
    adds.forEach((text, k) => lines.push(k < dels.length ? { op: 'change', text, was: dels[k] } : { op: 'add', text }));
    dels.slice(adds.length).forEach((text) => lines.push({ op: 'del', text }));
  }
  const label = { keep: 'same', add: 'new', del: 'dropped', change: 'changed', adjust: 'adjusted' };
  const codeLines = diffSteps(before, after).filter((r) => r.op !== 'keep').length;
  return h(
    'div',
    {},
    h(
      'ol',
      { class: 'plain-diff' },
      lines.map((l) => h('li', { class: l.op }, h('span', { class: 'm', text: label[l.op] }), h('span', { class: 's' }, l.text, l.was ? h('small', { class: 'was', text: `was: ${low1(l.was)}` }) : null, l.note ? h('small', { text: l.note }) : null))),
    ),
    h('details', { class: 'tech' }, h('summary', { text: before?.length ? `${codeLines} line${codeLines === 1 ? '' : 's'} of code changed · show the code` : 'show the code' }), diffView(before, after)),
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
  const heading = h('h3', { text: title });
  const chip = h('span', { class: 'chip queued live', text: 'waiting' });
  const clock = h('span', { class: 'clock', 'data-since': Date.now() });
  const sub = h('span', { class: 'sub' });
  const body = h('div');
  const next = h('div', { class: 'next' });
  const rawList = h('ol');
  const rawSummary = h('summary', { text: 'technical log' });
  const node = h('article', { class: `job${forge ? ' forge' : ''}`, style: 'scroll-margin-top: 96px' }, h('div', { class: 'job-head' }, heading, sub, h('div', { class: 'right' }, clock, chip)), body, next, h('details', { class: 'raw' }, rawSummary, rawList));
  return { node, heading, chip, clock, sub, body, next, rawList, rawSummary, count: 0 };
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
  card.rawSummary.textContent = `technical log · ${card.count} event${card.count === 1 ? '' : 's'}`;
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

// A ticking list of what the browser did, newest at the bottom.
function checklist() {
  const list = h('ol', { class: 'checklist' });
  let doing = null;
  const settle = (to) => {
    doing?.classList.replace('doing', to);
    doing = null;
  };
  return {
    node: list,
    step(text, code) {
      settle('done');
      doing = h('li', { class: 'doing' }, h('span', { class: 'tick' }), h('div', {}, h('p', { text }), code ? h('code', { text: code }) : null));
      list.append(doing);
    },
    note(text) {
      settle('done');
      list.append(h('li', { class: 'note' }, h('span', { class: 'tick' }), h('div', {}, h('p', { text }))));
    },
    fail: () => settle('failed'),
    finish: () => settle('done'),
  };
}

// Screenshots from the cloud browser, the latest one big, earlier ones as thumbnails.
function viewer(where = "Harbor Lane Library, as Anvil's cloud browser saw it") {
  const img = h('img', { alt: '' });
  const caption = h('figcaption');
  const thumbs = h('div', { class: 'thumbs' });
  const big = h('a', { class: 'shot-big', target: '_blank', rel: 'noopener', title: 'Open the full-size screenshot' }, img);
  const node = h('figure', { class: 'viewer', hidden: true }, h('div', { class: 'chrome' }, h('i'), h('i'), h('i'), h('span', { text: where })), big, caption, thumbs);
  const show = (src, text, tone) => {
    img.src = src;
    img.alt = `Screenshot: ${text}`;
    big.href = src;
    caption.textContent = text;
    caption.className = tone ?? '';
    for (const b of thumbs.children) b.classList.toggle('on', b.dataset.src === src);
  };
  return {
    node,
    add(src, text, tone) {
      node.hidden = false;
      thumbs.append(h('button', { type: 'button', class: tone ?? '', 'data-src': src, title: text, 'aria-label': `Show: ${text}`, onclick: () => show(src, text, tone) }, h('img', { src, alt: '', loading: 'lazy' })));
      thumbs.hidden = thumbs.children.length < 2;
      show(src, text, tone);
    },
  };
}

function shotCaption(d, presses) {
  if (d.stuck) return ['Where it got stuck', 'bad'];
  if (d.kind === 'extract') return ['The page Anvil read the result from', 'good'];
  return [presses ? 'The next page, just before pressing its button' : 'The form filled in, just before pressing the button', ''];
}

const MODEL_HINT = 'free AI models usually take 10 to 90 seconds';

// Playwright and network errors, said the way a person would
const humanize = (s) =>
  String(s ?? '')
    .replace(/page\.(fill|click|waitForSelector|goto): Timeout (\d+)ms exceeded\.?/g, (_, verb, ms) => `nothing on the page matched within ${Number(ms) / 1000}s`)
    .replace(/net::ERR_CONNECTION_REFUSED/g, 'the site did not answer')
    .replace(/net::ERR_HTTP_RESPONSE_CODE_FAILURE/g, 'the site answered with an error page')
    .replace(/\.\.+/g, '.')
    .replace(/\s+at https?:\/\/\S+/g, '');

// ------------------------------------------------------------------ the story so far, for this visitor

// booked: this visitor has had a booking finish. changed: the site differs from what Anvil's steps
// were last proven on. mine: this visitor made that change (the demo is shared, others may have).
const story = { booked: false, changed: false, mine: false, broke: false, fixed: false, again: false, degraded: false, paused: false, others: 0 };

function afterRun(ok, structural) {
  const hadBooked = story.booked;
  story.booked = true;
  // other visitors' changes that the steps already cope with are not part of this visitor's story
  if (ok && story.changed && !story.mine && !story.broke && !story.fixed) story.changed = false;
  if (ok && story.changed && (hadBooked || story.broke || story.fixed)) story.again = true;
  if (structural) story.broke = true;
}

function renderStory() {
  const done = { booked: story.booked, changed: story.changed, fixed: story.fixed, again: story.again };
  const next = story.again ? null : ['booked', 'changed', 'fixed', 'again'].find((k) => !done[k]);
  for (const li of $('story').querySelectorAll('li')) {
    const k = li.dataset.stage;
    li.className = done[k] ? 'done' : k === next ? 'next' : k === 'fixed' && story.again ? 'skipped' : '';
  }
  const b = (t) => `<b>${t}</b>`;
  let hint;
  if (!story.changed) hint = story.booked ? `Booked. Now change the website with the buttons under ${b('The website Anvil works on')} (on the right, or further down on a phone), then book again.` : `Start at the top: press ${b('Send Anvil to book it')}. On its first good booking Anvil also learns what a correct booking looks like.`;
  else if (story.degraded) hint = `This time Anvil could not fix itself in three tries, so it kept its old steps and says so instead of pretending. Press ${b('Put everything back')} to start over.`;
  else if (story.paused && !story.fixed) hint = `The live repair had to pause (the demo's free AI models or its credit budget ran out for now). The recording below shows the whole loop, start to finish. Try again later, or press ${b('Put everything back')}.`;
  else if (story.again && !story.fixed) hint = `That change did not touch anything Anvil's steps rely on, so there was nothing to fix. Try another change, or ${b('Surprise me')}.`;
  else if (story.again) hint = `That is the whole loop: the website changed, Anvil's steps broke, it fixed itself and booked for real. Try ${b('Surprise me')} for a change nobody scripted.`;
  else if (story.fixed) hint = `Fixed and saved as a new version. Book once more to see the new steps work on an ordinary booking.`;
  else if (story.broke) hint = `Anvil's old steps did not fit the changed website. It is fixing itself right now, below.`;
  else if (!story.booked) hint = `Other visitors have already changed this website (${story.others} change${story.others === 1 ? '' : 's'} so far, it is a shared demo). Book a room to see whether Anvil copes, or press ${b('Put everything back')} to start fresh.`;
  else hint = `Now book again. Anvil still has the steps it saved before your change, and nobody has told it the website is different.`;
  $('story-hint').innerHTML = hint;
}

// ------------------------------------------------------------------ run view

function verdictBox(kind, { why, at, reason }) {
  const box = (tone, title, text) => h('div', { class: `verdict ${tone}` }, h('h4', { text: title }), h('p', { text }));
  if (kind === 'structural') {
    const where = at ? `It got stuck on this step: ${low1(at)}. ${reason === 'selector-missing' ? 'What that step was looking for is not on the page any more.' : `${cap1(why)}.`}` : `The booking it came back with did not look right: ${why}.`;
    return box('', 'The website changed, so the saved steps stopped fitting', `${where} The page itself loaded fine, so this is not a network glitch. This is the kind of failure Anvil repairs by itself.`);
  }
  if (kind === 'blocked') return box('blocked', 'The website refused Anvil', `${cap1(why)}. New steps cannot get past a block, so Anvil does not try. It marks itself as needing a person instead.`);
  if (kind === 'empty') return box('transient', 'Nothing to return', 'The page loaded and there was simply nothing there. That counts as a success.');
  return box('transient', 'A hiccup, not a website change', `${cap1(why)}. A hiccup is no reason to change the steps, so Anvil leaves them alone.`);
}

function runView(card, capability) {
  // recordings are only ever of the booking, and older ones do not say which engine they used
  const booking = (capability?.engine ?? 'browser') === 'browser';
  card.heading.textContent = booking ? 'Anvil books a room' : 'Anvil reads the page';
  const list = checklist();
  const view = viewer();
  card.body.append(list.node, view.node);
  list.note('Waiting its turn');
  const waiting = list.node.lastChild;
  let inputs = null;
  const steps = [];
  let presses = 0;
  let failure = null;
  let checked = false;
  return {
    context(json) {
      inputs ??= json.run?.inputs ?? null;
    },
    event(e) {
      const d = e.detail ?? {};
      if (e.kind === 'run') {
        card.sub.textContent = `${booking ? 'on Harbor Lane Library · ' : ''}saved steps v${d.version}${d.try > 1 ? ` · try ${d.try}` : ''}`;
        setChip(card, 'working', 'run', true);
        waiting.remove();
        if (d.try > 1) list.note('Trying again from the start');
        presses = 0;
      } else if (e.kind === 'anakin' && d.call === 'browser' && /opened/.test(e.label)) {
        list.step('Started a real browser in the cloud', 'Anakin Browser API');
      } else if (e.kind === 'anakin' && d.call === 'scrape') {
        list.step("Fetched the page with Anakin's URL Scraper", e.label);
      } else if (e.kind === 'step') {
        steps[d.index] = d.step;
        list.step(plainStep(d.step, inputs), stepText(d.step));
      } else if (e.kind === 'shot') {
        const [text, tone] = shotCaption(d, presses);
        if (!d.stuck && d.kind !== 'extract') presses++;
        view.add(d.src, text, tone);
      } else if (e.kind === 'error') {
        failure = d;
        list.fail();
      } else if (e.kind === 'triage') {
        list.fail();
        const at = failure?.step !== null && failure?.step !== undefined && steps[failure.step] ? plainStep(steps[failure.step], inputs) : null;
        card.body.append(verdictBox(d.kind, { why: humanize(e.label.replace(/^\w+: /, '')).replace(/\.$/, ''), at, reason: failure?.reason }));
      } else if (e.kind === 'contract' && d.requiredFields) {
        const echoes = Object.keys(d.echoes ?? {}).map((k) => FIELD_WORDS[k] ?? k);
        card.body.append(
          h('div', { class: 'verdict transient' }, h('h4', { text: 'Anvil learned what a correct result looks like' }), h('p', { text: `This was the first good ${booking ? 'booking' : 'run'}, so Anvil remembers it: ${listWords(d.requiredFields.map((k) => FIELD_WORDS[k] ?? k))} must come back filled in${echoes.length ? `, and ${listWords(echoes)} must match what was typed in` : ''}. Any new steps it writes later only count if they pass the same check.` })),
        );
      } else if (e.kind === 'contract') {
        checked = !d.problems?.length;
      } else if (e.kind === 'budget') {
        card.body.append(h('div', { class: 'verdict capped' }, h('h4', { text: 'The hourly credit budget is used up' }), h('p', { text: e.label })));
      } else if (e.kind === 'repair' && d.circuitBreaker) {
        card.body.append(h('div', { class: 'verdict blocked' }, h('h4', { text: 'Not repairing automatically' }), h('p', { text: e.label })));
      }
    },
    finish(json, { replay }) {
      const r = json.run;
      stopClock(card, r.endedAt && r.startedAt ? Date.parse(r.endedAt) - Date.parse(r.startedAt) : undefined);
      const records = r.result?.records ?? [];
      if (r.status === 'succeeded') {
        list.finish();
        const rec = records[0];
        setChip(card, rec?.reference ? 'booked' : r.result?.empty ? 'nothing to return' : 'done', 'good');
        if (rec?.reference) {
          const seats = rec.seats !== undefined ? `${rec.seats} seat${rec.seats === 1 ? '' : 's'}` : null;
          card.body.prepend(
            h(
              'div',
              { class: 'booked' },
              h('div', { class: 'ref' }, h('small', { text: 'Booked · reference' }), rec.reference),
              h('p', { text: `A study room for ${[rec.name, seats].filter(Boolean).join(', ')}${rec.email ? `, confirmation to ${rec.email}` : ''}. Anvil read this off the library's confirmation page${checked ? ', and it passed the same check as the first good booking' : ''}.` }),
            ),
          );
        } else {
          card.body.prepend(recordsView(records));
        }
        if (!replay) afterRun(true, false);
      } else if (r.status === 'capped') {
        list.finish();
        setChip(card, 'budget used up', 'warm');
        if (!card.body.querySelector('.verdict')) card.body.append(h('div', { class: 'verdict capped' }, h('h4', { text: 'The hourly credit budget is used up' }), h('p', { text: r.result?.why ?? '' })));
        if (!replay) playRecording('This run hit the hourly Anakin budget.');
      } else {
        list.fail();
        const words = { structural: 'website changed', transient: 'hiccup', blocked: 'blocked' };
        setChip(card, `did not work · ${words[r.failureKind] ?? r.failureKind ?? 'failed'}`, 'bad');
        if (!card.body.querySelector('.verdict')) card.body.append(h('div', { class: 'verdict' }, h('h4', { text: 'It did not work' }), h('p', { text: humanize(r.result?.why) })));
        if (!replay) afterRun(false, r.failureKind === 'structural');
        if (r.result?.repairId) {
          card.next.append(h('p', { class: 'handoff', text: 'Anvil is fixing itself, below ↓' }));
          if (!replay) follow('repair', r.result.repairId);
        }
      }
      if (!replay) renderStory();
    },
  };
}

// ------------------------------------------------------------------ repair view (the dark one)

function repairView(card) {
  card.heading.textContent = 'Anvil fixes itself';
  const view = { stepper: h('ol', { class: 'stepper' }), live: null };
  card.body.append(view.stepper);
  let fromSteps = null;
  let changes = null;
  let running = null;
  let shots = null;
  let presses = 0;
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
        card.sub.textContent = d.trigger === 'monitor' ? 'started by Anakin Website Monitoring, before any booking failed' : d.trigger === 'manual' ? 'started by hand' : 'started because the booking did not work';
      } else if (e.kind === 'repair' && d.fromPlanId !== undefined) {
        setChip(card, 'fixing', 'warm', true);
        const v = e.label.match(/plan v(\d+)/)?.[1];
        const stuck = String(d.failure ?? '').match(/step (\d+) \(/);
        const why = !d.failure ? null : stuck ? `Why: step ${stuck[1]} of them no longer matched the website, so the booking could not go through.` : `Why: ${humanize(d.failure)}`;
        add({ icon: '⌫', title: `Put the saved steps${v ? ` (version ${v})` : ''} aside`, text: why });
      } else if (e.kind === 'repair' && /backing off/.test(e.label)) {
        endLive(view);
      } else if (e.kind === 'repair') {
        add({ icon: '!', tone: 'bad', title: cap1(e.label) });
      } else if (e.kind === 'attempt') {
        endLive(view);
        changes = null;
        view.stepper.append(h('li', { class: 'attempt' }, h('span', { text: e.label.replace(/^attempt/, 'try') })));
      } else if (e.kind === 'read') {
        add({ icon: '↻', title: 'Looked at the website again', text: /scraper/.test(e.label) ? "Read the live page with Anakin's URL Scraper" : 'Opened the live booking page in a fresh cloud browser' });
      } else if (e.kind === 'diff') {
        if (!changes) {
          changes = h('ul', { class: 'changes' });
          add({ icon: 'Δ', tone: 'warm', title: 'Spotted what is different now', text: 'Compared with the page it saw on its first good booking. Nobody told it.', extra: changes });
        }
        changes.append(h('li', { text: /no structural change/.test(e.label) ? 'The first page looks the same, so the change must be further along.' : cap1(e.label) }));
        liveRow(view, 'An AI model is writing new steps from the live page', MODEL_HINT);
      } else if (e.kind === 'derive' && /^skipped/.test(e.label)) {
        skipped++;
      } else if (e.kind === 'derive') {
        add({ icon: '✎', title: `New steps written in ${(d.ms / 1000).toFixed(1)}s`, text: `by ${d.model}${skipped ? `, after skipping ${skipped} model${skipped === 1 ? '' : 's'} that ${skipped === 1 ? 'was' : 'were'} busy or out of free requests` : ''}` });
        skipped = 0;
      } else if (e.kind === 'plan') {
        add({ icon: '≡', tone: 'good', title: 'The new steps', extra: plainDiff(fromSteps ?? [], d.steps ?? []) });
        const v = viewer();
        shots = v;
        presses = 0;
        running = add({ icon: '▶', title: 'Tried them on the real website', text: 'in the same cloud browser', extra: v.node });
        liveRow(view, 'Running the new steps', 'Anakin Browser API');
      } else if (e.kind === 'step' && running) {
        running.querySelector('p').textContent = short(plainStep(d.step), 110);
      } else if (e.kind === 'shot' && shots) {
        const [text, tone] = shotCaption(d, presses);
        if (!d.stuck && d.kind !== 'extract') presses++;
        shots.add(d.src, text, tone);
      } else if (e.kind === 'browser' && /went away/.test(e.label)) {
        add({ icon: '↻', title: 'The cloud browser dropped, so it opened a new one', text: 'That is the connection, not the steps, so the same steps run again.' });
      } else if (e.kind === 'reject') {
        add({ icon: '✕', tone: 'bad', title: 'Those steps could not even run, asking again', text: e.label.replace(/^The plan was not runnable: /, '') });
      } else if (e.kind === 'execute') {
        const m = e.label.match(/step (\d+) \((\w+)[^)]*\) failed/);
        const doing = { navigate: 'opening the page', fill: 'typing into a box', click: 'pressing a button', submit: 'pressing a button', assert: 'checking the next page had loaded', extract: 'reading the result' };
        const text = m ? `It got stuck at step ${m[1]}, ${doing[m[2]] ?? m[2]}: what it was looking for was not there.` : `${cap1(humanize(e.label.replace(/^candidate plan failed: /, '')).replace(/\.$/, ''))}.`;
        add({ icon: '✕', tone: 'bad', title: 'That did not work', text: `${text} The next try also gets to see the page it got stuck on.` });
      } else if (e.kind === 'validate') {
        if (running) running.querySelector('p').textContent = 'every step ran, in the same cloud browser';
        const bad = d.problems?.length;
        const rec = d.records?.[0] ?? {};
        const extra = bad ? h('ul', { class: 'checks' }, d.problems.map((p) => h('li', { class: 'miss', text: p }))) : h('ul', { class: 'checks' }, Object.entries(rec).map(([k, v]) => h('li', {}, h('b', { text: k }), `${v} ✓`)));
        add({ icon: bad ? '✕' : '✓', tone: bad ? 'bad' : 'good', title: bad ? 'The booking did not pass the check' : 'Checked it is a real, correct booking', text: bad ? null : 'Same check as the first good booking: a reference came back and the details match what was typed in.', extra });
      } else if (e.kind === 'promote') {
        outcome('', 'Fixed', `The new steps are saved as version ${d.version}, and every booking uses them from now on. No person changed any code.`);
      } else if (e.kind === 'rollback') {
        outcome('bad', 'Not fixed', 'Three tries did not produce a booking that passes the check, so Anvil kept its old steps and marked itself as needing a person. It says so instead of pretending.');
      } else if (e.kind === 'budget') {
        outcome(
          'warm',
          'Paused',
          d.modelQuota
            ? 'The free AI models Anvil uses have no requests left for now, so it could not write new steps. It kept its old steps instead of guessing. A recording of a full repair plays below.'
            : 'The hourly cloud-browser budget for this demo is used up, so it stopped before spending more. It kept its old steps. A recording of a full repair plays below.',
        );
      } else if (e.kind === 'error') {
        add({ icon: '!', tone: 'bad', title: 'That try crashed', text: e.label });
      }
    },
    finish(json, { replay }) {
      endLive(view);
      stopClock(card);
      const r = json.repair;
      const tones = { repaired: ['fixed', 'good'], degraded: ['not fixed', 'bad'], capped: ['stopped · budget', 'warm'], skipped: ['skipped', 'warm'], failed: ['failed', 'bad'] };
      const [text, tone] = tones[r.outcome] ?? [r.outcome, ''];
      setChip(card, text, tone);
      if (r.outcome === 'skipped' && !card.body.querySelector('.outcome')) outcome('warm', 'Skipped', r.diagnosis ?? '');
      if (!replay) {
        if (r.outcome === 'repaired') {
          story.fixed = true;
          card.next.append(h('button', { type: 'button', class: 'btn blue', text: 'Book again with the new steps →', onclick: () => $('run-button').click() }));
        }
        if (r.outcome === 'degraded') story.degraded = true;
        if (r.outcome === 'capped') {
          story.paused = true;
          playRecording('The live repair had to pause.');
        }
        renderStory();
      }
    },
  };
}

// ------------------------------------------------------------------ derivation view

function derivationView(card) {
  card.heading.textContent = 'Anvil learns a new website';
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
        liveRow(view, 'An AI model is working out how to read it', MODEL_HINT);
      } else if (e.kind === 'derive' && d.steps) {
        add({ icon: '✎', title: `Steps from ${d.model}`, extra: diffView([], d.steps) });
      } else if (e.kind === 'check') {
        add({ icon: '✓', tone: 'good', title: 'Tried them on the scraped page, and they worked', text: e.label.replace(/^dry run on the scraped page: /, ''), extra: recordsView(d.sample, 3) });
        liveRow(view, 'Reading the live page for real', 'fresh scrape');
      } else if (e.kind === 'reject') {
        add({ icon: '✕', tone: 'bad', title: 'Those steps did not work, asking again', text: e.label });
        liveRow(view, 'Asking the model again', MODEL_HINT);
      } else if (e.kind === 'result') {
        add({ icon: '▦', tone: 'good', title: cap1(e.label), extra: recordsView(d.records, 5) });
      } else if (e.kind === 'contract') {
        add({ icon: '✓', tone: 'good', title: 'Learned what a correct result looks like', extra: h('ul', { class: 'checks' }, (d.requiredFields ?? []).map((f) => h('li', {}, h('b', { text: f }), d.fieldTypes?.[f] ?? ''))) });
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
const TITLES = { run: 'Anvil books a room', repair: 'Anvil fixes itself', derivation: 'Anvil learns a new website' };

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
    if (job.type === 'run' && /changed/.test(job.note ?? '')) marker('The website was changed', cap1(job.note.replace(/^Then the demo site was changed: /, '').replace(/\. Same plan.*$/, '')));
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
  const booking = cap.engine === 'browser' && schema.name && schema.email && schema.seats;
  $('run-button').firstChild.textContent = booking ? 'Send Anvil to book it ' : 'Run it ';
  $('composer-hint').hidden = !booking;
  if (booking) {
    $('composer-kicker').textContent = 'Tell Anvil what to book · you can edit the details';
    box.append('Book a study room for ', input('name', 'string', sample.name), ' at ', input('email', 'string', sample.email), ' for ', input('seats', 'number', sample.seats), ' people.');
  } else if (Object.keys(schema).length) {
    $('composer-kicker').textContent = cap.name;
    for (const [k, t] of Object.entries(schema)) box.append(`${k} `, input(k, t, ''), ' ');
  } else {
    $('composer-kicker').textContent = `Read capability · ${new URL(cap.targetUrl).hostname}`;
    box.append(h('span', { text: `Read ${cap.goal}.` }), h('span', { class: 'quiet', text: `from ${cap.targetUrl}` }));
  }
}

const STATUS_WORDS = { healthy: 'working', repairing: 'fixing itself', degraded: 'needs a person', deriving: 'learning' };

function renderHealth(cap) {
  $('health').replaceChildren();
  if (!cap) return;
  $('health').append(h('i', { class: `dot ${cap.status}` }), `${STATUS_WORDS[cap.status] ?? cap.status}${cap.plan ? ` · steps v${cap.plan.version}` : ''}`);
  $('run-button').disabled = !cap.plan;
  $('nav-run').disabled = !cap.plan;
  $('nav-run').textContent = cap.engine === 'browser' ? 'Book a room' : 'Run';
  $('repair-button').hidden = !(cap.engine === 'browser' && cap.status === 'degraded');
  $('site-card').hidden = cap.engine !== 'browser';
}

async function renderPlans(cap) {
  if (!cap) return;
  const { status, json } = await api('GET', `/api/capabilities/${cap.id}`);
  if (status !== 200) return;
  const plans = [...(json.plans ?? [])].reverse();
  $('plans-count').textContent = `${plans.length} version${plans.length === 1 ? '' : 's'}`;
  const nice = (o) =>
    o
      .replace(/^repair \((.*)\)$/, 'fixed itself, written by $1')
      .replace(/^derived \((.*)\)$/, 'learned, written by $1')
      .replace(/^wire \((.*)\)$/, 'Wire action $1')
      .replace(/^hand-written$/, 'written by hand, the starting point');
  $('plans').replaceChildren(
    ...(plans.length
      ? plans.slice(0, 6).map((p) => h('li', { class: p.active ? 'active' : '' }, h('span', { class: 'v', text: `v${p.version}` }), h('span', { class: 'o', text: nice(p.origin), title: p.origin }), h('time', { text: new Date(p.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })))
      : [h('li', {}, h('span', { class: 'v', text: '—' }), h('span', { class: 'o', text: 'no steps yet' }), h('time'))]),
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
  $('capability').replaceChildren(...capabilities.map((c) => h('option', { value: c.id, selected: c.id === selected, text: c.engine === 'browser' ? 'Book a study room · Harbor Lane Library' : `${c.name.slice(0, 40)} — ${new URL(c.targetUrl).hostname}` })));
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
    notice('run-notice', 'Someone else is booking right now. Following their booking instead.');
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
$('replay-button').addEventListener('click', () => playRecording('You asked for a recording.'));
$('repair-button').addEventListener('click', async () => {
  const { status, json } = await api('POST', '/api/repairs', { capabilityId: selected });
  if (status === 202) follow('repair', json.id);
  else if (status === 409 && json.repairId) follow('repair', json.repairId);
  else notice('run-notice', json.error, true);
});

// ------------------------------------------------------------------ the demo site card

const ORIGINAL_NAMES = { name: 'full_name', email: 'email', seats: 'seats' };
const BREAK_ICONS = { 'rename-field': 'Aa', 'add-step': '+', 'reorder-steps': '⇅', 'restyle-confirmation': '▤', surprise: '✦' };
const BREAK_SHORT = {
  'rename-field': 'Rename the Email box',
  'add-step': 'Add a “check your details” page',
  'reorder-steps': 'Ask for seats on a page of its own',
  'restyle-confirmation': 'Redesign the confirmation page',
  surprise: 'Surprise me: random changes nobody scripted',
};
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
    const shuffled = s.fields.map((f) => f.key).join() !== 'name,email,seats';
    pages.push(page('Form', [formChanged ? h('code', { class: 'ref', text: `#${s.formId}` }) : null, s.fields.map(miniField), h('span', { class: 'go', text: s.submitLabel })], { changed: formChanged || shuffled, flag: formChanged ? 'changed' : shuffled ? 'shuffled' : null }));
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
  $('browser').replaceChildren(h('div', { class: 'chrome' }, h('i'), h('i'), h('i'), h('span', { text: `${s.org} · page by page` })), h('div', { class: 'pages' }, row));
}

// the live preview is the real page drawn small, so it is scaled to whatever width the card has
const PREVIEW_WIDTH = 820;
const frameBox = $('site-live');
new ResizeObserver(() => {
  const scale = frameBox.clientWidth / PREVIEW_WIDTH;
  $('site-frame').style.transform = `scale(${scale})`;
  $('site-frame').style.height = `${frameBox.clientHeight / scale}px`;
}).observe(frameBox);

let shownVersion = null;
let firstTarget = true;

async function loadTarget() {
  if (current() && current().engine !== 'browser') return;
  const { status, json } = await api('GET', '/api/target');
  if (status !== 200) return notice('site-notice', json.error ?? 'the demo site is not answering', true);
  site = json.site;
  renderBrowser(json);
  if (shownVersion !== json.version) {
    shownVersion = json.version;
    const preview = await api('GET', '/api/target/page');
    if (preview.status === 200) $('site-frame').srcdoc = preview.json.html;
    else shownVersion = null;
  }
  $('site-version').textContent = json.breaks.length ? `changed ${json.breaks.length}×` : 'as built';
  $('site-version').classList.toggle('hot', json.breaks.length > 0);
  $('owned').textContent = json.owned;
  $('monitor').hidden = !json.monitor;
  if (json.monitor) {
    const hours = json.monitor.everyMinutes / 60;
    $('monitor').replaceChildren('Anakin Website Monitoring also watches ', h('a', { href: json.monitor.page, target: '_blank', rel: 'noopener', text: 'this page' }), ` every ${hours >= 1 ? `${hours} hour${hours === 1 ? '' : 's'}` : `${json.monitor.everyMinutes} minutes`}. When it spots a change, Anvil starts fixing itself on its own, before any booking fails, and it shows up in the list.`);
  }
  if (firstTarget) {
    firstTarget = false;
    story.others = json.breaks.length;
    story.changed = json.breaks.length > 0;
    renderStory();
  }
  const applied = new Set(json.breaks.map((b) => b.kind));
  const busy = !!json.busy;
  $('breaks').replaceChildren(
    ...Object.keys(json.kinds)
      .sort((a, b) => REPEATABLE.has(b) - REPEATABLE.has(a))
      .map((kind) =>
        h(
          'button',
          { type: 'button', class: `brk${REPEATABLE.has(kind) ? ' wild' : applied.has(kind) ? ' done' : ''}`, disabled: busy || (applied.has(kind) && !REPEATABLE.has(kind)), title: json.kinds[kind], onclick: () => breakSite(kind) },
          h('span', { class: 'ico', text: applied.has(kind) && !REPEATABLE.has(kind) ? '✓' : (BREAK_ICONS[kind] ?? '•') }),
          BREAK_SHORT[kind] ?? json.kinds[kind],
        ),
      ),
    h('button', { type: 'button', class: 'brk reset', disabled: busy, onclick: () => breakSite(null) }, 'Put everything back'),
  );
  if (busy) notice('site-notice', 'Anvil is busy on the website right now. Changing it waits until that finishes.');
  else if (/busy on the website/.test($('site-notice').textContent)) notice('site-notice', '');
}

async function breakSite(kind) {
  notice('site-notice', kind ? 'Changing the website…' : 'Putting everything back…');
  const { status, json } = kind ? await api('POST', '/api/target/break', { kind }) : await api('POST', '/api/target/reset', {});
  if (status === 200) {
    notice('site-notice', kind ? 'Done. Now book again, at the top.' : '');
    if (kind) {
      marker(`You changed the website: ${low1(BREAK_SHORT[kind] ?? kind).replace(/^surprise me: /, '')}`, `${cap1(json.detail)}. Nobody has told Anvil. Book again to see what it does.`);
      Object.assign(story, { changed: true, mine: true, broke: false, fixed: false, again: false, degraded: false, paused: false });
    } else {
      marker('Everything is back to the start', 'The website is as built, and Anvil is back to its hand-written first steps with nothing learned yet.', true);
      Object.assign(story, { booked: false, changed: false, mine: false, broke: false, fixed: false, again: false, degraded: false, paused: false, others: 0 });
    }
    renderStory();
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
    notice('read-notice', 'Queued. It shows up in the list.');
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
    marker('Anakin Website Monitoring noticed the website changed', 'Nobody pressed anything and no booking has failed yet. Anvil is fixing itself ahead of time.', true);
    follow('repair', r.id);
  }
}

renderStory();
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
