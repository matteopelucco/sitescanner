import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AREA_PALETTE, NEUTRAL_AREA_COLOR, buildSitemap, mapSupport } from '../src/core/sitemap.js';

// A site modelled on corner.ch: Italian pages under /it/, hubs with children, a hub without its parent page
// (/it/disclaimer/), two sibling hosts (one reached by a redirect, one by a link), redirects and documents.
const NAV = ['/it/', '/it/private-banking/', '/it/crediti/', '/it/contatti/'];
const SUFFIX = ' | Cornèr';

const page = (key, o = {}) => ({
  key, host: o.host, html: true, status: 200,
  title: o.title === undefined ? (o.h1 || key) + SUFFIX : o.title, h1: o.h1, description: o.description === undefined ? `Descrizione ${key}` : o.description,
  wordCount: o.words ?? 300, lang: o.lang ?? 'it', clickDepth: 'click' in o ? o.click : 1, inSitemap: true, regions: 'landmark',
  contentLinks: o.content || [], navLinks: o.nav || NAV, documents: o.docs, externalHosts: o.ext, hreflang: o.hreflang, redirectKind: undefined,
  inlinks: 0, outlinks: 0,
});
const redirect = (key, to, o = {}) => ({ key, host: o.host, html: false, status: 301, redirectTo: to, redirectKind: o.kind || 'same-host', clickDepth: null });

function corner() {
  const pages = [
    page('/it/', { title: 'Cornèr: Private Banking, crediti e soluzioni per imprese', click: 0, words: 636, content: ['/it/private-banking/', '/it/crediti/', '/it/gruppo-corner/', '/it/soluzioni-per-imprese/mercati/', '/it/lavora-con-noi/'], hreflang: [{ lang: 'de', href: 'https://www.corner.ch/de/' }, { lang: 'en', href: 'https://www.corner.ch/en/' }] }),
    page('/it/private-banking/', { h1: 'Private Banking', content: ['/it/private-banking/conto-corrente/', '/it/private-banking/fondi/'], ext: ['login.cornerlink.com'] }),
    page('/it/private-banking/conto-corrente/', { h1: 'Conto corrente', click: 2, content: ['/it/private-banking/conto-corrente/corner4you/', '/it/private-banking/conto-corrente/corner4two/'] }),
    page('/it/private-banking/conto-corrente/corner4you/', { h1: 'Cornèr4you', click: 3, words: 120, content: ['/it/private-banking/conto-corrente/corner4two/'], docs: [{ url: 'https://www.corner.ch/pdf/a.pdf', host: 'www.corner.ch', ext: 'pdf', region: 'content' }] }),
    page('/it/private-banking/conto-corrente/corner4two/', { h1: 'Cornèr4two', click: 3, content: ['/it/private-banking/conto-corrente/corner4you/'], docs: [{ url: 'https://www.corner.ch/pdf/a.pdf', host: 'www.corner.ch', ext: 'pdf', region: 'content' }, { url: 'https://www.corner.ch/pdf/b.pdf', host: 'www.corner.ch', ext: 'pdf', region: 'nav' }] }),
    page('/it/private-banking/fondi/', { h1: 'Fondi', click: 2, words: 6354 }),
    page('/it/crediti/', { h1: 'Crediti', content: ['/it/crediti/crediti-lombard/', '/it/crediti/crediti-ipotecari/'] }),
    page('/it/crediti/crediti-lombard/', { h1: 'Crediti lombard', click: 2, content: ['/it/crediti/crediti-ipotecari/'] }),
    page('/it/crediti/crediti-ipotecari/', { h1: 'Crediti ipotecari', click: 2 }),
    page('/it/contatti/', { h1: 'Contatti', content: [] }),
    page('/it/contatti/?tab=form', { h1: 'Contatti: formulario', click: 2 }),
    page('/it/gruppo-corner/', { h1: 'Gruppo Cornèr', content: [] }),
    // an hub whose parent page /it/disclaimer/ does not exist, and a landing without its section page
    page('/it/disclaimer/mandati/', { h1: 'Mandati', click: null, content: [] }),
    page('/it/landing/friendly-work-space/', { h1: 'Friendly Work Space', content: ['/it/lavora-con-noi/'] }),
    page('/it/area-legale/', { h1: 'Area legale', content: ['/it/area-legale/cookie-policy/', '/it/area-legale/note-legali/', 'kid.corner.ch/it/'] }),
    page('/it/area-legale/cookie-policy/', { h1: 'Politica dei cookie', click: 2, content: ['kid.corner.ch/it/'] }),
    page('/it/area-legale/note-legali/', { title: '', h1: undefined, click: 2 }),
    page('/it/prodotti-strutturati/', { h1: 'Prodotti strutturati', content: ['/it/prodotti-strutturati/i-nostri-prodotti/'] }),
    page('/it/intermediari-finanziari/', { h1: 'Intermediari finanziari', content: ['/it/intermediari-finanziari/mercati/'] }),
    page('/it/intermediari-finanziari/mercati/', { h1: 'Mercati', click: 2 }),
    // other hosts
    page('/it/', { host: 'kid.corner.ch', title: 'Fogli informativi di base (FIB) - Cornèr Banca SA', click: 2, nav: [], content: [], ext: [], hreflang: [] }),
    page('/l/it/', { host: 'jobs.corner.ch', title: 'Jobs and Careers at Cornèr Bank', click: 2, nav: [], content: [], lang: 'en' }),
    page('/our-products/search/?language_id=5', { host: 'structuredproducts.corner.ch', title: 'I nostri prodotti', click: 2, nav: [], content: [] }),
    // redirects
    redirect('/it/lavora-con-noi/', 'https://jobs.corner.ch/l/it/', { kind: 'sibling' }),
    redirect('/it/soluzioni-per-imprese/mercati/', 'https://www.corner.ch/it/intermediari-finanziari/mercati/'),
    redirect('/it/prodotti-strutturati/i-nostri-prodotti/', 'https://structuredproducts.corner.ch/our-products/search/?language_id=5', { kind: 'sibling' }),
  ];
  // a link from the menu to a redirecting page: the "link of the menu that redirects"
  pages.find((p) => p.key === '/it/contatti/').navLinks = [...NAV, '/it/lavora-con-noi/'];
  // pages of the main host link the sibling hosts too
  pages.find((p) => p.key === '/it/gruppo-corner/').externalHosts = ['www.esisuisse.ch'];
  pages.find((p) => p.key === '/it/crediti/').externalHosts = ['www.esisuisse.ch', 'www.sif.admin.ch', 'kid.corner.ch', 'shop.corner.ch'];
  return {
    baseUrl: 'https://www.corner.ch/it/', crawl: { start: ['/it/'] }, options: { map: { templateRatio: 0.8 } },
    pages,
    documents: [
      { url: 'https://www.corner.ch/pdf/a.pdf', host: 'www.corner.ch', ext: 'pdf', pages: 2, regions: ['content'], check: { status: 200, bytes: 1000 } },
      { url: 'https://www.corner.ch/pdf/b.pdf', host: 'www.corner.ch', ext: 'pdf', pages: 1, regions: ['nav'], check: { status: 404 } },
    ],
  };
}

const node = (m, id) => m.nodes.find((n) => n.id === id);

test('nodes are the valid HTML pages; redirects are not nodes (RF-MAP-40)', () => {
  const m = buildSitemap(corner());
  assert.equal(m.nodes.length, 23);
  assert.ok(!node(m, '/it/lavora-con-noi/'));
  assert.ok(node(m, 'kid.corner.ch/it/') && node(m, 'jobs.corner.ch/l/it/'));
  assert.equal(m.root, '/it/');
  assert.equal(node(m, '/it/').level, 0);
});

test('the root is the first start page, or the shortest path of the main host (RF-MAP-50)', () => {
  const inv = corner();
  inv.crawl.start = ['/it/gruppo-corner/'];
  assert.equal(buildSitemap(inv).root, '/it/gruppo-corner/');
  inv.crawl.start = ['/nonexistent/'];
  assert.equal(buildSitemap(inv).root, '/it/');
});

test('parents: closest ancestor by path, else the root; query pages hang under their path (RF-MAP-51)', () => {
  const m = buildSitemap(corner());
  assert.equal(node(m, '/it/private-banking/conto-corrente/corner4you/').parent, '/it/private-banking/conto-corrente/');
  assert.equal(node(m, '/it/private-banking/conto-corrente/').parent, '/it/private-banking/');
  assert.equal(node(m, '/it/disclaimer/mandati/').parent, '/it/', 'no /it/disclaimer/ page: the root');
  assert.equal(node(m, '/it/landing/friendly-work-space/').parent, '/it/');
  assert.equal(node(m, '/it/contatti/?tab=form').parent, '/it/contatti/');
  assert.equal(node(m, '/it/contatti/?tab=form').parentKind, 'path');
  assert.equal(node(m, '/it/private-banking/conto-corrente/corner4you/').level, 3);
});

test('pages of other hosts: in place of the redirect, or under the page that links them (RF-MAP-52/53)', () => {
  const m = buildSitemap(corner());
  const jobs = node(m, 'jobs.corner.ch/l/it/');
  assert.equal(jobs.parent, '/it/', 'the parent the redirecting URL /it/lavora-con-noi/ would have had');
  assert.equal(jobs.parentKind, 'redirect');
  assert.equal(jobs.reachedFrom, '/it/lavora-con-noi/');
  const sp = node(m, 'structuredproducts.corner.ch/our-products/search/?language_id=5');
  assert.equal(sp.parent, '/it/prodotti-strutturati/');
  assert.equal(sp.parentKind, 'redirect');
  const kid = node(m, 'kid.corner.ch/it/');
  assert.equal(kid.parent, '/it/area-legale/', 'linked from /it/area-legale/ (click 1) and from the cookie page (click 2)');
  assert.equal(kid.parentKind, 'link');
  assert.equal(kid.level, 2);
});

test('parent rules win over the default, and a cycle is refused with a warning (RF-MAP-54)', () => {
  const m = buildSitemap(corner(), { parents: [{ match: ['/it/gruppo-corner/'], parent: '/it/area-legale/' }] });
  const g = node(m, '/it/gruppo-corner/');
  assert.equal(g.parent, '/it/area-legale/');
  assert.equal(g.parentKind, 'rule');

  const cyc = buildSitemap(corner(), { parents: [{ match: ['/it/private-banking/conto-corrente/'], parent: '/it/private-banking/conto-corrente/corner4you/' }] });
  assert.equal(node(cyc, '/it/private-banking/conto-corrente/').parent, '/it/private-banking/');
  assert.equal(node(cyc, '/it/private-banking/conto-corrente/').parentKind, 'path');
  assert.ok(cyc.warnings.some((w) => /ciclo/.test(w)));
  // every page still reaches the root
  for (const n of cyc.nodes) assert.ok(n.id === cyc.root || n.level > 0, n.id);
});

test('short names drop the brand suffix, then fall back to H1 and path (RF-MAP-60/61)', () => {
  const m = buildSitemap(corner());
  assert.equal(node(m, '/it/crediti/crediti-lombard/').shortName, 'Crediti lombard');
  assert.equal(node(m, '/it/').shortName, 'Cornèr: Private Banking, crediti e soluzioni per imprese', 'no suffix on the home');
  assert.equal(node(m, '/it/area-legale/note-legali/').shortName, 'note legali', 'no title and no H1: the last path segment');
  assert.equal(node(m, 'kid.corner.ch/it/').shortName, 'Fogli informativi di base (FIB) - Cornèr Banca SA', 'another host has its own affix detection');
  assert.equal(buildSitemap(corner(), { titleAffix: false }).nodes.find((n) => n.id === '/it/crediti/').shortName, 'Crediti | Cornèr');
  assert.equal(buildSitemap(corner(), { titleAffix: { 'www.corner.ch': ' | Cornèr' } }).nodes.find((n) => n.id === '/it/crediti/').shortName, 'Crediti');
});

test('areas: Home, one per hub, first-level pages, one per other host (RF-MAP-70)', () => {
  const m = buildSitemap(corner());
  assert.equal(node(m, '/it/').area, 'Home');
  assert.equal(node(m, '/it/private-banking/conto-corrente/corner4you/').area, 'Private Banking');
  assert.equal(node(m, '/it/crediti/crediti-lombard/').area, 'Crediti');
  assert.equal(node(m, '/it/gruppo-corner/').area, 'Pagine di primo livello');
  assert.equal(node(m, '/it/disclaimer/mandati/').area, 'Pagine di primo livello');
  assert.equal(node(m, 'kid.corner.ch/it/').area, 'kid.corner.ch');
  assert.equal(node(m, 'jobs.corner.ch/l/it/').area, 'jobs.corner.ch');
  const total = m.areas.reduce((s, a) => s + a.pages, 0);
  assert.equal(total, m.nodes.length);
});

test('area rules assign, rename and merge areas (RF-MAP-71)', () => {
  const m = buildSitemap(corner(), {
    areas: [
      { name: 'Disclaimer & Fondi', match: ['/it/disclaimer/', '/it/private-banking/fondi/'] },
      { name: 'Corporate', match: ['re:^/it/(gruppo-corner|contatti)/'], color: '#112233' },
      { name: 'Banca', match: ['/it/private-banking/'] },
    ],
  });
  assert.equal(node(m, '/it/disclaimer/mandati/').area, 'Disclaimer & Fondi');
  assert.equal(node(m, '/it/private-banking/fondi/').area, 'Disclaimer & Fondi', 'first matching rule wins');
  assert.equal(node(m, '/it/private-banking/conto-corrente/').area, 'Banca');
  assert.equal(node(m, '/it/contatti/?tab=form').area, 'Corporate');
  assert.equal(m.areas.find((a) => a.name === 'Corporate').color.light, '#112233');
  assert.ok(!m.areas.some((a) => a.name === 'Private Banking'), 'the automatic area emptied by the rule disappears');
  // a rule for another host does not touch the main host
  const other = buildSitemap(corner(), { areas: [{ name: 'X', host: 'kid.corner.ch', match: ['/'] }] });
  assert.equal(node(other, 'kid.corner.ch/it/').area, 'X');
  assert.equal(node(other, '/it/crediti/').area, 'Crediti');
  assert.ok(buildSitemap(corner(), { areas: [{ name: 'Y', match: ['/it/'], color: 'rosso' }] }).warnings.some((w) => /Colore/.test(w)));
});

test('area colors: Home first, then by size, from the validated palette; neutral beyond it (RF-MAP-72)', () => {
  const m = buildSitemap(corner());
  assert.deepEqual(m.areas[0].color, AREA_PALETTE[0]);
  assert.equal(m.areas[0].name, 'Home');
  const rest = m.areas.slice(1);
  for (let i = 1; i < rest.length; i++) assert.ok(rest[i - 1].pages >= rest[i].pages, 'sorted by number of pages');
  const colored = m.areas.filter((a) => !a.neutral);
  assert.equal(new Set(colored.map((a) => JSON.stringify(a.color))).size, colored.length, 'distinct colors within the palette');

  // twelve areas: the first eight use the palette, the others the neutral color
  const inv = corner();
  for (let i = 0; i < 12; i++) inv.pages.push(page(`/it/s${i}/`, { h1: `Sezione ${i}`, content: [`/it/s${i}/x/`] }), page(`/it/s${i}/x/`, { h1: `Pagina ${i}` }));
  const big = buildSitemap(inv);
  assert.ok(big.areas.length > 8);
  assert.equal(big.areas.filter((a) => a.neutral).length, big.areas.length - AREA_PALETTE.length);
  assert.deepEqual(big.areas.at(-1).color, NEUTRAL_AREA_COLOR);
});

test('sub-areas: the pages under the top page of an area with enough pages (RF-MAP-73)', () => {
  const m = buildSitemap(corner());
  const sub = m.subareas.find((s) => s.id === '/it/private-banking/conto-corrente/');
  assert.deepEqual([sub.area, sub.name, sub.pages], ['Private Banking', 'Conto corrente', 3]);
  assert.ok(!m.subareas.some((s) => s.id === '/it/private-banking/fondi/'), 'one page only: below the minimum');
  assert.ok(buildSitemap(corner(), { subareaMin: 1 }).subareas.some((s) => s.id === '/it/private-banking/fondi/'));
});

test('edges: content and navigation, redirects resolved, self links ignored (RF-MAP-41..43)', () => {
  const m = buildSitemap(corner());
  const has = (list, s, t) => list.some((e) => e.source === s && e.target === t);
  assert.ok(has(m.edges.content, '/it/', '/it/private-banking/'));
  assert.ok(!has(m.edges.content, '/it/', '/it/'));
  assert.ok(!has(m.edges.navigation, '/it/', '/it/'), 'a header link to itself is not an edge');
  assert.ok(has(m.edges.navigation, '/it/crediti/', '/it/private-banking/'));
  // the link to /it/soluzioni-per-imprese/mercati/ (redirect) counts as a link to its destination
  assert.ok(has(m.edges.content, '/it/', '/it/intermediari-finanziari/mercati/'));
  assert.ok(has(m.edges.content, '/it/', 'jobs.corner.ch/l/it/'));
  assert.ok(has(m.edges.content, '/it/landing/friendly-work-space/', 'jobs.corner.ch/l/it/'));
  assert.equal(m.edges.hierarchy.length, m.nodes.length - 1);
  assert.deepEqual(m.edges.hierarchy.find((e) => e.target === 'jobs.corner.ch/l/it/'), { source: '/it/', target: 'jobs.corner.ch/l/it/', type: 'redirect' });
  // an edge once per pair
  const keys = m.edges.content.map((e) => `${e.source}>${e.target}`);
  assert.equal(new Set(keys).size, keys.length);
  const jobs = node(m, 'jobs.corner.ch/l/it/');
  assert.deepEqual(jobs.contentIn, ['/it/', '/it/landing/friendly-work-space/']);
});

test('global navigation and pages reachable only from menus (RF-MAP-44, RF-MAP-81)', () => {
  const m = buildSitemap(corner());
  assert.deepEqual(m.nodes.filter((n) => n.globalNav).map((n) => n.id).sort(), [...NAV].sort());
  // /it/contatti/ is only linked from menus
  assert.equal(node(m, '/it/contatti/').onlyFromMenus, true);
  assert.equal(node(m, '/it/private-banking/').onlyFromMenus, false);
  assert.equal(node(m, '/it/').onlyFromMenus, false, 'never the root');
  assert.equal(m.stats.links.onlyFromMenus, m.nodes.filter((n) => n.onlyFromMenus).length);
  assert.ok(m.stats.links.pagesWithTemplate >= 17);
  assert.ok(m.stats.links.contentEdges === m.edges.content.length);
  assert.equal(m.stats.links.notLinked, 1, 'only /it/disclaimer/mandati/ has no click depth');
});

test('with fewer than five pages of the host there is no global navigation', () => {
  const inv = corner();
  inv.pages = inv.pages.filter((p) => ['/it/', '/it/private-banking/', '/it/crediti/'].includes(p.key) && !p.host || p.redirectTo);
  assert.equal(buildSitemap(inv).nodes.filter((n) => n.globalNav).length, 0);
});

test('statistics: composition, content, documents, ecosystem, languages (RF-MAP-80..86)', () => {
  const m = buildSitemap(corner());
  const s = m.stats;
  assert.equal(s.composition.nodes, 23);
  assert.deepEqual(s.composition.byHost.map((h) => [h.host, h.relation, h.pages]), [['www.corner.ch', 'main', 20], ['jobs.corner.ch', 'sibling', 1], ['kid.corner.ch', 'sibling', 1], ['structuredproducts.corner.ch', 'sibling', 1]]);
  assert.equal(s.composition.byArea.reduce((a, b) => a + b.pages, 0), 23);
  assert.equal(Object.values(s.composition.byLevel).reduce((a, b) => a + b, 0), 23);

  assert.deepEqual(s.content.max, { id: '/it/private-banking/fondi/', words: 6354 });
  assert.deepEqual(s.content.min, { id: '/it/private-banking/conto-corrente/corner4you/', words: 120 });
  assert.equal(s.content.thin, 1);
  assert.equal(s.content.medianWords, 300);

  assert.equal(s.documents.unique, 2);
  assert.deepEqual(s.documents.byExt, { pdf: 2 });
  assert.equal(s.documents.pagesWithDocuments, 2);
  assert.deepEqual(s.documents.top[0], { id: '/it/private-banking/conto-corrente/corner4two/', documents: 2 });
  assert.equal(s.documents.broken, 1);
  assert.equal(s.documents.bytes, 1000);

  const eco = Object.fromEntries(s.ecosystem.map((e) => [e.host, e]));
  assert.equal(eco['kid.corner.ch'].relation, 'sibling-visited');
  assert.equal(eco['kid.corner.ch'].visited, 1);
  assert.equal(eco['shop.corner.ch'].relation, 'sibling-not-visited');
  assert.equal(eco['www.esisuisse.ch'].relation, 'external');
  assert.equal(eco['www.esisuisse.ch'].pages, 2);
  assert.equal(eco['login.cornerlink.com'].pages, 1);
  assert.ok(!eco['www.corner.ch']);

  const langs = Object.fromEntries(s.languages.map((l) => [l.lang, l]));
  assert.equal(langs.it.pages, 22);
  assert.equal(langs.en.pages, 1);
  assert.equal(langs.it.alternates.de, 4.5, '1 of 22 pages has an alternate in German');
});

test('language comes from the page, else from a two-letter ISO 639-1 first segment (RF-MAP-86)', () => {
  const inv = corner();
  const p = inv.pages.find((x) => x.key === '/it/crediti/');
  p.lang = undefined;
  assert.equal(node(buildSitemap(inv), '/it/crediti/').lang, 'it');
  p.key = '/xx/crediti/';
  p.lang = undefined;
  assert.equal(node(buildSitemap(inv), '/xx/crediti/').lang, null);
});

test('redirects: destination, hops, host and area changes, links from menus (RF-MAP-85)', () => {
  const m = buildSitemap(corner());
  const r = Object.fromEntries(m.stats.redirects.map((x) => [x.id, x]));
  assert.equal(m.stats.redirects[0].id, '/it/lavora-con-noi/', 'redirects linked from menus come first');
  assert.equal(r['/it/lavora-con-noi/'].linkedFromNav, 1);
  assert.equal(r['/it/lavora-con-noi/'].linkedFromContent, 2);
  assert.equal(r['/it/lavora-con-noi/'].crossHost, true);
  assert.equal(r['/it/lavora-con-noi/'].target, 'jobs.corner.ch/l/it/');
  assert.equal(r['/it/soluzioni-per-imprese/mercati/'].crossHost, false);
  assert.equal(r['/it/soluzioni-per-imprese/mercati/'].crossArea, true, 'from the first-level area to Intermediari finanziari');
  assert.equal(r['/it/soluzioni-per-imprese/mercati/'].target, '/it/intermediari-finanziari/mercati/');
  const chain = corner();
  chain.pages.push(redirect('/a/', 'https://www.corner.ch/b/'), redirect('/b/', 'https://www.corner.ch/it/crediti/'));
  assert.equal(buildSitemap(chain).stats.redirects.find((x) => x.id === '/a/').hops, 2);
});

test('inventories without link data still give the tree and a warning (RF-MAP-33)', () => {
  const legacy = {
    baseUrl: 'https://www.corner.ch/it/', crawl: { start: ['/it/'] },
    pages: ['/it/', '/it/a/', '/it/a/b/', '/it/c/'].map((key, i) => ({ key, html: true, status: 200, title: `T${i} | X`, clickDepth: i, inlinks: i + 1, outlinks: 2, urlDepth: 1 })),
  };
  const support = mapSupport(legacy);
  assert.deepEqual([support.links, support.regions, support.description], [false, false, false]);
  const m = buildSitemap(legacy);
  assert.equal(m.nodes.length, 4);
  assert.equal(node(m, '/it/a/b/').parent, '/it/a/');
  assert.equal(m.edges.content.length, 0);
  assert.equal(node(m, '/it/a/').totalIn, 2);
  assert.ok(m.warnings.some((w) => /Rilancia l'inventario/.test(w)));
  assert.equal(m.stats.links.noContentOut, null, 'unknown, not zero');
  assert.deepEqual(buildSitemap({ baseUrl: 'https://a.it/', pages: [] }).nodes, []);
});

test('the derivation is pure and deterministic', () => {
  const inv = corner();
  const before = JSON.stringify(inv);
  const a = JSON.stringify(buildSitemap(inv, { areas: [{ name: 'Z', match: ['/it/crediti/'] }] }));
  assert.equal(JSON.stringify(inv), before, 'the inventory is not changed');
  const shuffled = { ...inv, pages: [...inv.pages].reverse() };
  assert.equal(JSON.stringify(buildSitemap(shuffled, { areas: [{ name: 'Z', match: ['/it/crediti/'] }] })), a, 'the order of the records does not matter');
});

test('5000 pages and over 100000 links are derived in about a second (RNF-MAP-01)', () => {
  const sections = 50, perSection = 99;
  const pages = [page('/', { title: 'Home', content: [], nav: [] })];
  const navShared = ['/', ...Array.from({ length: 5 }, (_, i) => `/s${i}/`)];
  for (let s = 0; s < sections; s++) {
    pages.push(page(`/s${s}/`, { title: `S${s} | Sito`, nav: navShared, content: [] }));
    for (let p = 0; p < perSection; p++) pages.push(page(`/s${s}/p${p}/`, { title: `P${s}-${p} | Sito`, nav: navShared, content: [] }));
  }
  let edges = 0;
  for (const pg of pages.slice(1)) {
    const mine = pg.key.split('/').filter(Boolean);
    const sec = mine[0];
    const links = new Set();
    for (let k = 0; k < 22; k++) links.add(`/${sec}/p${(k * 7 + pg.key.length) % perSection}/`);
    pg.contentLinks = [...links].filter((l) => l !== pg.key);
    edges += pg.contentLinks.length + pg.navLinks.length;
  }
  pages[0].contentLinks = Array.from({ length: sections }, (_, s) => `/s${s}/`);
  const inv = { baseUrl: 'https://www.x.it/', crawl: { start: ['/'] }, pages, documents: [] };
  const t0 = performance.now();
  const m = buildSitemap(inv);
  const ms = Math.round(performance.now() - t0);
  console.log(`  ${m.nodes.length} nodes, ${m.edges.content.length + m.edges.navigation.length} edges in ${ms} ms`);
  assert.equal(m.nodes.length, 5001);
  assert.ok(m.edges.content.length + m.edges.navigation.length > 100000, `edges: ${edges}`);
  assert.ok(ms < 2000, `took ${ms} ms`);
});
