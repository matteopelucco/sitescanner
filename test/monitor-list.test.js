import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { FsMonitorStore } from '../src/monitor/store-fs.js';
import { PgMonitorStore } from '../src/monitor/store-pg.js';
import { VercelBackend, pgliteDb, MemoryBlob } from '../src/storage/vercel/backend.js';
import { normalizeMonitor, aggregate, monitorKpis, applyResult } from '../src/monitor/engine.js';
import { monitorRows, listResponse } from '../src/monitor/list.js';
import { BOUNDS } from '../src/core/uptime.js';
import { serve } from '../src/server.js';

// The list of the monitors (spec §13.8): columns of the period from the aggregates, parity with the
// KPIs, 500 monitors under a second (RNF-42), the API with filters, views and bulk actions.

const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const NOW = Date.UTC(2026, 9, 25, 0, 0); // midnight: hours and days line up

const STORES = [
  { name: 'file', async make() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-list-')); return { store: new FsMonitorStore(dir), close: async () => fs.rmSync(dir, { recursive: true, force: true }) }; } },
  { name: 'postgres', async make() { const { PGlite } = await import('@electric-sql/pglite'); const b = new VercelBackend({ db: pgliteDb(new PGlite()), blob: new MemoryBlob() }); return { store: new PgMonitorStore(b), close: () => b.db.close() }; } },
];

const mk = (name, extra = {}) => {
  const m = normalizeMonitor({ url: `https://${name}.esempio.it/`, name, ...extra });
  m.createdAt = NOW - 40 * DAY;
  return m;
};

for (const kind of STORES) {
  test(`list columns equal the KPIs of the same period [${kind.name}] (RF-LST-02, RF-KPI-07)`, async () => {
    const { store, close } = await kind.make();
    try {
      const m = mk('Negozio');
      await store.saveMonitor('', m);
      // 8 days of 5-minute checks (written straight to the store: the engine is not what is tested here): a 40-minute
      // outage 3 days ago, responses between 100 and 400 ms; the last 20 go through the engine, for the mini-bars
      const outageStart = NOW - 3 * DAY;
      const lastTwenty = NOW - 20 * 5 * MIN;
      for (let t = NOW - 8 * DAY; t < lastTwenty; t += 5 * MIN) {
        const out = t >= outageStart && t < outageStart + 40 * MIN;
        await store.addCheck('', m.id, out ? { at: t, outcome: 'error', status: 503, ms: 50, errorClass: 'http', error: 'Errore HTTP 503' } : { at: t, outcome: 'ok', status: 200, ms: 100 + ((t / MIN) % 300) });
      }
      await store.saveIncident('', { id: 'inc1', monitorId: m.id, start: outageStart, end: outageStart + 40 * MIN, cause: { message: 'Errore HTTP 503' }, causes: [], notifications: [] });
      for (let t = lastTwenty; t < NOW; t += 5 * MIN) await applyResult(store, '', m, { at: t, outcome: 'ok', status: 200, ms: 100 + ((t / MIN) % 300) }, { windows: [], tz: 'UTC' });
      m.state.aggregatedUntil = NOW - 8 * DAY;
      await aggregate(store, '', m, { now: NOW, windows: [], tz: 'UTC' });
      const fresh = await store.getMonitor('', m.id);
      const [row] = await monitorRows(store, '', [fresh], { now: NOW, windows: [], tz: 'UTC', period: '30d' });
      const k = await monitorKpis(store, '', fresh, { from: NOW - 30 * DAY, to: NOW, now: NOW, windows: [], tz: 'UTC' });
      assert.equal(row.availability, k.availability);
      assert.equal(row.downtimeMs, k.downtimeMs);
      assert.equal(row.avgMs, k.response.avg);
      assert.equal(row.p95Ms, k.response.p95);
      assert.ok(row.availability < 100 && row.availability >= 99.5, String(row.availability));
      // shorter and longer periods
      const at = async (period) => (await monitorRows(store, '', [fresh], { now: NOW, windows: [], tz: 'UTC', period }))[0];
      assert.equal((await at('24h')).availability, 100, 'the outage was three days ago');
      assert.equal((await at('7d')).availability, (await monitorKpis(store, '', fresh, { from: NOW - 7 * DAY, to: NOW, now: NOW, windows: [], tz: 'UTC' })).availability);
      assert.equal((await at('90d')).downtimeMs, 40 * MIN);
      // the last 20 runs, for the mini-bars
      assert.equal(row.recent.length, 20);
      assert.ok(row.recent.every((c) => c === 'o'));
      assert.equal(row.health.level, 'critica', 'the outage put it under the SLA');
      assert.match(row.health.reasons[0], /sotto l'obiettivo/);
      // down now: the time not aggregated yet counts as downtime
      fresh.state.openIncident = 'i1';
      fresh.state.since = NOW - 20 * MIN;
      fresh.state.aggregatedUntil = NOW - 30 * MIN;
      const [down] = await monitorRows(store, '', [fresh], { now: NOW, windows: [], tz: 'UTC', period: '24h' });
      assert.equal(down.status, 'down');
      assert.equal(down.downtimeMs, 20 * MIN);
    } finally { await close(); }
  });
}

test('500 monitors answer in under a second (RNF-42)', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const b = new VercelBackend({ db: pgliteDb(new PGlite()), blob: new MemoryBlob() });
  const store = new PgMonitorStore(b);
  try {
    const tags = ['cliente:acme', 'cliente:zeta', 'cliente:beta', 'prod', 'test'];
    const hist = new Array(BOUNDS.length).fill(0);
    hist[6] = 280;
    for (let i = 0; i < 500; i++) {
      const m = mk(`sito-${String(i).padStart(3, '0')}`, { tags: [tags[i % 5], tags[(i + 2) % 5]], type: i % 10 === 0 ? 'api' : 'http' });
      m.state = { ...m.state, status: i % 50 === 0 ? 'down' : 'up', lastCheckAt: NOW - 2 * MIN, lastOutcome: i % 50 === 0 ? 'error' : 'ok', lastMs: 250, since: NOW - DAY, aggregatedUntil: NOW, recent: 'ooooooooooooooooooee'.split(''), openIncident: i % 50 === 0 ? 'inc' : null };
      await store.saveMonitor('', m);
      const dailyRows = Array.from({ length: 90 }, (_, d) => ({ day: NOW - (d + 1) * DAY, checks: 288, ok: 288, errors: 0, degraded: 0, msSum: 288 * 250, msCount: 288, monitoredMs: DAY, downtimeMs: i % 7 === 0 && d < 3 ? 600000 : 0, hist: [...hist], phases: { n: 0, dnsMs: 0, tcpMs: 0, tlsMs: 0, waitMs: 0, downloadMs: 0 } }));
      const hourlyRows = Array.from({ length: 24 }, (_, h) => ({ hour: NOW - (h + 1) * HOUR, checks: 12, ok: 12, errors: 0, degraded: 0, msSum: 12 * 250, msCount: 12, monitoredMs: HOUR, downtimeMs: 0, hist: [...hist] }));
      await store.saveAggregates('', 'daily', m.id, dailyRows);
      await store.saveAggregates('', 'hourly', m.id, hourlyRows);
    }
    const monitors = await store.listMonitors('');
    assert.equal(monitors.length, 500);
    // the best of three: when the whole suite runs at once the machine is busy, and a single run says little
    let ms = Infinity, rows, res;
    for (let i = 0; i < 3 && ms >= 1000; i++) {
      const t0 = Date.now();
      rows = await monitorRows(store, '', monitors, { now: NOW, windows: [], tz: 'UTC', period: '30d' });
      res = listResponse(rows, { now: NOW, period: '30d', query: 'tag:cliente:acme stato:giù', sort: 'availability' });
      ms = Math.min(ms, Date.now() - t0);
    }
    assert.ok(ms < 1000, `${ms} ms`);
    assert.equal(rows.length, 500);
    assert.equal(res.counts.down, 10);
    assert.ok(res.total > 0 && res.total <= 10);
    assert.equal(listResponse(rows, { now: NOW, pageSize: 50, page: 3 }).rows.length, 50);
    console.log(`    (500 monitors: ${ms} ms)`);
  } finally { await b.db.close(); }
});

// ---------------- API ----------------

let home, server, base, site, siteUrl, siteMode = 'ok';

before(async () => {
  site = http.createServer((req, res) => (siteMode === 'down' && req.url.startsWith('/giu') ? res.writeHead(503).end('no') : res.writeHead(200).end('ok')));
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-listapi-'));
  Object.assign(process.env, { SITESCANNER_HOME: home, SITESCANNER_ADMIN_USER: 'admin', SITESCANNER_ADMIN_PASSWORD: 'admin-iniziale-123', SITESCANNER_MONITOR_DEV: '1', SITESCANNER_ALLOW_PRIVATE_NETWORKS: '1', SITESCANNER_MON_RETRY_MS: '10' });
  server = await serve({ port: 0, multi: true });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await new Promise((r) => site.close(r));
  for (const k of ['SITESCANNER_ADMIN_USER', 'SITESCANNER_ADMIN_PASSWORD', 'SITESCANNER_MONITOR_DEV', 'SITESCANNER_ALLOW_PRIVATE_NETWORKS', 'SITESCANNER_MON_RETRY_MS']) delete process.env[k];
  fs.rmSync(home, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  return async (method, p, body) => {
    const res = await fetch(`${base}/api/${p}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, data };
  };
}

test('API list: tabs, search, period, sorting, pages, saved views, bulk actions (RF-LST-01..05)', async () => {
  const admin = client();
  await admin('POST', 'login', { username: 'admin', password: 'admin-iniziale-123' });
  await admin('PUT', 'me/password', { current: 'admin-iniziale-123', password: 'admin-definitiva-12' });
  await admin('POST', 'users', { username: 'nora', password: 'nora-temporanea-1' });
  const nora = client();
  await nora('POST', 'login', { username: 'nora', password: 'nora-temporanea-1' });
  await nora('PUT', 'me/password', { current: 'nora-temporanea-1', password: 'nora-definitiva-12' });

  siteMode = 'ok';
  const add = async (name, path, tags) => (await nora('POST', 'monitors', { name, url: `${siteUrl}/${path}`, tags })).data;
  const a = await add('Acme sito', 'a', ['cliente:acme', 'prod']);
  const b = await add('Acme blog', 'giu-b', ['cliente:acme']);
  const z = await add('Zeta shop', 'z', ['cliente:zeta', 'prod']);
  const dns = await add('Zeta api', 'api-z', ['cliente:zeta']);
  await nora('PUT', `monitors/${dns.id}`, { ...dns, type: 'api', method: 'GET' });
  siteMode = 'down';
  await nora('POST', `monitors/${b.id}/check`, {});
  siteMode = 'ok';
  await nora('POST', 'monitors/actions', { ids: [z.id], action: 'pause' });

  let r = await nora('GET', 'monitor-list');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.counts, { all: 4, up: 2, degraded: 0, down: 1, paused: 1, maintenance: 0, pending: 0 });
  assert.equal(r.data.rows[0].name, 'Acme blog', 'the one that is down first');
  assert.deepEqual(r.data.rows[0].recent, ['o', 'e'], 'created up, then down');
  assert.equal(r.data.period, '30d');
  assert.deepEqual(r.data.tags, ['cliente:acme', 'cliente:zeta', 'prod']);
  assert.deepEqual(r.data.types, ['api', 'http']);

  // the status tab keeps the counts of the others
  r = await nora('GET', 'monitor-list?status=down');
  assert.deepEqual([r.data.total, r.data.rows[0].name, r.data.counts.all, r.data.counts.up], [1, 'Acme blog', 4, 2]);
  assert.equal((await nora('GET', 'monitor-list?status=up,degraded')).data.total, 2);
  // the written search
  r = await nora('GET', `monitor-list?q=${encodeURIComponent('tag:cliente:acme')}`);
  assert.deepEqual(r.data.rows.map((x) => x.name).sort(), ['Acme blog', 'Acme sito']);
  assert.deepEqual([r.data.counts.all, r.data.counts.down], [2, 1], 'the tabs count what the search finds');
  assert.equal((await nora('GET', `monitor-list?q=${encodeURIComponent('stato:giù tag:prod')}`)).data.total, 0);
  assert.equal((await nora('GET', `monitor-list?q=${encodeURIComponent('tipo:api')}`)).data.rows[0].name, 'Zeta api');
  assert.equal((await nora('GET', `monitor-list?q=${encodeURIComponent('stato:boh')}`)).data.errors[0], 'stato sconosciuto: boh');
  assert.equal((await nora('GET', 'monitor-list?tag=prod')).data.total, 2, 'the tag menu');
  // sorting and pages
  r = await nora('GET', 'monitor-list?sort=name&dir=desc');
  assert.deepEqual(r.data.rows.map((x) => x.name), ['Zeta shop', 'Zeta api', 'Acme sito', 'Acme blog']);
  r = await nora('GET', 'monitor-list?sort=name&pageSize=3&page=2');
  assert.deepEqual([r.data.pages, r.data.rows.length, r.data.rows[0].name], [2, 1, 'Zeta shop']);
  assert.equal((await nora('GET', 'monitor-list?sort=boh')).status, 200, 'an unknown sorting is the default one');
  // periods
  for (const p of ['24h', '7d', '30d', '90d']) assert.equal((await nora('GET', `monitor-list?period=${p}`)).data.period, p);
  assert.equal((await nora('GET', 'monitor-list?period=1y')).data.period, '30d');
  // the dashboard keeps its old shape
  r = await nora('GET', 'monitoring');
  assert.equal(r.data.monitors.length, 4);
  assert.ok(r.data.monitors[0].k30 && r.data.monitors[0].id);

  // saved views (RF-LST-04)
  r = await nora('POST', 'monitor-views', { name: 'Acme giù', q: 'tag:cliente:acme stato:giù', period: '7d', sort: 'availability', dir: 'desc', home: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const v1 = r.data;
  assert.deepEqual([v1.period, v1.sort, v1.dir], ['7d', 'availability', 'desc']);
  assert.equal((await nora('POST', 'monitor-views', { name: 'acme GIÙ' })).status, 400, 'same name');
  assert.equal((await nora('POST', 'monitor-views', { name: '  ' })).status, 400);
  r = await nora('POST', 'monitor-views', { name: 'Premium', q: 'tag:prod', home: true });
  const list = (await nora('GET', 'monitor-views')).data;
  assert.deepEqual(list.map((v) => [v.name, !!v.home]), [['Acme giù', false], ['Premium', true]], 'one home only');
  await nora('PUT', `monitor-views/${v1.id}`, { home: true });
  assert.deepEqual((await nora('GET', 'monitor-views')).data.map((v) => !!v.home), [true, false]);
  assert.equal((await nora('PUT', 'monitor-views/inesistente', { home: true })).status, 404);
  await nora('DELETE', `monitor-views/${v1.id}`);
  assert.equal((await nora('GET', 'monitor-views')).data.length, 1);

  // bulk: run now, duplicate (RF-LST-05)
  r = await nora('POST', 'monitors/actions', { ids: [a.id, b.id], action: 'check' });
  assert.deepEqual([r.status, r.data.count], [200, 2]);
  assert.equal((await nora('GET', 'monitor-list?q=blog')).data.rows[0].status, 'up', 'the site is up again');
  r = await nora('POST', 'monitors/actions', { ids: [a.id, b.id], action: 'duplicate' });
  assert.equal(r.data.count, 2);
  assert.deepEqual((await nora('GET', 'monitor-list?q=copia&sort=name')).data.rows.map((x) => x.name), ['Copia di Acme blog', 'Copia di Acme sito']);
  assert.equal((await nora('POST', 'monitors/actions', { ids: [], action: 'check' })).status, 400);

  // another user sees none of it
  const other = client();
  await admin('POST', 'users', { username: 'olga', password: 'olga-temporanea-1' });
  await other('POST', 'login', { username: 'olga', password: 'olga-temporanea-1' });
  await other('PUT', 'me/password', { current: 'olga-temporanea-1', password: 'olga-definitiva-12' });
  assert.equal((await other('GET', 'monitor-list')).data.total, 0);
  assert.deepEqual((await other('GET', 'monitor-views')).data, []);
});
