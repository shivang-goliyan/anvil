import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
let answer = () => ({ status: 200, body: { choices: [{ message: { content: '{"ok":true}' } }], model: 'm' } });
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url, model: body.model, auth: init.headers.Authorization });
  const { status, body: out } = answer(url, body);
  return { ok: status < 400, status, statusText: 'x', json: async () => out };
};

process.env.GROQ_API_KEY = 'gk';
process.env.GEMINI_API_KEY = 'mk';
process.env.OPENROUTER_API_KEY = 'or1';
process.env.OPENROUTER_API_KEY_2 = 'or2';
delete process.env.LLM_BASE_URL;
const { askForJson } = await import('../src/llm.mjs');

const quota = (msg) => ({ status: 429, body: { error: { code: 429, message: msg } } });
const ok = { status: 200, body: { choices: [{ message: { content: '```json\n{"ok":true}\n```' } }] } };

beforeEach(() => {
  calls.length = 0;
});

test('first provider in chain answers', async () => {
  answer = () => ok;
  const out = await askForJson({ system: 's', prompt: 'p', model: 'groq:llama-x,gemini:flash-y' });
  assert.deepEqual(out.data, { ok: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.groq\.com\/openai\/v1\/chat\/completions$/);
  assert.equal(calls[0].model, 'llama-x');
  assert.equal(calls[0].auth, 'Bearer gk');
});

test('daily quota falls through to next', async () => {
  answer = (url) => (url.includes('groq') ? quota('Rate limit reached on requests per day (RPD)') : ok);
  const out = await askForJson({ system: 's', prompt: 'p', model: 'groq:llama-q,gemini:flash-q' });
  assert.deepEqual(out.data, { ok: true });
  assert.match(calls.at(-1).url, /generativelanguage\.googleapis\.com\/v1beta\/openai/);
  assert.equal(calls.at(-1).model, 'flash-q');
});

test('bare model name means openrouter', async () => {
  answer = () => ok;
  await askForJson({ system: 's', prompt: 'p', model: 'nex-agi/some-model:free' });
  assert.match(calls[0].url, /openrouter\.ai/);
  assert.equal(calls[0].model, 'nex-agi/some-model:free');
});

test('second openrouter key after quota', async () => {
  answer = (url, body) => (calls.length === 1 ? quota('Rate limit exceeded: free-models-per-day') : ok);
  await askForJson({ system: 's', prompt: 'p', model: 'other/model-z:free' });
  assert.deepEqual(calls.map((c) => c.auth), ['Bearer or1', 'Bearer or2']);
});

test('bad request moves on too', async () => {
  answer = (url) => (url.includes('groq') ? { status: 400, body: { error: { code: 400, message: 'response_format not supported' } } } : ok);
  const out = await askForJson({ system: 's', prompt: 'p', model: 'groq:no-json,gemini:flash-b' });
  assert.deepEqual(out.data, { ok: true });
});

// last, because it leaves the gemini key marked empty for the day
test('everything out of quota says so', async () => {
  answer = () => quota('Quota exceeded for metric generate_requests_per_day');
  await assert.rejects(askForJson({ system: 's', prompt: 'p', model: 'gemini:flash-all' }), (err) => err.quota === true);
});
