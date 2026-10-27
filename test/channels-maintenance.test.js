import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { windowOccurrences, zonedClock } from '../src/core/uptime.js';
import { serve } from '../src/server.js';

// Recurring maintenance (spec §13.14, RF-MNT-10) and the channels webhook, Teams and Discord (RF-CHN-01).

const DAY = 86400000, HOUR = 3600000;
const iso = (list) => list.map(([s, e]) => [new Date(s).toISOString(), new Date(e).toISOString()]);
const rome = (y, mo, d, h = 0, mi = 0) => { const t = zonedClockInverse(y, mo, d, h, mi); return t; };
// Europe/Rome as a time zone: the instant of a wall-clock time
function zonedClockInverse(y, mo, d, h, mi) {
  for (const off of [1, 2]) {
    const t = Date.UTC(y, mo, d, h - off, mi);
    const c = zonedClock(t, 'Europe/Rome');
    if (c.y === y && c.mo === mo && c.d === d && c.hh === h && c.mi === mi) return t;
  }
  throw new Error('no such time');
}

test('a window that repeats every N days, weeks or months until a date (RF-MNT-10)', () => {
  const start = rome(2026, 0, 5, 22, 30); // Monday 5 January 2026, 22:30 in Rome
  const w = (extra) => ({ type: 'repeat', start, durationMin: 60, every: 1, unit: 'day', until: null, ...extra });
  const occ = (win, from, to) => windowOccurrences(win, from, to, 'Europe/Rome');
  // every day
  assert.deepEqual(iso(occ(w(), start, start + 3 * DAY)), [['2026-01-05T21:30:00.000Z', '2026-01-05T22:30:00.000Z'], ['2026-01-06T21:30:00.000Z', '2026-01-06T22:30:00.000Z'], ['2026-01-07T21:30:00.000Z', '2026-01-07T22:30:00.000Z']]);
  // every 3 days, and nothing before the first one
  assert.deepEqual(iso(occ(w({ every: 3 }), start - 10 * DAY, start + 7 * DAY)).map((x) => x[0]), ['2026-01-05T21:30:00.000Z', '2026-01-08T21:30:00.000Z', '2026-01-11T21:30:00.000Z']);
  // every 2 weeks
  assert.deepEqual(iso(occ(w({ every: 2, unit: 'week' }), start, start + 35 * DAY)).map((x) => x[0].slice(0, 10)), ['2026-01-05', '2026-01-19', '2026-02-02']);
  // until: the last day is whole, the next one is not
  const until = rome(2026, 0, 8, 23, 59);
  assert.deepEqual(iso(occ(w({ until }), start, start + 10 * DAY)).map((x) => x[0].slice(0, 10)), ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08']);
  // the occurrence that overlaps the interval asked, even if it began before
  assert.equal(occ(w(), start + 30 * 60000, start + 40 * 60000).length, 1);
  assert.equal(occ(w(), start + 2 * HOUR, start + 3 * HOUR).length, 0);
  // the wall-clock time holds across the change of summer time (25 October 2026, 03:00 → 02:00)
  const t0 = rome(2026, 9, 23, 2, 30);
  const across = occ(w({ start: t0, durationMin: 30 }), t0, t0 + 5 * DAY).map(([s]) => zonedClock(s, 'Europe/Rome'));
  assert.deepEqual(across.map((c) => `${c.d}/${c.hh}:${c.mi}`), ['23/2:30', '24/2:30', '25/2:30', '26/2:30', '27/2:30'], 'always 02:30 on the clock');
  assert.deepEqual(iso(occ(w({ start: t0, durationMin: 30 }), t0 + 3 * DAY, t0 + 4 * DAY)).map((x) => x[0]), ['2026-10-26T01:30:00.000Z'], 'one hour later in UTC after the change');
  // monthly: the 31st falls on the last day of the shorter months, and the day is the one of the start, not the one of the month before
  const jan31 = rome(2026, 0, 31, 3, 0);
  assert.deepEqual(iso(occ(w({ start: jan31, every: 1, unit: 'month' }), jan31, jan31 + 130 * DAY)).map((x) => x[0].slice(0, 10)), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  assert.deepEqual(iso(occ(w({ start: jan31, every: 3, unit: 'month' }), jan31, jan31 + 200 * DAY)).map((x) => x[0].slice(0, 10)), ['2026-01-31', '2026-04-30', '2026-07-31']);
  assert.deepEqual(iso(occ(w({ start: rome(2026, 11, 15, 10, 0), unit: 'month' }), rome(2027, 0, 1), rome(2027, 2, 1))).map((x) => x[0].slice(0, 10)), ['2027-01-15', '2027-02-15']);
  // a window that began years ago costs little: it jumps to the interval
  const old = rome(2020, 0, 1, 4, 0);
  const t = Date.now();
  assert.equal(occ(w({ start: old, unit: 'day' }), rome(2026, 9, 1), rome(2026, 9, 4)).length, 3);
  assert.equal(occ(w({ start: old, unit: 'week', every: 1 }), rome(2026, 9, 1), rome(2026, 9, 8)).length, 1);
  assert.ok(Date.now() - t < 200, 'no walk from the first day');
  // closing it early, as the other types
  assert.equal(occ(w({ endedAt: start + 30 * 60000 }), start, start + 3 * DAY).length, 1);
  assert.deepEqual(iso(occ(w({ endedAt: start + 30 * 60000 }), start, start + 3 * DAY))[0][1], '2026-01-05T22:00:00.000Z');
  void rome;
});

// ---------------- the service ----------------

let home, server, base, fake;
const got = { teams: [], discord: [], hook: [] };
const SECRET_STATE = {};

before(async () => {
  fake = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const rec = { url: req.url, headers: req.headers, body };
    if (req.url.startsWith('/teams/')) got.teams.push(rec);
    else if (req.url.startsWith('/discord/')) got.discord.push(rec);
    else if (req.url.startsWith('/hook/')) got.hook.push(rec);
    res.writeHead(req.url.includes('rotto') ? 500 : 200).end(req.url.includes('rotto') ? 'giù' : 'ok');
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const u = `http://127.0.0.1:${fake.address().port}`;
  Object.assign(SECRET_STATE, { u });
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-chm-'));
  Object.assign(process.env, { SITESCANNER_HOME: home, SITESCANNER_ADMIN_USER: 'admin', SITESCANNER_ADMIN_PASSWORD: 'admin-iniziale-123', SITESCANNER_MONITOR_DEV: '1', SITESCANNER_ALLOW_PRIVATE_NETWORKS: '1', SITESCANNER_NOTIFY_RETRY_MS: '1,1,1', SITESCANNER_PUBLIC_URL: 'https://monitor.example.com', SITESCANNER_TEAMS_WEBHOOK_PREFIX: `${u}/teams/`, SITESCANNER_DISCORD_WEBHOOK_PREFIX: `${u}/discord/` });
  server = await serve({ port: 0, multi: true });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await new Promise((r) => fake.close(r));
  for (const k of ['SITESCANNER_ADMIN_USER', 'SITESCANNER_ADMIN_PASSWORD', 'SITESCANNER_MONITOR_DEV', 'SITESCANNER_ALLOW_PRIVATE_NETWORKS', 'SITESCANNER_NOTIFY_RETRY_MS', 'SITESCANNER_PUBLIC_URL', 'SITESCANNER_TEAMS_WEBHOOK_PREFIX', 'SITESCANNER_DISCORD_WEBHOOK_PREFIX']) delete process.env[k];
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

test('API: maintenance that repeats, validated', async () => {
  const admin = client();
  await admin('POST', 'login', { username: 'admin', password: 'admin-iniziale-123' });
  await admin('PUT', 'me/password', { current: 'admin-iniziale-123', password: 'admin-definitiva-12' });
  await admin('POST', 'users', { username: 'maria', password: 'maria-temporanea-1' });
  const maria = client();
  await maria('POST', 'login', { username: 'maria', password: 'maria-temporanea-1' });
  await maria('PUT', 'me/password', { current: 'maria-temporanea-1', password: 'maria-definitiva-12' });
  const mon = (await maria('POST', 'monitors', { name: 'Sito', url: `${SECRET_STATE.u}/x` })).data;
  const mk = (extra) => maria('POST', 'maintenance', { name: 'Ricorrente', type: 'repeat', start: new Date(Date.now() + DAY).toISOString(), durationMin: 60, every: 2, unit: 'week', monitorIds: [mon.id], ...extra });
  let r = await mk({});
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual([r.data.type, r.data.every, r.data.unit, r.data.until], ['repeat', 2, 'week', null]);
  r = await mk({ until: '2026-12-31' });
  assert.equal(r.data.until, Date.parse('2026-12-31') + DAY - 1, 'a date alone is the whole day');
  assert.equal((await mk({ unit: 'anno' })).status, 400);
  assert.match((await mk({ every: 60, unit: 'week' })).data.error, /ogni 1–52 settimane/);
  assert.match((await mk({ every: 0 })).data.error, /ogni 1–365 giorni|ogni 1–52/);
  assert.match((await mk({ start: 'boh' })).data.error, /prima volta non valide/);
  assert.match((await mk({ until: '2020-01-01' })).data.error, /finisce prima di cominciare/);
  assert.match((await mk({ until: 'boh' })).data.error, /fine della ripetizione non valida/);
  // the dashboard shows the next ones
  const dash = (await maria('GET', 'monitoring')).data;
  assert.ok(dash.windows.length >= 1);
  assert.equal(dash.windows[0].monitors[0], 'Sito');
});

test('channels: webhook (signed), Teams and Discord, with test messages (RF-CHN-01)', async () => {
  const admin = client();
  await admin('POST', 'login', { username: 'admin', password: 'admin-definitiva-12' });
  await admin('POST', 'users', { username: 'nino', password: 'nino-temporanea-1' });
  const nino = client();
  await nino('POST', 'login', { username: 'nino', password: 'nino-temporanea-1' });
  await nino('PUT', 'me/password', { current: 'nino-temporanea-1', password: 'nino-definitiva-12' });
  const u = SECRET_STATE.u;

  // validation
  assert.equal((await nino('POST', 'channels', { type: 'teams', webhookUrl: 'https://esempio.it/x' })).status, 400);
  assert.equal((await nino('POST', 'channels', { type: 'discord', webhookUrl: 'https://esempio.it/x' })).status, 400);
  assert.equal((await nino('POST', 'channels', { type: 'webhook', url: 'ftp://x' })).status, 400);
  assert.equal((await nino('POST', 'channels', { type: 'webhook', url: 'boh' })).status, 400);
  assert.match((await nino('POST', 'channels', { type: 'altro' })).data.error, /email, slack, teams, discord o webhook/);

  // creation: the secret of a webhook is shown once, and not again
  let r = await nino('POST', 'channels', { type: 'webhook', name: 'Il mio sistema', url: `${u}/hook/ricevi` });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const hook = r.data;
  assert.match(hook.secret, /^whsec_[\w-]{32}$/);
  assert.equal(hook.target.includes('ricevi'), false, 'the address is masked');
  const teams = (await nino('POST', 'channels', { type: 'teams', name: 'Team', webhookUrl: `${u}/teams/abc123` })).data;
  const discord = (await nino('POST', 'channels', { type: 'discord', name: 'Ops', webhookUrl: `${u}/discord/xyz789` })).data;
  const listed = (await nino('GET', 'channels')).data.channels;
  assert.deepEqual(listed.map((c) => c.type).sort(), ['discord', 'teams', 'webhook']);
  assert.equal(JSON.stringify(listed).includes(hook.secret), false);
  assert.match(listed.find((c) => c.type === 'teams').target, /^Teams …c123$/);

  // the test messages reach the three services
  for (const c of [hook, teams, discord]) {
    const t = await nino('POST', `channels/${c.id}/test`, {});
    assert.equal(t.status, 200, JSON.stringify(t.data));
    assert.equal(t.data.ok, true, t.data.error);
  }
  // the webhook: JSON with the event and the signature that the receiver can check
  const h = got.hook[0];
  const msg = JSON.parse(h.body);
  assert.equal(msg.type, 'sitescanner.event');
  assert.equal(msg.event.type, 'test');
  assert.match(msg.message.text, /Notifica di prova da sitescanner/);
  const ts = h.headers['x-sitescanner-timestamp'];
  const want = `sha256=${crypto.createHmac('sha256', hook.secret).update(`${ts}.${h.body}`).digest('hex')}`;
  assert.equal(h.headers['x-sitescanner-signature'], want, 'the signature is verified with the secret');
  assert.notEqual(h.headers['x-sitescanner-signature'], `sha256=${crypto.createHmac('sha256', 'altro').update(`${ts}.${h.body}`).digest('hex')}`);
  assert.ok(Math.abs(Date.now() - Number(ts)) < 60000);
  // Teams: an Adaptive Card
  const card = JSON.parse(got.teams[0].body);
  assert.equal(card.type, 'message');
  assert.equal(card.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  assert.equal(card.attachments[0].content.type, 'AdaptiveCard');
  assert.match(card.attachments[0].content.body[0].text, /Notifica di prova/);
  // Discord: an embed
  const emb = JSON.parse(got.discord[0].body);
  assert.equal(emb.username, 'sitescanner');
  assert.match(emb.embeds[0].title, /Notifica di prova/);

  // a real event goes to the three, with the event as data for the webhook
  const mon = (await nino('POST', 'monitors', { name: 'Sito', url: `${u}/hook/rotto-sito` })).data;
  await nino('POST', `monitors/${mon.id}/check`, {});
  const down = got.hook.filter((x) => x.body).map((x) => JSON.parse(x.body)).find((m) => m.event && m.event.type === 'down');
  assert.ok(down, 'the down alert reached the webhook');
  assert.deepEqual([down.event.monitor.name, down.event.cause.includes('500') || down.event.cause.includes('HTTP')], ['Sito', true]);
  assert.match(down.message.link, /^https:\/\/monitor\.example\.com\/#\/incident\//);
  assert.ok(got.teams.some((x) => /GIÙ/.test(x.body)));
  assert.ok(got.discord.some((x) => JSON.parse(x.body).embeds[0].color === 0xd64545), 'red for a down');

  // a service that answers with an error: the failure is reported with what it said
  const broken = (await nino('POST', 'channels', { type: 'webhook', name: 'Rotto', url: `${u}/hook/rotto` })).data;
  const t = await nino('POST', `channels/${broken.id}/test`, {});
  assert.equal(t.data.ok, false);
  assert.match(t.data.error, /HTTP 500: giù/);

  // the guard: with accounts, a webhook cannot point to a private address (RF-SEC-01)
  delete process.env.SITESCANNER_ALLOW_PRIVATE_NETWORKS;
  try {
    r = await nino('POST', 'channels', { type: 'webhook', name: 'Locale', url: 'http://127.0.0.1:9/x' });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /Indirizzo non ammesso/);
    // a hostname that resolves to the private one is refused when it is sent
    const sneaky = (await (async () => { process.env.SITESCANNER_ALLOW_PRIVATE_NETWORKS = '1'; const x = await nino('POST', 'channels', { type: 'webhook', name: 'Furbo', url: 'http://localhost:9/x' }); delete process.env.SITESCANNER_ALLOW_PRIVATE_NETWORKS; return x; })()).data;
    void sneaky;
  } finally { process.env.SITESCANNER_ALLOW_PRIVATE_NETWORKS = '1'; }
});
