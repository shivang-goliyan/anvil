import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linksWorthOpening, learnedProblems, pathsOnly } from '../src/learn.mjs';

const OUT = { reference: 'string', name: 'string', seats: 'number', stored_name: 'string', stored_seats: 'number' };
const IN = { name: 'Priya Raman', seats: 3 };

test('good booking passes', () => {
  assert.deepEqual(learnedProblems([{ reference: 'HL-1', name: 'Priya Raman', seats: 3, stored_name: 'priya raman', stored_seats: 3 }], IN, OUT), []);
});

test('empty and wrong fields fail', () => {
  const problems = learnedProblems([{ reference: 'HL-1', name: null, seats: '3', stored_name: 'Tomas', stored_seats: 3 }], IN, OUT);
  assert.ok(problems.some((p) => /"name" came back empty/.test(p)));
  assert.ok(problems.some((p) => /"seats" should be a number/.test(p)));
  assert.ok(problems.some((p) => /"stored_name" shows "Tomas"/.test(p)));
  assert.deepEqual(learnedProblems([], IN, OUT), ['nothing was read back']);
});

test('goal links are picked', () => {
  const html = '<a href="/">Harbor Lane Library</a><a href="/events">Events</a><a href="/find">Find my booking</a><a href="https://elsewhere.test/find">Find</a>';
  const links = linksWorthOpening(html, 'look the booking up on the Find my booking page', 'https://harbor-lane.anvil.test/');
  assert.deepEqual(links, [{ url: 'https://harbor-lane.anvil.test/find', text: 'Find my booking' }]);
});

test('same-site urls become paths', () => {
  const steps = pathsOnly([{ kind: 'navigate', url: 'https://harbor-lane.anvil.test/find?x=1' }, { kind: 'navigate', url: 'https://elsewhere.test/' }, { kind: 'fill', selector: '#a' }], 'https://harbor-lane.anvil.test/');
  assert.deepEqual(steps.map((s) => s.url), ['/find?x=1', 'https://elsewhere.test/', undefined]);
});
