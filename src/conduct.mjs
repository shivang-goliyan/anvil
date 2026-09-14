// Rules for touching other people's sites: an allowlist, then robots.txt. Checked before every
// third-party fetch, including the ones Anakin makes for us.

export const AGENT = 'AnvilBot';
const UA = `${AGENT}/0.1 (+https://github.com/shivang-goliyan/anvil)`;
const ROBOTS_TTL = 60 * 60 * 1000;

export class NotAllowed extends Error {
  constructor(message, { url, rule } = {}) {
    super(message);
    this.url = url;
    this.rule = rule;
  }
}

// Our own demo target is not third-party.
function firstParty(host) {
  if (host.endsWith('.anvil.test')) return true;
  const own = [process.env.TARGET_URL, process.env.DEMO_PUBLIC_URL].filter(Boolean).map((u) => new URL(u).hostname);
  return own.includes(host);
}

export function allowedSites() {
  return (process.env.ALLOWED_SITES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^www\./, ''))
    .filter(Boolean);
}

export function onAllowlist(url) {
  const host = new URL(url).hostname.toLowerCase();
  if (firstParty(host)) return true;
  const bare = host.replace(/^www\./, '');
  return allowedSites().some((d) => bare === d || bare.endsWith(`.${d}`));
}

export function parseRobots(text) {
  const groups = [];
  let group = null;
  let agentLine = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!agentLine) groups.push((group = { agents: [], rules: [] }));
      group.agents.push(value.toLowerCase());
      agentLine = true;
      continue;
    }
    agentLine = false;
    if (group && (key === 'allow' || key === 'disallow') && value) group.rules.push({ allow: key === 'allow', path: value });
  }
  return groups;
}

function toRegex(pattern) {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

// RFC 9309: the most specific (longest) matching rule wins, allow wins a tie, no match means allowed.
export function robotsVerdict(groups, path, agent = AGENT) {
  const name = agent.toLowerCase();
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && name.includes(a)));
  const rules = (mine.length ? mine : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules);
  let best = null;
  for (const r of rules) {
    if (!toRegex(r.path).test(path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return { allowed: !best || best.allow, rule: best ? `${best.allow ? 'Allow' : 'Disallow'}: ${best.path}` : null };
}

const cache = new Map();

async function robotsFor(origin) {
  const hit = cache.get(origin);
  // a robots.txt that could not be fetched is asked for again a minute later, not an hour
  if (hit && Date.now() - hit.at < (hit.unreachable ? 60_000 : ROBOTS_TTL)) return hit;
  let entry;
  try {
    const res = await fetch(`${origin}/robots.txt`, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (res.ok) entry = { groups: parseRobots(await res.text()), note: 'robots.txt read' };
    // 4xx means there is no usable robots.txt, which RFC 9309 treats as no restrictions
    else if (res.status < 500) entry = { groups: [], note: `no robots.txt (HTTP ${res.status})` };
    else entry = { unreachable: true, note: `robots.txt answered HTTP ${res.status}` };
  } catch (err) {
    entry = { unreachable: true, note: `could not fetch robots.txt: ${err.message}` };
  }
  entry.at = Date.now();
  cache.set(origin, entry);
  return entry;
}

// Throws NotAllowed with a reason a person can read. Returns a short note when fine.
export async function mayFetch(url, { log } = {}) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new NotAllowed(`only http and https pages, not ${u.protocol}`, { url });
  if (firstParty(u.hostname)) return 'our own site';
  if (!onAllowlist(url)) throw new NotAllowed(`${u.hostname} is not on this deployment's allowlist`, { url });

  const robots = await robotsFor(u.origin);
  // unreachable robots.txt counts as a full disallow until it can be read
  if (robots.unreachable) throw new NotAllowed(`${robots.note}, so not fetching ${u.hostname} for now`, { url });
  const verdict = robotsVerdict(robots.groups, `${u.pathname}${u.search}`);
  if (!verdict.allowed) throw new NotAllowed(`robots.txt on ${u.hostname} disallows ${u.pathname} (${verdict.rule})`, { url, rule: verdict.rule });
  const note = `${u.hostname} is allowlisted, ${robots.note}${verdict.rule ? ` (${verdict.rule})` : ', nothing disallows it'}`;
  log?.('conduct', note, { url, rule: verdict.rule });
  return note;
}
