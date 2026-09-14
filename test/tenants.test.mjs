import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validSandbox, newSandbox, capId, splitCapId, sandboxHost, sandboxOfHost, cookieValue, sandboxOfPath } from '../src/tenants.mjs';

test('sandbox ids are checked', () => {
  assert.equal(validSandbox('abc123def4'), 'abc123def4');
  assert.equal(validSandbox('ABC123def4'), null);
  assert.equal(validSandbox('short'), null);
  assert.equal(validSandbox(undefined), null);
  assert.ok(validSandbox(newSandbox()));
});

test('capability ids round trip', () => {
  assert.equal(capId('reserve-room', ''), 'reserve-room');
  assert.equal(capId('reserve-room', 'abc123def4'), 'reserve-room~abc123def4');
  assert.deepEqual(splitCapId('reserve-room~abc123def4'), { base: 'reserve-room', sandbox: 'abc123def4' });
  assert.deepEqual(splitCapId('quotes-toscrape-com-qppwk'), { base: 'quotes-toscrape-com-qppwk', sandbox: '' });
  assert.deepEqual(splitCapId('reserve-room~../x'), { base: 'reserve-room', sandbox: '' });
});

test('hosts and paths map', () => {
  assert.equal(sandboxHost('abc123def4'), 'abc123def4.harbor-lane.anvil.test');
  assert.equal(sandboxOfHost('abc123def4.harbor-lane.anvil.test'), 'abc123def4');
  assert.equal(sandboxOfHost('harbor-lane.anvil.test'), '');
  assert.equal(sandboxOfHost('evil.com'), '');
  assert.deepEqual(sandboxOfPath('/t/abc123def4/events'), { sandbox: 'abc123def4', path: '/events' });
  assert.deepEqual(sandboxOfPath('/t/abc123def4'), { sandbox: 'abc123def4', path: '/' });
  assert.equal(sandboxOfPath('/events'), null);
});

test('cookie values parse', () => {
  assert.equal(cookieValue('a=1; anvil_sandbox=abc123def4; b=2', 'anvil_sandbox'), 'abc123def4');
  assert.equal(cookieValue('', 'anvil_sandbox'), null);
});
