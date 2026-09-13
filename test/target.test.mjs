import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshConfig, applyBreak } from '../target/config.mjs';

test('custom rename follows the label', () => {
  const c = freshConfig();
  const out = applyBreak(c, 'custom', null, { field: 'email', label: 'Where should we write?' });
  const email = c.fields.find((f) => f.key === 'email');
  assert.equal(email.name, 'where_should_we_write');
  assert.equal(email.label, 'Where should we write?');
  assert.match(out.detail, /was "email"/);
  assert.equal(c.breaks.at(-1).kind, 'custom');
});

test('custom button and order', () => {
  const c = freshConfig();
  applyBreak(c, 'custom', null, { button: 'Grab my room', order: 'seats,name,email,room,date,time' });
  assert.equal(c.submitLabel, 'Grab my room');
  assert.deepEqual(c.fields.map((f) => f.key), ['seats', 'name', 'email', 'room', 'date', 'time']);
});

test('custom names never collide', () => {
  const c = freshConfig();
  applyBreak(c, 'custom', null, { field: 'name', label: 'Seats' });
  const [name, seats] = ['name', 'seats'].map((k) => c.fields.find((f) => f.key === k).name);
  assert.notEqual(name, seats);
});

test('custom refuses markup and no-ops', () => {
  assert.throws(() => applyBreak(freshConfig(), 'custom', null, { field: 'email', label: '<script>x</script>' }), /letters, numbers/);
  assert.throws(() => applyBreak(freshConfig(), 'custom', null, {}), /would not change anything/);
  assert.throws(() => applyBreak(freshConfig(), 'custom', null, { order: 'name,name,email' }), /every box once/);
  assert.throws(() => applyBreak(freshConfig(), 'custom', null, { label: 'Hello' }), /which box/);
});
