import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { FsMonitorStore } from '../src/monitor/store-fs.js';
import { PgMonitorStore } from '../src/monitor/store-pg.js';
import { VercelBackend, pgliteDb, MemoryBlob } from '../src/storage/vercel/backend.js';
import { normalizeMonitor, runRound, applyResult, monitorKpis, monitoringConfig } from '../src/monitor/engine.js';
import { HOUR, DAY } from '../src/core/uptime.js';

// Monitoring (spec §12): the up → down → up cycle on a site that we switch on and off,
// with the confirmation retry, maintenance, mass false downs and aggregates, on both stores.

const MIN = 60000;
let site, siteUrl, mode = 'ok', failNext = 0, dead;

before(async () => {
  // the sites of the tests are on 127.0.0.1, a private destination for accounts (RF-SEC-01)
  process.env.SITESCANNER_ALLOW_PRIVATE_NETWORKS = '1';
  site = http.createServer((req, res) => {
    if (failNext > 0) {
      failNext--;
      res.writeHead(503).end('busy');
      return;
    }
    if (mode === 'ok') res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Benvenuto nel negozio</h1>');
    else if (mode === '500') res.writeHead(500).end('boom');
    else res.writeHead(503).end('Service unavailable');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}/`;
  // a port where nobody listens: connection refused
  const tmp = http.createServer();
  await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
  dead = `http://127.0.0.1:${tmp.address().port}/`;
  await new Promise((r) => tmp.close(r));
});

after(async () => {
  delete process.env.SITESCANNER_ALLOW_PRIVATE_NETWORKS;
  await new Promise((r) => site.close(r));
});

const STORES = [
  { name: 'file', async make() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-mon-')); return { store: new FsMonitorStore(dir), close: async () => fs.rmSync(dir, { recursive: true, force: true }) }; } },
  { name: 'postgres', async make() { const { PGlite } = await import('@electric-sql/pglite'); const b = new VercelBackend({ db: pgliteDb(new PGlite()), blob: new MemoryBlob() }); return { store: new PgMonitorStore(b), close: () => b.db.close() }; } },
];

const config = (extra = {}) => ({ ...monitoringConfig(), retryMs: 20, spread: false, canaries: [], heartbeatUrl: null, tz: 'UTC', ...extra });

for (const kind of STORES) {
  test(`monitoring cycle [${kind.name}]: up, confirmed down, cause change, up, retry, aggregates`, async () => {
    const { store, close } = await kind.make();
    const area = kind.name === 'file' ? '' : 'u1';
    let clock = Date.UTC(2026, 9, 1, 9, 50);
    const now = () => clock;
    const round = async () => {
      const r = await runRound({ store, now, config: config() });
      clock += 5 * MIN;
      return r;
    };
    try {
      const m = normalizeMonitor({ url: siteUrl, name: 'Negozio', keyword: { text: 'negozio', mode: 'present', caseInsensitive: true } });
      m.createdAt = clock;
      await store.saveMonitor(area, m);

      mode = 'ok';
      let r = await round();
      assert.equal(r.checked, 1);
      let mon = await store.getMonitor(area, m.id);
      assert.equal(mon.state.status, 'up');
      assert.equal(r.events.length, 0);

      // a single failure confirmed as ok by the retry: no incident (RF-MON-12)
      failNext = 1;
      r = await round();
      assert.equal((await store.getMonitor(area, m.id)).state.status, 'up');
      assert.deepEqual(await store.listIncidents(area, {}), []);

      // down: confirmed by the retry, incident with the cause (RF-INC-01)
      mode = '503';
      const downAt = clock;
      r = await round();
      assert.deepEqual(r.events.map((e) => e.type), ['down']);
      assert.equal(r.events[0].cause.message, 'Errore HTTP 503');
      mon = await store.getMonitor(area, m.id);
      assert.equal(mon.state.status, 'down');
      let [inc] = await store.listIncidents(area, { open: true });
      assert.equal(inc.start, downAt);
      assert.equal(inc.cause.status, 503);
      assert.match(inc.excerpt, /Service unavailable/);

      // still down with another cause: same incident, cause recorded (RF-INC-02)
      mode = '500';
      r = await round();
      assert.equal(r.events.length, 0);
      [inc] = await store.listIncidents(area, { open: true });
      assert.deepEqual(inc.causes.map((c) => c.status), [503, 500]);

      // back up: incident closed with its duration
      mode = 'ok';
      const upAt = clock;
      r = await round();
      assert.deepEqual(r.events.map((e) => e.type), ['up']);
      assert.equal(r.events[0].durationMs, upAt - downAt);
      inc = await store.getIncident(area, inc.id);
      assert.equal(inc.end, upAt);
      assert.equal((await store.getMonitor(area, m.id)).state.status, 'up');

      // the keyword is checked (RF-MON-11)
      const withWord = await store.getMonitor(area, m.id);
      await store.saveMonitor(area, { ...withWord, assertions: [...withWord.assertions, { source: 'body', comparison: 'contains', target: 'Carrello' }] });
      r = await round();
      assert.equal(r.events[0].cause.message, 'Parola «Carrello» non trovata');
      await store.saveMonitor(area, { ...(await store.getMonitor(area, m.id)), assertions: withWord.assertions });
      r = await round();
      assert.equal(r.events[0].type, 'up');

      // a few more rounds past the hour: aggregates of the complete hours (RF-MST-02)
      while (clock < Date.UTC(2026, 9, 1, 11, 10)) await round();
      mon = await store.getMonitor(area, m.id);
      assert.equal(mon.state.aggregatedUntil, Date.UTC(2026, 9, 1, 11, 0));
      const hourly = await store.listAggregates(area, 'hourly', m.id, 0, Infinity);
      assert.deepEqual(hourly.map((a) => new Date(a.hour).toISOString().slice(11, 16)), ['09:00', '10:00']);
      assert.equal(hourly[1].downtimeMs, 2 * 5 * MIN + 5 * MIN, 'two rounds down + the keyword round');
      const daily = await store.listAggregates(area, 'daily', m.id, 0, Infinity);
      assert.equal(daily.length, 1);

      // KPIs mixing aggregates and raw data (RF-KPI-07)
      const k = await monitorKpis(store, area, mon, { from: Date.UTC(2026, 9, 1, 9, 0), to: clock, now: clock, windows: [], tz: 'UTC' });
      assert.equal(k.downtimeMs, 15 * MIN);
      assert.equal(k.incidents, 2);
      assert.equal(k.monitoredMs, clock - Date.UTC(2026, 9, 1, 9, 50));
      assert.ok(k.availability < 100);
      assert.ok(k.response.count > 0);
      const beat = await store.lastBeat();
      assert.equal(beat.checked, 1);
    } finally {
      await close();
    }
  });

  test(`maintenance and mass false downs [${kind.name}]`, async () => {
    const { store, close } = await kind.make();
    const area = kind.name === 'file' ? '' : 'u1';
    let clock = Date.UTC(2026, 9, 2, 8, 0);
    const now = () => clock;
    try {
      const m = normalizeMonitor({ url: siteUrl, name: 'Negozio', tags: ['cliente-x'] });
      await store.saveMonitor(area, m);
      // RF-MNT-03: down during a window by tag: no incident, no alert
      await store.saveWindow(area, { id: 'w1', name: 'Rilascio', type: 'once', start: clock, durationMin: 10, monitorIds: [], tags: ['cliente-x'] });
      mode = '503';
      let r = await runRound({ store, now, config: config() });
      assert.equal(r.events.length, 0);
      assert.equal((await store.getMonitor(area, m.id)).state.status, 'maintenance');
      assert.deepEqual(await store.listIncidents(area, {}), []);
      assert.equal((await store.listChecks(area, m.id, 0, Infinity)).length, 1, 'checks are still recorded');
      // RF-MNT-04: still down after the window: the incident starts now and is notified
      clock += 15 * MIN;
      r = await runRound({ store, now, config: config() });
      assert.deepEqual(r.events.map((e) => e.type), ['down']);
      assert.equal((await store.listIncidents(area, { open: true }))[0].start, clock);
      mode = 'ok';

      // RF-MON-13: five sites refused at once and the reference URLs down too: round discarded
      const deads = [];
      for (let i = 0; i < 5; i++) {
        const d = normalizeMonitor({ url: `${dead}p${i}`, name: `Morto ${i}` });
        await store.saveMonitor(area, d);
        deads.push(d);
      }
      clock += 5 * MIN;
      r = await runRound({ store, now, config: config({ canaries: [dead] }) });
      assert.equal(r.unreliable, true);
      assert.equal(r.events.length, 0);
      for (const d of deads) assert.equal((await store.listChecks(area, d.id, 0, Infinity)).length, 0, 'no check stored');
      assert.equal((await store.listIncidents(area, { open: true })).length, 1, 'only the incident opened before');
      assert.ok((await store.listEvents('', {})).some((e) => e.type === 'monitor-unreliable'), 'the admin is told');
      assert.equal((await store.lastBeat()).unreliable, true);
      // with the reference URLs reachable, the failures are real
      clock += 5 * MIN;
      r = await runRound({ store, now, config: config({ canaries: [siteUrl] }) });
      assert.equal(r.unreliable, false);
      assert.equal(r.events.filter((e) => e.type === 'down').length, 5);
      assert.ok(r.events.some((e) => e.type === 'up'), 'the shop is back');
      assert.equal(r.events.find((e) => e.type === 'down').cause.message, 'Connessione rifiutata o interrotta');
    } finally {
      await close();
    }
  });
}

test('certificate expiry: the closest threshold once per certificate (RF-NOT-01)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-cert-'));
  try {
    const store = new FsMonitorStore(dir);
    const t = Date.UTC(2026, 9, 1);
    const m = normalizeMonitor({ url: 'https://example.com/' });
    m.state.cert = { expiresAt: t + 10 * DAY + HOUR, issuer: 'Let\'s Encrypt' };
    const ok = (at) => ({ at, outcome: 'ok', status: 200, ms: 50 });
    let ev = await applyResult(store, '', m, ok(t), { tz: 'UTC' });
    assert.deepEqual(ev.map((e) => [e.type, e.days]), [['cert', 10]], 'one alert, not one per passed threshold');
    ev = await applyResult(store, '', m, ok(t + HOUR), { tz: 'UTC' });
    assert.equal(ev.length, 0);
    ev = await applyResult(store, '', m, ok(t + 4 * DAY), { tz: 'UTC' });
    assert.deepEqual(ev.map((e) => [e.type, e.days]), [['cert', 6]]);
    ev = await applyResult(store, '', m, ok(t + 11 * DAY), { tz: 'UTC' });
    assert.deepEqual(ev.map((e) => e.type), ['cert-expired']);
    // a renewed certificate starts again
    m.state.cert = { expiresAt: t + 100 * DAY };
    ev = await applyResult(store, '', m, ok(t + 11 * DAY + HOUR), { tz: 'UTC' });
    assert.equal(ev.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
