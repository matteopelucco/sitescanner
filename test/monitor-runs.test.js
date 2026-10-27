import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { FsMonitorStore } from '../src/monitor/store-fs.js';
import { PgMonitorStore } from '../src/monitor/store-pg.js';
import { VercelBackend, pgliteDb, MemoryBlob } from '../src/storage/vercel/backend.js';
import { normalizeMonitor, runRound, monitoringConfig } from '../src/monitor/engine.js';

// Run details: what is kept and for how long (spec §13.4, RF-RIS-21/22/25, RNF-44), on both stores.

const MIN = 60000;
let site, siteUrl, mode = 'ok';
const PAGE = `<!doctype html><html><head><title>Negozio</title></head><body>${'<p>Contenuto della pagina di prova con un po\' di testo che si ripete.</p>'.repeat(60)}</body></html>`;

before(async () => {
  process.env.SITESCANNER_ALLOW_PRIVATE_NETWORKS = '1';
  site = http.createServer((req, res) => {
    const headers = { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'sessione=segretissima; HttpOnly', 'x-api-key': 'k-998877', server: 'nginx/1.25', 'cache-control': 'no-store', date: new Date().toUTCString(), 'x-request-id': 'a1b2c3d4e5f6', vary: 'Accept-Encoding' };
    if (mode === '503') return res.writeHead(503, headers).end('<h1>Servizio non disponibile</h1>');
    if (mode === 'slow') return setTimeout(() => res.writeHead(200, headers).end(PAGE), 90);
    res.writeHead(200, headers).end(PAGE);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}/`;
});

after(async () => {
  delete process.env.SITESCANNER_ALLOW_PRIVATE_NETWORKS;
  await new Promise((r) => site.close(r));
});

const STORES = [
  { name: 'file', async make() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-runs-')); return { store: new FsMonitorStore(dir), blobFiles: () => { const out = []; const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(path.join(d, e.name)) : out.push(e.name)); }; walk(path.join(dir, 'monitoring', 'runs')); return out; }, close: async () => fs.rmSync(dir, { recursive: true, force: true }) }; } },
  { name: 'postgres', async make() { const { PGlite } = await import('@electric-sql/pglite'); const blob = new MemoryBlob(); const b = new VercelBackend({ db: pgliteDb(new PGlite()), blob }); return { store: new PgMonitorStore(b), blobFiles: () => [...blob.files.keys()].filter((k) => k.includes('/runs/')), close: () => b.db.close() }; } },
];

const config = () => ({ ...monitoringConfig(), retryMs: 0, spread: false, canaries: [], heartbeatUrl: null, tz: 'UTC' });

for (const kind of STORES) {
  test(`run details [${kind.name}]: policy of what is kept, content, masking, size, incident, retention`, async () => {
    const { store, blobFiles, close } = await kind.make();
    const area = kind.name === 'file' ? '' : 'u1';
    let clock = Date.UTC(2026, 9, 1, 9, 0);
    const round = async () => { await runRound({ store, now: () => clock, config: config() }); clock += 5 * MIN; };
    try {
      const m = normalizeMonitor({ url: siteUrl, name: 'Negozio', degradedMs: 60, assertions: [{ source: 'status', comparison: 'in', target: '200' }, { source: 'body', comparison: 'contains', target: 'Contenuto' }] });
      m.createdAt = clock;
      await store.saveMonitor(area, m);
      mode = 'ok';

      // successful runs: the first one in full, then one an hour (RF-RIS-22)
      for (let i = 0; i < 13; i++) await round();
      let checks = await store.listChecks(area, m.id, 0, Infinity);
      assert.equal(checks.length, 13);
      assert.deepEqual(checks.map((c) => c.hasDetail), [true, ...Array(10).fill(false), true, false].slice(0, 12).concat([false]), 'runs 1 and 12 (55 minutes later)');
      assert.ok(checks.every((c) => /^[0-9a-z]{8}[0-9a-f]{6}$/.test(c.id)), 'ids sort by time');
      assert.ok(checks.every((c) => c.phases && c.phases.totalMs === c.ms), 'phases of every run, also without the detail');

      const first = await store.loadRunDetail(area, m.id, checks[0].id);
      assert.equal(first.outcome, 'ok');
      assert.equal(first.status, 200);
      assert.equal(first.method, 'GET');
      assert.equal(first.ip, '127.0.0.1');
      assert.deepEqual(first.assertions.map((a) => a.ok), [true, true]);
      assert.equal(first.excerpt.length, 2048, 'the first 2 KB of the body');
      assert.match(first.excerpt, /^<!doctype html>/);
      assert.equal(first.headers.server, 'nginx/1.25');
      assert.equal(first.headers['set-cookie'], '••••••', 'cookies and keys are masked (RF-RIS-21)');
      assert.equal(first.headers['x-api-key'], '••••••');
      assert.equal(first.phases.totalMs, first.ms);
      assert.equal(await store.loadRunDetail(area, m.id, checks[1].id), null, 'a run without detail');
      assert.equal(await store.loadRunDetail(area, m.id, 'inesistente'), null);

      // failed and degraded runs are always kept in full, and the incident keeps the first failed run
      mode = '503';
      await round();
      mode = 'slow';
      await round();
      mode = 'ok';
      await round();
      checks = await store.listChecks(area, m.id, 0, Infinity);
      const [bad, slow, back] = checks.slice(-3);
      assert.deepEqual([bad.outcome, bad.hasDetail, slow.outcome, slow.hasDetail, back.outcome, back.hasDetail], ['error', true, 'degraded', true, 'ok', false]);
      const failed = await store.loadRunDetail(area, m.id, bad.id);
      assert.equal(failed.status, 503);
      assert.equal(failed.error, 'Status 503, atteso 200');
      assert.deepEqual(failed.assertions.map((a) => a.ok), [false, false]);
      assert.match(failed.excerpt, /Servizio non disponibile/);
      const [inc] = await store.listIncidents(area, {});
      assert.equal(inc.firstRun.id, bad.id, 'RF-RIS-25: the first failed run is in the incident');
      assert.equal(inc.firstRun.status, 503);
      assert.equal(inc.firstRun.headers['set-cookie'], '••••••');
      assert.equal((await store.loadRunDetail(area, m.id, slow.id)).outcome, 'degraded');

      // RNF-44: a stored detail weighs about 2 KB compressed at most, on average
      const ids = checks.filter((c) => c.hasDetail).map((c) => c.id);
      assert.equal(ids.length, 4);
      const sizes = [];
      for (const id of ids) sizes.push(zlib.gzipSync(JSON.stringify(await store.loadRunDetail(area, m.id, id))).length);
      const avg = sizes.reduce((s, x) => s + x, 0) / sizes.length;
      assert.ok(avg < 2048, `average ${Math.round(avg)} bytes`);
      assert.equal(blobFiles().length, 4);

      // retention: the details go with the raw checks, the incident keeps its copy (RF-MST-01)
      await store.pruneChecks(clock - 20 * MIN);
      const left = await store.listChecks(area, m.id, 0, Infinity);
      assert.ok(left.length < checks.length);
      assert.equal(await store.loadRunDetail(area, m.id, checks[0].id), null, 'the oldest detail is gone');
      assert.equal((await store.loadRunDetail(area, m.id, slow.id))?.outcome, 'degraded', 'a recent one stays');
      assert.equal((await store.listIncidents(area, {}))[0].firstRun.status, 503, 'the incident does not expire');
      assert.ok(blobFiles().length < 4);

      // deleting a monitor deletes its details
      await store.deleteMonitor(area, m.id);
      assert.equal(blobFiles().length, 0);
    } finally {
      mode = 'ok';
      await close();
    }
  });
}
