import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFixture } from './fixture-server.js';
import { CrawlRun, crawl } from '../src/crawler.js';
import { parseSite, saveSite, resolveEnv } from '../src/config.js';
import { storageFor } from '../src/storage/index.js';
import { scanSite } from '../src/scan.js';
import { runInventory } from '../src/inventory.js';
import { VercelBackend, pgliteDb, MemoryBlob } from '../src/storage/vercel/backend.js';
import { VercelStorage } from '../src/storage/vercel/storage.js';
import { startJob, processStep, cancelJobOf, jobDetail } from '../src/jobs.js';
import { setQueueTransport } from '../src/queue.js';

// Jobs in steps (spec §11.4, ADR-0018): a crawl stopped at every page and resumed from its JSON
// state visits the same pages as a crawl in one go (RF-RUN-03); queue messages are idempotent
// (RF-RUN-04); a cancel between two steps saves nothing (RF-RUN-06).

let fixture, root;

before(async () => {
  fixture = await startFixture();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-steps-'));
  process.env.SITESCANNER_ALLOW_PRIVATE_NETWORKS = '1';
});

after(async () => {
  await fixture.close();
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.SITESCANNER_ALLOW_PRIVATE_NETWORKS;
  setQueueTransport(null);
});

const siteYaml = (extra = '') => `name: Demo\nenvs:\n  local:\n    baseUrl: ${fixture.url}\nconcurrency: 1\nscreenshots: { enabled: false }\n${extra}`;
// Timing differs between runs; everything else must be identical.
const stable = (pages) => JSON.parse(JSON.stringify(pages, (k, v) => (k === 'responseMs' || k === 'avgResponseMs' ? undefined : v)));

for (const [label, extra] of [['whole site', ''], ['truncated by maxPages', 'maxPages: 4\n']]) {
  test(`crawl resumed at every page = crawl in one go (RF-RUN-03, ${label})`, async () => {
    const cfg = parseSite('demo', siteYaml(extra));
    const env = resolveEnv(cfg, 'local');
    const whole = await crawl(cfg, env, {});

    let run = await CrawlRun.begin(cfg, env, {});
    let blocks = 0;
    // deadline in the past: each block visits exactly one page; the state goes through JSON as between instances
    while (!(await run.runBlock({ deadline: 0 }))) {
      blocks++;
      run = await CrawlRun.resume(JSON.parse(JSON.stringify(run.state)), cfg, env, {});
    }
    const resumed = run.finish();
    assert.ok(blocks >= Math.min(4, whole.pages.length) - 1, `${blocks} blocchi`);
    assert.deepEqual(resumed.pages.map((p) => p.key), whole.pages.map((p) => p.key));
    assert.deepEqual(stable(resumed.pages), stable(whole.pages));
    assert.deepEqual(resumed.issues, whole.issues);
    assert.equal(resumed.unvisited, whole.unvisited);
    assert.deepEqual(Object.fromEntries(resumed.texts), Object.fromEntries(whole.texts));
  });
}

test('scan and inventory in steps of one page give the same result as in one step', async () => {
  const st = storageFor(null, root);
  await saveSite(st, 'demo', siteYaml(), { create: true });
  const one = await scanSite('demo', 'local', { storage: st });
  const steps = await scanSite('demo', 'local', { storage: st, budgetMs: 0 });
  assert.deepEqual(stable(steps.pages), stable(one.pages));
  assert.deepEqual(steps.issues, one.issues);
  assert.equal(steps.stats.healthScore, one.stats.healthScore);
  assert.equal(String(await st.readScanFile('demo', steps.id, 'text.json')), String(await st.readScanFile('demo', one.id, 'text.json')));
  assert.deepEqual(fs.readdirSync(path.join(root, 'data', 'demo', 'scans')).filter((d) => d.startsWith('.')), [], 'no staging left');

  const inv1 = await runInventory({ site: 'demo', env: 'local' }, { storage: st });
  const inv2 = await runInventory({ site: 'demo', env: 'local' }, { storage: st, budgetMs: 0 });
  assert.deepEqual(stable(inv2.pages), stable(inv1.pages));
  assert.deepEqual(stable(inv2.summary), stable(inv1.summary));
});

// The queue of the tests: messages are kept and delivered by hand.
async function queuedArea() {
  const { PGlite } = await import('@electric-sql/pglite');
  const backend = new VercelBackend({ db: pgliteDb(new PGlite()), blob: new MemoryBlob() });
  const st = new VercelStorage(backend, 'u1');
  await saveSite(st, 'demo', siteYaml(), { create: true });
  const queue = [];
  setQueueTransport(async (m) => { queue.push(m); });
  return { backend, st, queue };
}

test('queued scan: every message delivered twice, one scan saved (RF-RUN-04)', async () => {
  const { backend, st, queue } = await queuedArea();
  try {
    const job = await startJob({ type: 'scan', site: 'demo', env: 'local', label: 'v1' }, { storage: st });
    assert.equal(job.status, 'running');
    assert.deepEqual(queue, [{ area: 'u1', jobId: job.id, step: 0 }]);
    let steps = 0, ignored = 0;
    while (queue.length) {
      const msg = queue.shift();
      const r = await processStep(msg, { storage: st, budgetMs: 0 });
      // at-least-once delivery: the same message again changes nothing
      const again = await processStep(msg, { storage: st, budgetMs: 0 });
      assert.ok(again.ignored);
      if (r.ignored) ignored++;
      steps++;
      assert.ok(steps < 200, 'too many steps');
    }
    assert.equal(ignored, 0);
    assert.ok(steps > 3, `${steps} passi`);
    const done = await jobDetail(job.id, st);
    assert.equal(done.status, 'done', done.error);
    assert.ok(done.log.length > 0, 'log kept across steps');
    const scans = await st.listScans('demo');
    assert.equal(scans.length, 1);
    assert.equal(scans[0].label, 'v1');
    assert.equal(done.result.scanId, scans[0].id);
    assert.ok(await st.readScanFile('demo', scans[0].id, 'text.json'));
    assert.equal(await st.loadJobState(job.id), null, 'state removed at the end');

    // the same crawl as a local scan
    const local = await scanSite('demo', 'local', { storage: storageFor(null, root) });
    assert.deepEqual(stable((await st.loadScan('demo', scans[0].id)).pages), stable(local.pages));
  } finally {
    setQueueTransport(null);
    await backend.db.close();
  }
});

test('queued scan: a step running elsewhere is not run twice, a cancel between steps saves nothing (RF-RUN-06)', async () => {
  const { backend, st, queue } = await queuedArea();
  try {
    const job = await startJob({ type: 'scan', site: 'demo', env: 'local' }, { storage: st });
    // lease: while step 0 is claimed by another instance the message is ignored
    assert.ok(await st.claimStep(job.id, 0, 60000));
    assert.ok((await processStep(queue[0], { storage: st, budgetMs: 0 })).ignored);
    await backend.db.query('UPDATE jobs SET lease_until = now() - interval \'1 second\'');
    // two steps, then the cancel arrives between steps
    await processStep(queue.shift(), { storage: st, budgetMs: 0 });
    await processStep(queue.shift(), { storage: st, budgetMs: 0 });
    const v = await cancelJobOf(job.id, st);
    assert.ok(v.cancelling);
    const r = await processStep(queue.shift(), { storage: st, budgetMs: 0 });
    assert.equal(r.status, 'cancelled');
    assert.equal(queue.length, 0, 'no further step');
    assert.equal((await jobDetail(job.id, st)).status, 'cancelled');
    assert.deepEqual(await st.listScans('demo'), []);
    assert.deepEqual((await backend.blob.list('u/u1/')).map((b) => b.pathname), [], 'nothing left on Blob');
  } finally {
    setQueueTransport(null);
    await backend.db.close();
  }
});

test('queued inventory', async () => {
  const { backend, st, queue } = await queuedArea();
  try {
    const job = await startJob({ type: 'inventory', url: fixture.url }, { storage: st });
    while (queue.length) await processStep(queue.shift(), { storage: st, budgetMs: 0 });
    const done = await jobDetail(job.id, st);
    assert.equal(done.status, 'done', done.error);
    assert.equal((await st.listInventories())[0].id, done.result.inventoryId);
  } finally {
    setQueueTransport(null);
    await backend.db.close();
  }
});

test('screenshots in blocks of one page: the same screenshots as in one block', async (t) => {
  const { loadPlaywright, launchChromium } = await import('../src/screenshots.js');
  const pw = await loadPlaywright();
  try {
    if (!pw) throw new Error('Playwright assente');
    await (await launchChromium(pw)).close();
  } catch (e) {
    t.skip(`Chromium non disponibile: ${e.message.split('\n')[0]}`);
    return;
  }
  const st = storageFor(null, root);
  await saveSite(st, 'shots', siteYaml('maxPages: 4\n').replace('screenshots: { enabled: false }', 'screenshots: { enabled: true, fullPage: false, waitMs: 0 }'), { create: true });
  const one = await scanSite('shots', 'local', { storage: st });
  const steps = await scanSite('shots', 'local', { storage: st, budgetMs: 0 });
  assert.ok(one.stats.screenshots > 0);
  assert.equal(steps.stats.screenshots, one.stats.screenshots);
  assert.deepEqual(steps.pages.map((p) => p.screenshot || null), one.pages.map((p) => p.screenshot || null));
  for (const p of steps.pages.filter((x) => x.screenshot)) assert.ok(await st.readScanFile('shots', steps.id, p.screenshot), p.screenshot);
});
