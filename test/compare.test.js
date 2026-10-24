import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareScans, parseRedirectMap, toKey, diffLines, exceedsThreshold } from '../src/core/compare.js';

const pg = (key, o = {}) => ({ key, url: 'https://x' + key, status: 200, isHtml: true, title: 'T', h1: ['H'], textHash: 'a', wordCount: 100, issues: [], links: { internal: [] }, ...o });
const scan = (id, pages, issues = [], config = {}) => ({ id, env: 'prod', pages, issues, config });

test('toKey normalizes origin, query order and utm params', () => {
  assert.equal(toKey('https://a.com/x?b=2&a=1&utm_source=z#frag'), '/x?a=1&b=2');
  assert.equal(toKey('/x'), '/x');
});

test('toKey drops known tracking params and site-specific ones', () => {
  assert.equal(toKey('/a/index.html?intcmp=fi-inter_x&gclid=1&id=3'), '/a/index.html?id=3');
  assert.equal(toKey('/a?ref_src=x&id=3', ['ref_*']), '/a?id=3');
});

test('links differing only by tracking params are not a change', () => {
  const b = scan('a', [pg('/', { links: { internal: ['/x?intcmp=campaign-a', '/y'] } })]);
  const h = scan('b', [pg('/', { links: { internal: ['/x?intcmp=campaign-b', '/y'] } })]);
  assert.equal(compareScans(b, h).findings.length, 0);
  const h2 = scan('b', [pg('/', { links: { internal: ['/x?sid=2', '/y'] } })], [], { ignoreParams: ['sid'] });
  const b2 = scan('a', [pg('/', { links: { internal: ['/x?sid=1', '/y'] } })], [], { ignoreParams: ['sid'] });
  assert.equal(compareScans(b2, h2).findings.length, 0);
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

test('issues of rules that Base did not run are info, not regressions', () => {
  const iss = { code: 'canonical-broken', severity: 'error', message: 'x' };
  const head = { ...scan('b', [pg('/', { issues: [iss] })]), options: { issueCodes: ['canonical-broken', 'h1-missing'] } };
  const off = { ...scan('a', [pg('/')]), options: { issueCodes: ['h1-missing'] } };
  let f = compareScans(off, head).findings.find((x) => x.type === 'issue-new');
  assert.equal(f.severity, 'info');
  assert.match(f.message, /non attiva in Base/);
  const base = { ...scan('a', [pg('/')]), options: { issueCodes: ['canonical-broken'] } };
  f = compareScans(base, head).findings.find((x) => x.type === 'issue-new');
  assert.equal(f.severity, 'error');
  // a rule disabled in Head resolves nothing
  const b2 = { ...scan('a', [pg('/', { issues: [iss] })]), options: { issueCodes: ['canonical-broken'] } };
  const h2 = { ...scan('b', [pg('/')]), options: { issueCodes: [] } };
  assert.ok(!compareScans(b2, h2).findings.some((x) => x.type === 'issue-resolved'));
});

test('indexability and structured data changes', () => {
  let r = compareScans(scan('a', [pg('/')]), scan('b', [pg('/', { xRobots: 'noindex' })]));
  assert.equal(r.findings.find((f) => f.type === 'indexability-changed').severity, 'error');
  // a new meta noindex is already reported by robots-changed
  r = compareScans(scan('a', [pg('/')]), scan('b', [pg('/', { robots: 'noindex' })]));
  assert.ok(!r.findings.some((f) => f.type === 'indexability-changed'));
  assert.ok(r.findings.some((f) => f.type === 'robots-changed' && f.severity === 'error'));

  const sd = (types) => ({ structuredData: { types, invalid: 0 } });
  r = compareScans(scan('a', [pg('/', sd(['Organization', 'Product']))]), scan('b', [pg('/', sd(['Organization', 'BreadcrumbList']))]));
  const f = r.findings.find((x) => x.type === 'structured-data-changed');
  assert.equal(f.severity, 'warn');
  assert.match(f.message, /rimossi Product · aggiunti BreadcrumbList/);
  // older scans without the field are not compared
  r = compareScans(scan('a', [pg('/')]), scan('b', [pg('/', sd(['Organization']))]));
  assert.ok(!r.findings.some((x) => x.type === 'structured-data-changed'));
});
