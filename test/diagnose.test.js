import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseScan, issueLabel } from '../src/core/diagnose.js';

const pg = (key, o = {}) => ({ key, url: 'https://x' + key, status: 200, isHtml: true, title: 'T', responseMs: 100, issues: [], links: { internal: [] }, ...o });
const iss = (code, severity, message = code) => ({ code, severity, message });

test('diagnoseScan groups issues by code, worst severity first', () => {
  const scan = {
    pages: [
      pg('/', { issues: [iss('h1-missing', 'warn'), iss('lang-missing', 'info')], links: { internal: ['/a', '/b', '/a', '/'] } }),
      pg('/a', { issues: [iss('h1-missing', 'warn')], links: { internal: ['/b'] } }),
      pg('/b', { status: 404, issues: [iss('http-4xx', 'error', 'Status 404')] }),
      pg('/c', { error: 'ECONNRESET', status: null, responseMs: null, issues: [iss('fetch-failed', 'error')] }),
    ],
    issues: [{ code: 'title-duplicate', id: 'title-duplicate:x', severity: 'warn', key: '/', message: 'Title duplicato su 2 pagine', pages: ['/', '/a'] }],
    crawl: { truncated: true, unvisited: 3 },
  };
  const d = diagnoseScan(scan);
  assert.deepEqual(d.codes.map((c) => c.code), ['fetch-failed', 'http-4xx', 'h1-missing', 'title-duplicate', 'lang-missing']);
  const h1 = d.codes.find((c) => c.code === 'h1-missing');
  assert.equal(h1.occurrences, 2);
  assert.equal(h1.pages, 2);
  assert.equal(h1.label, 'H1 assente');
  const dup = d.codes.find((c) => c.code === 'title-duplicate');
  assert.equal(dup.occurrences, 1);
  assert.equal(dup.pages, 2);
  assert.deepEqual(dup.items[0].pages, ['/', '/a']);

  assert.deepEqual(d.summary.byStatus, { '2xx': 2, '3xx': 0, '4xx': 1, '5xx': 0, fail: 1 });
  assert.equal(d.summary.error, 2);
  assert.equal(d.summary.warn, 3, 'site-level issues counted once');
  assert.equal(d.summary.info, 1);
  assert.equal(d.summary.pagesWithIssues, 4);
  assert.equal(d.summary.avgResponseMs, 100);
  assert.equal(d.summary.truncated, true);

  // inbound links: deduplicated, self-links ignored
  assert.deepEqual(d.inlinks['/b'], ['/', '/a']);
  assert.deepEqual(d.inlinks['/a'], ['/']);
  assert.equal(d.inlinks['/'], undefined);

  // pages: worst first; site issues are attributed to the pages they involve
  assert.deepEqual(d.pages.map((p) => p.key).slice(0, 2), ['/b', '/c']);
  const home = d.pages.find((p) => p.key === '/');
  assert.deepEqual(home.counts, { error: 0, warn: 2, info: 1 });
  assert.equal(d.siteIssuesByPage['/a'][0].code, 'title-duplicate');
  assert.equal(d.pages.find((p) => p.key === '/c').status, 'fail');
});

test('diagnoseScan on a clean scan', () => {
  const d = diagnoseScan({ pages: [pg('/')], issues: [] });
  assert.equal(d.codes.length, 0);
  assert.equal(d.summary.pagesWithIssues, 0);
  assert.equal(d.pages[0].worst, null);
});

test('issueLabel falls back to the code', () => {
  assert.equal(issueLabel('broken-links'), 'Link interni rotti');
  assert.equal(issueLabel('custom-x'), 'custom-x');
});
