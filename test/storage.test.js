import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { storageFor } from '../src/storage/index.js';
import { VercelBackend, pgliteDb, postgresDb, vercelBlob, MemoryBlob } from '../src/storage/vercel/backend.js';
import { VercelStorage, cleanupOrphans } from '../src/storage/vercel/storage.js';
import { resolveScanRef, allSiteIds } from '../src/store.js';
import { loadSite, saveSite, deleteSite } from '../src/config.js';

// Contract of the storage (RF-STO-07): the same behaviour is expected from every backend.
// Each backend gives a factory of fresh, isolated areas and a cleanup.
// The Vercel backend runs on PGlite (Postgres in process) and an in-memory blob store; on the real
// services only with SITESCANNER_TEST_DATABASE_URL and BLOB_READ_WRITE_TOKEN (npm run test:vercel).
async function pgliteBackend() {
  const { PGlite } = await import('@electric-sql/pglite');
  return new VercelBackend({ db: pgliteDb(new PGlite()), blob: new MemoryBlob() });
}

const REAL = process.env.SITESCANNER_TEST_DATABASE_URL && process.env.BLOB_READ_WRITE_TOKEN;

const BACKENDS = [
  {
    name: 'filesystem',
    async setup() {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-storage-'));
      return { area: (a = null) => storageFor(a, root), cleanup: async () => fs.rmSync(root, { recursive: true, force: true }) };
    },
  },
  {
    name: 'vercel (PGlite + blob in memoria)',
    async setup() {
      const b = await pgliteBackend();
      return { backend: b, area: (a = null) => new VercelStorage(b, a ? a.id : 'single'), cleanup: () => b.db.close() };
    },
  },
  {
    name: 'vercel (servizi reali)',
    skip: !REAL && 'servono SITESCANNER_TEST_DATABASE_URL e BLOB_READ_WRITE_TOKEN di un ambiente di test',
    async setup() {
      const [{ default: postgres }, sdk] = await Promise.all([import('postgres'), import('@vercel/blob')]);
      const sql = postgres(process.env.SITESCANNER_TEST_DATABASE_URL, { max: 2, prepare: false, onnotice: () => {} });
      const b = new VercelBackend({ db: postgresDb(sql), blob: vercelBlob(sdk) });
      const run = `test-${crypto.randomBytes(4).toString('hex')}`;
      const used = [];
      const area = (a = null) => {
        const st = new VercelStorage(b, `${run}-${a ? a.id : 'single'}`);
        used.push(st);
        return st;
      };
      return { area, cleanup: async () => { for (const st of used) await st.deleteArea(); await b.db.close(); } };
    },
  },
];

const SITE = 'name: Demo\nenvs:\n  prod:\n    baseUrl: https://example.com/\n';
const snapshot = (id, startedAt, extra = {}) => ({ schema: 1, id, site: 'demo', env: 'prod', baseUrl: 'https://example.com/', label: null, note: null, startedAt, finishedAt: startedAt, stats: { pages: 1 }, options: {}, pages: [], issues: [], ...extra });

async function commit(st, id, startedAt, extra = {}, files = {}) {
  const dir = await st.stageScan('demo', id);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  await st.commitScan('demo', id, dir, snapshot(id, startedAt, extra));
}

for (const backend of BACKENDS) {
  const opts = { skip: backend.skip || false };
  test(`storage [${backend.name}]: site configurations`, opts, async () => {
    const { area, cleanup } = await backend.setup();
    try {
      const st = area();
      assert.deepEqual(await st.listSiteIds(), []);
      assert.equal(await st.readSiteRaw('demo'), null);
      const raw = `# commento\n${SITE}`;
      await saveSite(st, 'demo', raw, { create: true });
      assert.equal(await st.readSiteRaw('demo'), raw, 'comments are kept');
      await assert.rejects(saveSite(st, 'demo', raw, { create: true }), /esiste già/);
      await assert.rejects(saveSite(st, 'demo', 'envs: {}'), /almeno un ambiente/);
      assert.equal(await st.readSiteRaw('demo'), raw, 'an invalid file is not written');
      await assert.rejects(saveSite(st, '../x', SITE, { create: true }), /Id sito non valido/);
      assert.equal((await loadSite(st, 'demo')).name, 'Demo');
      assert.deepEqual(await st.listSiteIds(), ['demo']);
      await deleteSite(st, 'demo');
      assert.equal(await st.readSiteRaw('demo'), null);
      await assert.rejects(deleteSite(st, 'demo'), /non trovato/);
      await assert.rejects(loadSite(st, 'demo'), /non trovato/);
    } finally {
      await cleanup();
    }
  });

  test(`storage [${backend.name}]: scans, labels, references, deletion`, opts, async () => {
    const { area, cleanup } = await backend.setup();
    try {
      const st = area();
      assert.deepEqual(await st.listScans('demo'), []);
      await commit(st, 'S2', '2026-01-02T00:00:00.000Z', { label: 'v2' }, { 'screenshots/a.png': 'PNG', 'text.json': '{"/":"ciao"}' });
      await commit(st, 'S1', '2026-01-01T00:00:00.000Z', { label: 'v1' });
      await commit(st, 'S3', '2026-01-03T00:00:00.000Z', { label: 'v2' });
      assert.deepEqual((await st.listScans('demo')).map((s) => s.id), ['S1', 'S2', 'S3'], 'oldest first, by start time');
      assert.deepEqual(await st.listDataSites(), ['demo']);
      assert.deepEqual(await allSiteIds(st), ['demo']);

      const s2 = await st.loadScan('demo', 'S2');
      assert.equal(s2.label, 'v2');
      assert.equal(String(await st.readScanFile('demo', 'S2', 'screenshots/a.png')), 'PNG');
      assert.equal(String(await st.readScanFile('demo', 'S2', 'text.json')), '{"/":"ciao"}');
      assert.equal(await st.readScanFile('demo', 'S2', 'missing.png'), null);
      assert.equal(await st.readScanFile('demo', 'S2', '../S1/scan.json'), null, 'no path traversal');
      await assert.rejects(st.loadScan('demo', 'nope'), /non trovata/);
      await assert.rejects(commit(st, 'S1', '2026-01-04T00:00:00.000Z'), /esiste già/, 'a snapshot is never overwritten');

      // Label overlay: the snapshot keeps its own values
      await st.writeLabel('demo', 'S1', { label: 'release-1', note: 'prima' });
      assert.equal((await st.loadScan('demo', 'S1')).label, 'release-1');
      assert.equal((await st.listScans('demo'))[0].note, 'prima');
      await st.writeLabel('demo', 'S1', { note: 'seconda' });
      assert.equal((await st.loadScan('demo', 'S1')).label, 'release-1', 'partial updates keep the other field');

      assert.equal(await resolveScanRef(st, 'demo', 'latest'), 'S3');
      assert.equal(await resolveScanRef(st, 'demo', 'latest~2'), 'S1');
      assert.equal(await resolveScanRef(st, 'demo', 'v2'), 'S3', 'most recent label wins');
      assert.equal(await resolveScanRef(st, 'demo', 'release-1'), 'S1');
      await assert.rejects(resolveScanRef(st, 'demo', 'S'), /ambiguo/);
      await assert.rejects(resolveScanRef(st, 'demo', 'latest~9'), /solo 3 scan/);

      // A discarded staging leaves nothing in the history
      const dir = await st.stageScan('demo', 'S4');
      await st.discardStaging(dir);
      assert.equal((await st.listScans('demo')).length, 3);

      assert.equal(await st.deleteSiteData('demo'), 3);
      assert.deepEqual(await st.listScans('demo'), []);
      assert.deepEqual(await st.listDataSites(), []);
      await assert.rejects(st.loadScan('demo', 'S1'), /non trovata/, 'no stale cache after deletion');
      assert.equal(await st.deleteSiteData('demo'), 0);
    } finally {
      await cleanup();
    }
  });

  test(`storage [${backend.name}]: inventories`, opts, async () => {
    const { area, cleanup } = await backend.setup();
    try {
      const st = area();
      const meta = (id, startedAt) => ({ id, startedAt, baseUrl: 'https://example.com/' });
      await st.saveInventory({ ...meta('I1', '2026-01-01'), pages: [{ key: '/' }] }, meta('I1', '2026-01-01'));
      await st.saveInventory({ ...meta('I2', '2026-01-02'), pages: [] }, meta('I2', '2026-01-02'));
      assert.deepEqual((await st.listInventories()).map((i) => i.id), ['I2', 'I1'], 'newest first');
      assert.equal((await st.loadInventory('I1')).pages[0].key, '/');
      // rules and notes live beside the inventory (spec §14.6): none at first, replaced as a whole, isolated per area, gone with it
      assert.equal(await st.readInventoryOverlay('I1'), null);
      const saved = await st.writeInventoryOverlay('I1', { version: 1, rules: { areas: [{ name: 'A', match: ['/a'] }] }, notes: { general: 'x', pages: { '/': 'home' } } });
      assert.ok(saved.updatedAt);
      assert.equal((await st.readInventoryOverlay('I1')).notes.pages['/'], 'home');
      await st.writeInventoryOverlay('I1', { version: 1, rules: null, notes: { general: '', pages: {} } });
      assert.equal((await st.readInventoryOverlay('I1')).rules, null);
      assert.equal(await st.readInventoryOverlay('I2'), null, 'another inventory is not touched');
      await assert.rejects(st.writeInventoryOverlay('nope', {}), /non trovato/);
      await assert.rejects(st.readInventoryOverlay('../x'), /non valido/);
      assert.equal((await st.loadInventory('I1')).pages[0].key, '/', 'the inventory itself does not change');
      await st.deleteInventory('I1');
      assert.deepEqual((await st.listInventories()).map((i) => i.id), ['I2']);
      await assert.rejects(st.loadInventory('I1'), /non trovato/);
      await assert.rejects(st.loadInventory('../x'), /non valido/);
    } finally {
      await cleanup();
    }
  });

  test(`storage [${backend.name}]: areas are isolated`, opts, async () => {
    const { area, cleanup } = await backend.setup();
    try {
      const alice = area({ id: 'u1', username: 'alice' });
      const bob = area({ id: 'u2', username: 'bob' });
      await saveSite(alice, 'demo', SITE, { create: true });
      await commit(alice, 'S1', '2026-01-01T00:00:00.000Z');
      await saveSite(bob, 'demo', SITE.replace('Demo', 'Bob'), { create: true });
      assert.equal((await loadSite(bob, 'demo')).name, 'Bob', 'the same site id in two areas');
      assert.deepEqual(await bob.listScans('demo'), []);
      assert.deepEqual(await area().listSiteIds(), [], 'the single-user area is separate');
      await alice.deleteArea();
      assert.deepEqual(await alice.listSiteIds(), []);
      assert.deepEqual(await bob.listSiteIds(), ['demo']);
    } finally {
      await cleanup();
    }
  });
}

test('storage [vercel]: orphan files of interrupted scans are cleaned up, committed ones stay', async () => {
  const b = await pgliteBackend();
  try {
    const st = new VercelStorage(b, 'u1');
    await commit(st, 'S1', '2026-01-01T00:00:00.000Z', {}, { 'text.json': '{}' });
    // an interrupted commit: files uploaded, row never inserted
    await b.blob.put('u/u1/demo/scans/S9/scan.json', '{}');
    await b.blob.put('u/u1/inventory/I9.json', '{}');
    assert.equal(await st.readScanFile('demo', 'S9', 'scan.json'), null, 'not visible before the commit point');
    assert.equal(await cleanupOrphans(b, { olderThanMs: 60000 }), 0, 'recent files are kept: a commit may be in progress');
    assert.equal(await cleanupOrphans(b, { olderThanMs: 0, now: Date.now() + 1 }), 2);
    assert.deepEqual((await b.blob.list('u/')).map((x) => x.pathname).sort(), ['u/u1/demo/scans/S1/scan.json', 'u/u1/demo/scans/S1/text.json']);
  } finally {
    await b.db.close();
  }
});

test('storage [vercel]: jobs are shared through the database', async () => {
  const b = await pgliteBackend();
  try {
    const st = new VercelStorage(b, 'u1');
    const other = new VercelStorage(b, 'u2');
    await st.saveJob({ id: 'j1', status: 'running', startedAt: '2026-01-01', log: ['a'] });
    assert.equal((await st.getJob('j1')).log[0], 'a');
    assert.equal(await other.getJob('j1'), null, 'jobs belong to their area');
    assert.ok(await st.requestCancel('j1'));
    assert.ok(await st.cancelRequested('j1'));
    // RF-RUN-07: no progress for 15 minutes means failed
    await b.db.query("UPDATE jobs SET updated_at = now() - interval '16 minutes'");
    const [j] = await st.listJobs();
    assert.equal(j.status, 'failed');
    assert.match(j.error, /nessun avanzamento/);
    assert.ok(!(await st.requestCancel('j1')), 'only running jobs can be cancelled');
  } finally {
    await b.db.close();
  }
});

test('storage [vercel]: every table has row level security, so a Supabase Data API shows nothing', async () => {
  const b = await pgliteBackend();
  try {
    await new VercelStorage(b, 'single').listInventories(); // applies the migrations
    const open = await b.db.query("SELECT relname FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace AND NOT relrowsecurity ORDER BY relname");
    assert.deepEqual(open.map((r) => r.relname), [], 'a table of a migration without ENABLE ROW LEVEL SECURITY');
  } finally {
    await b.db.close();
  }
});
