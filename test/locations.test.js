import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { FsMonitorStore } from '../src/monitor/store-fs.js';
import { PgMonitorStore } from '../src/monitor/store-pg.js';
import { VercelBackend, pgliteDb, MemoryBlob } from '../src/storage/vercel/backend.js';
import { normalizeMonitor, runRound, monitoringConfig, checkMonitor } from '../src/monitor/engine.js';
import { sign, verifySignature, remoteCheck } from '../src/monitor/runner.js';
import { serve } from '../src/server.js';

// Retries and locations in the engine (spec §13.6, RF-LOC-01..05). Remote locations are real: the «other regions» are
// this very server, reached through its signed /api/check/<location>, and the site under test tells them apart
// by the x-sitescanner-location header.

const MIN = 60000;
const T0 = Date.UTC(2026, 9, 1, 9, 0);
const SECRET = 'segreto-interno-di-prova';
let site, siteUrl, home, server, base, deadPort;
const rules = { failFrom: new Set(), status: 503, hits: [], failFirst: 0, attemptsSeen: 0, onlyThisPath: null };

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-loc-'));
  site = http.createServer((req, res) => {
    const loc = req.headers['x-sitescanner-location'] || 'locale';
    rules.hits.push(`${loc}${req.url}`);
    if (req.url.startsWith('/flaky')) {
      rules.attemptsSeen++;
      return rules.attemptsSeen <= rules.failFirst ? res.writeHead(rules.status).end('no') : res.writeHead(200).end('ok');
    }
    if (rules.failFrom.has(loc)) return res.writeHead(rules.status).end('giù da qui');
    res.writeHead(200, { 'content-type': 'text/plain' }).end(`ok da ${loc}`);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
  const probe = net.createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r)); deadPort = probe.address().port; await new Promise((r) => probe.close(r));
  Object.assign(process.env, { SITESCANNER_HOME: home, SITESCANNER_MONITOR_DEV: '1', SITESCANNER_ALLOW_PRIVATE_NETWORKS: '1', SITESCANNER_INTERNAL_SECRET: SECRET, SITESCANNER_REGION: 'fra1' });
  server = await serve({ port: 0, multi: false });
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.SITESCANNER_INTERNAL_URL = base;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await new Promise((r) => site.close(r));
  for (const k of ['SITESCANNER_HOME', 'SITESCANNER_MONITOR_DEV', 'SITESCANNER_ALLOW_PRIVATE_NETWORKS', 'SITESCANNER_INTERNAL_SECRET', 'SITESCANNER_REGION', 'SITESCANNER_INTERNAL_URL']) delete process.env[k];
  fs.rmSync(home, { recursive: true, force: true });
});

const reset = () => { rules.failFrom = new Set(); rules.status = 503; rules.hits = []; rules.failFirst = 0; rules.attemptsSeen = 0; };
const config = (extra = {}) => ({ ...monitoringConfig(), retryMs: 0, spread: false, canaries: [], heartbeatUrl: null, tz: 'UTC', region: 'fra1', ...extra });
const mk = (extra) => { const m = normalizeMonitor({ url: `${siteUrl}/`, name: 'Sito', ...extra }); m.createdAt = T0 - 3600000; return m; };

test('the signature between the Functions: right, wrong, old, missing secret', () => {
  const ts = String(Date.now()), body = '{"a":1}';
  const sig = sign(SECRET, ts, body);
  assert.equal(verifySignature(SECRET, { ts, sig }, body), null);
  assert.equal(verifySignature(SECRET, { ts, sig }, '{"a":2}'), 'Firma non valida', 'another body');
  assert.equal(verifySignature(SECRET, { ts, sig: sig.replace(/.$/, '0') }, body) === null, sig.endsWith('0'));
  assert.equal(verifySignature(SECRET, { ts, sig: 'x' }, body), 'Firma non valida');
  assert.equal(verifySignature('altro', { ts, sig }, body), 'Firma non valida', 'another secret');
  assert.equal(verifySignature(SECRET, { ts: String(Date.now() - 120000), sig: sign(SECRET, String(Date.now() - 120000), body) }, body), 'Richiesta scaduta', 'replayed later');
  assert.equal(verifySignature(SECRET, { ts: 'boh', sig }, body), 'Richiesta scaduta');
  assert.match(verifySignature('', { ts, sig }, body), /Località remote non configurate/);
});

test('the internal endpoint refuses what is not signed, and answers what is', async () => {
  const ask = (body, headers = {}) => fetch(`${base}/api/check/lhr1`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }).then(async (r) => ({ status: r.status, data: await r.json() }));
  const body = JSON.stringify({ canary: `${siteUrl}/` });
  const ts = String(Date.now());
  assert.equal((await ask(body)).status, 401);
  assert.equal((await ask(body, { 'x-sitescanner-ts': ts, 'x-sitescanner-sig': 'sbagliata' })).data.error, 'Firma non valida');
  assert.equal((await fetch(`${base}/api/check/lhr1`)).status, 405);
  const ok = await ask(body, { 'x-sitescanner-ts': ts, 'x-sitescanner-sig': sign(SECRET, ts, body) });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.result.outcome, 'ok');
  assert.equal(ok.data.location, 'lhr1');
  // the owner of the site sees where a check comes from
  reset();
  const remote = await remoteCheck('cdg1', { area: '', monitor: { id: 'inesistente' } });
  assert.equal(remote.outcome, 'error', 'a monitor that does not exist there');
  assert.match(remote.error, /La località cdg1 non ha eseguito il controllo \(HTTP 404\)/);
});

test('retries: none, single, fixed, linear, only network errors, from another location (RF-LOC-01)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-retry-'));
  const store = new FsMonitorStore(dir);
  try {
    const attempts = async (extra, { fail = 99, status = 503 } = {}) => {
      reset();
      rules.failFirst = fail; rules.status = status;
      const m = mk({ url: `${siteUrl}/flaky`, ...extra });
      const r = await checkMonitor(m, { guard: false, retryMs: 0, now: () => T0 });
      return { r, hits: rules.attemptsSeen };
    };
    // none: one request, no retry flag
    let x = await attempts({ retry: { strategy: 'none' } });
    assert.deepEqual([x.hits, x.r.outcome, x.r.retried], [1, 'error', undefined]);
    // the default (a monitor of before): one more attempt
    x = await attempts({});
    assert.deepEqual([x.hits, x.r.attempts, x.r.retried], [2, 2, true]);
    // fixed, 3 more attempts: the site recovers at the third request → ok, with the log of the attempts
    x = await attempts({ retry: { strategy: 'fixed', attempts: 3, baseSec: 5 } }, { fail: 2 });
    assert.deepEqual([x.hits, x.r.outcome, x.r.attempts], [3, 'ok', 3]);
    assert.deepEqual(x.r.attemptLog.map((a) => a.outcome), ['error', 'error', 'ok'], 'every attempt is recorded (RF-LOC-01)');
    // it keeps failing: the 4 attempts are all in the log, the run is dated by the first
    x = await attempts({ retry: { strategy: 'linear', attempts: 3, baseSec: 5 } });
    assert.deepEqual([x.hits, x.r.outcome, x.r.attemptLog.length], [4, 'error', 4]);
    assert.equal(x.r.at, T0);
    // only for network errors: a 503 is not retried, a refused connection is
    x = await attempts({ retry: { strategy: 'fixed', attempts: 2, baseSec: 5, onlyNetwork: true } });
    assert.deepEqual([x.hits, x.r.outcome], [1, 'error']);
    const refused = mk({ url: `http://127.0.0.1:${deadPort}/`, retry: { strategy: 'fixed', attempts: 2, baseSec: 5, onlyNetwork: true } });
    const rr = await checkMonitor(refused, { guard: false, retryMs: 0, now: () => T0 });
    assert.deepEqual([rr.errorClass, rr.attempts], ['connessione', 3]);
    // the waits are real: with a scale of 1 % the 10 s of the default become 100 ms
    reset(); rules.failFirst = 1;
    const t = Date.now();
    const slow = await checkMonitor(mk({ url: `${siteUrl}/flaky` }), { guard: false, retryMs: 100, now: () => T0 });
    assert.equal(slow.outcome, 'ok');
    assert.ok(Date.now() - t >= 90, `${Date.now() - t} ms`);
    // from another location: the retry goes to the next one in the list
    reset(); rules.failFrom = new Set(['fra1']);
    const m = mk({ locations: ['fra1', 'lhr1'], locStrategy: 'rotate', retry: { strategy: 'single', sameLocation: false } });
    const ro = await checkMonitor(m, { guard: false, retryMs: 0, now: () => T0, area: '', runner: (await import('../src/monitor/runner.js')).runnerFor(config({ region: null })) });
    assert.deepEqual(ro.attemptLog.map((a) => [a.location, a.outcome]), [['fra1', 'error'], ['lhr1', 'ok']]);
    assert.deepEqual([ro.outcome, ro.location], ['ok', 'lhr1'], 'the retry from another place succeeded');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const STORES = [
  { name: 'file', async make() { return { store: new FsMonitorStore(home), area: '', close: async () => {} }; } },
];

for (const kind of STORES) {
  test(`locations: rotation, parallel runs, the percentage rule, the local failure, stats per location [${kind.name}] (RF-LOC-02..04)`, async () => {
    reset();
    const { store, area, close } = await kind.make();
    try {
      // rotating: every run from a different location, through the signed endpoint
      const rot = mk({ name: 'A rotazione', locations: ['fra1', 'lhr1', 'cdg1'], locStrategy: 'rotate', intervalMin: 5 });
      await store.saveMonitor(area, rot);
      let clock = T0;
      const round = async (t) => { clock = t; await runRound({ store, now: () => clock, config: config(), notify: false }); };
      for (let i = 0; i < 4; i++) await round(T0 + i * 5 * MIN);
      let checks = await store.listChecks(area, rot.id, 0, Infinity);
      assert.deepEqual(checks.map((c) => c.location), ['fra1', 'lhr1', 'cdg1', 'fra1']);
      assert.deepEqual(rules.hits.filter((h) => h.endsWith('/')).map((h) => h.split('/')[0]), ['fra1', 'lhr1', 'cdg1', 'fra1'], 'the site saw each location');
      assert.equal((await store.getMonitor(area, rot.id)).state.status, 'up');
      await store.deleteMonitor(area, rot.id);

      // in parallel: one location fails of three → a local failure, no incident (RF-LOC-03/04)
      reset();
      rules.failFrom = new Set(['lhr1']);
      const par = mk({ name: 'In parallelo', locations: ['fra1', 'lhr1', 'cdg1'], locStrategy: 'parallel' });
      await store.saveMonitor(area, par);
      await round(T0 + 60 * MIN);
      checks = await store.listChecks(area, par.id, 0, Infinity);
      assert.deepEqual(checks.map((c) => [c.location, c.outcome, !!c.localFailure]).sort(), [['cdg1', 'ok', false], ['fra1', 'ok', false], ['lhr1', 'error', true]]);
      assert.equal((await store.listIncidents(area, {})).length, 0, 'a failure seen from one location opens nothing');
      assert.equal((await store.getMonitor(area, par.id)).state.status, 'up');
      const local = checks.find((c) => c.location === 'lhr1');
      assert.equal((await store.loadRunDetail(area, par.id, local.id)).localFailure, true, 'the run says it is a local failure');

      // two of three fail: down, with the cause, and the share of the locations in the incident run
      rules.failFrom = new Set(['lhr1', 'cdg1']);
      await round(T0 + 65 * MIN);
      const [inc] = await store.listIncidents(area, {});
      assert.ok(inc, 'an incident');
      assert.match(inc.cause.message, /Errore HTTP 503/);
      assert.equal((await store.getMonitor(area, par.id)).state.status, 'down');
      checks = (await store.listChecks(area, par.id, 0, Infinity)).filter((c) => c.at === T0 + 65 * MIN);
      assert.equal(checks.some((c) => c.localFailure), false, 'now they are failures, not local ones');
      // the site is back: the incident closes
      rules.failFrom = new Set();
      await round(T0 + 70 * MIN);
      assert.equal((await store.listIncidents(area, {}))[0].end, T0 + 70 * MIN);

      // the percentage is the account's: 100% asks every location
      await store.savePrefs(area, { policy: { locationPct: 100 } });
      rules.failFrom = new Set(['lhr1', 'cdg1']);
      await round(T0 + 75 * MIN);
      assert.equal((await store.getMonitor(area, par.id)).state.status, 'up', '2 of 3 are not enough at 100%');
      rules.failFrom = new Set(['fra1', 'lhr1', 'cdg1']);
      await round(T0 + 80 * MIN);
      assert.equal((await store.getMonitor(area, par.id)).state.status, 'down');
      // and the monitor's own policy wins over the account's
      rules.failFrom = new Set();
      await round(T0 + 85 * MIN);
      const fresh = await store.getMonitor(area, par.id);
      fresh.alertPolicy = { mode: 'failures', failures: 1, minutes: 0, locationPct: 30, reminders: { max: 0, everyMin: 60 } };
      await store.saveMonitor(area, fresh);
      rules.failFrom = new Set(['cdg1']);
      await round(T0 + 90 * MIN);
      assert.equal((await store.getMonitor(area, par.id)).state.status, 'down', '1 of 3 is 33%, over the 30% of the monitor');
      await store.deleteMonitor(area, par.id);

      // a remote location that does not answer: its run is a failure of that location, the others decide
      reset();
      await store.savePrefs(area, {});
      process.env.SITESCANNER_INTERNAL_URL = `http://127.0.0.1:${deadPort}`; // the other Function is not there
      const down = mk({ name: 'Località muta', locations: ['fra1', 'lhr1'], locStrategy: 'parallel' });
      await store.saveMonitor(area, down);
      await round(T0 + 120 * MIN);
      checks = await store.listChecks(area, down.id, 0, Infinity);
      const lhr = checks.find((c) => c.location === 'lhr1');
      assert.equal(lhr.outcome, 'error');
      assert.match(lhr.error, /La località lhr1 non ha eseguito il controllo \(/);
      assert.equal(lhr.localFailure, undefined, '1 of 2 is 50%: the monitor is down, as the rule says');
      process.env.SITESCANNER_INTERNAL_URL = base;
    } finally { process.env.SITESCANNER_INTERNAL_URL = base; await close(); }
  });
}

test('an unreliable location is discarded on its own, the others are stored (RF-LOC-05)', async () => {
  reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-unrel-'));
  const store = new FsMonitorStore(dir);
  try {
    // five monitors checked from lhr1 against a closed port, and five healthy ones from fra1; the reference URL is closed too
    const dead = Array.from({ length: 5 }, (_, i) => mk({ name: `Muto ${i}`, url: `http://127.0.0.1:${deadPort}/${i}`, locations: ['lhr1'] }));
    const fine = Array.from({ length: 5 }, (_, i) => mk({ name: `Sano ${i}`, url: `${siteUrl}/s${i}` }));
    for (const m of [...dead, ...fine]) await store.saveMonitor('', m);
    const res = await runRound({ store, now: () => T0, config: config({ canaries: [`http://127.0.0.1:${deadPort}/canary`] }), notify: false });
    assert.equal(res.unreliable, true);
    for (const m of dead) assert.deepEqual(await store.listChecks('', m.id, 0, Infinity), [], 'discarded: no run, no incident');
    for (const m of fine) assert.equal((await store.listChecks('', m.id, 0, Infinity)).length, 1, 'the main location was fine');
    assert.equal((await store.listIncidents('', {})).length, 0);
    const ev = (await store.listEvents('', {})).find((e) => e.type === 'monitor-unreliable');
    assert.deepEqual(ev.locations, ['lhr1']);
    assert.equal((await store.getMonitor('', dead[0].id)).state.nextCheckAt, T0, 'tried again at the next round');
    // when the reference URLs answer, the failures are the sites' own
    const res2 = await runRound({ store, now: () => T0 + 5 * MIN, config: config({ canaries: [`${siteUrl}/canary`] }), notify: false });
    assert.equal(res2.unreliable, false);
    assert.equal((await store.listChecks('', dead[0].id, 0, Infinity)).length, 1);
    assert.equal((await store.listIncidents('', {})).length, 5);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('validation: retries and locations', () => {
  assert.equal(normalizeMonitor({ url: 'https://a.it/' }).retry, null, 'default: as before');
  assert.deepEqual(normalizeMonitor({ url: 'https://a.it/' }).locations, [], 'no locations: the main one, unlabeled');
  assert.deepEqual(normalizeMonitor({ url: 'https://a.it/', locations: ['fra1'] }).locations, [], 'the main one alone is the same thing');
  assert.deepEqual(normalizeMonitor({ url: 'https://a.it/', locations: ['LHR1', 'fra1'] }).locations, ['lhr1', 'fra1']);
  assert.throws(() => normalizeMonitor({ url: 'https://a.it/', locations: ['tokyo'] }), /Località sconosciuta: tokyo/);
  assert.throws(() => normalizeMonitor({ url: 'https://a.it/', retry: { strategy: 'fixed', attempts: 3, baseSec: 60 } }), /più di 120 secondi/);
  assert.throws(() => normalizeMonitor({ url: 'https://a.it/', retry: { strategy: 'boh' } }), /Strategia di retry/);
  assert.equal(normalizeMonitor({ url: 'https://a.it/', locations: ['fra1', 'lhr1'], locStrategy: 'boh' }).locStrategy, 'rotate');
  assert.deepEqual(normalizeMonitor({ url: 'https://a.it/', retry: { strategy: 'exponential', attempts: 2, baseSec: 10 } }).retry, { strategy: 'exponential', attempts: 2, baseSec: 10, onlyNetwork: false, sameLocation: true });
  void PgMonitorStore; void VercelBackend; void pgliteDb; void MemoryBlob;
});
