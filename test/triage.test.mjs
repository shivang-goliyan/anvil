import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triage } from '../src/triage.mjs';
import { StepError } from '../src/plan.mjs';
import { AnakinError } from '../src/errors.mjs';

const stepError = (reason, docStatus = 200) => new StepError(`step 2 failed: ${reason}`, { index: 1, step: {}, reason, url: 'https://x.test/', docStatus });
const passed = { pass: true, problems: [] };
const kind = (args) => triage({ records: [], canaryPresent: true, ...args }).kind;

test('anakin network trouble is transient', () => {
  assert.equal(kind({ error: new AnakinError('could not reach Anakin', { code: 'network' }) }), 'transient');
  assert.equal(kind({ error: new AnakinError('no browser', { code: 'browser_unavailable' }) }), 'transient');
  assert.equal(kind({ error: new AnakinError('slow down', { status: 429 }) }), 'transient');
});

test('site 5xx and 429 are transient', () => {
  assert.equal(kind({ error: stepError('selector-missing', 503) }), 'transient');
  assert.equal(kind({ error: stepError('selector-missing', 429) }), 'transient');
});

test('navigation failure is transient', () => {
  assert.equal(kind({ error: stepError('navigation', null) }), 'transient');
});

test('missing canary means transient', () => {
  assert.equal(kind({ error: stepError('selector-missing'), canaryPresent: false }), 'transient');
});

test('403 is blocked', () => {
  assert.equal(kind({ error: stepError('selector-missing', 403) }), 'blocked');
});

test('captcha page is blocked', () => {
  assert.equal(kind({ error: stepError('selector-missing'), pageText: 'Please verify you are human' }), 'blocked');
});

test('our own auth problem is blocked', () => {
  assert.equal(kind({ error: new AnakinError('refused', { status: 401, code: 'auth' }) }), 'blocked');
});

test('rendered page, missing selector is structural', () => {
  assert.equal(kind({ error: stepError('selector-missing') }), 'structural');
});

test('contract failure is structural', () => {
  const contractCheck = { pass: false, problems: ['"email" is missing'] };
  assert.equal(kind({ contractCheck, records: [{ email: null }] }), 'structural');
});

test('zero records with canary is empty', () => {
  const contractCheck = { pass: false, problems: ['got 0 record(s), need at least 1'] };
  assert.equal(kind({ contractCheck, records: [] }), 'empty');
});

test('zero records without canary is structural', () => {
  const contractCheck = { pass: false, problems: ['got 0 record(s), need at least 1'] };
  assert.equal(kind({ contractCheck, records: [], canaryPresent: false }), 'structural');
});

test('passing contract is ok', () => {
  assert.equal(kind({ contractCheck: passed, records: [{ a: 1 }] }), 'ok');
});

test('stored record disagreeing is mismatch', () => {
  const contractCheck = { pass: false, problems: ['"stored_room" (Media room) does not agree with "room" (Quiet room)'] };
  const sent = { found: ['name', 'room'], missing: [] };
  assert.equal(kind({ contractCheck, records: [{}], sent }), 'mismatch');
  assert.equal(kind({ contractCheck, records: [{}], sent: { found: [], missing: ['room'] } }), 'structural');
});

test('emptied long list is structural', () => {
  const contractCheck = { pass: false, problems: ['got 0 records, expected at least 10'] };
  assert.equal(triage({ contractCheck, records: [], canaryPresent: true, expected: 10 }).kind, 'structural');
});
