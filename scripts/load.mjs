// Several visitors at once, each in their own copy of the demo: book, change the website, book (fails),
// wait for the repair and its one real booking, book again. Reports what each visitor saw and how long it took.
//
//   node scripts/load.mjs https://anvil.kgbnetwork.com 5
//
// Costs what that many bookings and repairs cost.

const base = (process.argv[2] ?? 'http://127.0.0.1:3310').replace(/\/$/, '');
const visitors = Number(process.argv[3] ?? 3);
const change = process.argv[4] ?? 'rename-field';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function visitor(n) {
  const t0 = Date.now();
  const at = () => Math.round((Date.now() - t0) / 1000);
  const steps = [];
  const page = await fetch(`${base}/`);
  const cookie = page.headers.get('set-cookie')?.split(';')[0];
  if (!cookie || cookie.endsWith('=shared')) return { n, ok: false, why: 'no private copy handed out', steps };
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { cookie, ...(body && { 'content-type': 'application/json' }) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const wait = async (kind, id) => {
    for (;;) {
      const { json } = await call('GET', `/api/${kind}/${id}`);
      const row = json.run ?? json.repair;
      const state = row?.status ?? row?.outcome;
      if (state && !['queued', 'running'].includes(state)) return json;
      await sleep(2000);
    }
  };
  const inputs = { name: `Visitor ${n}`, email: `visitor${n}@example.com`, seats: 2 + (n % 5), room: ['Quiet room', 'Group room', 'Media room'][n % 3], date: `2026-09-${20 + (n % 8)}`, time: ['09:00', '11:00', '14:00', '16:00'][n % 4] };
  const book = async (label) => {
    const q = await call('POST', '/api/runs', { capabilityId: 'reserve-room', inputs });
    if (q.status !== 202) {
      steps.push(`${label}: refused ${q.status} ${q.json.error ?? ''} (${at()}s)`);
      return null;
    }
    const done = await wait('runs', q.json.id);
    steps.push(`${label}: ${done.run.status}${done.run.failureKind ? `/${done.run.failureKind}` : ''} (${at()}s)`);
    return done;
  };
  const first = await book('book');
  const b = await call('POST', '/api/target/break', { kind: change });
  steps.push(`change ${change}: ${b.status === 200 ? 'done' : `refused ${b.status}`} (${at()}s)`);
  const broken = await book('book on the changed site');
  let retry = null;
  if (broken?.run.result?.repairId) {
    const rep = await wait('repairs', broken.run.result.repairId);
    const during = rep.trace.find((e) => e.kind === 'ledger')?.detail.during;
    steps.push(`repair: ${rep.repair.outcome}, booked while repairing ${during ?? '?'} (${at()}s)`);
    const retryId = rep.trace.find((e) => e.kind === 'retry' && /^now making/.test(e.label))?.detail.runId;
    if (retryId) {
      retry = await wait('runs', retryId);
      steps.push(`the one real booking: ${retry.run.status} (${at()}s)`);
    }
  }
  const after = await book('book again');
  const ok = first?.run.status === 'succeeded' && broken?.run.failureKind === 'structural' && retry?.run.status === 'succeeded' && after?.run.status === 'succeeded';
  return { n, ok, seconds: at(), steps, sandbox: cookie.split('=')[1] };
}

const t0 = Date.now();
const results = await Promise.all(Array.from({ length: visitors }, (_, i) => visitor(i + 1).catch((err) => ({ n: i + 1, ok: false, why: err.message, steps: [] }))));
for (const r of results) console.log(`visitor ${r.n}${r.sandbox ? ` (${r.sandbox})` : ''}: ${r.ok ? 'PASS' : 'FAIL'} in ${r.seconds ?? '-'}s${r.why ? ` · ${r.why}` : ''}\n  ${r.steps.join('\n  ')}`);
console.log(`\n${results.filter((r) => r.ok).length}/${visitors} visitors completed the whole loop · ${Math.round((Date.now() - t0) / 1000)}s total`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
