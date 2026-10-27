import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { FsMonitorStore } from '../src/monitor/store-fs.js';
import { PgMonitorStore } from '../src/monitor/store-pg.js';
import { VercelBackend, pgliteDb, MemoryBlob } from '../src/storage/vercel/backend.js';
import { normalizeMonitor, runRound, recordPing, monitoringConfig, monitorKpis } from '../src/monitor/engine.js';
import { heartbeatMisses, pingResult, heartbeatDeadline, fmtMin } from '../src/monitor/types.js';
import { deliverArea } from '../src/monitor/notify.js';
import { serve } from '../src/server.js';

// Heartbeat monitors (spec §13.5, RF-TYP-01): the job calls /hb/<token>; no call within period + tolerance
// is a failure. Simulated clock, both stores, then the public route.

const MIN = 60000;
const T0 = Date.UTC(2026, 9, 1, 2, 0);

test('misses and results of the calls (pure)', () => {
  const m = normalizeMonitor({ type: 'heartbeat', name: 'Backup', expectedMin: 60, toleranceMin: 10 });
  m.createdAt = T0;
  m.state.nextCheckAt = heartbeatDeadline(m);
  assert.deepEqual([m.url, m.intervalMin, m.assertions, m.state.status], ['', 70, [], 'pending']);
  assert.equal(m.hbToken.length, 24, 'a secret token');
  assert.equal(m.state.nextCheckAt, T0 + 70 * MIN, 'the first deadline: creation + period + tolerance');
  assert.deepEqual(heartbeatMisses(m, T0 + 69 * MIN), []);
  assert.equal(heartbeatMisses(m, T0 + 70 * MIN)[0].at, T0 + 70 * MIN);
  const three = heartbeatMisses(m, T0 + 3 * 70 * MIN + 5);
  assert.deepEqual(three.map((r) => r.at), [T0 + 70 * MIN, T0 + 140 * MIN, T0 + 210 * MIN], 'one failure per period without a call');
  assert.equal(three[0].errorClass, 'heartbeat');
  assert.match(three[0].error, /Nessuna chiamata ricevuta da più di 1,2 ore/);
  assert.equal(heartbeatMisses(m, T0 + 100000 * MIN).length, 50, 'a long silence is caught up in pieces');

  // the length of a run is measured from /start, judged with the thresholds
  m.state.startedAt = T0 + 10 * MIN;
  m.degradedMs = 5 * MIN;
  m.failedMs = 30 * MIN;
  assert.deepEqual(pingResult(m, 'ok', T0 + 12 * MIN), { at: T0 + 12 * MIN, outcome: 'ok', status: null, ms: 2 * MIN, nextCheckAt: T0 + 82 * MIN });
  assert.equal(pingResult(m, 'ok', T0 + 20 * MIN).outcome, 'degraded');
  const slow = pingResult(m, 'ok', T0 + 50 * MIN);
  assert.deepEqual([slow.outcome, slow.errorClass], ['error', 'soglia']);
  assert.match(slow.error, /Esecuzione in 40 min, oltre la soglia di guasto di 30 min/);
  m.state.startedAt = null;
  assert.equal(pingResult(m, 'ok', T0).ms, null, 'no /start: no length');
  const fail = pingResult(m, 'fail', T0, { message: 'disco pieno' });
  assert.deepEqual([fail.outcome, fail.errorClass, fail.error], ['error', 'heartbeat-fail', 'Il job ha segnalato un errore: disco pieno']);
  assert.equal(pingResult(m, 'fail', T0).error, 'Il job ha segnalato un errore');
  assert.deepEqual([fmtMin(5), fmtMin(90), fmtMin(60 * 24 * 3)], ['5 minuti', '1,5 ore', '3 giorni']);

  // validation
  const bad = (x, re) => assert.throws(() => normalizeMonitor({ type: 'heartbeat', name: 'x', ...x }), re);
  bad({ expectedMin: 0 }, /da 1 minuto a 30 giorni/);
  bad({ expectedMin: 50000 }, /da 1 minuto a 30 giorni/);
  bad({ toleranceMin: -1 }, /tolleranza/);
  bad({ toleranceMin: 2000 }, /tolleranza/);
  assert.throws(() => normalizeMonitor({ type: 'heartbeat', name: '' }), /Dai un nome/);
  assert.equal(normalizeMonitor({ type: 'heartbeat', name: 'x', expectedMin: 1440 }).toleranceMin, 144, 'default tolerance: a tenth of the period');
  assert.equal(normalizeMonitor({ type: 'heartbeat', name: 'x', expectedMin: 5 }).toleranceMin, 1);
  assert.equal(normalizeMonitor({ type: 'heartbeat', name: 'x', url: 'https://boh.it/' }).url, '', 'a heartbeat has no URL');
  assert.throws(() => normalizeMonitor({ type: 'boh', name: 'x' }), /Tipo di monitor: http, api, heartbeat/);
  // the token survives edits, and a new period moves the deadline
  const first = normalizeMonitor({ type: 'heartbeat', name: 'Job', expectedMin: 60, toleranceMin: 5 });
  const edited = normalizeMonitor({ name: 'Job 2', expectedMin: 120 }, first);
  assert.equal(edited.hbToken, first.hbToken);
  assert.equal(edited.state.nextCheckAt, first.createdAt + 125 * MIN);
  assert.equal(normalizeMonitor({ name: 'Job 3' }, edited).state.nextCheckAt, edited.state.nextCheckAt, 'unchanged otherwise');
});

const STORES = [
  { name: 'file', async make() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-hb-')); return { store: new FsMonitorStore(dir), area: '', close: async () => fs.rmSync(dir, { recursive: true, force: true }) }; } },
  { name: 'postgres', async make() { const { PGlite } = await import('@electric-sql/pglite'); const b = new VercelBackend({ db: pgliteDb(new PGlite()), blob: new MemoryBlob() }); return { store: new PgMonitorStore(b), area: 'u1', close: () => b.db.close() }; } },
];

const config = () => ({ ...monitoringConfig(), retryMs: 0, spread: false, canaries: [], heartbeatUrl: null, tz: 'UTC' });

for (const kind of STORES) {
  test(`heartbeat life: calls, missed deadlines, incident, recovery [${kind.name}]`, async () => {
    const { store, area, close } = await kind.make();
    try {
      const m = normalizeMonitor({ type: 'heartbeat', name: 'Backup notturno', expectedMin: 60, toleranceMin: 10, tags: ['prod'] });
      m.createdAt = T0;
      m.state.nextCheckAt = heartbeatDeadline(m);
      await store.saveMonitor(area, m);
      assert.equal((await store.findHeartbeat(m.hbToken)).monitor.id, m.id);
      assert.equal(await store.findHeartbeat('inesistente-inesistente'), null);
      let clock = T0;
      const round = async (t) => { clock = t; return runRound({ store, now: () => clock, config: config(), notify: false }); };
      const events = async () => (await store.listEvents(area, {})).map((e) => e.type);

      // before the deadline nothing happens, and the monitor is waiting for its first call
      await round(T0 + 30 * MIN);
      assert.deepEqual(await store.listChecks(area, m.id, 0, Infinity), []);
      assert.equal((await store.getMonitor(area, m.id)).state.status, 'pending');

      // a call in time: a good run, the deadline moves
      let r = await recordPing(store, area, m, 'ok', T0 + 40 * MIN, { ip: '10.0.0.5' });
      assert.deepEqual([r.ok, r.outcome], [true, 'ok']);
      let saved = await store.getMonitor(area, m.id);
      assert.equal(saved.state.nextCheckAt, T0 + 110 * MIN);
      assert.equal(saved.state.status, 'up');
      await round(T0 + 100 * MIN);
      assert.equal((await store.listChecks(area, m.id, 0, Infinity)).length, 1, 'still in time');

      // the silence: one failed run at the deadline (110 min), then one per period
      await round(T0 + 112 * MIN);
      let checks = await store.listChecks(area, m.id, 0, Infinity);
      assert.deepEqual(checks.map((c) => [c.at, c.outcome]), [[T0 + 40 * MIN, 'ok'], [T0 + 110 * MIN, 'error']]);
      assert.equal(checks[1].errorClass, 'heartbeat');
      const [inc] = await store.listIncidents(area, {});
      assert.deepEqual([inc.start, inc.end, inc.failures], [T0 + 110 * MIN, null, 1]);
      assert.deepEqual(await events(), ['heartbeat-missed']);
      const ev = (await store.listEvents(area, {}))[0];
      assert.deepEqual([ev.expectedMin, ev.lastAt, ev.cause.message], [70, T0 + 40 * MIN, 'Nessuna chiamata ricevuta da più di 1,2 ore']);
      assert.equal((await store.getMonitor(area, m.id)).state.status, 'down');
      await round(T0 + 300 * MIN);
      checks = await store.listChecks(area, m.id, 0, Infinity);
      assert.deepEqual(checks.filter((c) => c.outcome === 'error').map((c) => c.at), [T0 + 110 * MIN, T0 + 180 * MIN, T0 + 250 * MIN], 'one failure every 70 minutes');
      assert.equal((await store.listIncidents(area, {})).length, 1, 'one incident');
      assert.equal((await store.listIncidents(area, {}))[0].failures, 3);
      assert.deepEqual(await events(), ['heartbeat-missed'], 'only the first miss alerts');

      // the job comes back: the incident closes, an «up» is sent; the downtime runs to the call
      await recordPing(store, area, m, 'ok', T0 + 310 * MIN);
      const closed = (await store.listIncidents(area, {}))[0];
      assert.deepEqual([closed.start, closed.end], [T0 + 110 * MIN, T0 + 310 * MIN]);
      assert.deepEqual(await events(), ['heartbeat-missed', 'up']);
      assert.equal((await store.getMonitor(area, m.id)).state.status, 'up');

      // the calls received are kept in the monitor, the last ones
      const pings = (await store.getMonitor(area, m.id)).state.pings;
      assert.deepEqual(pings.map((p) => [p.at, p.kind]), [[T0 + 40 * MIN, 'ok'], [T0 + 310 * MIN, 'ok']]);
      assert.equal(pings[0].ip, '10.0.0.5');

      // KPIs count it like any other monitor: 200 minutes down since the deadline
      const kp = await monitorKpis(store, area, await store.getMonitor(area, m.id), { from: T0, to: T0 + 320 * MIN, now: T0 + 320 * MIN, windows: [], tz: 'UTC' });
      assert.equal(kp.downtimeMs, 200 * MIN);
      assert.equal(kp.incidents, 1);
    } finally { await close(); }
  });

  test(`start, run length, thresholds, /fail and pause [${kind.name}]`, async () => {
    const { store, area, close } = await kind.make();
    try {
      const m = normalizeMonitor({ type: 'heartbeat', name: 'Feed', expectedMin: 60, toleranceMin: 5, degradedMs: 5 * MIN, failedMs: 20 * MIN });
      m.createdAt = T0;
      m.state.nextCheckAt = heartbeatDeadline(m);
      await store.saveMonitor(area, m);
      // /start then /ok: the length of the run
      await recordPing(store, area, m, 'start', T0 + 10 * MIN);
      assert.equal((await store.getMonitor(area, m.id)).state.startedAt, T0 + 10 * MIN);
      assert.equal((await store.listChecks(area, m.id, 0, Infinity)).length, 0, 'a start is not a run');
      await recordPing(store, area, m, 'ok', T0 + 12 * MIN);
      let [c] = await store.listChecks(area, m.id, 0, Infinity);
      assert.deepEqual([c.outcome, c.ms], ['ok', 2 * MIN]);
      assert.equal((await store.getMonitor(area, m.id)).state.startedAt, null);
      // slow: degraded; very slow: failed with the cause
      await recordPing(store, area, m, 'start', T0 + 20 * MIN);
      await recordPing(store, area, m, 'ok', T0 + 28 * MIN);
      await recordPing(store, area, m, 'start', T0 + 30 * MIN);
      await recordPing(store, area, m, 'ok', T0 + 55 * MIN);
      const outcomes = (await store.listChecks(area, m.id, 0, Infinity)).map((x) => x.outcome);
      assert.deepEqual(outcomes, ['ok', 'degraded', 'error']);
      assert.match((await store.listIncidents(area, {}))[0].cause.message, /Esecuzione in 25 min, oltre la soglia di guasto di 20 min/);
      // a good run closes it
      await recordPing(store, area, m, 'ok', T0 + 60 * MIN);
      assert.equal((await store.listIncidents(area, {}))[0].end, T0 + 60 * MIN);
      // /fail: a failure at once, with the message, and the monitor is down without waiting for a deadline
      await recordPing(store, area, m, 'fail', T0 + 70 * MIN, { message: 'disco pieno' });
      const open = (await store.listIncidents(area, { open: true }))[0];
      assert.equal(open.cause.message, 'Il job ha segnalato un errore: disco pieno');
      const types = (await store.listEvents(area, {})).map((e) => e.type);
      assert.equal(types.at(-1), 'down', '/fail is a down, not a missed deadline');
      // a monitor in pause ignores the calls
      const fresh = await store.getMonitor(area, m.id);
      fresh.paused = true;
      await store.saveMonitor(area, fresh);
      const n = (await store.listChecks(area, m.id, 0, Infinity)).length;
      assert.equal((await recordPing(store, area, m, 'ok', T0 + 80 * MIN)).ignored, 'il monitor è in pausa');
      assert.equal((await store.listChecks(area, m.id, 0, Infinity)).length, n);
      await assert.rejects(() => recordPing(store, area, normalizeMonitor({ url: 'https://x.it/' }), 'ok', T0), /Non è un heartbeat/);
    } finally { await close(); }
  });
}

// ---------------- the public route and the API ----------------

let home, server, base, fake;
const slack = [];

before(async () => {
  fake = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    slack.push(JSON.parse(body).text);
    res.writeHead(200).end('ok');
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-hbapi-'));
  Object.assign(process.env, {
    SITESCANNER_HOME: home, SITESCANNER_ADMIN_USER: 'admin', SITESCANNER_ADMIN_PASSWORD: 'admin-iniziale-123', SITESCANNER_MONITOR_DEV: '1', SITESCANNER_ALLOW_PRIVATE_NETWORKS: '1',
    SITESCANNER_SLACK_WEBHOOK_PREFIX: `http://127.0.0.1:${fake.address().port}/slack/`, SITESCANNER_NOTIFY_RETRY_MS: '1,1,1', SITESCANNER_PUBLIC_URL: 'https://monitor.example',
  });
  server = await serve({ port: 0, multi: true });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await new Promise((r) => fake.close(r));
  for (const k of ['SITESCANNER_ADMIN_USER', 'SITESCANNER_ADMIN_PASSWORD', 'SITESCANNER_MONITOR_DEV', 'SITESCANNER_ALLOW_PRIVATE_NETWORKS', 'SITESCANNER_SLACK_WEBHOOK_PREFIX', 'SITESCANNER_NOTIFY_RETRY_MS', 'SITESCANNER_PUBLIC_URL']) delete process.env[k];
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

test('public route and API of the heartbeats', async () => {
  const admin = client();
  await admin('POST', 'login', { username: 'admin', password: 'admin-iniziale-123' });
  await admin('PUT', 'me/password', { current: 'admin-iniziale-123', password: 'admin-definitiva-12' });
  await admin('POST', 'users', { username: 'hugo', password: 'hugo-temporanea-1' });
  const hugo = client();
  await hugo('POST', 'login', { username: 'hugo', password: 'hugo-temporanea-1' });
  await hugo('PUT', 'me/password', { current: 'hugo-temporanea-1', password: 'hugo-definitiva-12' });
  await hugo('POST', 'channels', { type: 'slack', name: 'Ops', webhookUrl: `${process.env.SITESCANNER_SLACK_WEBHOOK_PREFIX}ops` });

  // creation: no URL, no first check, the token and the address come back to the owner only
  let r = await hugo('POST', 'monitors', { type: 'heartbeat', name: 'Backup', expectedMin: 5, toleranceMin: 1, tags: ['cron'] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const mon = r.data;
  assert.deepEqual([mon.type, mon.url, mon.status, mon.expectedMin], ['heartbeat', '', 'pending', 5]);
  assert.equal((await hugo('POST', 'monitors', { type: 'heartbeat', name: 'Altro', expectedMin: 5 })).status, 201, 'no URL to clash on');
  assert.equal((await hugo('POST', 'monitors', { type: 'heartbeat', name: 'x', expectedMin: 0 })).status, 400);
  r = await hugo('GET', `monitors/${mon.id}`);
  assert.equal(r.data.hbUrl, `https://monitor.example/hb/${r.data.hbToken}`);
  const token = r.data.hbToken;
  assert.deepEqual(r.data.pings, []);
  assert.equal((await hugo('POST', 'monitors/test', { type: 'heartbeat', name: 'x' })).status, 400);
  const row = (await hugo('GET', 'monitor-list')).data.rows.find((x) => x.id === mon.id);
  assert.equal(JSON.stringify(row).includes(token), false, 'the list never shows the token');
  assert.equal(row.type, 'heartbeat');

  // calls with no session at all
  const call = (p, method = 'GET', body) => fetch(`${base}/hb/${p}`, { method, body });
  let res = await call(`${token}/start`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
  res = await call(token, 'POST');
  assert.equal(res.status, 200);
  r = await hugo('GET', `monitors/${mon.id}`);
  assert.deepEqual(r.data.pings.map((p) => p.kind), ['ok', 'start'], 'newest first');
  assert.equal(r.data.status, 'up');
  assert.ok(r.data.state.lastPingAt);
  res = await call(`${token}/fail?msg=${encodeURIComponent('database irraggiungibile')}`);
  assert.equal(res.status, 200);
  r = await hugo('GET', `monitors/${mon.id}`);
  assert.equal(r.data.status, 'down');
  assert.equal(r.data.state.lastError.message, 'Il job ha segnalato un errore: database irraggiungibile');
  assert.ok(slack.some((t) => /GIÙ — Backup/.test(t) && /database irraggiungibile/.test(t)), 'the alert went out at once');
  res = await call(token, 'POST', 'tutto a posto');
  assert.equal(res.status, 200);
  assert.ok(slack.some((t) => /DI NUOVO SU — Backup/.test(t)));
  assert.equal((await call(`${token}/fail`, 'POST', 'esploso')).status, 200);
  assert.equal((await hugo('GET', `monitors/${mon.id}`)).data.state.lastError.message, 'Il job ha segnalato un errore: esploso', 'a POST body is the message');
  await call(token);

  // unknown tokens, methods, the rate limit
  assert.equal((await call('x'.repeat(24))).status, 404);
  assert.equal((await call(`${token}x`)).status, 404, 'a wrong token looks like an unknown one');
  assert.equal((await call(token, 'DELETE')).status, 405);
  assert.equal((await fetch(`${base}/hb/corto`)).status, 401, 'not even a token: the login wall answers, not the route');
  let limited = null;
  for (let i = 0; i < 70 && !limited; i++) if ((await call(token)).status === 429) limited = i;
  assert.ok(limited != null && limited < 70, 'more than 60 calls a minute are refused');
  // the calls are in the log of the monitor, not an unbounded list
  assert.ok((await hugo('GET', `monitors/${mon.id}`)).data.pings.length <= 50);

  // the history: created, down, up
  const history = (await hugo('GET', 'history?type=down,up')).data.days.flatMap((d) => d.events).map((e) => e.type);
  assert.deepEqual(history.slice(0, 3), ['up', 'down', 'up']);

  // another user knows nothing of it; deleting the monitor makes the address stop working
  const other = client();
  await admin('POST', 'users', { username: 'iris', password: 'iris-temporanea-1' });
  await other('POST', 'login', { username: 'iris', password: 'iris-temporanea-1' });
  await other('PUT', 'me/password', { current: 'iris-temporanea-1', password: 'iris-definitiva-12' });
  assert.equal((await other('GET', `monitors/${mon.id}`)).status, 404);
  assert.equal((await hugo('DELETE', `monitors/${mon.id}`)).status, 200);
  assert.notEqual((await call(token)).status, 200, 'the address no longer works (404, or 429 while the limit of the minute lasts)');
});
