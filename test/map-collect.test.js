import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { documentExtension, hostRelation, primaryLang, siteDomain, urlExtension } from '../src/core/hosts.js';
import { analyzeHtml } from '../src/analyze.js';
import { applySiteForm, parseSite } from '../src/config.js';
import { analyzeInventory, applyTemplateRegions, runInventory } from '../src/inventory.js';

// A small site: pages with landmarks (header, nav, main, footer), pages without any, documents and external links.
const landmark = (title, body) => `<!doctype html><html lang="it-CH"><head><title>${title}</title><meta name="description" content="Descrizione di ${title}"></head><body>
<header><a href="/">Home</a></header>
<nav><a href="/a">A</a> <a href="/b">B</a></nav>
<main><h1>${title}</h1><p>uno due tre quattro</p>${body}</main>
<footer><a href="/privacy">Privacy</a></footer></body></html>`;
const plain = (n) => `<!doctype html><html lang="it"><head><title>Semplice ${n}</title></head><body><h1>Semplice ${n}</h1>
<div><a href="/">Home</a> <a href="/a">A</a> <a href="/plain/${n + 1}">Avanti</a></div></body></html>`;

const ROUTES = {
  '/': landmark('Home', '<a href="/c">C</a> <a href="/docs/guida.pdf">Guida</a> <a href="/docs/rotto.pdf">Rotto</a> <a href="https://ext.example/x">esterno</a> <a href="/plain/1">semplici</a> <a href="/old">vecchia</a> <a href="/go">fuori</a>'),
  '/a': landmark('A', '<a href="/docs/guida.pdf#p2">Guida</a> <a href="https://altro.example/y">altro</a>'),
  '/b': landmark('B', ''),
  '/c': landmark('C', '<a href="/b">B</a>'),
  '/privacy': landmark('Privacy', ''),
  ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`/plain/${n}`, plain(n)])),
};

let server, base, home;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-map-'));
  process.env.SITESCANNER_HOME = home;
  server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/old') return res.writeHead(301, { location: '/a' }).end();
    if (pathname === '/go') return res.writeHead(301, { location: 'https://fuori.example/' }).end();
    if (pathname === '/docs/guida.pdf') return res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': '2048' }).end(req.method === 'HEAD' ? undefined : 'x');
    if (pathname === '/docs/rotto.pdf') return res.writeHead(404, { 'content-type': 'text/plain' }).end();
    if (ROUTES[pathname]) return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(ROUTES[pathname]);
    res.writeHead(404, { 'content-type': 'text/plain' }).end('no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(home, { recursive: true, force: true });
});

const byKey = (inv, key) => inv.pages.find((p) => p.key === key);

test('hosts: domain, relation, extensions, language', () => {
  assert.equal(siteDomain('www.corner.ch'), 'corner.ch');
  assert.equal(siteDomain('shop.example.com', 'example.com'), 'example.com');
  assert.equal(hostRelation('www.corner.ch', 'www.corner.ch', 'corner.ch'), 'main');
  assert.equal(hostRelation('kid.corner.ch', 'www.corner.ch', 'corner.ch'), 'sibling');
  assert.equal(hostRelation('corner.ch', 'www.corner.ch', 'corner.ch'), 'sibling');
  assert.equal(hostRelation('evilcorner.ch', 'www.corner.ch', 'corner.ch'), 'external');
  assert.equal(urlExtension('https://a.it/x/Guida.PDF?v=1#p'), 'pdf');
  assert.equal(urlExtension('https://a.it/x/'), '');
  assert.equal(documentExtension('https://a.it/a.docx', ['pdf']), null);
  assert.equal(documentExtension('https://a.it/a.docx', ['pdf', 'docx']), 'docx');
  assert.equal(primaryLang('it-CH'), 'it');
  assert.equal(primaryLang(''), null);
});

test('analyzeHtml marks navigation links by landmark, ARIA role and custom selectors', () => {
  const html = `<body><div role="navigation"><a href="/n1">1</a></div><div class="mega"><span><a href="/n2">2</a></span></div><main><a href="/c">c</a></main><aside><a href="/n3">3</a></aside></body>`;
  const plainRun = analyzeHtml(html, 'https://a.it/');
  assert.deepEqual(plainRun.links.map((l) => [new URL(l.url).pathname, l.nav]), [['/n1', true], ['/n2', false], ['/c', false], ['/n3', true]]);
  assert.equal(plainRun.landmarks, true);
  const custom = analyzeHtml(html, 'https://a.it/', { navSelectors: ['.mega'] });
  assert.equal(custom.links.find((l) => l.url.endsWith('/n2')).nav, true);
  assert.equal(analyzeHtml('<body><div><a href="/x">x</a></div></body>', 'https://a.it/').landmarks, false);
});

test('config: map defaults and validation', () => {
  const env = 'envs: { p: { baseUrl: "https://a.it/" } }\n';
  assert.deepEqual(parseSite('x', env).map, { siblings: true, siblingHosts: [], siblingExclude: [], maxSiblingPages: 200, render: 'auto', maxRendered: 50, documentTypes: ['pdf'], checkDocuments: false, maxDocuments: 1000, navSelectors: [], templateRatio: 0.8, areas: [], parents: [], subareaMin: 3 });
  assert.deepEqual(parseSite('x', `${env}map: { documentTypes: [pdf, docx], navSelectors: [".mega-menu"] }`).map.documentTypes, ['pdf', 'docx']);
  for (const bad of ['map: { documentTypes: [exe] }', 'map: { templateRatio: 2 }', 'map: { maxDocuments: 0 }', 'map: { navSelectors: ["[["] }', 'map: [1]', 'map: { checkDocuments: "si" }']) {
    assert.throws(() => parseSite('x', env + bad), /map/, bad);
  }
});

test('applyTemplateRegions moves links shared by most pages of a host to navigation', () => {
  const ok = { isHtml: true, status: 200, redirects: [], host: 'h' };
  const mk = (key, regions, content, nav = []) => ({ ...ok, key, regions, contentLinks: content, navLinks: nav });
  const pages = [
    mk('/1', 'none', ['/', '/x1']), mk('/2', 'none', ['/', '/x2']), mk('/3', 'none', ['/', '/x3']), mk('/4', 'none', ['/', '/x4']),
    mk('/5', 'landmark', ['/x5'], ['/']),
  ];
  applyTemplateRegions(pages, 0.8);
  assert.deepEqual(pages[0].navLinks, ['/']);
  assert.deepEqual(pages[0].contentLinks, ['/x1']);
  assert.equal(pages[0].regions, 'template');
  assert.equal(pages[4].regions, 'landmark', 'pages with landmarks are not touched');

  const few = pages.slice(0, 3).map((p) => ({ ...p, regions: 'none', contentLinks: ['/', '/y'], navLinks: [] }));
  applyTemplateRegions(few, 0.8);
  assert.equal(few[0].regions, 'none', 'fewer than 5 pages of a host: no detection');
});

test('inventory collects the site map data, with and without landmarks', async () => {
  const inv = await runInventory({ url: base, map: { checkDocuments: true } });
  assert.equal(inv.schema, 2);
  assert.equal(inv.options.map.checkDocuments, true);

  const home = byKey(inv, '/');
  assert.equal(home.host, new URL(base).host);
  assert.equal(home.h1, 'Home');
  assert.equal(home.description, 'Descrizione di Home');
  assert.equal(home.lang, 'it');
  assert.equal(home.regions, 'landmark');
  assert.deepEqual(home.navLinks, ['/', '/a', '/b', '/privacy'], 'the self link stays in the record: the graph ignores it later');
  assert.ok(home.contentLinks.includes('/c') && home.contentLinks.includes('/plain/1'));
  assert.ok(!home.contentLinks.includes('/a'), 'a link only in nav is not content');
  assert.deepEqual(home.externalHosts, ['ext.example']);
  assert.ok(home.wordCount >= 4);

  // pages without landmarks: template detection moves the shared links to navigation
  const p1 = byKey(inv, '/plain/1');
  assert.equal(p1.regions, 'template');
  assert.deepEqual(p1.navLinks, ['/', '/a']);
  assert.deepEqual(p1.contentLinks, ['/plain/2']);

  // redirects keep their destination kind
  assert.equal(byKey(inv, '/old').redirectKind, 'same-host');
  assert.equal(byKey(inv, '/go').redirectKind, 'external');
});

test('documents are recorded once, never visited as pages, and checked with HEAD on request', async () => {
  const inv = await runInventory({ url: base, map: { checkDocuments: true } });
  assert.ok(!inv.pages.some((p) => p.key.endsWith('.pdf')), 'no PDF among the visited URLs');
  assert.equal(inv.documents.length, 2);
  const guida = inv.documents.find((d) => d.url.endsWith('guida.pdf'));
  assert.equal(guida.pages, 2, 'linked from / and /a (fragment ignored)');
  assert.equal(guida.check.status, 200);
  assert.equal(guida.check.contentType, 'application/pdf');
  assert.equal(guida.check.bytes, 2048);
  assert.equal(inv.documents.find((d) => d.url.endsWith('rotto.pdf')).check.status, 404);
  assert.deepEqual(inv.summary.map.documents, { unique: 2, byExt: { pdf: 2 }, checked: 2, broken: 1 });
  assert.equal(byKey(inv, '/').documents.length, 2);

  const unchecked = await runInventory({ url: base });
  assert.equal(unchecked.documents.length, 2);
  assert.ok(unchecked.documents.every((d) => !d.check), 'no HEAD request unless requested');
});

test('the inventory resumes across steps with the same result', async () => {
  const whole = await runInventory({ url: base, map: { checkDocuments: true } });
  const steps = await runInventory({ url: base, map: { checkDocuments: true } }, { budgetMs: 0 });
  const strip = (inv) => JSON.stringify({ pages: inv.pages.map((p) => ({ ...p, responseMs: 0 })), documents: inv.documents, summary: { ...inv.summary, avgResponseMs: 0 } });
  assert.equal(strip(steps), strip(whole));
});

test('progress reports the documents phase', async () => {
  const phases = new Set();
  await runInventory({ url: base, map: { checkDocuments: true } }, { onProgress: (p) => phases.add(p.phase) });
  assert.ok(phases.has('documents') && phases.has('saving'));
});

test('inventories made before the site map stay readable (RF-MAP-33)', () => {
  const legacy = [
    { key: '/', url: 'http://h/', depth: 0, redirects: [], status: 200, isHtml: true, contentType: 'text/html', title: 'Home', bytes: 10, responseMs: 5, links: { internal: ['/a'], external: 0, nofollow: 0 } },
    { key: '/a', url: 'http://h/a', depth: 1, foundFrom: '/', redirects: [], status: 200, isHtml: true, contentType: 'text/html', title: 'A', bytes: 10, responseMs: 5, links: { internal: [], external: 0, nofollow: 0 } },
  ];
  const r = analyzeInventory(legacy, { start: ['/'], sitemap: [] });
  assert.equal(r.summary.map, undefined);
  assert.deepEqual(r.documents, []);
  assert.equal(r.pages[0].contentLinks, undefined);
  assert.equal(r.summary.clickDepth.max, 1);
});

test('scans do not collect the site map data', async () => {
  const { crawl } = await import('../src/crawler.js');
  const { adhocSite, resolveEnv } = await import('../src/config.js');
  const cfg = { ...adhocSite(base), storeText: false };
  const res = await crawl(cfg, resolveEnv(cfg, 'web'), { maxPages: 3 });
  const p = res.pages.find((x) => x.key === '/');
  assert.equal(p.contentLinks, undefined);
  assert.equal(p.documents, undefined);
});

test('the site form writes the map options and keeps comments', () => {
  const raw = '# il mio sito\nenvs:\n  prod:\n    baseUrl: https://a.it/\nmaxPages: 50 # pochi\n';
  const out = applySiteForm(raw, { map: { documentTypes: ['pdf', 'docx'], navSelectors: ['.mega'], checkDocuments: true, maxDocuments: null, templateRatio: 0.9 } });
  assert.match(out, /# il mio sito/);
  assert.match(out, /# pochi/);
  const cfg = parseSite('x', out);
  assert.deepEqual(cfg.map, { siblings: true, siblingHosts: [], siblingExclude: [], maxSiblingPages: 200, render: 'auto', maxRendered: 50, documentTypes: ['pdf', 'docx'], checkDocuments: true, maxDocuments: 1000, navSelectors: ['.mega'], templateRatio: 0.9, areas: [], parents: [], subareaMin: 3 });
  // defaults are not written when the file did not have them
  assert.doesNotMatch(applySiteForm(raw, { map: { documentTypes: ['pdf'], navSelectors: [], checkDocuments: false, templateRatio: 0.8 } }), /map:/);
});

test('an inventory started with importNotes takes the notes of the previous one of the same site (RF-MAP-162)', async () => {
  const { storageFor } = await import('../src/storage/index.js');
  const st = storageFor();
  await st.writeSiteRaw('notes', `name: Notes\nstart: [/]\nsitemap: false\nenvs:\n  local: { baseUrl: "${base}" }\n`, { create: true });
  const first = await runInventory({ site: 'notes', env: 'local', maxPages: 5 });
  await st.writeInventoryOverlay(first.id, { version: 1, rules: null, notes: { general: 'Contesto', pages: { '/a': 'Nota di A', '/mai-esistita': 'x' } } });
  await new Promise((r) => setTimeout(r, 20)); // ids and dates follow the clock
  const second = await runInventory({ site: 'notes', env: 'local', maxPages: 5, importNotes: true });
  const overlay = await st.readInventoryOverlay(second.id);
  assert.equal(overlay.notes.general, 'Contesto');
  assert.deepEqual(overlay.notes.pages, { '/a': 'Nota di A' });
  const third = await runInventory({ site: 'notes', env: 'local', maxPages: 5 });
  assert.equal(await st.readInventoryOverlay(third.id), null, 'without the option nothing is copied');
});
