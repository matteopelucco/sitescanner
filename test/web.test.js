import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFixture } from './fixture-server.js';
import { analyzeInventory } from '../src/inventory.js';
import { serve } from '../src/server.js';

let fixture, home, server, base;

before(async () => {
  fixture = await startFixture();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-web-'));
  process.env.SITESCANNER_HOME = home;
  server = await serve({ port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await fixture.close();
  fs.rmSync(home, { recursive: true, force: true });
});

async function api(method, p, body, headers = {}) {
  const res = await fetch(`${base}/api/${p}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* CSV, plain text */ }
  return { status: res.status, data };
}

async function waitJob(id) {
  for (let i = 0; i < 300; i++) {
    const { data } = await api('GET', `jobs/${id}`);
    if (data.status !== 'running') return data;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`job ${id} ancora in corso`);
}

const pg = (key, links = [], extra = {}) => ({ key, status: 200, isHtml: true, redirects: [], links: { internal: links }, ...extra });

test('analyzeInventory: click depth via BFS, orphans, sitemap, sections, tree', () => {
  const pages = [
    pg('/', ['/a', '/b']),
    pg('/a', ['/a/x', '/']),
    pg('/b', ['/missing']),
    pg('/a/x', ['/a/x/y']),
    pg('/a/x/y'),
    pg('/orphan'), // reached only via sitemap
    { ...pg('/old'), status: 301, redirects: [{ status: 301, location: '/b' }], finalUrl: 'http://h/b', finalStatus: 200, isHtml: false },
  ];
  const { summary, tree, pages: recs } = analyzeInventory(pages, { start: ['/'], sitemap: ['/', '/orphan', '/zzz'] });
  const by = Object.fromEntries(recs.map((r) => [r.key, r]));
  assert.equal(by['/'].clickDepth, 0);
  assert.equal(by['/a/x/y'].clickDepth, 3);
  assert.equal(by['/orphan'].clickDepth, null);
  assert.equal(by['/a'].inlinks, 1);
  assert.equal(summary.htmlPages, 6);
  assert.equal(summary.clickDepth.max, 3);
  assert.deepEqual(summary.clickDepth.histogram, { 0: 1, 1: 2, 2: 1, 3: 1 });
  assert.equal(summary.clickDepth.notLinked, 1);
  assert.equal(summary.urlDepth.max, 3);
  assert.deepEqual(summary.sitemap, { listed: 3, crawled: 2, notLinked: 1, missing: 4 });
  assert.equal(summary.linkedNotVisited, 1);
  assert.equal(summary.byStatus['3xx'], 1);
  assert.equal(summary.sections.find((s) => s.section === '/a').pages, 3);
  assert.equal(tree.total, 6);
  assert.equal(tree.children.find((c) => c.name === 'a').children[0].path, '/a/x');
});

test('web app: static files, Host and Origin protection', async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /app\.js/);
  assert.equal((await fetch(`${base}/app/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/app/../config.js`)).status, 404);

  assert.equal((await api('POST', 'sites', { id: 'x' }, { origin: 'http://evil.example' })).status, 403);
  const form = await fetch(`${base}/api/sites`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 403, 'non-JSON writes are refused (simple cross-site POST)');
  const rebinding = await new Promise((resolve) => {
    import('node:http').then(({ default: http }) => {
      http.get(`${base}/api/state`, { headers: { host: 'attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    });
  });
  assert.equal(rebinding, 403);
});

test('web app API: create and edit a site, scan via job, label, inventory', async () => {
  let r = await api('POST', 'sites', { id: 'demo', form: { name: 'Demo', envs: { local: { baseUrl: fixture.url } }, concurrency: 2, screenshots: { enabled: false } } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.config.name, 'Demo');
  const raw = fs.readFileSync(path.join(home, 'sites', 'demo.yml'), 'utf8');
  assert.match(raw, /# Configurazione di un sito/, 'the form keeps the comments of the example');
  assert.match(raw, /enabled: false/);
  assert.doesNotMatch(raw, /envs:\s*\n\s*prod:/, 'the example env is replaced');

  assert.equal((await api('POST', 'sites', { id: 'demo', form: {} })).status, 400, 'no overwrite on create');
  assert.equal((await api('PUT', 'sites/demo', { raw: 'envs: {}' })).status, 400, 'invalid YAML is not written');
  assert.equal((await api('GET', 'sites/nope')).status, 404);

  r = await api('POST', 'jobs', { type: 'scan', site: 'demo', env: 'local', label: 'v1' });
  assert.equal(r.status, 202);
  assert.equal((await api('POST', 'jobs', { type: 'scan', site: 'demo', env: 'local' })).status, 400, 'one job per site');
  const job = await waitJob(r.data.id);
  assert.equal(job.status, 'done', job.error || job.log.join('\n'));
  assert.ok(job.result.stats.pages >= 6);
  assert.ok(fs.existsSync(path.join(home, 'report', 'index.html')), 'report rebuilt after the scan');

  r = await api('GET', 'sites/demo');
  assert.equal(r.data.history.length, 1);
  assert.equal(r.data.history[0].label, 'v1');
  r = await api('PUT', `sites/demo/scans/${job.result.scanId}`, { label: 'v1-bis', note: 'rinominata' });
  assert.equal(r.data.history[0].label, 'v1-bis');

  r = await api('POST', 'jobs', { type: 'inventory', site: 'demo', env: 'local' });
  const inv = await waitJob(r.data.id);
  assert.equal(inv.status, 'done', inv.error || inv.log.join('\n'));
  const list = await api('GET', 'inventories');
  assert.equal(list.data.length, 1);
  const full = await api('GET', `inventories/${inv.result.inventoryId}`);
  assert.equal(full.data.summary.clickDepth.max, 2);
  assert.ok(full.data.pages.some((p) => p.key === '/hidden' && p.clickDepth === null && p.inSitemap));
  const csv = await api('GET', `inventories/${inv.result.inventoryId}.csv`);
  assert.match(csv.data, /^key,status,/);
  assert.equal((await api('DELETE', `inventories/${inv.result.inventoryId}`)).status, 200);

  assert.equal((await api('DELETE', 'sites/demo')).status, 200);
  r = await api('GET', 'state');
  assert.deepEqual(r.data.sites.map((s) => [s.id, s.configured]), [['demo', false]], 'history stays after deleting the config');
});

test('web app API: cancelling a job saves nothing', async () => {
  const r = await api('POST', 'jobs', { type: 'inventory', url: fixture.url, concurrency: 1 });
  await api('POST', `jobs/${r.data.id}/cancel`, {});
  const job = await waitJob(r.data.id);
  assert.ok(['cancelled', 'done'].includes(job.status));
  if (job.status === 'cancelled') assert.equal((await api('GET', 'inventories')).data.length, 0);
});
