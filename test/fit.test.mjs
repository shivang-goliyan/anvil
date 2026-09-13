import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstPageSelectors } from '../src/fit.mjs';
import { reserveRoom } from '../capabilities/reserve-room.mjs';

test('first page stops at press', () => {
  const found = firstPageSelectors(reserveRoom().steps);
  assert.equal(found.length, 7);
  assert.equal(found.at(-1).selector, '#reserve-form button[type="submit"]');
});

test('first page stops at navigate', () => {
  const steps = [{ kind: 'navigate', url: '/' }, { kind: 'fill', selector: '#a', value: 'x' }, { kind: 'navigate', url: '/b' }, { kind: 'fill', selector: '#b' }];
  assert.deepEqual(firstPageSelectors(steps).map((s) => s.selector), ['#a']);
});

test('frame selectors keep frame', () => {
  const steps = [{ kind: 'navigate', url: '/' }, { kind: 'fill', selector: '#a', frame: 'iframe#f', value: 'x' }];
  assert.equal(firstPageSelectors(steps)[0].frame, 'iframe#f');
});
