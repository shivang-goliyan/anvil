import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beforeAndAfter } from '../src/shots.mjs';

const shot = (src, detail) => ({ kind: 'shot', detail: { src, ...detail } });

test('before matches the stuck step', () => {
  const good = [shot('g-open', { index: 0, after: true }), shot('g-email', { index: 2, after: true }), shot('g-press', { index: 4 }), shot('g-read', { index: 6 })];
  const failed = [shot('f-open', { index: 0, after: true }), shot('f-stuck', { index: 2, stuck: true })];
  assert.deepEqual(beforeAndAfter(good, failed), { before: 'g-email', after: 'f-stuck' });
});

test('a later page falls forward', () => {
  const good = [shot('g-press', { index: 4 }), shot('g-read', { index: 6 })];
  const failed = [shot('f-stuck', { index: 5, stuck: true })];
  assert.equal(beforeAndAfter(good, failed).before, 'g-read');
});

test('nothing to compare without both', () => {
  assert.equal(beforeAndAfter([], [shot('f', { stuck: true })]), null);
  assert.equal(beforeAndAfter([shot('g', { index: 1 })], [shot('f', { index: 1 })]), null);
});
