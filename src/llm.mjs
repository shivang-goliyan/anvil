// The only file that knows which model provider we use. Swap it here.

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export class LlmError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

function pullJson(content) {
  const s = String(content ?? '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
  return JSON.parse(body);
}

// LLM_MODEL can be a comma-separated list; free models get overloaded, so we walk down it.
export async function askForJson({ system, prompt, model = process.env.LLM_MODEL, timeoutMs = 120_000 }) {
  const models = String(model ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  if (!models.length) throw new LlmError('LLM_MODEL is not set');
  const skipped = [];
  for (const m of models) {
    try {
      const out = await askOne({ system, prompt, model: m, timeoutMs });
      return { ...out, skipped };
    } catch (err) {
      if (!err.retryable || m === models.at(-1)) {
        err.message = skipped.length ? `${err.message} (after skipping ${skipped.join('; ')})` : err.message;
        throw err;
      }
      skipped.push(`${m}: ${err.message}`);
    }
  }
}

async function askOne({ system, prompt, model, timeoutMs }) {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new LlmError('OPENROUTER_API_KEY is missing');

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
    throw new LlmError(`model call failed (${status}): ${body.error?.message ?? res.statusText}`, {
      status,
      retryable: status === 429 || status >= 500,
    });
  }

  const choice = body.choices?.[0];
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
