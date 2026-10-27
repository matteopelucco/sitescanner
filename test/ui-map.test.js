import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startApp, openPage, chromiumAvailable } from './helpers/ui.js';
import { runInventory } from '../src/inventory.js';

// The map views of the inventory detail, in a real browser (spec §14.5). Skipped without Chromium.
let app, browser, server, invId, skip = false;

const page = (t, b = '') => `<!doctype html><html lang="it"><head><title>${t} | Marca</title><meta name="description" content="Descrizione ${t}"></head><body><header><a href="/">Home</a> <a href="/servizi/">Servizi</a> <a href="/blog/">Blog</a></header><main><h1>${t}</h1><p>uno due tre</p>${b}</main></body></html>`;

before(async () => {
  if (!(await chromiumAvailable())) {
    skip = 'Chromium non disponibile (npx playwright install chromium)';
    return;
  }
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  app = await startApp();
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x').pathname;
    const html = (b) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(b);
    if (u === '/') return html(page('Home', '<a href="/servizi/">S</a> <a href="/blog/">B</a> <a href="/guida.pdf">PDF</a>'));
    if (u === '/servizi/') return html(page('Servizi', '<a href="/servizi/uno">uno</a> <a href="/servizi/due">due</a>'));
    if (u === '/servizi/uno' || u === '/servizi/due') return html(page(`Servizio ${u.slice(-3)}`));
    if (u === '/blog/') return html(page('Blog', '<a href="/blog/a">a</a>'));
    if (u === '/blog/a') return html(page('Articolo A'));
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  invId = (await runInventory({ url: `http://127.0.0.1:${server.address().port}/` })).id;
});

after(async () => {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
  if (app) await app.stop();
});

test('tree, catalog, inspector and filters, with no JavaScript errors', async (t) => {
  if (skip) return t.skip(skip);
  const errors = [];
  for (const scheme of ['light', 'dark']) {
    const { page: p, context: ctx, problems } = await openPage(browser, app.base);
    await p.emulateMedia({ colorScheme: scheme });
    await p.goto(`${app.base}/#/inventory/${invId}?tab=tree`);
    await p.waitForSelector('.mtree .trow');
    assert.ok((await p.locator('.mtree .trow').count()) >= 3, 'the tree shows the first levels');
    await p.locator('.tname', { hasText: 'Servizi' }).first().click();
    await p.waitForSelector('#mapInsp:not([hidden])');
    assert.match(await p.locator('#mapInsp').innerText(), /Servizi/);
    assert.match(p.url(), /sel=/, 'the selection is in the URL');

    // filters shared with the catalog; selection survives the tab change in the URL
    await p.goto(`${app.base}/#/inventory/${invId}?tab=catalog`);
    await p.waitForSelector('table.mcat tbody tr');
    const all = await p.locator('table.mcat tbody tr').count();
    await p.fill('#mq', 'blog');
    await p.waitForFunction((n) => document.querySelectorAll('table.mcat tbody tr').length < n, all);
    assert.ok((await p.locator('table.mcat tbody tr').count()) >= 1);
    assert.match(await p.locator('#mcount').innerText(), /di \d+ pagine/);
    await p.click('th button[data-sort="words"]');
    await p.click('table.mcat tbody tr >> nth=0');
    await p.waitForSelector('#mapInsp:not([hidden])');

    await p.goto(`${app.base}/#/inventory/${invId}?tab=redirects`);
    await p.waitForSelector('text=Ecosistema');
    await p.goto(`${app.base}/#/inventory/${invId}`);
    await p.waitForSelector('#mapStats h2');
    errors.push(...problems);
    await ctx.close();
  }
  assert.deepEqual(errors, []);
});

test('phone width: the inspector takes the whole screen', async (t) => {
  if (skip) return t.skip(skip);
  const { page: p, context: ctx } = await openPage(browser, app.base, { viewport: { width: 400, height: 800 } });
  await p.goto(`${app.base}/#/inventory/${invId}?tab=tree`);
  await p.waitForSelector('.mtree .trow');
  await p.locator('.tname').first().click();
  await p.waitForSelector('#mapInsp:not([hidden])');
  const box = await p.locator('#mapInsp').boundingBox();
  assert.ok(box.width >= 399);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal scroll');
  await ctx.close();
});

test('graph: three layouts, selection by click, keyboard search, no JavaScript errors', async (t) => {
  if (skip) return t.skip(skip);
  for (const scheme of ['light', 'dark']) {
    const { page: p, context: ctx, problems } = await openPage(browser, app.base);
    await p.emulateMedia({ colorScheme: scheme });
    await p.goto(`${app.base}/#/inventory/${invId}?tab=graph`);
    await p.waitForSelector('canvas#gcv');
    await p.waitForFunction(() => window.__mapGraph && window.__mapGraph.state().nodes >= 5);
    assert.equal(await p.evaluate(() => window.__mapGraph.state().aggregated), false);
    for (const layout of ['levels', 'force', 'radial']) {
      await p.selectOption('#glay', layout);
      await p.waitForFunction((l) => window.__mapGraph.state().layout === l, layout);
      await p.waitForTimeout(700); // the transition, and the worker for the force layout
    }
    // a click on a node selects it and opens the inspector
    const target = await p.evaluate(() => window.__mapGraph.screenPos('/blog/'));
    await p.evaluate(() => document.querySelector('canvas#gcv').scrollIntoView());
    const box = await p.locator('canvas#gcv').boundingBox();
    await p.mouse.click(box.x + target.x, box.y + target.y);
    await p.waitForSelector('#mapInsp:not([hidden])');
    assert.match(await p.locator('#mapInsp').innerText(), /Blog/);
    assert.match(p.url(), /sel=%2Fblog%2F|sel=\/blog\//);
    // keyboard: "/" focuses the search, Enter selects the first result
    await p.locator('canvas#gcv').focus();
    await p.keyboard.press('/');
    assert.equal(await p.evaluate(() => document.activeElement.id), 'mq');
    await p.keyboard.type('servizi');
    await p.keyboard.press('Enter');
    await p.waitForFunction(() => /Servizi/.test(document.querySelector('#mapInsp').innerText));
    assert.deepEqual(problems, []);
    await ctx.close();
  }
});

// A site of 2400 pages saved directly (RNF-MAP-02): above 1500 nodes the graph starts aggregated.
function bigInventory(id, sections, per) {
  const base = { host: 'x.test', html: true, status: 200, wordCount: 50, regions: 'landmark', documents: [], inlinks: 1, outlinks: 1, section: '/' };
  const pages = [{ ...base, key: '/', title: 'Home | X', clickDepth: 0, urlDepth: 0, navLinks: [], contentLinks: [] }];
  for (let s = 0; s < sections; s++) {
    const top = { ...base, key: `/sec${s}/`, title: `Sezione ${s} | X`, clickDepth: 1, urlDepth: 1, navLinks: ['/'], contentLinks: [] };
    pages.push(top);
    pages[0].contentLinks.push(top.key);
    for (let p = 0; p < per; p++) {
      const k = `${top.key}p${p}`;
      pages.push({ ...base, key: k, title: `Pagina ${s}-${p} | X`, clickDepth: 2, urlDepth: 2, navLinks: ['/'], contentLinks: p ? [`${top.key}p${p - 1}`] : [] });
      top.contentLinks.push(k);
    }
  }
  const meta = {
    schema: 2, id, baseUrl: 'https://x.test/', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1,
    options: { maxPages: 5000, maxDepth: 50, map: {} }, crawl: { truncated: false, unvisited: 0, start: ['/'] },
    summary: { urls: pages.length, htmlPages: pages.length, byStatus: {}, contentTypes: {}, htmlBytes: 0, avgResponseMs: 1, clickDepth: { max: 2, avg: 2, histogram: {}, notLinked: 0 }, urlDepth: { max: 2, histogram: {} }, sections: [], sitemap: { listed: 0, crawled: 0, notLinked: 0, missing: 0 }, linkedNotVisited: 0, topInlinks: [], deepest: [], map: {} },
  };
  return { ...meta, tree: { name: '/', path: '/', pages: 1, total: pages.length, children: [] }, pages, documents: [] };
}

test('graph: a large site starts aggregated and a click expands a group', async (t) => {
  if (skip) return t.skip(skip);
  const { storageFor } = await import('../src/storage/index.js');
  const inv = bigInventory('big', 40, 60);
  await storageFor().saveInventory(inv, inv);
  const { page: p, context: ctx, problems } = await openPage(browser, app.base, { viewport: { width: 1200, height: 900 } });
  await p.goto(`${app.base}/#/inventory/big?tab=graph`);
  await p.waitForFunction(() => window.__mapGraph && window.__mapGraph.state().nodes > 3);
  const st = await p.evaluate(() => window.__mapGraph.state());
  assert.equal(st.aggregated, true);
  assert.ok(st.nodes < 100, `one node per group, not per page (${st.nodes})`);
  assert.equal(await p.evaluate(() => document.querySelector('#glay option[value="force"]').disabled), true, 'force is available up to 1500 nodes');
  await p.waitForTimeout(700);
  const at = await p.evaluate(() => window.__mapGraph.screenPos('/sec3/'));
  await p.evaluate(() => document.querySelector('canvas#gcv').scrollIntoView());
  const box = await p.locator('canvas#gcv').boundingBox();
  await p.mouse.click(box.x + at.x, box.y + at.y);
  await p.waitForFunction((n) => window.__mapGraph.state().nodes > n, st.nodes);
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('inspector: a link to the diagnostics of the latest scan that has the page (RF-MAP-145)', async (t) => {
  if (skip) return t.skip(skip);
  const { storageFor } = await import('../src/storage/index.js');
  const { scanSite } = await import('../src/scan.js');
  const st = storageFor();
  const root = `http://127.0.0.1:${server.address().port}/`;
  await st.writeSiteRaw('demo', `name: Demo\nstart: [/]\nsitemap: false\nscreenshots: { enabled: false }\nenvs:\n  local: { baseUrl: "${root}" }\n`, { create: true });
  await scanSite('demo', 'local', { storage: st });
  const inv = await runInventory({ site: 'demo', env: 'local' });
  const { page: p, context: ctx, problems } = await openPage(browser, app.base);
  await p.goto(`${app.base}/#/inventory/${inv.id}?tab=tree&sel=%2Fblog%2F`);
  const link = p.locator('#diag a');
  await link.waitFor();
  assert.match(await link.getAttribute('href'), /^\/report\/#site=demo&base=.+&page=%2Fblog%2F$/);
  const res = await fetch(`${app.base}/api/inventories/${inv.id}/diagnostic?key=%2Fnon-esiste`);
  assert.deepEqual(await res.json(), { scan: null });
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('graph at phone width: the canvas fits and the inspector covers the screen', async (t) => {
  if (skip) return t.skip(skip);
  const { page: p, context: ctx, problems } = await openPage(browser, app.base, { viewport: { width: 400, height: 800 } });
  await p.goto(`${app.base}/#/inventory/${invId}?tab=graph`);
  await p.waitForFunction(() => window.__mapGraph && window.__mapGraph.state().nodes >= 5);
  await p.waitForTimeout(700);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal scroll');
  await p.evaluate(() => document.querySelector('canvas#gcv').scrollIntoView());
  const at = await p.evaluate(() => window.__mapGraph.screenPos('/blog/'));
  const box = await p.locator('canvas#gcv').boundingBox();
  await p.mouse.click(box.x + at.x, box.y + at.y);
  await p.waitForSelector('#mapInsp:not([hidden])');
  const ib = await p.locator('#mapInsp').boundingBox();
  assert.ok(ib.width >= 399 && ib.height >= 700, JSON.stringify(ib));
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('tree of a large site: levels 0 and 1 open, closed branches not drawn (RF-MAP-121)', async (t) => {
  if (skip) return t.skip(skip);
  const { storageFor } = await import('../src/storage/index.js');
  const inv = bigInventory('big-tree', 40, 60);
  await storageFor().saveInventory(inv, inv);
  const { page: p, context: ctx, problems } = await openPage(browser, app.base);
  const t0 = Date.now();
  await p.goto(`${app.base}/#/inventory/big-tree?tab=tree`);
  await p.waitForSelector('.mtree .trow');
  assert.equal(await p.locator('.mtree .trow').count(), 2441, 'levels 0 and 1 are open');
  await p.locator('[data-tog="/sec3/"]').click();
  assert.equal(await p.locator('.mtree .trow').count(), 2441 - 60, 'a closed branch is not drawn');
  assert.ok(Date.now() - t0 < 10000);
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('rules and notes from the map: a page note, «Sposta in area…», the rules editor with its preview', async (t) => {
  if (skip) return t.skip(skip);
  const { page: p, context: ctx, problems } = await openPage(browser, app.base, { allow: ["400 (Bad Request)"] }); // the preview of a wrong regex answers 400 on purpose
  await p.goto(`${app.base}/#/inventory/${invId}?tab=catalog&sel=%2Fblog%2F`);
  await p.waitForSelector('#mapInsp:not([hidden])');
  // the page note: saved, and marked in the catalog
  await p.fill('#pnote', 'Gate di accesso <b>non</b> HTML');
  await p.click('#pnsave');
  await p.waitForSelector('text=Salvata.');
  await p.waitForSelector('.mcat .notemark');
  assert.equal(await p.locator('.mcat b').count(), 0, 'a note is text, never markup');
  // «Sposta in area…» creates an exact-path rule and the map follows
  await p.click('details:has-text("Regole per questa pagina") summary');
  await p.click('#mvarea');
  await p.fill('#mv', 'Area Blog');
  await p.click('#mvOk');
  await p.waitForSelector('.chip:has-text("Area Blog")');
  // the editor: edit a rule, preview, save
  await p.goto(`${app.base}/#/inventory/${invId}`);
  await p.click('#mrules');
  await p.waitForSelector('#rAreas .rrow');
  await p.fill('#rAreas .rrow textarea', '/blog/\n/servizi/');
  await p.waitForFunction(() => /Area Blog/.test(document.querySelector('#rPrev').innerText));
  await p.fill('#rAreas .rrow input[data-f="name"] >> nth=0', 'Contenuti');
  await p.waitForFunction(() => /Contenuti/.test(document.querySelector('#rPrev').innerText));
  await p.click('#rAddArea');
  await p.locator('#rAreas .rrow textarea').last().fill('re:(');
  await p.locator('#rAreas .rrow input[data-f="name"]').last().fill('Rotta');
  await p.waitForFunction(() => !document.querySelector('#rErr').hidden);
  assert.match(await p.locator('#rErr').innerText(), /regolare non valida/);
  await p.locator('#rAreas .rrow [data-del]').last().click();
  await p.waitForFunction(() => document.querySelector('#rErr').hidden);
  await p.click('#rSave');
  await p.waitForSelector('#mrules');
  const map = await (await fetch(`${app.base}/api/inventories/${invId}/map`)).json();
  assert.equal(map.rulesFrom, 'inventory');
  assert.ok(map.areas.some((a) => a.name === 'Contenuti'));
  assert.equal(map.notes.pages['/blog/'], 'Gate di accesso <b>non</b> HTML');
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('offline bundle opened from file://: every view works, in both themes, with no request to anything else', async (t) => {
  if (skip) return t.skip(skip);
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { storageFor } = await import('../src/storage/index.js');
  const { mapOf } = await import('../src/mapservice.js');
  const { mapBundle } = await import('../src/mapbundle.js');
  const { mapDataset } = await import('../src/core/mapexport.js');
  const st = storageFor();
  await st.writeInventoryOverlay(invId, { version: 1, rules: null, notes: { general: 'Nota generale del bundle', pages: { '/blog/': 'Nota del blog' } } });
  const inv = await st.loadInventory(invId);
  const map = await mapOf(st, invId);
  const { files } = mapBundle(map, inv, { dataset: mapDataset(map, inv) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-bundle-'));
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f.name)), { recursive: true });
    fs.writeFileSync(path.join(dir, f.name), f.data);
  }
  try {
    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, colorScheme: scheme });
      const p = await ctx.newPage();
      const problems = [];
      p.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      p.on('console', (m) => { if (m.type() === 'error' && !/Worker|worker/.test(m.text())) problems.push(`console: ${m.text()}`); });
      p.on('request', (r) => { if (!r.url().startsWith('file://') && !r.url().startsWith('data:')) problems.push(`external: ${r.url()}`); });
      const url = `file://${dir}/index.html`;
      await p.goto(url);
      await p.waitForSelector('#mapStats, .grid2');
      assert.match(await p.locator('main').innerText(), /Nota generale del bundle/);
      assert.equal(await p.locator('#mrules').count(), 0, 'read-only: no editing');
      await p.goto(`${url}#/inventory/${encodeURIComponent(invId)}?tab=graph`);
      await p.waitForFunction(() => window.__mapGraph && window.__mapGraph.state().nodes >= 5);
      await p.goto(`${url}#/inventory/${encodeURIComponent(invId)}?tab=tree`);
      await p.waitForSelector('.mtree .trow');
      await p.locator('.tname', { hasText: 'Blog' }).first().click();
      await p.waitForSelector('#mapInsp:not([hidden])');
      assert.match(await p.locator('#mapInsp').innerText(), /Nota del blog/);
      assert.equal(await p.locator('#pnote').count(), 0);
      await p.goto(`${url}#/inventory/${encodeURIComponent(invId)}?tab=catalog`);
      await p.waitForSelector('table.mcat tbody tr');
      await p.fill('#mq', 'servizi');
      await p.waitForFunction(() => /di \d+ pagine/.test(document.querySelector('#mcount').innerText));
      await p.goto(`${url}#/inventory/${encodeURIComponent(invId)}?tab=redirects`);
      await p.waitForSelector('text=Ecosistema');
      assert.deepEqual(problems, []);
      await ctx.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pdf export: a real PDF with the diagram, when Chromium can print', async (t) => {
  if (skip) return t.skip(skip);
  const res = await fetch(`${app.base}/api/inventories/${invId}/map.pdf`);
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(buf.length > 10000);
  assert.match(res.headers.get('content-disposition'), /\.pdf"/);
});

test('inventory table: a 404 shows who links to it, and the count opens the list of any page (RF-INV-17)', async (t) => {
  if (skip) return t.skip(skip);
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x').pathname;
    const html = (b) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(b);
    if (u === '/') return html(page('Home', '<a href="/a">a</a> <a href="/b">b</a> <a href="/rotta">rotta</a>'));
    if (u === '/a' || u === '/b') return html(page(u.slice(1), '<a href="/rotta">rotta</a>'));
    res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const id = (await runInventory({ url: `http://127.0.0.1:${srv.address().port}/` })).id;
    const { page: p, context: ctx, problems } = await openPage(browser, app.base, { viewport: { width: 1200, height: 900 } });
    await p.goto(`${app.base}/#/inventory/${id}`);
    const row = p.locator('#pagesBox tbody tr', { hasText: '/rotta' });
    await row.waitFor();
    const text = await row.innerText();
    assert.match(text, /Linkata da:/, 'a page that does not load shows its referrers at once');
    for (const k of ['/', '/a', '/b']) assert.ok(text.includes(k), `lists ${k}`);
    // a healthy page lists them on demand
    const ok = p.locator('#pagesBox tbody tr', { hasText: 'Servizi' }).or(p.locator('#pagesBox tbody tr').filter({ has: p.locator('a[href$="/a"]') }).first());
    assert.doesNotMatch(await ok.first().innerText(), /Linkata da:/);
    await ok.first().locator('[data-refs]').click();
    assert.match(await p.locator('#pagesBox tbody tr').filter({ has: p.locator('a[href$="/a"]') }).first().innerText(), /Linkata da:\s*\//);
    assert.deepEqual(problems, []);
    await ctx.close();
  } finally {
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
});

test('inventory table: a page of a sibling host says so, links to its own host, and has a filter', async (t) => {
  if (skip) return t.skip(skip);
  const { storageFor } = await import('../src/storage/index.js');
  const inv = bigInventory('sib', 1, 1);
  inv.pages.push({ key: '/hc/it', boundary: true, host: 'support.x.test', status: 403, html: false, inlinks: 1, linkedFrom: ['/'], outlinks: 0, urlDepth: 2, section: '/hc', clickDepth: null, inSitemap: false });
  await storageFor().saveInventory(inv, inv);
  const { page: p, context: ctx, problems } = await openPage(browser, app.base, { viewport: { width: 1200, height: 900 } });
  await p.goto(`${app.base}/#/inventory/sib`);
  await p.waitForSelector('#pagesBox tbody tr');
  await p.selectOption('#pf', 'siblings');
  await p.waitForFunction(() => document.querySelectorAll('#pagesBox tbody tr').length === 1);
  const row = p.locator('#pagesBox tbody tr');
  const text = await row.innerText();
  assert.match(text, /host fratello/);
  assert.match(text, /support\.x\.test/);
  assert.match(text, /Linkata da:/);
  assert.equal(await row.locator('td.key a').first().getAttribute('href'), 'https://support.x.test/hc/it', 'the link goes to its own host');
  assert.deepEqual(problems, []);
  await ctx.close();
});
