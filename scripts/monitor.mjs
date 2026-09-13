// Sets up Anakin Website Monitoring on the public, read-only view of the demo site.
//
//   node --env-file=.env scripts/monitor.mjs create https://attirebytatsavi.com   (writes id + secret into .env)
//   node --env-file=.env scripts/monitor.mjs run | status | deliveries | test | delete

import { appendFile } from 'node:fs/promises';

const API = 'https://api.anakin.io/v1/monitors';
const headers = { 'X-API-Key': process.env.ANAKIN_API_KEY?.trim() ?? '', 'Content-Type': 'application/json' };
const id = process.env.ANAKIN_MONITOR_ID;
const [cmd, site] = process.argv.slice(2);

async function call(method, path = '', body) {
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path || '/'} said ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

if (cmd === 'create') {
  if (id) throw new Error(`ANAKIN_MONITOR_ID is already set (${id}); delete that monitor first`);
  if (!site) throw new Error('give the public site, e.g. https://attirebytatsavi.com');
  const minutes = Number(process.env.ANAKIN_MONITOR_MINUTES ?? 240);
  const m = await call('POST', '', {
    url: `${site.replace(/\/$/, '')}/harbor-lane/`,
    intervalMinutes: minutes,
    watchMode: 'full_page',
    watchFormat: 'html',
    alertWebhookUrl: `${site.replace(/\/$/, '')}/api/hooks/site-changed`,
  });
  // the secret is only shown once, so it goes straight into .env and never to the terminal
  await appendFile('.env', `ANAKIN_MONITOR_ID=${m.id}\nANAKIN_WEBHOOK_SECRET=${m.alertWebhookSecret}\nANAKIN_MONITOR_MINUTES=${minutes}\n`);
  console.log(`monitor ${m.id} on ${m.url} every ${m.intervalMinutes} min, ${m.creditCostPerRun} credit(s) per check, next run ${m.nextRunAt}. id and secret written to .env`);
} else if (!id) {
  throw new Error('ANAKIN_MONITOR_ID is not set');
} else if (cmd === 'run') {
  console.log(JSON.stringify(await call('POST', `/${id}/run`)));
} else if (cmd === 'test') {
  console.log(JSON.stringify(await call('POST', `/${id}/test-alert`)));
} else if (cmd === 'deliveries') {
  for (const d of (await call('GET', `/${id}/deliveries`)).deliveries ?? []) console.log(d.createdAt, d.event, d.status, d.httpStatus, d.attempts, d.error ?? '');
} else if (cmd === 'delete') {
  console.log(JSON.stringify(await call('DELETE', `/${id}`)));
} else {
  const m = await call('GET', `/${id}`);
  console.log(JSON.stringify({ url: m.url, isActive: m.isActive, intervalMinutes: m.intervalMinutes, lastCheckedAt: m.lastCheckedAt, nextRunAt: m.nextRunAt, creditCostPerRun: m.creditCostPerRun, lastChangeAt: m.lastChangeAt }, null, 1));
}
