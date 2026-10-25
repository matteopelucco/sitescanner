import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { serve } from '../src/server.js';

// Monitoring API (spec §12.2, §12.5 bis, §12.6) in multi-user mode: creation with the first check,
// bulk add, import from a site, actions, maintenance, CSV, incidents, isolation between users.

let home, server, base, site, siteUrl, down = false;

before(async () => {
  site = http.createServer((req, res) => (down ? res.writeHead(502).end('bad gateway') : res.writeHead(200, { 'content-type': 'text/html' }).end('<p>ok</p>')));
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}/`;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-monapi-'));
  Object.assign(process.env, {
    SITESCANNER_HOME: home, SITESCANNER_ADMIN_USER: 'admin', SITESCANNER_ADMIN_PASSWORD: 'admin-iniziale-123',
    SITESCANNER_MONITOR_DEV: '1', SITESCANNER_ALLOW_PRIVATE_NETWORKS: '1', SITESCANNER_MON_RETRY_MS: '10',
  });
  server = await serve({ port: 0, multi: true });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await new Promise((r) => site.close(r));
  for (const k of ['SITESCANNER_ADMIN_USER', 'SITESCANNER_ADMIN_PASSWORD', 'SITESCANNER_MONITOR_DEV', 'SITESCANNER_ALLOW_PRIVATE_NETWORKS', 'SITESCANNER_MON_RETRY_MS']) delete process.env[k];
  fs.rmSync(home, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  const req = async (method, p, body) => {
    const res = await fetch(`${base}${p}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* CSV */ }
    return { status: res.status, data };
  };
  return { req, api: (m, p, b) => req(m, `/api/${p}`, b) };
}

async function user(admin, name) {
  const c = client();
  if (admin) await admin.api('POST', 'users', { username: name, password: `${name}-temporanea-1` });
  await c.api('POST', 'login', { username: name, password: admin ? `${name}-temporanea-1` : 'admin-iniziale-123' });
  await c.api('PUT', 'me/password', { current: admin ? `${name}-temporanea-1` : 'admin-iniziale-123', password: `${name}-definitiva-12` });
  return c;
}

test('monitoring API: create, bulk, import, actions, maintenance, incidents, CSV, isolation', async () => {
  const admin = await user(null, 'admin');
  const anna = await user(admin, 'anna');
  const bruno = await user(admin, 'bruno');

  assert.deepEqual((await anna.api('GET', 'state')).data.monitoring, { enabled: true, dev: true });

  // creation runs the first check at once (§12.8)
  let r = await anna.api('POST', 'monitors', { url: siteUrl, name: 'Negozio', tags: ['Cliente-X'], auth: { username: 'u', password: 'segreta' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const shop = r.data;
  assert.equal(shop.status, 'up');
  assert.deepEqual(shop.tags, ['cliente-x']);
  assert.equal(shop.auth.password, '••••••', 'credentials are never sent back (RF-NOT-09)');
  assert.equal((await anna.api('POST', 'monitors', { url: 'ftp://x' })).status, 400);
  assert.equal((await anna.api('POST', 'monitors', { url: siteUrl, intervalMin: 1 })).status, 400, 'minimum 5 minutes');
  assert.equal((await anna.api('POST', 'monitors', { url: `${siteUrl}x`, headers: { 'x-token': '${DATABASE_URL}' } })).status, 400, 'RF-SEC-02');

  // edit keeps the stored password when the masked value comes back
  r = await anna.api('PUT', `monitors/${shop.id}`, { ...shop, name: 'Negozio online' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const stored = JSON.parse(fs.readFileSync(path.join(home, 'users', 'anna', 'monitoring', 'monitors.json'), 'utf8'));
  assert.equal(stored[0].auth.password, 'segreta');

  // RF-MON-02: bulk add with errors and duplicates
  r = await anna.api('POST', 'monitors/bulk', { text: `Blog, ${siteUrl}blog\n${siteUrl}chi-siamo\nnon un url\n${siteUrl}\n# commento`, tags: ['cliente-y'] });
  assert.equal(r.data.created.length, 2);
  assert.deepEqual(r.data.skipped.map((s) => s.reason), ['URL non valido: non un url', 'URL già monitorato']);
  assert.equal(r.data.created[0].name, 'Blog');

  // RF-MON-03: from a site, one monitor per environment
  await anna.api('POST', 'sites', { id: 'shop', form: { name: 'Shop', envs: { prod: { baseUrl: `${siteUrl}prod/` }, stage: { baseUrl: `${siteUrl}stage/`, auth: { username: 's', password: 'p' } } } } });
  r = await anna.api('POST', 'monitors/import-site', { site: 'shop' });
  assert.deepEqual(r.data.created.map((m) => m.name).sort(), ['Shop · prod', 'Shop · stage']);
  assert.deepEqual(r.data.created.find((m) => m.name === 'Shop · stage').source, { site: 'shop', env: 'stage' });

  // dashboard
  r = await anna.api('GET', 'monitoring');
  assert.equal(r.data.monitors.length, 5);
  assert.deepEqual(r.data.tags, ['cliente-x', 'cliente-y', 'shop']);
  assert.equal(r.data.beat.stale, true, 'no round yet');

  // a failure: incident, then pause closes it (RF-INC-04)
  down = true;
  r = await anna.api('POST', `monitors/${shop.id}/check`, {});
  assert.equal(r.data.status, 'down');
  r = await anna.api('GET', 'monitoring');
  assert.equal(r.data.openIncidents.length, 1);
  assert.equal(r.data.monitors[0].id, shop.id, 'the ones that are down come first');
  const incId = r.data.openIncidents[0].id;
  r = await anna.api('GET', `incidents/${incId}`);
  assert.equal(r.data.cause.message, 'Errore HTTP 502');
  assert.equal((await anna.api('PUT', `incidents/${incId}`, { note: 'Proxy riavviato' })).data.note, 'Proxy riavviato');
  r = await anna.api('POST', 'monitors/actions', { ids: [shop.id], action: 'pause' });
  assert.equal(r.data.count, 1);
  r = await anna.api('GET', `incidents/${incId}`);
  assert.equal(r.data.closedBy, 'paused');
  assert.equal((await anna.api('GET', `monitors/${shop.id}`)).data.status, 'paused');
  assert.equal((await anna.api('POST', 'monitors/actions', { tag: 'cliente-x', action: 'resume' })).data.count, 1);
  down = false;

  // RF-MON-04: by tag
  r = await anna.api('POST', 'monitors/actions', { tag: 'cliente-y', action: 'interval', value: 15 });
  assert.equal(r.data.count, 2);
  assert.ok((await anna.api('GET', 'monitors')).data.filter((m) => m.tags.includes('cliente-y')).every((m) => m.intervalMin === 15));

  // RF-MNT-05: immediate maintenance; RF-MNT-01/02: recurring window
  r = await anna.api('POST', 'monitors/actions', { tag: 'cliente-y', action: 'maintenance', value: 30 });
  assert.equal(r.data.window.durationMin, 30);
  assert.equal((await anna.api('GET', 'monitoring')).data.windows[0].active, true);
  assert.equal((await anna.api('POST', `maintenance/${r.data.window.id}/end`, {})).status, 200);
  assert.equal((await anna.api('POST', 'maintenance', { name: 'Rilasci', type: 'weekly', days: [3], time: '22:00', durationMin: 60, tags: ['cliente-x'] })).status, 201);
  assert.equal((await anna.api('POST', 'maintenance', { name: 'Senza nulla', type: 'weekly', days: [3], time: '22:00', durationMin: 60 })).status, 400);
  assert.equal((await anna.api('POST', 'maintenance', { type: 'weekly', days: [], time: '22:00', durationMin: 60, tags: ['x'] })).status, 400);

  // detail with KPIs of the standard periods (RF-KPI-05)
  r = await anna.api('GET', `monitors/${shop.id}`);
  assert.deepEqual(Object.keys(r.data.periods), ['24h', '7d', '30d', '90d', '12m', 'month']);
  assert.equal(r.data.periods['24h'].incidents, 1);
  assert.ok(r.data.checks.length >= 2);
  assert.ok(['buona', 'attenzione', 'critica'].includes(r.data.health.level));

  // RF-MON-05 / RF-KPI-06: CSV
  r = await anna.req('GET', '/api/monitors.csv');
  assert.match(r.data, /^name,url,intervalMin/);
  const csv = `name,url,intervalMin,tags\nDa CSV,${siteUrl}csv,10,a;b\nRotto,xx,5,\n`;
  r = await bruno.api('POST', 'monitors/import-csv', { csv });
  assert.equal(r.data.created.length, 1);
  assert.deepEqual(r.data.created[0].tags, ['a', 'b']);
  assert.equal(r.data.skipped.length, 1);
  assert.match((await anna.req('GET', '/api/incidents.csv')).data, /Errore HTTP 502/);
  assert.match((await anna.req('GET', '/api/monitors/daily.csv')).data, /^monitor,url,giorno/);

  // RF-ISO-02/03: users see only their monitors
  assert.equal((await bruno.api('GET', `monitors/${shop.id}`)).status, 404);
  assert.equal((await bruno.api('GET', `incidents/${incId}`)).status, 404);
  assert.equal((await bruno.api('GET', 'monitoring')).data.monitors.length, 1);
  assert.equal((await bruno.api('POST', 'monitors/actions', { ids: [shop.id], action: 'delete' })).status, 400);

  // RF-MON-01: deletion with its history
  assert.equal((await anna.api('DELETE', `monitors/${shop.id}`)).status, 200);
  assert.equal((await anna.api('GET', `incidents/${incId}`)).status, 404);

  // off unless enabled (RF-MON-18)
  delete process.env.SITESCANNER_MONITOR_DEV;
  assert.equal((await anna.api('GET', 'monitoring')).status, 404);
  assert.equal((await anna.api('GET', 'state')).data.monitoring, null);
  process.env.SITESCANNER_MONITOR_DEV = '1';

  // the cron needs the secret
  assert.equal((await anna.req('GET', '/api/cron/monitor')).status, 401);
});
