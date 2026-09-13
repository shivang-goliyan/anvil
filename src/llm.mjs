// The only file that knows which model provider we use. Swap it here.

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

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

// A model that just failed (overloaded, rate limited, empty answer) sits out for a while, so the
// next call goes straight to one that is working instead of waiting on it again.
const COOLDOWN_MS = 10 * 60 * 1000;
const benched = new Map();

// Free keys get a daily request allowance. A key that runs out rests until the next UTC midnight.
const keys = () => [process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_API_KEY_2].map((k) => k?.trim()).filter(Boolean);
const emptyUntil = new Map();
const nextUtcMidnight = () => new Date(new Date().setUTCHours(24, 0, 0, 0)).getTime();

// LLM_MODEL can be a comma-separated list; free models get overloaded, so we walk down it.
export async function askForJson({ system, prompt, model = process.env.LLM_MODEL, timeoutMs = 120_000 }) {
  const all = String(model ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  if (!all.length) throw new LlmError('LLM_MODEL is not set');
  if (!keys().length) throw new LlmError('OPENROUTER_API_KEY is missing');
  const skipped = [];

  for (const [i, apiKey] of keys().entries()) {
    if (emptyUntil.get(apiKey) > Date.now()) {
      skipped.push(`key ${i + 1}: no free requests left today`);
      continue;
    }
    const rested = all.filter((m) => !(benched.get(m) > Date.now()));
    const models = rested.length ? rested : all;
    for (const m of all) if (!models.includes(m)) skipped.push(`${m}: sitting out after a recent failure`);
    for (const m of models) {
      try {
        const out = await askOne({ system, prompt, model: m, timeoutMs, apiKey });
        benched.delete(m);
        return { ...out, skipped };
      } catch (err) {
        if (err.quota) {
          emptyUntil.set(apiKey, nextUtcMidnight());
          skipped.push(`key ${i + 1}: ${err.message}`);
          break;
        }
        if (err.retryable) benched.set(m, Date.now() + COOLDOWN_MS);
        if (!err.retryable || m === models.at(-1)) {
          err.message = skipped.length ? `${err.message} (after skipping ${skipped.join('; ')})` : err.message;
          throw err;
        }
        skipped.push(`${m}: ${err.message}`);
      }
    }
  }
  throw new LlmError(`every model key is out of free requests for today (${skipped.join('; ')})`, { status: 429, quota: true });
}

async function askOne({ system, prompt, model, timeoutMs, apiKey }) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Anvil' },
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

  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const status = body.error?.code ?? res.status;
    const message = body.error?.message ?? res.statusText;
    throw new LlmError(`model call failed (${status}): ${message}`, {
      status,
      retryable: status === 429 || status >= 500,
      quota: status === 429 && /per-day|per day/i.test(message),
    });
  }

  const choice = body.choices?.[0];
  if (!choice) throw new LlmError(`model sent no choices back${body.error ? `: ${body.error.message}` : ''} (keys: ${Object.keys(body).join(', ') || 'none'})`, { retryable: true });
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
