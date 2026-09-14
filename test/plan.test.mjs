import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlanShape } from '../src/plan.mjs';

const extract = { kind: 'extract', fields: { reference: { selector: '#r', type: 'string' } } };

test('select and check are runnable', () => {
  const plan = { steps: [{ kind: 'navigate', url: '/' }, { kind: 'select', selector: '#room', value: '{{room}}' }, { kind: 'check', selector: '#terms' }, extract] };
  assert.deepEqual(checkPlanShape(plan, { outputFields: ['reference'], inputKeys: ['room'] }), []);
});

test('select checks its input key', () => {
  const plan = { steps: [{ kind: 'navigate', url: '/' }, { kind: 'select', selector: '#room', value: '{{nope}}' }, extract] };
  assert.match(checkPlanShape(plan, { outputFields: ['reference'], inputKeys: ['room'] })[0], /unknown input "nope"/);
});

test('frame must be a selector', () => {
  const plan = { steps: [{ kind: 'navigate', url: '/' }, { kind: 'fill', selector: '#a', value: 'x', frame: 3 }, extract] };
  assert.match(checkPlanShape(plan, { outputFields: ['reference'] }).join(), /frame must be a css selector/);
});

test('commit must reach the confirmation', () => {
  const steps = (commitAt) => [
    { kind: 'navigate', url: '/' },
    { kind: 'submit', selector: '#form button', ...(commitAt === 1 && { commit: true }) },
    { kind: 'assert', selector: '#confirm-form' },
    { kind: 'submit', selector: '#confirm-form button', ...(commitAt === 3 && { commit: true }) },
    { kind: 'assert', selector: '#reference' },
    { kind: 'extract', fields: { reference: { selector: '#reference', type: 'string' } } },
  ];
  assert.match(checkPlanShape({ steps: steps(1) }, { outputFields: ['reference'], write: true }).join(), /still acts on the page/);
  assert.deepEqual(checkPlanShape({ steps: steps(3) }, { outputFields: ['reference'], write: true }), []);
});

test('selector placeholders are checked', () => {
  const plan = { steps: [{ kind: 'navigate', url: '/' }, { kind: 'check', selector: 'input[name="space"][value="{{room}}"]' }, { kind: 'check', selector: 'input[value="{{nope}}"]' }, { kind: 'extract', fields: { a: { selector: '#a' } } }] };
  const problems = checkPlanShape(plan, { inputKeys: ['room'], outputFields: ['a'] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unknown input "nope"/);
});
