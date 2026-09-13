import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract, runReadPlan } from '../src/read-plan.mjs';
import { wireRecords, hasRealFields } from '../src/read-engines.mjs';
import { markdownLinks, rankLinks } from '../src/derive-read.mjs';
import { compactHtml } from '../src/page-shape.mjs';

const page = `<html><body><header class="top">Shop</header><ol>
  <li><article class="pod"><h3><a href="/b/1" title="The Full Title">The Full…</a></h3><p class="price">£1,051.77</p></article></li>
  <li><article class="pod"><h3><a href="/b/2" title="Second">Second</a></h3><p class="price">£10.00</p></article></li>
</ol></body></html>`;

test('extracts one record per match', () => {
  const step = { each: 'article.pod', fields: { title: { selector: 'h3 a', attr: 'title', type: 'string' }, price: { selector: '.price', type: 'number' }, link: { selector: 'h3 a', attr: 'href', type: 'string' } } };
  assert.deepEqual(extract(page, step, 'https://shop.test/list/'), [
    { title: 'The Full Title', price: 1051.77, link: 'https://shop.test/b/1' },
    { title: 'Second', price: 10, link: 'https://shop.test/b/2' },
  ]);
});

test('missing assert selector fails', async () => {
  const plan = { steps: [{ kind: 'navigate', url: '/' }, { kind: 'assert', selector: '.nope' }] };
  await assert.rejects(runReadPlan(plan, { baseUrl: 'https://shop.test/', fetchPage: async (url) => ({ html: page, url }) }), (err) => err.reason === 'selector-missing');
});

test('read plans refuse to fill', async () => {
  const plan = { steps: [{ kind: 'navigate', url: '/' }, { kind: 'fill', selector: 'input', value: 'x' }] };
  await assert.rejects(runReadPlan(plan, { baseUrl: 'https://shop.test/', fetchPage: async (url) => ({ html: page, url }) }), /cannot fill/);
});

test('wire records found when nested', () => {
  const { records, path } = wireRecords({ status: 'ok', data: { total: 2, stories: [{ id: 1, title: 'A', tags: ['x'] }, { id: 2, title: 'B' }] }, meta: {} });
  assert.equal(path, 'data.stories');
  assert.deepEqual(records, [{ id: 1, title: 'A' }, { id: 2, title: 'B' }]);
});

test('bare envelope is not data', () => {
  assert.equal(hasRealFields(wireRecords({ status: 'ok', error: null }).records), false);
});

test('markdown links keep anchor text', () => {
  const links = markdownLinks('![logo](/l.png) [Countries of the World](/pages/simple/)', 'https://site.test/pages/');
  assert.deepEqual(links, [{ url: 'https://site.test/pages/simple/', text: 'Countries of the World' }]);
});

test('links ranked by goal words', () => {
  const ranked = rankLinks(['https://s.test/', 'https://s.test/events/', 'https://s.test/about/', 'https://other.test/events/', 'https://s.test/events.pdf'], 'upcoming events near me', 'https://s.test/');
  assert.deepEqual(ranked.map((r) => r.url), ['https://s.test/events/']);
});

test('compact html trims repeats', () => {
  const html = `<body><ul>${Array.from({ length: 10 }, (_, i) => `<li class="row" onclick="x()">item ${i}</li>`).join('')}</ul><script>bad()</script></body>`;
  const out = compactHtml(html);
  assert.equal((out.match(/<li/g) ?? []).length, 3);
  assert.match(out, /7 more li\.row/);
  assert.doesNotMatch(out, /script|onclick/);
});
