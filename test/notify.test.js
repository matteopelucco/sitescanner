import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { FsMonitorStore } from '../src/monitor/store-fs.js';
import { normalizeMonitor } from '../src/monitor/engine.js';
import { deliverArea } from '../src/monitor/notify.js';
import { serve } from '../src/server.js';

// Notifications (spec §12.5) with fake services: a local HTTP server stands for Resend, Slack and Telegram.

const MIN = 60000;
let fake, fakeUrl;
const got = { email: [], slack: [], telegram: [] };
const failing = new Map(); // slack hook → failures left (Infinity = always)

before(async () => {
  fake = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const data = body ? JSON.parse(body) : {};
    if (req.url === '/resend') {
      got.email.push({ ...data, auth: req.headers.authorization });
      return res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"e1"}');
    }
    const hook = /^\/slack\/(\w+)$/.exec(req.url);
    if (hook) {
      const left = failing.get(hook[1]) || 0;
      if (left > 0) {
        failing.set(hook[1], left - 1);
        return res.writeHead(404).end('no_service');
      }
      got.slack.push({ hook: hook[1], ...data });
      return res.writeHead(200).end('ok');
    }
    if (/^\/tg\/botT0K3N\/sendMessage$/.test(req.url)) {
      got.telegram.push(data);
      return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    }
    if (/^\/tg\/botT0K3N\/getMe$/.test(req.url)) return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"result":{"username":"sitescanner_bot"}}');
    res.writeHead(404).end();
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${fake.address().port}`;
  Object.assign(process.env, {
    SITESCANNER_RESEND_URL: `${fakeUrl}/resend`, RESEND_API_KEY: 're_test', SITESCANNER_EMAIL_FROM: 'avvisi@esempio.it',
    SITESCANNER_TELEGRAM_API: `${fakeUrl}/tg`, SITESCANNER_TELEGRAM_BOT_TOKEN: 'T0K3N', SITESCANNER_TELEGRAM_WEBHOOK_SECRET: 'segreto-webhook',
    SITESCANNER_SLACK_WEBHOOK_PREFIX: `${fakeUrl}/slack/`, SITESCANNER_NOTIFY_RETRY_MS: '1,1,1', SITESCANNER_PUBLIC_URL: 'https://monitor.example', SITESCANNER_MONITOR_DEV: '1',
  });
});

after(async () => {
  await new Promise((r) => fake.close(r));
  for (const k of ['SITESCANNER_RESEND_URL', 'RESEND_API_KEY', 'SITESCANNER_EMAIL_FROM', 'SITESCANNER_TELEGRAM_API', 'SITESCANNER_TELEGRAM_BOT_TOKEN', 'SITESCANNER_TELEGRAM_WEBHOOK_SECRET', 'SITESCANNER_SLACK_WEBHOOK_PREFIX', 'SITESCANNER_NOTIFY_RETRY_MS', 'SITESCANNER_PUBLIC_URL', 'SITESCANNER_MONITOR_DEV']) delete process.env[k];
});

const reset = () => { got.email.length = 0; got.slack.length = 0; got.telegram.length = 0; failing.clear(); };

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-notify-'));
  const store = new FsMonitorStore(dir);
  const ch = {
    slack: { id: 'cs', type: 'slack', name: 'Slack #ops', status: 'active', config: { webhookUrl: `${fakeUrl}/slack/ops` } },
    tg: { id: 'ct', type: 'telegram', name: 'Telegram', status: 'active', config: { chatId: 42 } },
    mail: { id: 'ce', type: 'email', name: 'Mario', status: 'active', config: { address: 'mario@esempio.it' } },
  };
  for (const c of Object.values(ch)) await store.saveChannel('', c);
  await store.savePrefs('', { tz: 'Europe/Rome' });
  return { store, ch, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function monitorDown(store, m, at, cause = { class: 'http', status: 503, message: 'Errore HTTP 503' }) {
  const inc = { id: `i-${m.id}-${at}`, monitorId: m.id, start: at, end: null, cause, causes: [cause], notifications: [] };
  await store.saveIncident('', inc);
  m.state.openIncident = inc.id;
  await store.saveMonitor('', m);
  await store.addEvent('', { type: 'down', at, monitorId: m.id, monitorName: m.name, url: m.url, incidentId: inc.id, cause });
  return inc;
}

async function monitorUp(store, m, inc, at) {
  inc.end = at;
  await store.saveIncident('', inc);
  m.state.openIncident = null;
  await store.saveMonitor('', m);
  await store.addEvent('', { type: 'up', at, monitorId: m.id, monitorName: m.name, url: m.url, incidentId: inc.id, durationMs: at - inc.start, cause: inc.cause });
}

const T = Date.UTC(2026, 9, 25, 8, 30); // 10:30 in Rome (CEST ends this day at 03:00, so it is CET: 09:30)

test('down and up on the three channels, with the cause, local time and link (RF-NOT-01/02)', async () => {
  reset();
  const { store, cleanup } = await setup();
  try {
    const m = normalizeMonitor({ url: 'https://shop.esempio.it/', name: 'Negozio' });
    const inc = await monitorDown(store, m, T);
    await deliverArea(store, '', { now: () => T + 1000 });
    assert.equal(got.slack.length, 1);
    assert.match(got.slack[0].text, /^\*🔴 GIÙ — Negozio\*/);
    assert.match(got.slack[0].text, /Causa: Errore HTTP 503/);
    assert.match(got.slack[0].text, /Dalle 25\/10\/26, 09:30/);
    assert.match(got.slack[0].text, new RegExp(`https://monitor.example/#/incident/${inc.id}`));
    assert.equal(got.telegram[0].chat_id, 42);
    assert.equal(got.telegram[0].parse_mode, 'HTML');
    assert.match(got.telegram[0].text, /<b>🔴 GIÙ — Negozio<\/b>/);
    assert.equal(got.email[0].subject, '🔴 GIÙ: Negozio');
    assert.deepEqual(got.email[0].to, ['mario@esempio.it']);
    assert.equal(got.email[0].auth, 'Bearer re_test');
    assert.match(got.email[0].html, /Apri in sitescanner/);
    const [ev] = await store.listEvents('', {});
    assert.equal(ev.status, 'sent');
    assert.equal(ev.deliveries.length, 3);
    assert.ok((await store.getIncident('', inc.id)).downNotifiedAt);

    await monitorUp(store, m, inc, T + 72 * MIN);
    await deliverArea(store, '', { now: () => T + 73 * MIN });
    assert.match(got.slack[1].text, /🟢 DI NUOVO SU — Negozio/);
    assert.match(got.slack[1].text, /Giù per 1 h 12 min \(Errore HTTP 503\)/);
    for (const x of [...got.slack, ...got.telegram, ...got.email]) assert.doesNotMatch(JSON.stringify(x), /password|authorization/i);
  } finally {
    cleanup();
  }
});

test('notification delay, reminders, channels per monitor (RF-NOT-05/07)', async () => {
  reset();
  const { store, ch, cleanup } = await setup();
  try {
    // back up within the delay: neither down nor up
    const a = normalizeMonitor({ url: 'https://a.esempio.it/', name: 'A', notifyDelayMin: 10 });
    let inc = await monitorDown(store, a, T);
    await deliverArea(store, '', { now: () => T + MIN });
    assert.equal(got.slack.length, 0);
    assert.equal((await store.listEvents('', {}))[0].status, 'delayed');
    await monitorUp(store, a, inc, T + 3 * MIN);
    await deliverArea(store, '', { now: () => T + 4 * MIN });
    assert.equal(got.slack.length, 0);
    assert.deepEqual((await store.listEvents('', {})).map((e) => e.status), ['suppressed', 'suppressed']);

    // still down after the delay: sent, then a reminder every 15 minutes, only to its channel
    const b = normalizeMonitor({ url: 'https://b.esempio.it/', name: 'B', notifyDelayMin: 10, reminderMin: 15, channels: [ch.slack.id] });
    inc = await monitorDown(store, b, T);
    await deliverArea(store, '', { now: () => T + 5 * MIN });
    assert.equal(got.slack.length, 0);
    await deliverArea(store, '', { now: () => T + 11 * MIN });
    assert.equal(got.slack.length, 1);
    assert.equal(got.telegram.length + got.email.length, 0, 'only the channels of the monitor');
    await deliverArea(store, '', { now: () => T + 20 * MIN });
    assert.equal(got.slack.length, 1);
    await deliverArea(store, '', { now: () => T + 27 * MIN });
    assert.match(got.slack[1].text, /ANCORA GIÙ — B/);
    assert.match(got.slack[1].text, /Giù da 27 min/);
  } finally {
    cleanup();
  }
});

test('grouping and rate limit (RF-NOT-06/08)', async () => {
  reset();
  const { store, ch, cleanup } = await setup();
  try {
    for (const c of [ch.tg, ch.mail]) await store.deleteChannel('', c.id);
    for (let i = 0; i < 5; i++) await monitorDown(store, normalizeMonitor({ url: `https://s${i}.esempio.it/`, name: `Sito ${i}` }), T);
    await deliverArea(store, '', { now: () => T + 1000 });
    assert.equal(got.slack.length, 1, 'one message for 5 sites');
    assert.match(got.slack[0].text, /🔴 5 giù/);
    assert.match(got.slack[0].text, /• Sito 3 — Errore HTTP 503/);

    // 40 certificate alerts in a burst: 29 messages + 1 summary, the rest dropped (the group above counts too)
    reset();
    const m = normalizeMonitor({ url: 'https://c.esempio.it/', name: 'C' });
    await store.saveMonitor('', m);
    for (let i = 0; i < 40; i++) await store.addEvent('', { type: 'cert', at: T + i, monitorId: m.id, monitorName: 'C', url: m.url, days: 10, expiresAt: T + 10 * 864e5 });
    await deliverArea(store, '', { now: () => T + 2000 });
    assert.equal(got.slack.length, 29);
    assert.match(got.slack[28].text, /Altri 12 eventi/);
    const evs = (await store.listEvents('', { limit: 1000 })).filter((e) => e.type === 'cert');
    assert.equal(evs.filter((e) => e.status === 'sent').length, 28);
    assert.equal(evs.filter((e) => e.status === 'failed').length, 12);
  } finally {
    cleanup();
  }
});

test('retries, channel in error, email about it, recovery (RF-NOT-04)', async () => {
  reset();
  const { store, ch, cleanup } = await setup();
  try {
    await store.deleteChannel('', ch.tg.id);
    const m = normalizeMonitor({ url: 'https://r.esempio.it/', name: 'R' });
    // two failures, then delivered at the third attempt
    failing.set('ops', 2);
    let inc = await monitorDown(store, m, T);
    await deliverArea(store, '', { now: () => T + 1000 });
    assert.equal(got.slack.length, 1);
    let ev = (await store.listEvents('', {}))[0];
    assert.equal(ev.deliveries.find((d) => d.type === 'slack').attempts, 3);
    // the webhook was revoked: the channel goes in error and the user is told by email
    failing.set('ops', Infinity);
    await monitorUp(store, m, inc, T + 5 * MIN);
    await deliverArea(store, '', { now: () => T + 6 * MIN });
    const slack = (await store.listChannels('')).find((c) => c.id === ch.slack.id);
    assert.equal(slack.status, 'error');
    assert.match(slack.lastError, /HTTP 404: no_service/);
    assert.ok(got.email.some((e) => /CANALE DI NOTIFICA IN ERRORE/.test(e.text) && /Slack #ops/.test(e.text)));
    ev = (await store.listEvents('', {})).find((e) => e.type === 'up');
    assert.equal(ev.status, 'sent', 'the email went out');
    // the channel works again: back to active
    failing.delete('ops');
    inc = await monitorDown(store, m, T + 10 * MIN);
    await deliverArea(store, '', { now: () => T + 11 * MIN });
    assert.equal((await store.listChannels('')).find((c) => c.id === ch.slack.id).status, 'active');
  } finally {
    cleanup();
  }
});

test('channels from the web app: email confirmation, Slack, Telegram link, test, masking', async () => {
  reset();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-notifyapi-'));
  process.env.SITESCANNER_HOME = home;
  process.env.SITESCANNER_ADMIN_USER = 'admin';
  process.env.SITESCANNER_ADMIN_PASSWORD = 'admin-iniziale-123';
  const server = await serve({ port: 0, multi: true });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const req = async (method, p, body, headers = {}) => {
    const res = await fetch(`${base}${p}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: text }; }
  };
  try {
    await req('POST', '/api/login', { username: 'admin', password: 'admin-iniziale-123' });
    await req('PUT', '/api/me/password', { current: 'admin-iniziale-123', password: 'admin-definitiva-1' });
    let r = await req('GET', '/api/channels');
    assert.deepEqual(r.data.available, { email: true, slack: true, telegram: true });
    assert.equal(r.data.tz, 'Europe/Rome');

    // email: pending until the link is opened
    r = await req('POST', '/api/channels', { type: 'email', address: 'Mario@Esempio.it' });
    assert.equal(r.status, 201);
    assert.equal(r.data.status, 'pending');
    const link = /https:\/\/monitor\.example(\/api\/notify\/confirm\?token=[\w-]+)/.exec(got.email[0].text)[1];
    assert.equal((await req('POST', `/api/channels/${r.data.id}/test`, {})).status, 400, 'not before the confirmation');
    let page = await fetch(`${base}${link}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Indirizzo confermato/);
    assert.equal((await fetch(`${base}${link}`)).status, 400, 'single use');
    assert.equal((await req('GET', '/api/channels')).data.channels[0].status, 'active');
    assert.equal((await req('POST', '/api/channels', { type: 'email', address: 'non-valido' })).status, 400);

    // Slack: only Incoming Webhook URLs; never shown in full (RF-NOT-09)
    assert.equal((await req('POST', '/api/channels', { type: 'slack', webhookUrl: 'https://evil.example/x' })).status, 400);
    r = await req('POST', '/api/channels', { type: 'slack', name: 'Ops', webhookUrl: `${fakeUrl}/slack/abcd1234` });
    assert.equal(r.status, 201);
    assert.doesNotMatch(JSON.stringify((await req('GET', '/api/channels')).data), /abcd1234/);
    assert.match(r.data.target, /…1234$/);
    // RF-NOT-03: test message
    r = await req('POST', `/api/channels/${r.data.id}/test`, {});
    assert.equal(r.data.ok, true);
    assert.match(got.slack[0].text, /Notifica di prova/);

    // Telegram: link with a single-use code, confirmed by the bot's webhook
    r = await req('POST', '/api/channels/telegram-link', {});
    const code = /^https:\/\/t\.me\/sitescanner_bot\?start=([0-9a-f]{24})$/.exec(r.data.url)[1];
    const hook = (text, secret = 'segreto-webhook') => fetch(`${base}/api/telegram/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify({ message: { text, chat: { id: 777, type: 'group', title: 'Ops team' } } }) });
    assert.equal((await hook(`/start ${code}`, 'sbagliato')).status, 401);
    assert.equal((await hook(`/start ${code}`)).status, 200);
    assert.match(got.telegram.at(-1).text, /Chat collegata/);
    const channels = (await req('GET', '/api/channels')).data.channels;
    const tg = channels.find((c) => c.type === 'telegram');
    assert.equal(tg.name, 'Telegram · Ops team');
    assert.doesNotMatch(JSON.stringify(channels), /777/);
    await hook(`/start ${code}`);
    assert.match(got.telegram.at(-1).text, /già usato/);

    // time zone of the account
    assert.equal((await req('PUT', '/api/notify-prefs', { tz: 'Marte/Olympus' })).status, 400);
    assert.equal((await req('PUT', '/api/notify-prefs', { tz: 'America/New_York' })).status, 200);
    // email unavailable without Resend
    delete process.env.RESEND_API_KEY;
    assert.equal((await req('GET', '/api/channels')).data.available.email, false);
    assert.equal((await req('POST', '/api/channels', { type: 'email', address: 'x@esempio.it' })).status, 400);
    process.env.RESEND_API_KEY = 're_test';
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    for (const k of ['SITESCANNER_ADMIN_USER', 'SITESCANNER_ADMIN_PASSWORD']) delete process.env[k];
    fs.rmSync(home, { recursive: true, force: true });
  }
});
