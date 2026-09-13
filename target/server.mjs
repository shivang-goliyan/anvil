import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { freshConfig, applyBreak, describe, BREAKS } from './config.mjs';

const port = Number(process.env.TARGET_PORT ?? 4310);
const adminToken = process.env.TARGET_ADMIN_TOKEN ?? '';

let config = freshConfig();
const reservations = new Map();
// half-finished bookings for the multi-page flows, keyed by a token in a hidden field
const pending = new Map();

function hold(values) {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [t, p] of pending) if (p.at < cutoff) pending.delete(t);
  const token = randomBytes(8).toString('hex');
  pending.set(token, { values, at: Date.now() });
  return token;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(config.org)}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; background: #f6f4ef; color: #1d1d1b; }
  .site-header, .site-footer { padding: 14px 24px; background: #1f3a2e; color: #f6f4ef; }
  .site-header a { color: inherit; text-decoration: none; font-weight: 600; }
  .site-footer { font-size: 13px; background: #e7e2d6; color: #555; }
  main { max-width: 520px; margin: 32px auto; padding: 0 24px; }
  label { display: block; margin-top: 16px; font-weight: 500; }
  .steps { color: #555; font-size: 14px; }
  .receipt { background: #fff; border: 1px solid #d8d2c4; padding: 8px 18px; }
  .receipt-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px dashed #d8d2c4; }
  .receipt-row:last-child { border-bottom: 0; }
  .receipt-row .k { color: #555; }
  input { width: 100%; padding: 8px; font: inherit; box-sizing: border-box; }
  button { margin-top: 24px; padding: 10px 18px; font: inherit; background: #1f3a2e; color: #fff; border: 0; }
  .error { color: #a3261f; font-size: 14px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; }
  dt { color: #555; }
</style>
</head>
<body>
<header class="site-header"><a href="/">${esc(config.org)}</a></header>
${body}
<footer class="site-footer">Demo target for Anvil. This site is owned by the project so it can be broken on purpose.</footer>
</body>
</html>`;
}

const byKey = (key) => config.fields.find((f) => f.key === key);

function formPage(values = {}, errors = {}, { keys = config.fields.map((f) => f.key), id = 'reserve-form', action = '/reserve', button = config.submitLabel, token = null, step = null } = {}) {
  const inputs = keys
    .map(byKey)
    .map((f) => {
      const extra = [f.required ? 'required' : '', f.min != null ? `min="${f.min}"` : '', f.max != null ? `max="${f.max}"` : '']
        .filter(Boolean)
        .join(' ');
      return `  <label for="${esc(f.name)}">${esc(f.label)}</label>
  <input id="${esc(f.name)}" name="${esc(f.name)}" type="${esc(f.type)}" value="${esc(values[f.name])}" ${extra}>
  ${errors[f.name] ? `<p class="error" data-error-for="${esc(f.name)}">${esc(errors[f.name])}</p>` : ''}`;
    })
    .join('\n');

  return layout(
    config.title,
    `<main>
<h1>${esc(config.title)}</h1>
<p>Rooms seat up to eight. We hold a room for fifteen minutes past the start time.</p>
${step ? `<p class="steps">${esc(step)}</p>` : ''}
${Object.keys(errors).length ? '<p class="error" role="alert">Please fix the highlighted fields.</p>' : ''}
<form id="${id}" method="post" action="${action}" novalidate>
${token ? `  <input type="hidden" name="t" value="${esc(token)}">\n` : ''}${inputs}
  <button type="submit">${esc(button)}</button>
</form>
</main>`,
  );
}

function reviewPage(values, token) {
  return layout(
    'Check your details',
    `<main>
<h1>Check your details</h1>
<p>Nothing is booked until you confirm.</p>
<dl>
  <dt>${esc(byKey('name').label)}</dt><dd>${esc(values.name)}</dd>
  <dt>${esc(byKey('email').label)}</dt><dd>${esc(values.email)}</dd>
  <dt>${esc(byKey('seats').label)}</dt><dd>${esc(values.seats)}</dd>
</dl>
<form id="confirm-form" method="post" action="/reserve/confirm">
  <input type="hidden" name="t" value="${esc(token)}">
  <button type="submit">Confirm reservation</button>
</form>
</main>`,
  );
}

function confirmationPage(r) {
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
</section>
<p><a href="/">Book another room</a></p>
</main>`,
    );
  return layout(
    'Reservation confirmed',
    `<main class="confirmation">
<h1>Room reserved</h1>
<p>Your reference is <strong id="reference">${esc(r.reference)}</strong>. Show it at the front desk.</p>
<dl class="summary">
  <dt>Name</dt><dd class="summary-name">${esc(r.name)}</dd>
  <dt>Email</dt><dd class="summary-email">${esc(r.email)}</dd>
  <dt>Seats</dt><dd class="summary-seats">${esc(r.seats)}</dd>
</dl>
<p><a href="/">Make another reservation</a></p>
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

function send(res, status, html, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(html);
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    const seatsPage = (values, errors) => formPage(values, errors, { keys: ['seats'], id: 'party-form', action: '/reserve/seats', button: 'Continue', step: 'Step 1 of 2' });
    const detailsPage = (values, errors, token) => formPage(values, errors, { keys: ['name', 'email'], token, step: 'Step 2 of 2' });
    const book = (values) => {
      const reference = `HL-${randomBytes(4).toString('hex').toUpperCase().slice(0, 6)}`;
      reservations.set(reference, { reference, ...values });
      return send(res, 303, '', { location: `/reservations/${reference}` });
    };

    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, config.seatsFirst ? seatsPage() : formPage());

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
      const keys = config.seatsFirst ? ['name', 'email'] : config.fields.map((f) => f.key);
      const { errors, clean } = validate(body, keys);
      if (Object.keys(errors).length) return send(res, 422, config.seatsFirst ? detailsPage(Object.fromEntries(body), errors, token) : formPage(Object.fromEntries(body), errors));
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
      const token = new URLSearchParams(await readBody(req)).get('t');
      const held = pending.get(token);
      if (!held) return send(res, 303, '', { location: '/' });
      pending.delete(token);
      return book(held.values);
    }

    const match = url.pathname.match(/^\/reservations\/(HL-[A-F0-9]{6})$/);
    if (req.method === 'GET' && match) {
      const r = reservations.get(match[1]);
      return r ? send(res, 200, confirmationPage(r)) : send(res, 404, layout('Not found', '<main><h1>No such reservation</h1></main>'));
    }

    if (url.pathname.startsWith('/_admin/')) {
      if (!isAdmin(req)) return sendJson(res, 401, { error: 'bad or missing admin token' });
      if (req.method === 'GET' && url.pathname === '/_admin/config') return sendJson(res, 200, { ...config, described: describe(config), kinds: BREAKS });
      if (req.method === 'POST' && url.pathname === '/_admin/reset') {
        config = freshConfig();
        pending.clear();
        return sendJson(res, 200, { ok: true, config, described: describe(config) });
      }
      if (req.method === 'POST' && url.pathname === '/_admin/break') {
        const { kind, key } = JSON.parse((await readBody(req)) || '{}');
        if (!BREAKS[kind]) return sendJson(res, 400, { error: `unknown break kind "${kind}"` });
        return sendJson(res, 200, { ...applyBreak(config, kind, key), config, described: describe(config) });
      }
    }

    send(res, 404, layout('Not found', '<main><h1>Page not found</h1></main>'));
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'something went wrong on our side' });
  }
});

server.listen(port, () => {
  if (!adminToken) console.warn('TARGET_ADMIN_TOKEN is not set, admin routes are locked');
  console.log(`target site on http://localhost:${port}`);
});
