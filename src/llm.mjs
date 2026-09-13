// The only file that knows which model providers we use. Swap them here.
//
// LLM_MODEL is a comma-separated chain, tried in order: "groq:<model>, gemini:<model>, <openrouter model>".
// A bare model name means OpenRouter (or LLM_BASE_URL, when that is set). All of them speak the
// OpenAI chat completions format, and all have a free tier.

const PROVIDERS = {
  openrouter: { base: 'https://openrouter.ai/api/v1', keys: ['OPENROUTER_API_KEY', 'OPENROUTER_API_KEY_2'] },
  groq: { base: 'https://api.groq.com/openai/v1', keys: ['GROQ_API_KEY'] },
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai', keys: ['GEMINI_API_KEY'] },
};

export class LlmError extends Error {
  constructor(message, { status, retryable = false, quota = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    // the key has no free requests left today; no model on that key will answer
    this.quota = quota;
  }
}

function pullJson(content) {
  const s = String(content ?? '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
  return JSON.parse(body);
}

function chain(list) {
  return String(list ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean)
    .map((entry) => {
      const [head, ...rest] = entry.split(':');
      if (PROVIDERS[head] && rest.length) return { provider: head, model: rest.join(':'), label: entry };
      const base = process.env.LLM_BASE_URL;
      return base ? { provider: 'custom', base, model: entry, label: entry } : { provider: 'openrouter', model: entry, label: entry };
    });
}

function keysFor(entry) {
  if (entry.provider === 'custom') return [process.env.LLM_API_KEY?.trim() || 'none'];
  return PROVIDERS[entry.provider].keys.map((k) => process.env[k]?.trim()).filter(Boolean);
}

// A model that just failed (overloaded, rate limited, empty answer) sits out for a while, so the
// next call goes straight to one that is working instead of waiting on it again.
const COOLDOWN_MS = 10 * 60 * 1000;
const benched = new Map();

// Free keys get a daily allowance. A key that runs out rests until the next UTC midnight.
const emptyUntil = new Map();
const nextUtcMidnight = () => new Date(new Date().setUTCHours(24, 0, 0, 0)).getTime();

export async function askForJson({ system, prompt, model = process.env.LLM_MODEL, timeoutMs = 120_000 }) {
  const entries = chain(model);
  if (!entries.length) throw new LlmError('LLM_MODEL is not set');

  const attempts = entries.flatMap((entry) => keysFor(entry).map((key, i) => ({ entry, key, keyLabel: `${entry.provider} key ${i + 1}` })));
  if (!attempts.length) throw new LlmError('no API key is set for any model in LLM_MODEL');

  const usable = (a) => !(emptyUntil.get(a.key) > Date.now());
  const rested = attempts.filter((a) => usable(a) && !(benched.get(a.entry.label) > Date.now()));
  // if everything is sitting out, try the ones that still have requests left anyway
  const order = rested.length ? rested : attempts.filter(usable);
  const skipped = attempts.filter((a) => !order.includes(a)).map((a) => `${a.entry.label} (${usable(a) ? 'sitting out after a recent failure' : `${a.keyLabel} has no free requests left today`})`);

  let last = null;
  let onlyQuota = true;
  for (const a of order) {
    try {
      const out = await askOne({ ...a.entry, system, prompt, apiKey: a.key, timeoutMs });
      benched.delete(a.entry.label);
      return { ...out, skipped: [...new Set(skipped)] };
    } catch (err) {
      last = err;
      if (err.quota) {
        emptyUntil.set(a.key, nextUtcMidnight());
        skipped.push(`${a.keyLabel}: out of free requests for today`);
        continue;
      }
      onlyQuota = false;
      benched.set(a.entry.label, Date.now() + COOLDOWN_MS);
      skipped.push(`${a.entry.label}: ${err.message}`);
    }
  }
  if (onlyQuota || !last) throw new LlmError(`every model key is out of free requests for today (${[...new Set(skipped)].join('; ')})`, { status: 429, quota: true });
  last.message = `${last.message} (tried ${[...new Set(skipped)].join('; ')})`;
  throw last;
}

async function askOne({ provider, base, model, system, prompt, apiKey, timeoutMs }) {
  const url = `${(base ?? PROVIDERS[provider].base).replace(/\/$/, '')}/chat/completions`;
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(provider === 'openrouter' && { 'X-Title': 'Anvil' }) },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new LlmError(`model request did not complete: ${err.message}`, { retryable: true });
  }

  let body = await res.json().catch(() => ({}));
  // Gemini's compatibility layer sometimes wraps errors in an array
  if (Array.isArray(body)) body = body[0] ?? {};
  if (!res.ok || body.error) {
    const status = Number(body.error?.code) || res.status;
    const message = body.error?.message ?? res.statusText;
    throw new LlmError(`model call failed (${status}): ${message}`, {
      status,
      // 402 is a paid model on an account with no credit; everything here moves on to the next model anyway
      retryable: status === 429 || status === 402 || status >= 500,
      quota: status === 429 && /per.?day|daily|RPD|free-models-per-day/i.test(message),
    });
  }

  const choice = body.choices?.[0];
  if (!choice) throw new LlmError(`model sent no choices back (keys: ${Object.keys(body).join(', ') || 'none'})`, { retryable: true });
  const content = choice?.message?.content;
  try {
    return { data: pullJson(content), model: body.model ?? model, ms: Date.now() - started, usage: body.usage };
  } catch {
    // reasoning models sometimes spend the whole answer thinking and leave content empty
    const why = content
      ? String(content).slice(0, 200)
      : `empty answer (finish ${choice?.finish_reason ?? '?'}${choice?.message?.reasoning ? ', only reasoning came back' : ''}${choice?.error ? `, ${choice.error.message}` : ''})`;
    throw new LlmError(`model did not return usable JSON: ${why}`, { retryable: true });
  }
}
