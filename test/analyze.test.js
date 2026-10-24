import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHtml, pageIssues, siteIssues, setIndexability, applyQuality } from '../src/analyze.js';
import { ISSUE_TYPES, healthScore } from '../src/core/diagnose.js';

const URL0 = 'https://x.it/';
const codes = (issues) => issues.map((i) => i.code).sort();
// Page record as the crawler builds it: fields from analyzeHtml plus response metadata.
function record(html, o = {}) {
  const { page } = analyzeHtml(html, o.url || URL0);
  const p = { key: '/', url: URL0, status: 200, isHtml: true, redirects: [], responseMs: 50, bytes: html.length, compressed: true, links: { internal: [], external: 0, nofollow: 0 }, ...page, ...o };
  if (p.canonical && !p.canonicalKey) p.canonicalKey = new URL(p.canonical).pathname;
  return setIndexability(p);
}

const GOOD = `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Un title di lunghezza giusta per la pagina</title>
<meta name="description" content="Una descrizione sufficientemente lunga da superare la soglia minima di settanta caratteri.">
<link rel="canonical" href="https://x.it/"><meta property="og:title" content="T"><meta property="og:image" content="https://x.it/i.png">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization"},{"@type":["WebSite","Thing"]}]}</script>
</head><body><h1>Titolo</h1><h2>Sezione</h2><p>${'parola '.repeat(250)}</p><a href="/a">Prodotti</a></body></html>`;

test('a well-formed page has no issues and its data is extracted', () => {
  const p = record(GOOD);
  assert.deepEqual(codes(pageIssues(p)), []);
  assert.deepEqual(p.structuredData, { types: ['Organization', 'Thing', 'WebSite'], invalid: 0 });
  assert.equal(p.doctype, true);
  assert.equal(p.charset, 'utf-8');
  assert.equal(p.titleCount, 1);
  assert.equal(p.indexable, true);
  assert.equal(p.headingSkip, null);
});

test('page rules: metadata, content, structured data, accessibility', () => {
  const html = `<html><head><title>Corto</title><title>Altro</title><meta name="description" content="breve"><meta name="description" content="x">
<link rel="canonical" href="/a"><link rel="canonical" href="/b"><meta http-equiv="refresh" content="0;url=/b">
<script type="application/ld+json">{bad json</script><link rel="alternate" hreflang="italian" href="https://x.it/en">
<svg><title>icona</title></svg></head>
<body><h1>Pagina non trovata</h1><h2>a</h2><h4>b</h4><p>Lorem ipsum dolor sit amet</p>
<img src="a.png" alt="x"><form action="http://x.it/send"><input name="q"><label>Nome <input name="n"></label><input type="hidden"></form>
<button></button><button aria-label="Chiudi"></button><iframe src="https://y.it"></iframe>
<a href="/a"></a><a href="/b">clicca qui</a><a href="/c" rel="nofollow">Contatti</a></body></html>`;
  const p = record(html, { compressed: false, bytes: 5000 });
  const c = codes(pageIssues(p));
  for (const code of ['title-too-short', 'title-multiple', 'description-too-short', 'description-multiple', 'canonical-multiple', 'canonical-relative',
    'meta-refresh', 'structured-data-invalid', 'hreflang-invalid', 'hreflang-self-missing', 'hreflang-x-default-missing', 'soft-404', 'heading-skip',
    'placeholder-text', 'img-no-dimensions', 'form-insecure', 'input-no-label', 'button-no-name', 'iframe-no-title', 'anchor-empty', 'anchor-generic',
    'compression-missing', 'doctype-missing', 'charset-missing', 'lang-missing', 'viewport-missing']) {
    assert.ok(c.includes(code), `${code} expected in ${c.join(', ')}`);
  }
  assert.equal(p.titleCount, 2, 'svg <title> ignored');
  assert.equal(p.headingSkip, 'h2 → h4');
  assert.equal(p.a11y.unlabeledInputs, 1);
  assert.equal(p.a11y.unnamedButtons, 1);
  assert.deepEqual(p.anchors, { empty: 1, generic: 1 });
  // thin-content and og-missing only on indexable pages: this one is canonicalised to /a
  assert.equal(p.indexability, 'canonicalizzata');
  assert.ok(!c.includes('thin-content'));
});

test('X-Robots-Tag, redirects and URL hygiene', () => {
  const p = record(GOOD, { xRobots: 'noindex, nofollow' });
  assert.equal(p.indexability, 'X-Robots-Tag noindex');
  assert.deepEqual(codes(pageIssues(p)), ['nofollow-page', 'x-robots-noindex']);

  const r = setIndexability({ key: '/Old_Page//x', url: 'https://x.it/Old_Page//x', status: 302, redirectLoop: true, redirects: [{ url: 'a', status: 302, location: 'b' }, { url: 'b', status: 301, location: 'a' }] });
  assert.deepEqual(codes(pageIssues(r)), ['redirect-loop', 'redirect-temporary', 'url-malformed', 'url-underscore', 'url-uppercase']);
  assert.equal(r.indexability, 'redirect');

  const thin = record(GOOD.replace(/parola /g, ''));
  assert.ok(codes(pageIssues(thin)).includes('thin-content'));
  assert.ok(!codes(pageIssues(thin, { thinWords: 0 })).includes('thin-content'), 'threshold is configurable');
});

test('cross-page rules: depth, redirects, canonical, hreflang, sitemap, duplicates, headers', () => {
  const pg = (key, o = {}) => setIndexability({ key, url: 'https://x.it' + key, status: 200, isHtml: true, redirects: [], issues: [], links: { internal: [] }, depth: 1, textHash: key, wordCount: 10, title: 'T ' + key, securityHeaders: ['hsts', 'csp', 'xcto', 'xfo', 'referrer'], ...o });
  const pages = [
    pg('/', { depth: 0, links: { internal: ['/a', '/moved', '/gone'] } }),
    pg('/a', { links: { internal: ['/b'] }, canonical: 'https://x.it/moved', canonicalKey: '/moved', hreflang: [{ lang: 'en', href: 'https://x.it/en' }, { lang: 'de', href: 'https://x.it/de' }] }),
    pg('/b', { links: { internal: ['/c'] } }),
    pg('/c', { links: { internal: ['/d'] }, textHash: 'same' }),
    pg('/d', { links: { internal: ['/'] }, textHash: 'same', securityHeaders: ['hsts'] }),
    pg('/moved', { status: 301, isHtml: false, redirects: [{ status: 301 }], finalUrl: 'https://x.it/b', links: undefined }),
    pg('/gone', { status: 404, links: undefined }),
    pg('/en', { hreflang: [{ lang: 'it', href: 'https://x.it/a' }], links: { internal: ['/'] } }),
    pg('/de', { status: 404, links: undefined }),
    pg('/orphan', { links: { internal: ['/'] } }),
    pg('/noidx', { robots: 'noindex', links: { internal: ['/'] } }),
  ];
  const site = siteIssues(pages, { startKeys: ['/'], sitemapKeys: ['/', '/a', '/orphan', '/noidx'], robotsFound: false, sitemapFound: true });
  const of = (k) => codes(byKey(k).issues);
  const byKey = (k) => pages.find((p) => p.key === k);

  assert.deepEqual(of('/'), ['broken-links', 'links-to-redirect']);
  assert.equal(byKey('/d').clickDepth, 4);
  assert.ok(of('/d').includes('deep-page'));
  assert.ok(of('/a').includes('canonical-to-redirect'));
  assert.ok(of('/a').includes('hreflang-broken'), '/de is 404');
  assert.ok(!of('/a').includes('hreflang-return-missing'), '/en links back');
  assert.ok(!of('/en').includes('hreflang-return-missing'), '/a links back to /en');
  assert.ok(of('/orphan').includes('orphan-page'));
  assert.ok(of('/noidx').includes('sitemap-non-indexable'));
  assert.ok(of('/b').includes('not-in-sitemap'));
  assert.ok(!of('/').includes('orphan-page'), 'start pages are never orphans');

  const sc = site.map((i) => i.id).sort();
  assert.ok(sc.includes('robots-missing'));
  assert.ok(!sc.includes('sitemap-missing'));
  assert.ok(sc.includes('security-headers-missing:csp'));
  const dup = site.find((i) => i.code === 'content-duplicate');
  assert.deepEqual(dup.pages, ['/c', '/d']);
});

test('canonical towards a broken page and hreflang without return link', () => {
  const pg = (key, o = {}) => setIndexability({ key, url: 'https://x.it' + key, status: 200, isHtml: true, redirects: [], issues: [], links: { internal: [] }, ...o });
  const pages = [
    pg('/', { depth: 0, canonical: 'https://x.it/x', canonicalKey: '/x', hreflang: [{ lang: 'en', href: 'https://x.it/en' }] }),
    pg('/x', { status: 500 }),
    pg('/en', { hreflang: [] }),
  ];
  siteIssues(pages);
  assert.ok(codes(pages[0].issues).includes('canonical-broken'));
  assert.ok(codes(pages[0].issues).includes('hreflang-return-missing'));
});

test('applyQuality disables rules and overrides severities', () => {
  const pages = [{ key: '/', issues: [{ code: 'h1-missing', severity: 'warn' }, { code: 'lang-missing', severity: 'info' }] }];
  const { issues, issueCodes } = applyQuality(pages, [{ code: 'title-duplicate', severity: 'warn' }], { disable: ['lang-missing'], severity: { 'h1-missing': 'error' } });
  assert.deepEqual(pages[0].issues, [{ code: 'h1-missing', severity: 'error' }]);
  assert.equal(issues.length, 1);
  assert.ok(!issueCodes.includes('lang-missing'));
  assert.equal(issueCodes.length, Object.keys(ISSUE_TYPES).length - 1);
});

test('healthScore is the share of pages without errors', () => {
  const scan = {
    pages: [{ key: '/', issues: [] }, { key: '/a', issues: [{ severity: 'error' }] }, { key: '/b', issues: [{ severity: 'warn' }] }, { key: '/c', issues: [] }],
    issues: [{ severity: 'error', pages: ['/c'] }],
  };
  assert.equal(healthScore(scan), 50);
  assert.equal(healthScore({ pages: [] }), null);
});
