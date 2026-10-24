import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPrintHtml } from '../src/core/print.js';

const pg = (key, o = {}) => ({ key, url: 'https://x.it' + key, status: 200, isHtml: true, title: 'T ' + key, textHash: key, wordCount: 300, issues: [], links: { internal: [] }, ...o });
const scan = (id, pages, o = {}) => ({ id, site: 'demo', siteName: 'Demo', env: 'prod', baseUrl: 'https://x.it/', startedAt: '2026-10-24T10:00:00Z', pages, issues: [], ...o });

test('diagnostic print document: paged media, sections, escaping', () => {
  const pages = [
    pg('/', { issues: [{ code: 'h1-missing', severity: 'warn', message: '<script>alert(1)</script>' }] }),
    pg('/x', { status: 500, issues: [{ code: 'http-5xx', severity: 'error', message: 'Status 500' }] }),
    pg('/n', { robots: 'noindex' }),
  ];
  const html = renderPrintHtml({ base: scan('s1', pages), siteName: 'Sito "A" \\ B', version: '9.9.9' });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /@page \{ size: A4/);
  assert.match(html, /counter\(page\) " di " counter\(pages\)/, 'page numbers');
  assert.match(html, /@top-left \{ content: "sitescanner · Sito \\"A\\" \\\\ B"/, 'site name escaped inside the CSS string');
  assert.match(html, /<title>Report di qualità · Sito &quot;A&quot;/);
  for (const h of ['1. Sintesi', '2. Issue rilevate', '3. Dettaglio di errori e warning', '4. Pagine con più problemi', '5. Pagine non indicizzabili']) assert.ok(html.includes(`<h2>${h}</h2>`), h);
  assert.ok(!html.includes('<script>alert'), 'content from the site is escaped');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Errori da correggere/);
  assert.match(html, /<td class="key">\/n<\/td><td>noindex<\/td>/);
  assert.match(html, /sitescanner 9\.9\.9/);
});

test('comparison print document: verdict, findings by severity, limits', () => {
  const base = scan('s1', [pg('/'), pg('/gone'), ...Array.from({ length: 450 }, (_, i) => pg(`/p${i}`))]);
  const head = scan('s2', [pg('/', { title: 'Nuovo' }), ...Array.from({ length: 450 }, (_, i) => pg(`/p${i}`, { status: 404 }))], { startedAt: '2026-10-25T10:00:00Z' });
  const html = renderPrintHtml({ base, head });
  assert.match(html, /Report di regressione/);
  assert.match(html, /<b>Regressioni<\/b>/);
  assert.ok(html.includes('<h2>2. Regressioni (error)</h2>'));
  assert.match(html, /Pagina rimossa/);
  assert.match(html, /… e altre \d+ differenze/, 'long lists are truncated with a note');
  assert.match(html, /Base → Head/);
  // same scan: no regressions
  assert.match(renderPrintHtml({ base, head: base }), /Stessa scan/);
});
