import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { freshConfig, applyBreak, describe, BREAKS, ROOMS, SLOTS, DEMO_ACCOUNT, WIZARD, EVENTS } from './config.mjs';
import { SHARED, validSandbox, sandboxOfPath } from '../src/tenants.mjs';

const port = Number(process.env.TARGET_PORT ?? 4310);
const adminToken = process.env.TARGET_ADMIN_TOKEN ?? '';
const APP_JS = readFileSync(new URL('./booking-app.js', import.meta.url), 'utf8');

// Every visitor's sandbox has its own copy of the site; the shared demo is ''. A request runs inside its copy,
// so the page code below reads config, reservations and the rest as if there were only one site.
const copies = new Map();
const here = new AsyncLocalStorage();
const MAX_COPIES = Number(process.env.TARGET_MAX_COPIES ?? 120);
const IDLE_MS = 90 * 60 * 1000;

function copyFor(sandbox) {
  let copy = copies.get(sandbox);
  if (!copy) {
    if (copies.size >= MAX_COPIES) return null;
    // pending: half-finished bookings for the multi-page flows; sessions: browsers signed in with the demo account
    copy = { config: freshConfig(), reservations: new Map(), pending: new Map(), sessions: new Set(), captchas: new Map() };
    copies.set(sandbox, copy);
  }
  copy.seen = Date.now();
  return copy;
}
setInterval(() => {
  for (const [id, copy] of copies) if (id !== SHARED && Date.now() - copy.seen > IDLE_MS) copies.delete(id);
}, 5 * 60_000).unref();

const state = () => here.getStore().copy;
const base = () => here.getStore().base;
// reads through to whichever copy the current request belongs to
const current = (key) =>
  new Proxy(
    {},
    {
      get(_, prop) {
        const target = state()[key];
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(_, prop, value) {
        state()[key][prop] = value;
        return true;
      },
    },
  );
const config = current('config');
const reservations = current('reservations');
const pending = current('pending');
const sessions = current('sessions');
const captchas = current('captchas');

const HALF_HOUR = 30 * 60 * 1000;
function hold(values) {
  for (const [t, p] of pending) if (p.at < Date.now() - HALF_HOUR) pending.delete(t);
  const token = randomBytes(8).toString('hex');
  pending.set(token, { values, at: Date.now() });
  return token;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function layout(title, body, { bare = false } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(config.org)}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; background: ${bare ? '#fff' : config.colors.paper}; color: #1d1d1b; }
  .site-header, .site-footer { padding: 14px 24px; background: ${config.colors.ink}; color: #f6f4ef; }
  .banner { margin: 0; padding: 10px 24px; background: #efe3fb; color: #3d1d5c; font-size: 14px; }
  .site-header a { color: inherit; text-decoration: none; font-weight: 600; }
  .site-footer { font-size: 13px; background: #e7e2d6; color: #555; }
  main { max-width: 520px; margin: ${bare ? '8px' : '32px'} auto; padding: 0 24px; }
  label { display: block; margin-top: 16px; font-weight: 500; }
  .steps { color: #555; font-size: 14px; }
  .receipt { background: #fff; border: 1px solid #d8d2c4; padding: 8px 18px; }
  .receipt-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px dashed #d8d2c4; }
  .receipt-row:last-child { border-bottom: 0; }
  .receipt-row .k { color: #555; }
  input, select { width: 100%; padding: 8px; font: inherit; box-sizing: border-box; }
  input[type="radio"] { width: auto; }
  .site-header nav { float: right; font-size: 14px; }
  .site-header nav a { font-weight: 500; }
  button { margin-top: 24px; padding: 10px 18px; font: inherit; background: ${config.colors.ink}; color: #fff; border: 0; }
  .error { color: #a3261f; font-size: 14px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; }
  dt { color: #555; }
  .captcha { margin-top: 20px; padding: 12px; background: #fff7e6; border: 1px solid #e8c77a; }
  .demo-account { margin: 16px 0; padding: 12px 16px; background: #fff; border-left: 4px solid ${config.colors.ink}; }
  .wizard-steps { display: flex; gap: 18px; padding: 0; list-style: none; color: #777; font-size: 14px; }
  .wizard-steps [aria-current] { color: #1d1d1b; font-weight: 700; }
  fieldset { margin-top: 16px; border: 1px solid #d8d2c4; }
  .choice { display: inline-flex; gap: 6px; margin: 6px 14px 0 0; font-weight: 400; }
  .ticket { background: #fff; border-radius: 14px; padding: 18px 22px; box-shadow: 0 6px 20px rgba(0,0,0,.08); }
  .ticket-code { font: 700 26px/1.2 ui-monospace, monospace; margin: 0 0 12px; }
  .ticket-lines { list-style: none; padding: 0; margin: 0; }
  .ticket-lines li { display: flex; justify-content: space-between; padding: 6px 0; border-top: 1px solid #eee; }
</style>
</head>
<body>
${bare ? '' : `<header class="site-header"><a href="${base()}/">${esc(config.org)}</a><nav><a href="${base()}/events">Events</a> · <a href="${base()}/find">Find my booking</a></nav></header>`}
${!bare && config.banner ? `<p class="banner">${esc(config.banner)}</p>` : ''}
${body}
${bare ? '' : '<footer class="site-footer">Demo target for Anvil. This site is owned by the project so it can be broken on purpose.</footer>'}
</body>
</html>`;
}

const byKey = (key) => config.fields.find((f) => f.key === key);

// "Are you a robot?": a fresh set of letters every time the page is drawn, in a picture Anvil is never meant to read
function captchaBlock() {
  if (!config.captcha) return '';
  for (const [t, c] of captchas) if (c.at < Date.now() - HALF_HOUR) captchas.delete(t);
  const token = randomBytes(8).toString('hex');
  const answer = Array.from(randomBytes(5), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
  captchas.set(token, { answer, at: Date.now() });
  const letters = [...answer].map((ch, i) => `<text x="${16 + i * 26}" y="${31 + ((i * 7) % 9)}" transform="rotate(${(i % 2 ? 1 : -1) * (9 + i * 3)} ${16 + i * 26} 28)">${ch}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="48"><rect width="150" height="48" fill="#eee"/><path d="M0 30 C40 5 90 45 150 18" stroke="#888" fill="none"/><g font-family="monospace" font-size="24" fill="#333">${letters}</g></svg>`;
  return `<div class="captcha">
  <p>Before we book anything: are you a robot? Type the letters in the picture.</p>
  <img alt="captcha" width="150" height="48" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">
  <input name="captcha" aria-label="Letters in the picture" autocomplete="off" required>
  <input type="hidden" name="captcha_t" value="${token}">
</div>`;
}

function captchaPassed(get) {
  if (!config.captcha) return true;
  const token = String(get('captcha_t') ?? '');
  const c = captchas.get(token);
  captchas.delete(token);
  return !!c && c.answer === String(get('captcha') ?? '').trim().toUpperCase();
}
const CAPTCHA_WRONG = 'The captcha was not right. Are you a robot? Type the letters in the picture to book.';

const cookie = (req, name) => (req.headers.cookie ?? '').split(/;\s*/).map((p) => p.split('=')).find(([k]) => k === name)?.[1];
const signedIn = (req) => !config.signIn || sessions.has(cookie(req, 'hl_session'));

function formPage(values = {}, errors = {}, { keys = config.fields.map((f) => f.key), id = config.formId, action = '/reserve', button = config.submitLabel, token = null, step = null, bare = false } = {}) {
  const inputs = keys
    .map(byKey)
    .map((f) => {
      const extra = [f.required ? 'required' : '', f.min != null ? `min="${f.min}"` : '', f.max != null ? `max="${f.max}"` : '']
        .filter(Boolean)
        .join(' ');
      const control =
        f.type === 'select'
          ? `<select id="${esc(f.name)}" name="${esc(f.name)}" ${extra}><option value="">Choose…</option>${f.options.map((o) => `<option${values[f.name] === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`
          : `<input id="${esc(f.name)}" name="${esc(f.name)}" type="${esc(f.type)}" value="${esc(values[f.name])}" ${extra}>`;
      return `  <label for="${esc(f.name)}">${esc(f.label)}</label>
  ${control}
  ${errors[f.name] ? `<p class="error" data-error-for="${esc(f.name)}">${esc(errors[f.name])}</p>` : ''}`;
    })
    .join('\n');
  // the page whose button books is the one that carries the captcha
  const books = action === '/reserve' && !config.reviewStep;

  return layout(
    config.title,
    `<main>
${bare ? '' : `<h1>${esc(config.title)}</h1>\n<p>${esc(config.intro)}</p>`}
${step ? `<p class="steps">${esc(step)}</p>` : ''}
${errors._captcha ? `<p class="error" role="alert">${esc(errors._captcha)}</p>` : Object.keys(errors).length ? '<p class="error" role="alert">Please fix the highlighted fields.</p>' : ''}
<form id="${id}" method="post" action="${action}"${bare ? ' target="_top"' : ''} novalidate>
${token ? `  <input type="hidden" name="t" value="${esc(token)}">\n` : ''}${inputs}
${books ? captchaBlock() : ''}
  <button type="submit">${esc(button)}</button>
</form>
</main>`,
    { bare },
  );
}

// the iframe change: the page around the form stays, the form itself is loaded into a frame
function framedPage() {
  return layout(
    config.title,
    `<main>
<h1>${esc(config.title)}</h1>
<p>${esc(config.intro)}</p>
<iframe id="booking-frame" title="Booking form" src="${base()}/embed/reserve" style="width:100%;height:${config.seatsFirst ? 300 : 760}px;border:1px solid #d8d2c4;background:#fff"></iframe>
</main>`,
  );
}

function reviewPage(values, token, error) {
  return layout(
    'Check your details',
    `<main>
<h1>Check your details</h1>
<p>Nothing is booked until you confirm.</p>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<dl>
${config.fields.map((f) => `  <dt>${esc(f.label)}</dt><dd>${esc(values[f.key])}</dd>`).join('\n')}
</dl>
<form id="confirm-form" method="post" action="/reserve/confirm">
  <input type="hidden" name="t" value="${esc(token)}">
${captchaBlock()}
  <button type="submit">Confirm reservation</button>
</form>
</main>`,
  );
}

function confirmationPage(r) {
  if (config.redesign)
    return layout(
      'All set',
      `<main class="ticket-page">
<h1>All set</h1>
<section class="ticket">
  <p class="ticket-label">Booking code</p>
  <p class="ticket-code" data-code>${esc(r.reference)}</p>
  <ul class="ticket-lines">
    <li><span>Guest</span><b data-line="guest">${esc(r.name)}</b></li>
    <li><span>Contact</span><b data-line="contact">${esc(r.email)}</b></li>
    <li><span>Group</span><b data-line="party">${esc(r.seats)}</b></li>
    <li><span>Space</span><b data-line="space">${esc(r.shownRoom)}</b></li>
    <li><span>Day</span><b data-line="day">${esc(r.date)}</b></li>
    <li><span>Arrival</span><b data-line="arrival">${esc(r.time)}</b></li>
  </ul>
</section>
<p><a href="${base()}/find">Look this booking up later</a></p>
</main>`,
    );
  if (config.receiptLayout)
    return layout(
      'Reservation confirmed',
      `<main class="receipt-page">
<h1>You're booked</h1>
<section class="receipt">
  <div class="receipt-row"><span class="k">Booking code</span><code class="booking-code">${esc(r.reference)}</code></div>
  <div class="receipt-row"><span class="k">Patron</span><span class="v" data-field="name">${esc(r.name)}</span></div>
  <div class="receipt-row"><span class="k">Contact</span><span class="v" data-field="email">${esc(r.email)}</span></div>
  <div class="receipt-row"><span class="k">Party</span><span class="v" data-field="seats">${esc(r.seats)}</span></div>
  <div class="receipt-row"><span class="k">Space</span><span class="v" data-field="room">${esc(r.shownRoom)}</span></div>
  <div class="receipt-row"><span class="k">Day</span><span class="v" data-field="date">${esc(r.date)}</span></div>
  <div class="receipt-row"><span class="k">Starts</span><span class="v" data-field="time">${esc(r.time)}</span></div>
</section>
<p><a href="${base()}/">Book another room</a></p>
</main>`,
    );
  return layout(
    'Reservation confirmed',
    `<main class="confirmation">
<h1>Room reserved</h1>
<p>Your reference is <strong id="${esc(config.confirm.reference)}">${esc(r.reference)}</strong>. Show it at the front desk.</p>
<dl class="summary">
  <dt>Name</dt><dd class="${esc(config.confirm.name)}">${esc(r.name)}</dd>
  <dt>Email</dt><dd class="${esc(config.confirm.email)}">${esc(r.email)}</dd>
  <dt>Seats</dt><dd class="${esc(config.confirm.seats)}">${esc(r.seats)}</dd>
  <dt>Room</dt><dd class="${esc(config.confirm.room)}">${esc(r.shownRoom)}</dd>
  <dt>Date</dt><dd class="${esc(config.confirm.date)}">${esc(r.date)}</dd>
  <dt>Time</dt><dd class="${esc(config.confirm.time)}">${esc(r.time)}</dd>
</dl>
<p><a href="${base()}/find">Find this booking later</a></p>
<p><a href="${base()}/">Make another reservation</a></p>
</main>`,
  );
}

// the JavaScript app change: an empty shell and a script that draws everything
function appShell() {
  const boot = {
    salt: config.appSalt,
    title: config.title,
    intro: config.intro,
    submitLabel: config.submitLabel,
    fields: config.fields.map(({ key, label, type, options }) => ({ key, label, type, options })),
    captcha: captchaBlock() || null,
  };
  return layout(
    config.title,
    `<main><div id="app-root"><p>Loading the booking app…</p></div></main>
<script type="application/json" id="boot">${JSON.stringify(boot).replace(/</g, '\\u003c')}</script>
<script>${APP_JS}</script>`,
  );
}

function signInPage(next, error) {
  return layout(
    'Sign in',
    `<main>
<h1>Sign in to book a room</h1>
<p>Rooms can only be booked by signed-in patrons.</p>
<aside class="demo-account">
  <p><b>Demo account, for everyone trying this site:</b></p>
  <p>Email <code>${esc(DEMO_ACCOUNT.email)}</code><br>Password <code>${esc(DEMO_ACCOUNT.password)}</code></p>
</aside>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<form id="sign-in-form" method="post" action="/sign-in">
  <input type="hidden" name="next" value="${esc(next)}">
  <label for="login-email">Email</label>
  <input id="login-email" name="login_email" type="email" required>
  <label for="login-password">Password</label>
  <input id="login-password" name="password" type="password" required>
  <button type="submit">Sign in</button>
</form>
</main>`,
  );
}

// the full redesign: three steps, radio buttons, every box renamed
function wizardPage(n, title, inner, { action, button, token, error }) {
  return layout(
    title,
    `<main class="wizard">
<ol class="wizard-steps">${['When', 'Who', 'Check'].map((s, i) => `<li${i + 1 === n ? ' aria-current="step"' : ''}>${s}</li>`).join('')}</ol>
<h1>${esc(title)}</h1>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<form class="wizard-form" id="wiz-${n}" method="post" action="${action}" novalidate>
${token ? `<input type="hidden" name="t" value="${esc(token)}">` : ''}
${inner}
<button type="submit">${esc(button)}</button>
</form>
</main>`,
  );
}
const radios = (name, options) => options.map((o) => `<label class="choice"><input type="radio" name="${name}" value="${esc(o)}"> ${esc(o)}</label>`).join('');
const wizardWhen = (error) =>
  wizardPage(1, 'When would you like to come?', `<fieldset><legend>${WIZARD.room.label}</legend>${radios(WIZARD.room.name, ROOMS)}</fieldset>
<label for="${WIZARD.date.name}">${WIZARD.date.label}</label><input id="${WIZARD.date.name}" name="${WIZARD.date.name}" type="date" required>
<fieldset><legend>${WIZARD.time.label}</legend>${radios(WIZARD.time.name, SLOTS)}</fieldset>`, { action: '/visit/when', button: 'Next: who is coming', error });
const wizardWho = (token, error) =>
  wizardPage(2, 'Who is coming?', ['name', 'email', 'seats'].map((k) => `<label for="${WIZARD[k].name}">${WIZARD[k].label}</label><input id="${WIZARD[k].name}" name="${WIZARD[k].name}" type="${k === 'email' ? 'email' : k === 'seats' ? 'number' : 'text'}" required>`).join('\n'), {
    action: '/visit/who',
    button: 'Next: check it',
    token,
    error,
  });
const wizardCheck = (values, token, error) =>
  wizardPage(3, 'Check and book', `<ul class="check-list">${['room', 'date', 'time', 'name', 'email', 'seats'].map((k) => `<li>${WIZARD[k].label} <b>${esc(values[k])}</b></li>`).join('')}</ul>
${captchaBlock()}`, { action: '/visit/book', button: 'Book this room', token, error });

// What the read-only capability reads. The redesign turns the cards into a table and renames everything.
function eventsPage() {
  if (config.eventsLayout === 'table')
    return layout(
      "What's on",
      `<main>
<h1>What's on at the library</h1>
<table class="agenda">
  <thead><tr><th>Event</th><th>Day</th><th>Starts</th><th>Where</th><th>Places free</th></tr></thead>
  <tbody>
${EVENTS.map((e) => `    <tr class="agenda-row"><td data-col="name">${esc(e.title)}</td><td data-col="day">${esc(e.date)}</td><td data-col="start">${esc(e.time)}</td><td data-col="place">${esc(e.room)}</td><td data-col="free">${e.seats}</td></tr>`).join('\n')}
  </tbody>
</table>
</main>`,
    );
  return layout(
    'Upcoming events',
    `<main>
<h1>Upcoming events</h1>
<ul class="events">
${EVENTS.map((e) => `  <li class="event">
    <h3 class="event-title">${esc(e.title)}</h3>
    <p><span class="event-date">${esc(e.date)}</span> at <span class="event-time">${esc(e.time)}</span>, <span class="event-room">${esc(e.room)}</span></p>
    <p><span class="seats-left">${e.seats}</span> seats left</p>
  </li>`).join('\n')}
</ul>
</main>`,
  );
}

// The library's own record of a booking, looked up by reference and email. It shows what was stored.
function findPage(error) {
  return layout(
    'Find my booking',
    `<main>
<h1>Find my booking</h1>
<p>Enter the reference from your confirmation and the email you booked with.</p>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<form id="find-form" method="post" action="/find">
  <label for="find-reference">Booking reference</label>
  <input id="find-reference" name="reference" required>
  <label for="find-email">Email</label>
  <input id="find-email" name="email" type="email" required>
  <button type="submit">Look it up</button>
</form>
</main>`,
  );
}

function recordPage(r) {
  const row = (k, label, v) => `  <dt>${label}</dt><dd data-record="${k}">${esc(v)}</dd>`;
  return layout(
    'Your booking',
    `<main>
<h1>Your booking</h1>
<dl class="booking-record">
${row('reference', 'Reference', r.reference)}
${row('name', 'Name', r.name)}
${row('email', 'Email', r.email)}
${row('seats', 'Seats', r.seats)}
${row('room', 'Room', r.room)}
${row('date', 'Date', r.date)}
${row('time', 'Time', r.time)}
</dl>
</main>`,
  );
}

function validate(body, keys = config.fields.map((f) => f.key)) {
  const errors = {};
  const clean = {};
  for (const f of keys.map(byKey)) {
    const raw = (body.get(f.name) ?? '').trim();
    if (f.required && !raw) {
      errors[f.name] = `${f.label} is required.`;
      continue;
    }
    if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) errors[f.name] = 'That email address does not look right.';
    if (f.type === 'select' && raw && !f.options.includes(raw)) errors[f.name] = `Pick one of the listed options for ${f.label}.`;
    if (f.type === 'date' && raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) errors[f.name] = `${f.label} should look like 2026-09-20.`;
    if (f.type === 'number') {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < f.min || n > f.max) errors[f.name] = `${f.label} must be a whole number from ${f.min} to ${f.max}.`;
      clean[f.key] = n;
      continue;
    }
    clean[f.key] = raw;
  }
  return { errors, clean };
}

// the wizard's boxes carry other names, so its steps are checked against the same rules under those names
function validateWizard(body, keys) {
  const renamed = new URLSearchParams();
  for (const k of keys) renamed.set(byKey(k).name, body.get(WIZARD[k].name) ?? '');
  const { errors, clean } = validate(renamed, keys);
  return { error: Object.values(errors)[0] ?? null, clean };
}

function makeBooking(values) {
  const reference =
    config.referenceStyle === 'BK'
      ? `BK-2026-${String(1000 + (randomBytes(2).readUInt16BE() % 9000))}-${String(randomBytes(1)[0] % 100).padStart(2, '0')}`
      : `HL-${randomBytes(4).toString('hex').toUpperCase().slice(0, 6)}`;
  // the wrong-room trap stores another room but keeps showing the one that was asked for
  const room = config.wrongRoom ? ROOMS.find((r) => r !== values.room) : values.room;
  const record = { reference, ...values, room, shownRoom: values.room };
  reservations.set(reference, record);
  return record;
}

// People reach the site through a look-only public view under /harbor-lane/: it only passes page loads, so its
// links need that prefix and its booking buttons cannot work. Bookings are Anvil's, which keeps the count exact.
export function forPublicView(html) {
  return String(html)
    .replace(/\b(href|action|src)="\/(?!\/|harbor-lane\/)/g, '$1="/harbor-lane/')
    .replace(/<button type="submit"/g, '<button type="submit" disabled title="On this look-only view, only Anvil books"')
    .replace(
      '<body>',
      '<body>\n<p style="margin:0;padding:10px 24px;background:#fff4d6;color:#5a4300;font:14px/1.45 system-ui,sans-serif">You are looking at a look-only view of the demo site, so its buttons are switched off. Bookings here are made by Anvil\'s cloud browser, which keeps the site\'s own booking count exact. To see one, go back to <a href="https://anvil.kgbnetwork.com/" style="color:inherit">anvil.kgbnetwork.com</a> and press <b>Send Anvil to book it</b>.</p>',
    );
}

function send(res, status, html, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(here.getStore()?.view && html ? forPublicView(html) : html);
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function isAdmin(req) {
  const given = Buffer.from(String(req.headers['x-admin-token'] ?? ''));
  const want = Buffer.from(adminToken);
  return adminToken.length > 0 && given.length === want.length && timingSafeEqual(given, want);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_000) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// pages that belong to booking, which the sign-in change puts behind the demo account
const BOOKING = /^\/($|reserve(\/|$)|embed\/|visit\/|api\/reserve$)/;

async function handle(req, res, url) {
  try {
    const seatsPage = (values, errors, bare) => formPage(values, errors, { keys: ['seats'], id: 'party-form', action: '/reserve/seats', button: 'Continue', step: 'Step 1 of 2', bare });
    const detailsPage = (values, errors, token) => formPage(values, errors, { keys: config.fields.map((f) => f.key).filter((k) => k !== 'seats'), token, step: 'Step 2 of 2' });
    const book = (values) => send(res, 303, '', { location: `/reservations/${makeBooking(values).reference}` });

    if (config.signIn && BOOKING.test(url.pathname) && !signedIn(req)) {
      if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'sign in first' });
      return send(res, 303, '', { location: `${base()}/sign-in?next=${encodeURIComponent(req.method === 'GET' ? url.pathname : '/')}` });
    }

    if (req.method === 'GET' && url.pathname === '/sign-in') {
      if (!config.signIn) return send(res, 303, '', { location: '/' });
      return send(res, 200, signInPage(url.searchParams.get('next') ?? '/'));
    }
    if (req.method === 'POST' && url.pathname === '/sign-in') {
      const body = new URLSearchParams(await readBody(req));
      const next = /^\/(?!\/)/.test(body.get('next') ?? '') ? body.get('next') : '/';
      if (body.get('login_email')?.trim().toLowerCase() !== DEMO_ACCOUNT.email || body.get('password') !== DEMO_ACCOUNT.password) return send(res, 401, signInPage(next, 'That email and password do not match.'));
      const token = randomBytes(12).toString('hex');
      sessions.add(token);
      return send(res, 303, '', { location: next, 'set-cookie': `hl_session=${token}; Path=/; HttpOnly; SameSite=Lax` });
    }

    if (req.method === 'GET' && url.pathname === '/') {
      if (config.jsApp) return send(res, 200, appShell());
      if (config.redesign) return send(res, 200, wizardWhen());
      if (config.iframe) return send(res, 200, framedPage());
      return send(res, 200, config.seatsFirst ? seatsPage() : formPage());
    }

    if (req.method === 'GET' && url.pathname === '/embed/reserve') {
      if (!config.iframe) return send(res, 303, '', { location: '/' });
      return send(res, 200, config.seatsFirst ? seatsPage({}, {}, true) : formPage({}, {}, { bare: true }));
    }

    if (req.method === 'POST' && url.pathname === '/api/reserve') {
      if (!config.jsApp) return sendJson(res, 404, { error: 'nothing here' });
      let json;
      try {
        json = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { error: 'That did not arrive in one piece, try again.' });
      }
      if (!captchaPassed((k) => json[k])) return sendJson(res, 422, { error: CAPTCHA_WRONG, captcha: captchaBlock() });
      const body = new URLSearchParams();
      for (const f of config.fields) body.set(f.name, String(json[f.key] ?? ''));
      const { errors, clean } = validate(body);
      if (Object.keys(errors).length) return sendJson(res, 422, { error: Object.values(errors).join(' '), captcha: captchaBlock() || null });
      const r = makeBooking(clean);
      return sendJson(res, 200, { reference: r.reference, name: r.name, email: r.email, seats: r.seats, room: r.shownRoom, date: r.date, time: r.time });
    }
    const apiRecord = url.pathname.match(/^\/api\/reservations\/((?:HL|BK)-[A-Z0-9-]{6,12})$/);
    if (req.method === 'GET' && apiRecord) {
      const r = reservations.get(apiRecord[1]);
      return r ? sendJson(res, 200, { reference: r.reference, name: r.name, email: r.email, seats: r.seats, room: r.shownRoom, date: r.date, time: r.time }) : sendJson(res, 404, { error: 'no such reservation' });
    }

    if (req.method === 'POST' && url.pathname === '/visit/when') {
      const body = new URLSearchParams(await readBody(req));
      const { error, clean } = validateWizard(body, ['room', 'date', 'time']);
      if (error) return send(res, 422, wizardWhen(error));
      return send(res, 303, '', { location: `/visit/who?t=${hold(clean)}` });
    }
    if (req.method === 'GET' && url.pathname === '/visit/who') {
      const token = url.searchParams.get('t');
      return pending.has(token) ? send(res, 200, wizardWho(token)) : send(res, 303, '', { location: '/' });
    }
    if (req.method === 'POST' && url.pathname === '/visit/who') {
      const body = new URLSearchParams(await readBody(req));
      const token = body.get('t');
      const held = pending.get(token);
      if (!held) return send(res, 303, '', { location: '/' });
      const { error, clean } = validateWizard(body, ['name', 'email', 'seats']);
      if (error) return send(res, 422, wizardWho(token, error));
      pending.delete(token);
      return send(res, 303, '', { location: `/visit/check?t=${hold({ ...held.values, ...clean })}` });
    }
    if (req.method === 'GET' && url.pathname === '/visit/check') {
      const held = pending.get(url.searchParams.get('t'));
      return held ? send(res, 200, wizardCheck(held.values, url.searchParams.get('t'))) : send(res, 303, '', { location: '/' });
    }
    if (req.method === 'POST' && url.pathname === '/visit/book') {
      const body = new URLSearchParams(await readBody(req));
      const token = body.get('t');
      const held = pending.get(token);
      if (!held) return send(res, 303, '', { location: '/' });
      if (!captchaPassed((k) => body.get(k))) return send(res, 422, wizardCheck(held.values, token, CAPTCHA_WRONG));
      pending.delete(token);
      return book(held.values);
    }

    if (req.method === 'POST' && url.pathname === '/reserve/seats') {
      const body = new URLSearchParams(await readBody(req));
      const { errors, clean } = validate(body, ['seats']);
      if (Object.keys(errors).length) return send(res, 422, seatsPage(Object.fromEntries(body), errors));
      return send(res, 303, '', { location: `/reserve/details?t=${hold(clean)}` });
    }

    if (req.method === 'GET' && url.pathname === '/reserve/details') {
      const token = url.searchParams.get('t');
      if (!pending.has(token)) return send(res, 303, '', { location: '/' });
      return send(res, 200, detailsPage({}, {}, token));
    }

    if (req.method === 'POST' && url.pathname === '/reserve') {
      const body = new URLSearchParams(await readBody(req));
      const token = body.get('t');
      const earlier = config.seatsFirst ? pending.get(token)?.values : {};
      if (!earlier) return send(res, 303, '', { location: '/' });
      const keys = config.fields.map((f) => f.key).filter((k) => !config.seatsFirst || k !== 'seats');
      const { errors, clean } = validate(body, keys);
      const again = (errs) => send(res, 422, config.seatsFirst ? detailsPage(Object.fromEntries(body), errs, token) : formPage(Object.fromEntries(body), errs));
      if (!config.reviewStep && !captchaPassed((k) => body.get(k))) return again({ ...errors, _captcha: CAPTCHA_WRONG });
      if (Object.keys(errors).length) return again(errors);
      if (config.seatsFirst) pending.delete(token);
      const values = { ...earlier, ...clean };
      if (config.reviewStep) return send(res, 303, '', { location: `/reserve/review?t=${hold(values)}` });
      return book(values);
    }

    if (req.method === 'GET' && url.pathname === '/reserve/review') {
      const token = url.searchParams.get('t');
      const held = pending.get(token);
      return held ? send(res, 200, reviewPage(held.values, token)) : send(res, 303, '', { location: '/' });
    }

    if (req.method === 'POST' && url.pathname === '/reserve/confirm') {
      const body = new URLSearchParams(await readBody(req));
      const token = body.get('t');
      const held = pending.get(token);
      if (!held) return send(res, 303, '', { location: '/' });
      if (!captchaPassed((k) => body.get(k))) return send(res, 422, reviewPage(held.values, token, CAPTCHA_WRONG));
      pending.delete(token);
      return book(held.values);
    }

    if (req.method === 'GET' && url.pathname === '/find') return send(res, 200, findPage());
    if (req.method === 'GET' && url.pathname === '/events') return send(res, 200, eventsPage());
    if (req.method === 'POST' && url.pathname === '/find') {
      const body = new URLSearchParams(await readBody(req));
      const r = reservations.get((body.get('reference') ?? '').trim());
      const found = r && r.email.toLowerCase() === (body.get('email') ?? '').trim().toLowerCase() ? r : null;
      return send(res, found ? 200 : 404, found ? recordPage(found) : findPage('No booking matches that reference and email.'));
    }

    const match = url.pathname.match(/^\/reservations\/((?:HL|BK)-[A-Z0-9-]{6,12})$/);
    if (req.method === 'GET' && match) {
      const r = reservations.get(match[1]);
      if (!r) return send(res, 404, layout('Not found', '<main><h1>No such reservation</h1></main>'));
      return send(res, 200, config.jsApp ? appShell() : confirmationPage(r));
    }

    if (url.pathname.startsWith('/_admin/')) {
      if (!isAdmin(req)) return sendJson(res, 401, { error: 'bad or missing admin token' });
      if (req.method === 'GET' && url.pathname === '/_admin/config') return sendJson(res, 200, { ...state().config, described: describe(state().config), kinds: BREAKS });
      if (req.method === 'GET' && url.pathname === '/_admin/stats') return sendJson(res, 200, { bookings: reservations.size, copies: copies.size });
      if (req.method === 'POST' && url.pathname === '/_admin/reset') {
        const copy = state();
        copy.config = freshConfig();
        for (const key of ['pending', 'reservations', 'sessions', 'captchas']) copy[key].clear();
        return sendJson(res, 200, { ok: true, config: copy.config, described: describe(copy.config) });
      }
      if (req.method === 'POST' && url.pathname === '/_admin/drop') {
        const { sandbox } = here.getStore();
        if (sandbox !== SHARED) copies.delete(sandbox);
        return sendJson(res, 200, { dropped: sandbox !== SHARED });
      }
      if (req.method === 'POST' && url.pathname === '/_admin/break') {
        const { kind, key, ...params } = JSON.parse((await readBody(req)) || '{}');
        if (!BREAKS[kind]) return sendJson(res, 400, { error: `unknown break kind "${kind}"` });
        // work on a copy, so a change that fails its checks leaves the site exactly as it was
        const next = structuredClone(state().config);
        try {
          const out = applyBreak(next, kind, key, params);
          state().config = next;
          return sendJson(res, 200, { ...out, config: next, described: describe(next) });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
    }

    send(res, 404, layout('Not found', '<main><h1>Page not found</h1></main>'));
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'something went wrong on our side' });
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // the public read-only view reaches a sandbox's copy under /t/<id>/; Anvil's browser and API say which in a header
  const viaPath = sandboxOfPath(url.pathname);
  const sandbox = viaPath?.sandbox ?? validSandbox(req.headers['x-anvil-tenant']) ?? SHARED;
  if (viaPath) url.pathname = viaPath.path;
  const copy = copyFor(sandbox);
  if (!copy) return sendJson(res, 503, { error: 'too many copies of the demo site are open right now' });
  here.run({ copy, sandbox, base: viaPath ? `/t/${sandbox}` : '', view: req.headers['x-anvil-view'] === 'public' }, () => handle(req, res, url));
});

server.listen(port, () => {
  if (!adminToken) console.warn('TARGET_ADMIN_TOKEN is not set, admin routes are locked');
  console.log(`target site on http://localhost:${port}`);
});
