import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { FsMonitorStore } from '../src/monitor/store-fs.js';
import { PgMonitorStore } from '../src/monitor/store-pg.js';
import { VercelBackend, pgliteDb, MemoryBlob } from '../src/storage/vercel/backend.js';
import { normalizeMonitor, upgradeMonitor, runRound, monitoringConfig } from '../src/monitor/engine.js';
import { performCheck } from '../src/monitor/check.js';
import { deliverArea } from '../src/monitor/notify.js';
import { describeEvent } from '../src/monitor/channels.js';
import { isMuted, health } from '../src/core/uptime.js';

// Outcomes, thresholds, muting and request options (spec §13.2, RF-RIS-01..08).

const MIN = 60000;
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
let site, siteUrl, tlsSite, tlsUrl, hook, hookUrl;
let delayMs = 0, status = 200;
const slackGot = [];

before(async () => {
  process.env.SITESCANNER_ALLOW_PRIVATE_NETWORKS = '1';
  site = http.createServer((req, res) => {
    if (req.url === '/redirect') return res.writeHead(302, { location: '/final' }).end();
    setTimeout(() => res.writeHead(status, { 'content-type': 'text/html' }).end(status >= 400 ? 'errore' : '<p>ok</p>'), delayMs);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}/`;
  // a site with a self-signed certificate (test fixture, valid for localhost and 127.0.0.1 only)
  tlsSite = https.createServer({ key: fs.readFileSync(path.join(fixtures, 'selfsigned.key')), cert: fs.readFileSync(path.join(fixtures, 'selfsigned.crt')) }, (req, res) => res.writeHead(200).end('sicuro'));
  await new Promise((r) => tlsSite.listen(0, '127.0.0.1', r));
  tlsUrl = `https://127.0.0.1:${tlsSite.address().port}/`;
  hook = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    slackGot.push(JSON.parse(body));
    res.writeHead(200).end('ok');
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${hook.address().port}/`;
});

after(async () => {
  delete process.env.SITESCANNER_ALLOW_PRIVATE_NETWORKS;
  for (const s of [site, tlsSite, hook]) await new Promise((r) => s.close(r));
});

const STORES = [
  { name: 'file', async make() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-states-')); return { store: new FsMonitorStore(dir), close: async () => fs.rmSync(dir, { recursive: true, force: true }) }; } },
  { name: 'postgres', async make() { const { PGlite } = await import('@electric-sql/pglite'); const b = new VercelBackend({ db: pgliteDb(new PGlite()), blob: new MemoryBlob() }); return { store: new PgMonitorStore(b), close: () => b.db.close() }; } },
];

const config = () => ({ ...monitoringConfig(), retryMs: 0, spread: false, canaries: [], heartbeatUrl: null, tz: 'UTC' });

for (const kind of STORES) {
  test(`degraded and failed thresholds [${kind.name}] (RF-RIS-01/02)`, async () => {
    const { store, close } = await kind.make();
    let clock = Date.UTC(2026, 9, 1, 9, 0);
    const round = async () => { const r = await runRound({ store, now: () => clock, config: config() }); clock += 5 * MIN; return r; };
    try {
      const m = normalizeMonitor({ url: siteUrl, name: 'Soglie', degradedMs: 60, failedMs: 400, notifyDegraded: true });
      await store.saveMonitor('', m);
      delayMs = 0; status = 200;
      await round();
      assert.equal((await store.getMonitor('', m.id)).state.status, 'up');

      // slower than «degraded after»: the run succeeds, the monitor is degraded, no incident
      delayMs = 120;
      let r = await round();
      let mon = await store.getMonitor('', m.id);
      assert.equal(mon.state.status, 'degraded');
      assert.deepEqual(r.events.map((e) => e.type), ['degraded']);
      assert.deepEqual(await store.listIncidents('', {}), [], 'degraded never opens an incident');
      assert.equal((await store.listChecks('', m.id, 0, Infinity)).at(-1).outcome, 'degraded');
      // still degraded: no new event
      r = await round();
      assert.equal(r.events.length, 0);

      // slower than «failed after»: a failure, cause = threshold
      delayMs = 700;
      r = await round();
      assert.deepEqual(r.events.map((e) => e.type), ['down']);
      assert.match(r.events[0].cause.message, /soglia di guasto di 400 ms/);
      assert.equal(r.events[0].cause.class, 'soglia');

      // back to fast: up
      delayMs = 0;
      r = await round();
      assert.deepEqual(r.events.map((e) => e.type), ['up']);
      assert.equal((await store.getMonitor('', m.id)).state.status, 'up');
    } finally {
      await close();
    }
  });

  test(`monitors of the first version are upgraded and behave the same [${kind.name}] (RNF-47)`, async () => {
    const { store, close } = await kind.make();
    let clock = Date.UTC(2026, 9, 1, 9, 0);
    try {
      // as the first version stored them: «slowMs», «notifySlow», «slow» state, no new fields
      const base = normalizeMonitor({ url: siteUrl, name: 'Vecchio' });
      for (const k of ['degradedMs', 'failedMs', 'notifyDegraded', 'followRedirects', 'skipSsl', 'shouldFail', 'ipVersion', 'description', 'muted']) delete base[k];
      const withSlow = { ...base, id: 'old-slow', slowMs: 60, notifySlow: true, state: { ...base.state, lastOutcome: 'ok', status: 'up' } };
      const noSlow = { ...base, id: 'old-plain', url: `${siteUrl}p`, slowMs: null, notifySlow: false };
      await store.saveMonitor('', withSlow);
      await store.saveMonitor('', noSlow);
      assert.equal(upgradeMonitor(withSlow).degradedMs, 60);
      assert.equal(upgradeMonitor(noSlow).degradedMs, null, 'no slowness threshold before = off now');
      assert.equal('slowMs' in upgradeMonitor(withSlow), false);
      assert.deepEqual(upgradeMonitor(upgradeMonitor(withSlow)), upgradeMonitor(withSlow), 'idempotent');
      const slowState = upgradeMonitor({ ...withSlow, state: { ...withSlow.state, slow: true, slowStreak: 3, lastOutcome: 'slow', status: 'slow' } }).state;
      assert.deepEqual([slowState.lastOutcome, slowState.status, 'slow' in slowState, 'slowStreak' in slowState], ['degraded', 'degraded', false, false]);

      delayMs = 120; status = 200;
      const r = await runRound({ store, now: () => clock, config: config() });
      const a = await store.getMonitor('', 'old-slow');
      const b = await store.getMonitor('', 'old-plain');
      assert.equal(a.state.status, 'degraded');
      assert.equal(b.state.status, 'up', 'a monitor without a threshold does not become degraded');
      assert.deepEqual(r.events.filter((e) => e.type === 'degraded').map((e) => e.monitorId), ['old-slow']);
      assert.equal(a.slowMs, undefined, 'saved in the new shape');
      assert.equal(a.degradedMs, 60);
      // the checks of the first version said «slow»
      assert.equal(isMuted(a, clock), false);
    } finally {
      delayMs = 0;
      await close();
    }
  });

  test(`muted monitors keep incidents and send no alerts [${kind.name}] (RF-RIS-03)`, async () => {
    const { store, close } = await kind.make();
    let clock = Date.UTC(2026, 9, 1, 9, 0);
    const now = () => clock;
    try {
      await store.saveChannel('', { id: 'c1', type: 'slack', name: 'Slack', status: 'active', config: { webhookUrl: hookUrl } });
      const m = normalizeMonitor({ url: siteUrl, name: 'Silenziato', muted: { until: clock + 12 * MIN } });
      await store.saveMonitor('', m);
      status = 503; delayMs = 0;
      slackGot.length = 0;
      await runRound({ store, now, config: config() });
      clock += 5 * MIN;
      let inc = (await store.listIncidents('', { open: true }))[0];
      assert.ok(inc, 'the incident opens even if muted');
      assert.equal((await store.listEvents('', {}))[0].status, 'suppressed');
      assert.equal(slackGot.length, 0);

      // the mute expires while it is still down: no alert for the old incident, reminders resume only if configured
      clock += 20 * MIN;
      status = 200;
      await runRound({ store, now, config: config() });
      inc = await store.getIncident('', inc.id);
      assert.ok(inc.end, 'closed');
      const ev = await store.listEvents('', {});
      assert.deepEqual(ev.map((e) => [e.type, e.status]), [['down', 'suppressed'], ['up', 'suppressed']], 'neither the down nor its recovery');
      assert.equal(slackGot.length, 0);

      // not muted any more: the next failure is notified
      status = 503;
      clock += 5 * MIN;
      await runRound({ store, now, config: config() });
      assert.equal(slackGot.length, 1);
      assert.match(slackGot[0].text, /GIÙ — Silenziato/);
    } finally {
      status = 200;
      await close();
    }
  });
}

test('isMuted: for a time or until unmuted', () => {
  assert.equal(isMuted({ muted: { until: 1000 } }, 999), true);
  assert.equal(isMuted({ muted: { until: 1000 } }, 1000), false);
  assert.equal(isMuted({ muted: { until: null } }, 1e15), true);
  assert.equal(isMuted({ muted: null }, 0), false);
  assert.equal(isMuted({}, 0), false);
});

test('validation of the new fields', () => {
  const ok = { url: siteUrl };
  assert.equal(normalizeMonitor(ok).degradedMs, 3000, 'default for new monitors');
  assert.equal(normalizeMonitor({ ...ok, degradedMs: null }).degradedMs, null);
  assert.throws(() => normalizeMonitor({ ...ok, degradedMs: 2000, failedMs: 1000 }), /maggiore di quella di degrado/);
  assert.throws(() => normalizeMonitor({ ...ok, timeoutS: 5, failedMs: 9000 }), /non può superare il timeout/);
  assert.throws(() => normalizeMonitor({ ...ok, description: 'x'.repeat(501) }), /500 caratteri/);
  assert.equal(normalizeMonitor({ ...ok, ipVersion: '7' }).ipVersion, 'auto');
  assert.deepEqual(normalizeMonitor({ ...ok, muted: { until: 5 } }).muted, { until: 5 });
  assert.equal(normalizeMonitor({ ...ok, muted: true }).muted, null, 'only {until} is a mute');
  // the old names mean the same thing
  const legacy = normalizeMonitor({ ...ok, slowMs: 800, notifySlow: true });
  assert.deepEqual([legacy.degradedMs, legacy.notifyDegraded, 'slowMs' in legacy], [800, true, false]);
});

test('request options (RF-RIS-06): redirects, should fail, certificate, IP version', async () => {
  status = 200; delayMs = 0;
  const run = (extra) => performCheck(normalizeMonitor({ url: siteUrl, ...extra }), { guard: false });

  // redirects: followed by default, or judged as they are
  let r = await run({ url: `${siteUrl}redirect` });
  assert.equal(r.status, 200);
  assert.equal(r.finalUrl, `${siteUrl}final`);
  r = await run({ url: `${siteUrl}redirect`, followRedirects: false });
  assert.deepEqual([r.status, r.outcome, r.finalUrl], [302, 'ok', `${siteUrl}redirect`]);
  r = await run({ url: `${siteUrl}redirect`, followRedirects: false, expect: '200-299' });
  assert.equal(r.outcome, 'error', '302 is not in the expected statuses');

  // «should fail»: the failed response is the success; a successful one is the error
  status = 403;
  r = await run({ shouldFail: true });
  assert.equal(r.outcome, 'ok');
  assert.match(r.error, /Fallita come previsto \(Status 403, atteso 200-399\)/);
  status = 200;
  r = await run({ shouldFail: true });
  assert.deepEqual([r.outcome, r.errorClass], ['error', 'atteso-errore']);
  assert.match(r.error, /doveva fallire ma ha risposto con HTTP 200/);
  // a network error proves nothing about the response: still an error
  r = await performCheck(normalizeMonitor({ url: 'http://127.0.0.1:1/', shouldFail: true }), { guard: false });
  assert.equal(r.outcome, 'error');
  assert.equal(r.errorClass, 'connessione');

  // certificate errors
  r = await performCheck(normalizeMonitor({ url: tlsUrl }), { guard: false });
  assert.deepEqual([r.outcome, r.errorClass], ['error', 'tls']);
  r = await performCheck(normalizeMonitor({ url: tlsUrl, skipSsl: true }), { guard: false });
  assert.deepEqual([r.outcome, r.status], ['ok', 200]);

  // IP version: «localhost» has an IPv4 and, usually, an IPv6 address; the site listens on IPv4 only
  const local = `http://localhost:${site.address().port}/`;
  r = await run({ url: local, ipVersion: '4' });
  assert.equal(r.outcome, 'ok');
  r = await run({ url: local, ipVersion: '6' });
  assert.equal(r.outcome, 'error', 'nothing listens on ::1 (or the host has no IPv6)');
});

test('test runs return the response, mask sensitive headers and are not stored (RF-RIS-07)', async () => {
  const srv = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sid=segreto', 'x-api-key': 'k-123', server: 'prova' }).end(`<html>${'x'.repeat(5000)}</html>`));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await performCheck(normalizeMonitor({ url: `http://127.0.0.1:${srv.address().port}/` }), { guard: false, detail: true });
    assert.equal(r.headers.server, 'prova');
    assert.equal(r.headers['set-cookie'], '••••••');
    assert.equal(r.headers['x-api-key'], '••••••');
    assert.equal(r.excerpt.length, 2048);
    assert.equal(r.redirects, 0);
    const plain = await performCheck(normalizeMonitor({ url: `http://127.0.0.1:${srv.address().port}/` }), { guard: false });
    assert.equal('headers' in plain, false, 'without detail nothing else is kept');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('health: degraded in more than 10% of the runs of the last day is a warning (RF-RIS-02)', () => {
  const k30 = { availability: 100, coverage: 1, response: { p95: 100 } };
  assert.equal(health({ status: 'up', k30, degradedShare: 0.1 }).level, 'buona');
  const h = health({ status: 'degraded', k30, degradedShare: 0.25 });
  assert.equal(h.level, 'attenzione');
  assert.match(h.reasons[0], /degradato nel 25% dei controlli delle ultime 24 ore/);
});

test('the description goes in the alerts as notes for whoever intervenes (RF-RIS-05)', () => {
  const e = { type: 'down', at: Date.UTC(2026, 9, 1, 9, 0), monitorId: 'm', monitorName: 'Negozio', url: 'https://shop.example/', cause: { message: 'Errore HTTP 503' }, description: 'Hosting Aruba, contatto Mario 333 1234567' };
  const text = describeEvent(e, { tz: 'UTC', base: 'https://m.example' }).lines.join('\n');
  assert.match(text, /Note per chi interviene: Hosting Aruba, contatto Mario/);
  assert.doesNotMatch(describeEvent({ ...e, description: undefined }, { tz: 'UTC' }).lines.join('\n'), /Note per chi interviene/);
  assert.match(describeEvent({ type: 'degraded', monitorName: 'N', url: 'u', ms: 900, degradedMs: 500 }).lines.join('\n'), /DEGRADATO — N[\s\S]*900 ms, oltre la soglia di degrado di 500 ms/);
});
