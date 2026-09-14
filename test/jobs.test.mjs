import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickJob, yieldsTo } from '../src/job-order.mjs';

test('busy capability waits its turn', () => {
  const queued = [{ id: 'a', capabilityId: 'reserve-room~x' }, { id: 'b', capabilityId: 'reserve-room~y' }];
  assert.equal(pickJob(queued, new Set(['reserve-room~x'])).id, 'b');
  assert.equal(pickJob(queued, new Set()).id, 'a');
  assert.equal(pickJob(queued, new Set(['reserve-room~x', 'reserve-room~y'])), null);
});

test('newer claim yields', () => {
  const older = { id: 'a', createdAt: new Date(1000) };
  const newer = { id: 'b', createdAt: new Date(2000) };
  assert.equal(yieldsTo(newer, older), true);
  assert.equal(yieldsTo(older, newer), false);
  const twin = { id: 'c', createdAt: new Date(1000) };
  assert.notEqual(yieldsTo(older, twin), yieldsTo(twin, older));
});
