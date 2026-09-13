import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, robotsVerdict, onAllowlist } from '../src/conduct.mjs';

const robots = parseRobots(`
# comment
User-agent: *
Disallow: /private
Allow: /private/open
Disallow: /*.pdf$
Disallow:

User-agent: BadBot
User-agent: AnvilBot
Disallow: /catalogue/secret
`);

const star = (path) => robotsVerdict(robots, path, 'SomeoneElse').allowed;

test('no matching rule allows', () => {
  assert.equal(star('/books/1'), true);
});

test('disallow prefix blocks', () => {
  assert.equal(star('/private/stuff'), false);
});

test('longer allow beats disallow', () => {
  assert.equal(star('/private/open/page'), true);
});

test('wildcard with end anchor', () => {
  assert.equal(star('/files/report.pdf'), false);
  assert.equal(star('/files/report.pdf?x=1'), true);
});

test('named group replaces star group', () => {
  assert.equal(robotsVerdict(robots, '/private/stuff').allowed, true);
  assert.equal(robotsVerdict(robots, '/catalogue/secret/x').allowed, false);
});

test('empty robots allows everything', () => {
  assert.equal(robotsVerdict(parseRobots(''), '/anything').allowed, true);
});

test('allowlist matches subdomains only', () => {
  process.env.ALLOWED_SITES = 'toscrape.com, www.python.org';
  assert.equal(onAllowlist('https://books.toscrape.com/'), true);
  assert.equal(onAllowlist('https://python.org/events/'), true);
  assert.equal(onAllowlist('https://nottoscrape.com/'), false);
  assert.equal(onAllowlist('https://example.com/'), false);
});
