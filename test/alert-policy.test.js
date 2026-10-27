import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { FsMonitorStore } from '../src/monitor/store-fs.js';
import { PgMonitorStore } from '../src/monitor/store-pg.js';
import { VercelBackend, pgliteDb, MemoryBlob } from '../src/storage/vercel/backend.js';
import { normalizeMonitor, upgradeMonitor, applyResult, runRound, monitoringConfig } from '../src/monitor/engine.js';
import { deliverArea, testChannel } from '../src/monitor/notify.js';
import { serve } from '../src/server.js';

// Alert policy in the engine and the notifications (spec §13.7): failures in a row or minutes,
// reminders with a limit, event kinds and tags per channel, maintenance events, history, log, new problems.

const MIN = 60000;
let fake, fakeUrl;
const got = {}; // slack hook → messages
const failing = new Set();

before(async () => {
  fake = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const hook = /^\/slack\/(\w+)$/.exec(req.url);
    if (hook) {
      if (failing.has(hook[1])) return res.writeHead(500).end('servizio guasto');
      (got[hook[1]] ||= []).push(body ? JSON.parse(body).text : '');
      return res.writeHead(200).end('ok');
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${fake.address().port}`;
  Object.assign(process.env, { SITESCANNER_SLACK_WEBHOOK_PREFIX: `${fakeUrl}/slack/`, SITESCANNER_NOTIFY_RETRY_MS: '1,1,1', SITESCANNER_PUBLIC_URL: 'https://monitor.example', SITESCANNER_MONITOR_DEV: '1' });
});

after(async () => {
  await new Promise((r) => fake.close(r));
  for (const k of ['SITESCANNER_SLACK_WEBHOOK_PREFIX', 'SITESCANNER_NOTIFY_RETRY_MS', 'SITESCANNER_PUBLIC_URL', 'SITESCANNER_MONITOR_DEV']) delete process.env[k];
});

const reset = () => { for (const k of Object.keys(got)) delete got[k]; failing.clear(); };
const hook = (id, extra = {}) => ({ id, type: 'slack', name: `Slack ${id}`, status: 'active', config: { webhookUrl: `${fakeUrl}/slack/${id}` }, ...extra });

const STORES = [
  { name: 'file', async make() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-alert-')); return { store: new FsMonitorStore(dir), close: async () => fs.rmSync(dir, { recursive: true, force: true }) }; } },
  { name: 'postgres', async make() { const { PGlite } = await import('@electric-sql/pglite'); const b = new VercelBackend({ db: pgliteDb(new PGlite()), blob: new MemoryBlob() }); return { store: new PgMonitorStore(b), close: () => b.db.close() }; } },
];

const T0 = Date.UTC(2026, 9, 1, 9, 0);
const fail = (at, message = 'Errore HTTP 503') => ({ at, outcome: 'error', status: 503, ms: 50, errorClass: 'http', error: message });
const good = (at) => ({ at, outcome: 'ok', status: 200, ms: 50 });

async function newMonitor(store, area, extra = {}) {
  const m = normalizeMonitor({ url: 'https://shop.esempio.it/', name: 'Negozio', tags: ['cliente:acme'], ...extra });
  m.createdAt = T0 - 3600000;
  await store.saveMonitor(area, m);
  return m;
}

const step = async (store, area, m, r) => {
  await applyResult(store, area, m, r, { windows: [], tz: 'UTC' });
  await deliverArea(store, area, { now: () => r.at + 1000 });
};

for (const kind of STORES) {
  test(`alert after N failures in a row [${kind.name}] (RF-ALR-01)`, async () => {
    reset();
    const { store, close } = await kind.make();
    try {
      await store.saveChannel('', hook('ops'));
      await store.savePrefs('', { tz: 'UTC', policy: { mode: 'failures', failures: 3 } });
      const m = await newMonitor(store, '');
      await step(store, '', m, fail(T0));
      await step(store, '', m, fail(T0 + 5 * MIN));
      assert.equal(got.ops, undefined, 'two failures are not enough');
      assert.equal((await store.listEvents('', { status: 'delayed' })).length, 1);
      await step(store, '', m, fail(T0 + 10 * MIN));
      assert.equal(got.ops.length, 1);
      assert.match(got.ops[0], /GIÙ — Negozio/);
      await step(store, '', m, good(T0 + 15 * MIN));
      assert.match(got.ops[1], /DI NUOVO SU/);

      // a short blip is never notified, neither its recovery
      reset();
      await step(store, '', m, fail(T0 + 20 * MIN));
      await step(store, '', m, good(T0 + 25 * MIN));
      assert.equal(got.ops, undefined);
      const events = await store.listEvents('', {});
      const last = events.filter((e) => e.at >= T0 + 20 * MIN);
      assert.deepEqual(last.map((e) => [e.type, e.status]), [['down', 'suppressed'], ['up', 'suppressed']]);
      assert.match(last[0].reason, /prima della soglia/);
    } finally { await close(); }
  });

  test(`alert after X minutes, and a recovery in the same batch [${kind.name}]`, async () => {
    reset();
    const { store, close } = await kind.make();
    try {
      await store.saveChannel('', hook('ops'));
      const m = await newMonitor(store, '', { alertPolicy: { mode: 'minutes', minutes: 10 } });
      await step(store, '', m, fail(T0));
      await step(store, '', m, fail(T0 + 5 * MIN));
      assert.equal(got.ops, undefined);
      await step(store, '', m, fail(T0 + 10 * MIN));
      assert.equal(got.ops.length, 1, 'down for 10 minutes');
      await step(store, '', m, good(T0 + 15 * MIN));
      assert.equal(got.ops.length, 2);

      // down for 12 minutes whose alert never went out, then up: the delivery pass runs only at the end
      reset();
      await applyResult(store, '', m, fail(T0 + 60 * MIN), { windows: [], tz: 'UTC' });
      await applyResult(store, '', m, good(T0 + 72 * MIN), { windows: [], tz: 'UTC' });
      await deliverArea(store, '', { now: () => T0 + 73 * MIN });
      assert.equal(got.ops.length, 2, 'the down and its recovery are both sent');
      assert.match(got.ops[0], /GIÙ/);
      assert.match(got.ops[1], /DI NUOVO SU/);
    } finally { await close(); }
  });

  test(`reminders: at most N, every X minutes [${kind.name}] (RF-ALR-02)`, async () => {
    reset();
    const { store, close } = await kind.make();
    try {
      await store.saveChannel('', hook('ops'));
      await store.savePrefs('', { tz: 'UTC', policy: { reminders: { max: 2, everyMin: 30 } } });
      const m = await newMonitor(store, '');
      await step(store, '', m, fail(T0));
      assert.equal(got.ops.length, 1);
      for (let i = 1; i <= 24; i++) await step(store, '', m, fail(T0 + i * 5 * MIN));
      const reminders = got.ops.filter((t) => /ANCORA GIÙ/.test(t));
      assert.equal(reminders.length, 2, 'two reminders in two hours, not one every half hour for ever');
      assert.equal(got.ops.length, 3);
      // the monitor can have its own policy: no reminders at all
      reset();
      const n = await newMonitor(store, '', { name: 'Altro', url: 'https://altro.esempio.it/', alertPolicy: { reminders: { max: 0 } } });
      await step(store, '', n, fail(T0 + 200 * MIN));
      for (let i = 1; i <= 24; i++) await step(store, '', n, fail(T0 + 200 * MIN + i * 5 * MIN));
      assert.equal(got.ops.length, 1);
    } finally { await close(); }
  });

  test(`event kinds and tags per channel [${kind.name}] (RF-ALR-03/04)`, async () => {
    reset();
    const { store, close } = await kind.make();
    try {
      await store.saveChannel('', hook('all', { events: ['down', 'up', 'degraded', 'cert', 'maintenance', 'heartbeat'] }));
      await store.saveChannel('', hook('client', { events: ['down', 'up'], tags: ['cliente:acme'] }));
      await store.saveChannel('', hook('fresh')); // the default: down, up, certificate
      const acme = await newMonitor(store, '', { notifyDegraded: true, degradedMs: 20 });
      const zeta = await newMonitor(store, '', { name: 'Zeta', url: 'https://zeta.esempio.it/', tags: ['cliente:zeta'] });

      await step(store, '', acme, fail(T0));
      await step(store, '', zeta, fail(T0));
      assert.equal(got.all.length, 2);
      assert.equal(got.fresh.length, 2);
      assert.equal(got.client.length, 1, 'only the monitor with its tag');
      assert.match(got.client[0], /Negozio/);

      await step(store, '', acme, good(T0 + 5 * MIN));
      await step(store, '', acme, { at: T0 + 10 * MIN, outcome: 'degraded', status: 200, ms: 90 });
      assert.match(got.all.at(-1), /DEGRADATO/);
      assert.equal(got.fresh.length, 3, 'up, but not degraded');
      assert.equal(got.client.length, 2);
      const degraded = (await store.listEvents('', {})).filter((e) => e.type === 'degraded');
      assert.equal(degraded[0].status, 'sent');

      // a monitor with its own kinds overrides the channels': here only «degraded»
      const own = await newMonitor(store, '', { name: 'Proprio', url: 'https://proprio.esempio.it/', tags: ['altro'], alertPolicy: { events: ['down'] } });
      reset();
      await step(store, '', own, fail(T0 + 60 * MIN));
      assert.equal(got.all.length, 1);
      assert.equal(got.client?.length ?? 0, 0, 'no tag in common');
      await step(store, '', own, good(T0 + 65 * MIN));
      assert.equal(got.all.length, 1, 'the monitor wants only the down');
    } finally { await close(); }
  });

  test(`the legacy delay and reminder become the policy of the monitor [${kind.name}] (RF-ALR-05)`, async () => {
    const { store, close } = await kind.make();
    try {
      const m = await newMonitor(store, '');
      const old = { ...m, notifyDelayMin: 10, reminderMin: 30 };
      delete old.alertPolicy;
      await store.saveMonitor('', old);
      const migrated = upgradeMonitor(await store.getMonitor('', m.id));
      assert.deepEqual(migrated.alertPolicy, { mode: 'minutes', failures: 1, minutes: 10, locationPct: 50, reminders: { max: 10, everyMin: 30 } });
      assert.equal('notifyDelayMin' in migrated, false);
      assert.equal('reminderMin' in migrated, false);
      assert.deepEqual(upgradeMonitor(migrated).alertPolicy, migrated.alertPolicy, 'idempotent');
      // an old client that still sends the delay
      const next = normalizeMonitor({ url: m.url, notifyDelayMin: 20 }, migrated);
      assert.equal(next.alertPolicy.minutes, 20);
      assert.equal(normalizeMonitor({ url: m.url, alertPolicy: null }, migrated).alertPolicy, null);
      assert.throws(() => normalizeMonitor({ url: m.url, alertPolicy: { failures: 9 } }), /Politica di allerta: .*da 1 a 5/);
      assert.throws(() => normalizeMonitor({ url: m.url, alertPolicy: { events: ['boh'] } }), /Politica di allerta: .*sconosciuto/);
    } finally { await close(); }
  });

  test(`maintenance events and the log of the notifications [${kind.name}] (RF-ALR-03/07)`, async () => {
    reset();
    const { store, close } = await kind.make();
    try {
      await store.saveChannel('', hook('all', { events: ['down', 'up', 'maintenance'] }));
      await store.saveChannel('', hook('broken'));
      failing.add('broken');
      const m = await newMonitor(store, '');
      const config = { ...monitoringConfig(), retryMs: 0, spread: false, canaries: [], heartbeatUrl: null, tz: 'UTC' };
      let clock = T0;
      m.state.nextCheckAt = Infinity; // no check in these rounds, only the maintenance
      await store.saveMonitor('', m);
      await store.saveWindow('', { id: 'w1', name: 'Aggiornamento', type: 'once', start: T0 + 30 * MIN, durationMin: 60, monitorIds: [], tags: ['cliente:acme'], createdAt: T0 });
      const round = async (t) => { clock = t; await runRound({ store, now: () => clock, config }); };
      await round(T0 + 10 * MIN);
      assert.equal(got.all, undefined);
      await round(T0 + 35 * MIN);
      assert.match(got.all[0], /MANUTENZIONE INIZIATA — Negozio/);
      await round(T0 + 40 * MIN);
      assert.equal(got.all.length, 1, 'once');
      await round(T0 + 95 * MIN);
      assert.match(got.all[1], /MANUTENZIONE FINITA/);
      const events = await store.listEvents('', {});
      assert.deepEqual(events.filter((e) => e.type.startsWith('maintenance')).map((e) => e.type), ['maintenance-start', 'maintenance-end']);

      // the test message of a channel is in the log too, with the answer of the service
      const ch = (await store.listChannels('')).find((c) => c.id === 'all');
      const d = await testChannel(store, '', ch, () => T0 + 100 * MIN);
      assert.equal(d.ok, true);
      assert.equal(d.response, 'ok');
      const broken = (await store.listChannels('')).find((c) => c.id === 'broken');
      const bad = await testChannel(store, '', broken, () => T0 + 101 * MIN);
      assert.equal(bad.ok, false);
      assert.equal(bad.attempts, 4);
      assert.match(bad.error, /HTTP 500: servizio guasto/);
      const tests = (await store.listEvents('', {})).filter((e) => e.type === 'test');
      assert.deepEqual(tests.map((e) => [e.status, e.deliveries[0].ok]), [['info', true], ['info', false]]);
    } finally { await close(); }
  });

  test(`events are kept 90 days [${kind.name}] (RF-ALR-07)`, async () => {
    const { store, close } = await kind.make();
    try {
      await store.addEvent('', { type: 'down', at: T0 - 100 * 86400000, monitorId: 'x' });
      await store.addEvent('', { type: 'down', at: T0 - 10 * 86400000, monitorId: 'x' });
      await store.addEvent('', { type: 'down', at: T0, monitorId: 'x' });
      assert.equal((await store.listEvents('', { from: T0 - 30 * 86400000 })).length, 2);
      await store.pruneEvents(T0 - 90 * 86400000);
      assert.equal((await store.listEvents('', {})).length, 2);
    } finally { await close(); }
  });
}

// ---------------- API: history, notification log, new problems, channels, policy ----------------

let home, server, base, site, siteUrl, siteMode = 'ok';

function client() {
  let cookie = '';
  const req = async (method, p, body) => {
    const res = await fetch(`${base}/api/${p}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, data };
  };
  return req;
}

test('API: policy, channels with kinds and tags, history, log, new problems', async () => {
  reset();
  site = http.createServer((req, res) => (siteMode === 'down' ? res.writeHead(502).end('bad') : res.writeHead(200).end('ok')));
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}/`;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-alertapi-'));
  Object.assign(process.env, { SITESCANNER_HOME: home, SITESCANNER_ADMIN_USER: 'admin', SITESCANNER_ADMIN_PASSWORD: 'admin-iniziale-123', SITESCANNER_ALLOW_PRIVATE_NETWORKS: '1', SITESCANNER_MON_RETRY_MS: '10' });
  server = await serve({ port: 0, multi: true });
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    const admin = client();
    await admin('POST', 'login', { username: 'admin', password: 'admin-iniziale-123' });
    await admin('PUT', 'me/password', { current: 'admin-iniziale-123', password: 'admin-definitiva-12' });
    await admin('POST', 'users', { username: 'lia', password: 'lia-temporanea-1' });
    const lia = client();
    await lia('POST', 'login', { username: 'lia', password: 'lia-temporanea-1' });
    await lia('PUT', 'me/password', { current: 'lia-temporanea-1', password: 'lia-definitiva-12' });

    // the policy of the account: defaults, validation, saved
    let r = await lia('GET', 'channels');
    assert.deepEqual(r.data.policy, { mode: 'failures', failures: 1, minutes: 0, locationPct: 50, reminders: { max: 0, everyMin: 60 } });
    assert.deepEqual(r.data.kinds.map((k) => k.id), ['down', 'up', 'degraded', 'cert', 'maintenance', 'heartbeat']);
    assert.equal((await lia('PUT', 'notify-prefs', { policy: { failures: 9 } })).status, 400);
    r = await lia('PUT', 'notify-prefs', { policy: { mode: 'failures', failures: 2, reminders: { max: 3, everyMin: 45 } }, newProblemsDays: 14 });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal((await lia('PUT', 'notify-prefs', { newProblemsDays: 400 })).status, 400);
    r = await lia('GET', 'channels');
    assert.deepEqual([r.data.policy.failures, r.data.policy.reminders.max, r.data.newProblemsDays, r.data.tz], [2, 3, 14, 'Europe/Rome'], 'saving the policy keeps the time zone');

    // channels: kinds and tags, validated; the page tells how many monitors each one reaches
    r = await lia('POST', 'channels', { type: 'slack', name: 'Cliente Acme', webhookUrl: `${fakeUrl}/slack/acme`, events: ['down', 'up'], tags: ['Cliente:Acme'] });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.deepEqual([r.data.events, r.data.tags], [['down', 'up'], ['cliente:acme']]);
    const acmeCh = r.data.id;
    assert.equal((await lia('POST', 'channels', { type: 'slack', webhookUrl: `${fakeUrl}/slack/x`, events: ['boh'] })).status, 400);
    assert.equal((await lia('POST', 'channels', { type: 'slack', webhookUrl: `${fakeUrl}/slack/x`, events: [] })).status, 400);
    r = await lia('POST', 'channels', { type: 'slack', name: 'Tutti', webhookUrl: `${fakeUrl}/slack/all` });
    assert.deepEqual(r.data.events, ['down', 'up', 'cert', 'heartbeat'], 'the default of a new channel');
    const allCh = r.data.id;

    // monitors: a policy of its own is validated; changes are in the history
    siteMode = 'ok';
    r = await lia('POST', 'monitors', { url: siteUrl, name: 'Vetrina', tags: ['cliente:acme'] });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const mon = r.data;
    assert.equal(mon.alertPolicy, null);
    r = await lia('PUT', `monitors/${mon.id}`, { ...mon, alertPolicy: { mode: 'minutes', minutes: 15, events: ['down'] } });
    assert.deepEqual([r.status, r.data.alertPolicy.minutes, r.data.alertPolicy.events], [200, 15, ['down']]);
    assert.equal((await lia('PUT', `monitors/${mon.id}`, { ...mon, alertPolicy: { minutes: 99 } })).status, 400);
    await lia('PUT', `monitors/${mon.id}`, { ...mon, alertPolicy: null });
    r = await lia('GET', 'channels');
    assert.deepEqual(r.data.channels.map((c) => [c.name, c.reach]).sort(), [['Cliente Acme', 1], ['Tutti', 1]]);

    // a failure, with a delivery that fails: history, log and new problems
    siteMode = 'down';
    await lia('POST', `monitors/${mon.id}/check`, {});
    await lia('POST', `monitors/${mon.id}/check`, {}); // 2 failures: the policy of the account alerts now
    assert.equal(got.acme?.length, 1, 'the second failure alerts');
    assert.equal(got.all?.length, 1);
    failing.add('acme');
    siteMode = 'ok';
    await lia('POST', `monitors/${mon.id}/check`, {});
    r = await lia('GET', 'history');
    const flat = r.data.days.flatMap((d) => d.events);
    assert.deepEqual(flat.slice(0, 2).map((e) => e.type), ['up', 'down'], 'newest first');
    assert.ok(flat.some((e) => e.type === 'monitor-change' && e.action === 'creato' && e.by === 'lia'));
    assert.ok(flat.some((e) => e.type === 'monitor-change' && e.action === 'modificato'));
    assert.equal(r.data.days.length, 1);
    r = await lia('GET', 'history?type=down,up');
    assert.deepEqual(r.data.days.flatMap((d) => d.events).map((e) => e.type), ['up', 'down']);
    assert.equal((await lia('GET', 'history?type=changes')).data.total, 3, 'created, and changed twice');
    assert.equal((await lia('GET', 'history?tag=cliente:altro')).data.total, 0);
    assert.equal((await lia('GET', `history?monitor=${mon.id}&type=down`)).data.total, 1);
    r = await lia('GET', 'notification-log');
    assert.equal(r.data.entries.length, 4, 'down on two channels, then up on both (one of them failing)');
    assert.ok(r.data.entries.every((e) => e.channel && e.attempts >= 1 && e.at));
    const failed = (await lia('GET', 'notification-log?ok=0')).data.entries;
    assert.equal(failed.length, 1);
    assert.match(failed[0].error, /HTTP 500: servizio guasto/);
    assert.equal(failed[0].attempts, 4);
    assert.equal((await lia('GET', `notification-log?channel=${allCh}`)).data.entries.length, 2);
    assert.equal(r.data.days, 90);

    // new problems: this monitor started failing today
    r = await lia('GET', 'new-problems');
    assert.equal(r.data.days, 14, 'the preference of the user');
    assert.equal(r.data.problems.length, 1);
    assert.equal(r.data.problems[0].monitor.name, 'Vetrina');
    assert.equal(r.data.problems[0].groups[0].message, 'Status 502, atteso 200-399');
    assert.equal(r.data.problems[0].count, 2);
    assert.equal((await lia('GET', 'new-problems?days=3&tag=altro')).data.problems.length, 0);
    assert.equal((await lia('GET', 'new-problems?type=dns')).data.problems.length, 0);
    assert.equal((await lia('GET', 'new-problems?days=1')).data.days, 1);

    // the channel can be changed and the other users see nothing of it all
    r = await lia('PUT', `channels/${acmeCh}`, { name: 'Acme', events: ['down'], tags: [] });
    assert.deepEqual([r.data.name, r.data.events, r.data.tags], ['Acme', ['down'], []]);
    await admin('POST', 'users', { username: 'max', password: 'max-temporanea-1' });
    const max = client();
    await max('POST', 'login', { username: 'max', password: 'max-temporanea-1' });
    await max('PUT', 'me/password', { current: 'max-temporanea-1', password: 'max-definitiva-12' });
    assert.equal((await max('GET', 'history')).data.total, 0);
    assert.equal((await max('GET', 'notification-log')).data.total, 0);
    assert.equal((await max('GET', 'new-problems')).data.problems.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await new Promise((r) => site.close(r));
    for (const k of ['SITESCANNER_ADMIN_USER', 'SITESCANNER_ADMIN_PASSWORD', 'SITESCANNER_ALLOW_PRIVATE_NETWORKS', 'SITESCANNER_MON_RETRY_MS']) delete process.env[k];
    fs.rmSync(home, { recursive: true, force: true });
  }
});
