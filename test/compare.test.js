import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareScans, parseRedirectMap, toKey, diffLines, exceedsThreshold } from '../src/core/compare.js';

const pg = (key, o = {}) => ({ key, url: 'https://x' + key, status: 200, isHtml: true, title: 'T', h1: ['H'], textHash: 'a', wordCount: 100, issues: [], links: { internal: [] }, ...o });
const scan = (id, pages, issues = []) => ({ id, env: 'prod', pages, issues });

test('toKey normalizes origin, query order and utm params', () => {
  assert.equal(toKey('https://a.com/x?b=2&a=1&utm_source=z#frag'), '/x?a=1&b=2');
  assert.equal(toKey('/x'), '/x');
});

test('parseRedirectMap accepts header, absolute URLs and separators', () => {
  assert.deepEqual(parseRedirectMap('from,to\nhttps://a.com/old;https://b.com/new\n/x\t/y\n# c\n'), { '/old': '/new', '/x': '/y' });
});

test('identical scans have no findings', () => {
  const a = scan('a', [pg('/'), pg('/b')]);
  const r = compareScans(a, scan('b', [pg('/'), pg('/b')]));
  assert.equal(r.findings.length, 0);
  assert.equal(r.summary.unchanged, 2);
});

test('removed OK page is an error, removed 404 page is info', () => {
  const r = compareScans(scan('a', [pg('/'), pg('/gone'), pg('/was404', { status: 404 })]), scan('b', [pg('/')]));
  assert.equal(r.findings.find((f) => f.key === '/gone').severity, 'error');
  assert.equal(r.findings.find((f) => f.key === '/was404').severity, 'info');
  assert.ok(exceedsThreshold(r, 'error'));
});

test('redirect map target missing is an error', () => {
  const r = compareScans(scan('a', [pg('/old')]), scan('b', []), { redirectMap: { '/old': '/new' } });
  assert.equal(r.findings[0].type, 'mapped-target-missing');
});

test('ignore and thresholds options', () => {
  const r = compareScans(scan('a', [pg('/', { textHash: 'a', wordCount: 100 })]), scan('b', [pg('/', { textHash: 'b', wordCount: 105 })]), { ignore: ['content-changed'] });
  assert.equal(r.findings.length, 0);
  const r2 = compareScans(scan('a', [pg('/', { textHash: 'a', wordCount: 100 })]), scan('b', [pg('/', { textHash: 'b', wordCount: 105 })]), { thresholds: { contentWarnRatio: 0.01 } });
  assert.equal(r2.findings[0].severity, 'warn');
});

test('visual diffs become findings', () => {
  const r = compareScans(scan('a', [pg('/')]), scan('b', [pg('/')]), { visual: { '/': { ratio: 0.2, baseSize: [10, 10], headSize: [10, 12] } } });
  assert.equal(r.findings[0].type, 'visual-changed');
  assert.equal(r.findings[0].severity, 'warn');
});

test('diffLines', () => {
  const d = diffLines('a\nb\nc', 'a\nx\nc');
  assert.deepEqual(d.map((o) => o.op + o.text), ['=a', '-b', '+x', '=c']);
});
