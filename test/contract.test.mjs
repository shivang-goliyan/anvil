import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveContract, checkContract, amendContract, shapeOf } from '../src/contract.mjs';

const inputs = { name: 'Priya Raman', room: 'Quiet room' };
const good = { reference: 'HL-3B9AC9', name: 'Priya Raman', room: 'Quiet room', stored_reference: 'HL-3B9AC9', stored_room: 'Quiet room' };

test('code shapes ignore the letters', () => {
  assert.equal(shapeOf('HL-3B9AC9'), 'AA-XXXXXX');
  assert.equal(shapeOf('BK-2026-4821-07'), 'AA-9999-9999-99');
  assert.equal(shapeOf('Quiet room'), null);
});

test('wrong stored room fails', () => {
  const c = deriveContract([good], inputs);
  const out = checkContract(c, [{ ...good, stored_room: 'Media room' }], inputs);
  assert.equal(out.pass, false);
  assert.ok(out.problems.every((p) => p.startsWith('"stored_')));
});

test('new reference format is drift', () => {
  const c = deriveContract([good], inputs);
  const ref = 'BK-2026-4821-07';
  const out = checkContract(c, [{ ...good, reference: ref, stored_reference: ref }], inputs);
  assert.equal(out.pass, true);
  assert.deepEqual(out.drift.map((d) => d.field), ['reference', 'stored_reference']);
  const next = amendContract(c, [], out.drift);
  assert.deepEqual(next.formats.reference.shapes, ['AA-XXXXXX', 'AA-9999-9999-99']);
  assert.equal(checkContract({ ...c, ...next }, [{ ...good, reference: ref, stored_reference: ref }], inputs).drift.length, 0);
});
