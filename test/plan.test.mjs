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
