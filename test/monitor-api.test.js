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

test('monitor API (v2.1): test run, duplicate, mute, description, thresholds', async () => {
  const admin = client();
  assert.equal((await admin.api('POST', 'login', { username: 'admin', password: 'admin-definitiva-12' })).status, 200);
  const dora = await user(admin, 'dora');
  down = false;

  // RF-RIS-07: a test run with the form's configuration; nothing is stored
  let r = await dora.api('POST', 'monitors/test', { url: siteUrl, degradedMs: 5000, headers: { 'x-token': 'abc' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.outcome, 'ok');
  assert.equal(r.data.status, 200);
  assert.ok(r.data.excerpt.includes('<p>ok</p>'));
  assert.ok('content-type' in r.data.headers);
  assert.deepEqual(r.data.thresholds, { degradedMs: 5000, failedMs: 30000 });
  assert.deepEqual((await dora.api('GET', 'monitors')).data, [], 'a test run does not create the monitor');
  down = true;
  r = await dora.api('POST', 'monitors/test', { url: siteUrl });
  assert.deepEqual([r.data.outcome, r.data.message], ['error', 'Errore HTTP 502']);
  down = false;
  assert.equal((await dora.api('POST', 'monitors/test', { url: 'ftp://x' })).status, 400);
  assert.equal((await dora.api('POST', 'monitors/test', { url: siteUrl, degradedMs: 2000, failedMs: 1000 })).status, 400);
  // limited: 10 a minute per account (two were used for the failure cases above that passed validation)
  let last;
  for (let i = 0; i < 12; i++) last = await dora.api('POST', 'monitors/test', { url: siteUrl });
  assert.equal(last.status, 429);

  // description and options are saved and shown
  r = await dora.api('POST', 'monitors', { url: siteUrl, name: 'Sito A', description: 'Hosting Aruba, contatto Mario', followRedirects: false, shouldFail: false, tags: ['a'] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const a = r.data;
  assert.deepEqual([a.description, a.followRedirects, a.degradedMs, a.failedMs, a.ipVersion, a.skipSsl, a.status], ['Hosting Aruba, contatto Mario', false, 3000, null, 'auto', false, 'up']);
  assert.equal((await dora.api('POST', 'monitors', { url: `${siteUrl}x`, description: 'x'.repeat(501) })).status, 400);

  // RF-RIS-04: duplicate = same configuration, no history, «Copia di …»
  r = await dora.api('POST', `monitors/${a.id}/duplicate`, {});
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const copy = r.data;
  assert.equal(copy.name, 'Copia di Sito A');
  assert.notEqual(copy.id, a.id);
  assert.deepEqual([copy.url, copy.description, copy.followRedirects, copy.tags], [a.url, a.description, false, ['a']]);
  assert.equal(copy.state.lastCheckAt, undefined, 'no history');
  assert.equal((await dora.api('GET', 'monitors')).data.length, 2);
  assert.equal((await dora.api('POST', 'monitors/nope/duplicate', {})).status, 404);

  // RF-RIS-03: mute by selection and by tag, with a duration or until unmuted
  assert.equal((await dora.api('POST', 'monitors/actions', { ids: [a.id], action: 'mute', value: 'boh' })).status, 400);
  r = await dora.api('POST', 'monitors/actions', { ids: [a.id], action: 'mute', value: 60 });
  assert.equal(r.data.count, 1);
  r = await dora.api('GET', `monitors/${a.id}`);
  assert.equal(r.data.muted, true);
  assert.ok(Math.abs(r.data.mutedUntil - (Date.now() + 3600000)) < 60000);
  assert.equal((await dora.api('GET', 'monitoring')).data.monitors.find((m) => m.id === a.id).muted, true);
  // editing the monitor does not unmute it
  r = await dora.api('PUT', `monitors/${a.id}`, { ...(await dora.api('GET', `monitors/${a.id}`)).data, name: 'Sito A (nuovo)' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await dora.api('GET', `monitors/${a.id}`)).data.muted, true);
  r = await dora.api('POST', 'monitors/actions', { tag: 'a', action: 'mute', value: 0 });
  assert.equal(r.data.count, 2);
  assert.equal((await dora.api('GET', `monitors/${a.id}`)).data.mutedUntil, null);
  assert.equal((await dora.api('GET', `monitors/${a.id}`)).data.muted, true, 'until unmuted');
  await dora.api('POST', 'monitors/actions', { ids: [a.id, copy.id], action: 'unmute' });
  assert.equal((await dora.api('GET', `monitors/${a.id}`)).data.muted, false);

  // a monitor with an unreachable site is «down», muted or not, and shows in the dashboard as such
  down = true;
  await dora.api('POST', 'monitors/actions', { ids: [a.id], action: 'mute', value: 0 });
  r = await dora.api('POST', `monitors/${a.id}/check`, {});
  assert.deepEqual([r.data.status, r.data.muted], ['down', true]);
  down = false;

  // another account cannot touch them (RF-ISO)
  const eli = await user(admin, 'eli');
  assert.equal((await eli.api('POST', `monitors/${a.id}/duplicate`, {})).status, 404);
  assert.equal((await eli.api('POST', 'monitors/actions', { ids: [a.id], action: 'mute', value: 0 })).status, 400, 'nothing selected');
});

test('monitor API (v2.2): API monitors, assertions, test run with phases', async () => {
  const admin = client();
  await admin.api('POST', 'login', { username: 'admin', password: 'admin-definitiva-12' });
  const fay = await user(admin, 'fay');
  down = false;

  // an API monitor: method, body and assertions are kept, the password is not shown
  let r = await fay.api('POST', 'monitors', {
    type: 'api', name: 'Ordini', url: siteUrl, method: 'POST', bodyType: 'json', body: '{"a":1}', contentType: 'application/json',
    assertions: [{ source: 'status', comparison: 'in', target: '200-299' }, { source: 'body', comparison: 'contains', target: 'ok' }, { source: 'time', comparison: 'lt', target: '5000' }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual([r.data.type, r.data.method, r.data.bodyType, r.data.status], ['api', 'POST', 'json', 'up']);
  assert.equal(r.data.assertions.length, 3);
  assert.equal('expect' in r.data || 'keyword' in r.data, false);

  // a site monitor without assertions gets the default; an old-style payload becomes assertions
  r = await fay.api('POST', 'monitors', { url: `${siteUrl}a`, name: 'Sito' });
  assert.deepEqual(r.data.assertions, [{ source: 'status', comparison: 'in', target: '200-399' }]);
  r = await fay.api('POST', 'monitors', { url: `${siteUrl}b`, expect: '200', keyword: { text: 'ok', mode: 'present', caseInsensitive: true } });
  assert.deepEqual(r.data.assertions.map((a) => [a.source, a.comparison, a.target]), [['status', 'in', '200'], ['body', 'contains', 'ok']]);

  // validation errors are readable
  r = await fay.api('POST', 'monitors', { url: `${siteUrl}c`, assertions: [{ source: 'json', property: '$.x', comparison: 'gt', target: 'molto' }] });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Asserzione 1: il valore atteso deve essere un numero/);
  assert.equal((await fay.api('POST', 'monitors', { url: `${siteUrl}d`, method: 'DELETE' })).status, 400, 'a site monitor is GET or HEAD');

  // test run: phases, assertions with their verdict, nothing stored
  const before = (await fay.api('GET', 'monitors')).data.length;
  r = await fay.api('POST', 'monitors/test', { url: siteUrl, assertions: [{ source: 'status', comparison: 'equals', target: '200' }, { source: 'body', comparison: 'contains', target: 'assente' }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.outcome, 'error');
  assert.equal(r.data.message, 'Parola «assente» non trovata');
  assert.deepEqual(r.data.assertions.map((a) => a.ok), [true, false]);
  assert.deepEqual(Object.keys(r.data.phases).sort(), ['dnsMs', 'downloadMs', 'redirectMs', 'tcpMs', 'tlsMs', 'totalMs', 'waitMs']);
  assert.equal(r.data.ip, '127.0.0.1');
  assert.equal((await fay.api('GET', 'monitors')).data.length, before);

  // the CSV carries the simple configuration
  const csv = (await fay.req('GET', '/api/monitors.csv')).data;
  assert.match(csv, /Sito,.*,5,30,GET,200-399,,,/);
  assert.match(csv, /,200,ok,present,/);
});

test('monitor API (v2.3): analysis, runs with filters and pagination, run detail', async () => {
  const admin = client();
  await admin.api('POST', 'login', { username: 'admin', password: 'admin-definitiva-12' });
  const gia = await user(admin, 'gia');
  const hal = await user(admin, 'hal');
  down = false;

  const mon = (await gia.api('POST', 'monitors', { url: siteUrl, name: 'Vetrina' })).data;
  for (const d of [false, true, true, false]) {
    down = d;
    assert.equal((await gia.api('POST', `monitors/${mon.id}/check`, {})).status, 200);
  }
  down = false;

  // the list: newest first, filters, pagination (RF-RIS-23)
  let r = await gia.api('GET', `monitors/${mon.id}/runs?period=24h`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.total, r.data.pages, r.data.runs.length], [5, 1, 5]);
  assert.deepEqual(r.data.runs.map((x) => x.outcome), ['ok', 'error', 'error', 'ok', 'ok']);
  assert.ok(r.data.runs.every((x) => x.id && x.phases !== undefined));
  r = await gia.api('GET', `monitors/${mon.id}/runs?outcome=error`);
  assert.equal(r.data.total, 2);
  r = await gia.api('GET', `monitors/${mon.id}/runs?pageSize=2&page=3`);
  assert.deepEqual([r.data.total, r.data.pages, r.data.runs.length], [5, 3, 1]);
  assert.equal((await gia.api('GET', `monitors/${mon.id}/runs?period=12h`)).status, 400, 'unknown period');
  assert.equal((await gia.api('GET', `monitors/${mon.id}/runs?period=custom&from=2026-02-01&to=2026-01-01`)).status, 400);

  // the analysis: failures grouped by message, percentiles, phases
  r = await gia.api('GET', `monitors/${mon.id}/analysis?period=24h`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.runs.total, r.data.runs.failed, r.data.runs.ok], [5, 2, 3]);
  assert.equal(r.data.groups.length, 1);
  assert.deepEqual([r.data.groups[0].message, r.data.groups[0].count], ['Status 502, atteso 200-399', 2]);
  assert.ok(r.data.kpis.response.p50 != null && r.data.kpis.response.p99 != null);
  assert.ok(r.data.phases.average.n >= 3);
  assert.equal(r.data.phases.granularity, 'hour');
  const grouped = await gia.api('GET', `monitors/${mon.id}/runs?group=${r.data.groups[0].fingerprint}`);
  assert.equal(grouped.data.total, 2, 'a group opens the list of its runs');
  assert.equal((await gia.api('GET', `monitors/${mon.id}/analysis?period=90d`)).data.phases.granularity, 'day');

  // the detail of a run: the first and the failed ones have it, the others only the light record
  const all = (await gia.api('GET', `monitors/${mon.id}/runs`)).data.runs;
  const failed = all.find((x) => x.outcome === 'error');
  r = await gia.api('GET', `monitors/${mon.id}/runs/${failed.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.detail.status, 502);
  assert.equal(r.data.detail.error, 'Status 502, atteso 200-399');
  assert.equal(r.data.monitor.name, 'Vetrina');
  const plain = all.find((x) => x.outcome === 'ok' && !x.hasDetail);
  r = await gia.api('GET', `monitors/${mon.id}/runs/${plain.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.detail, null);
  assert.equal(r.data.run.id, plain.id);
  assert.equal((await gia.api('GET', `monitors/${mon.id}/runs/inesistente`)).status, 404);

  // the incident detail carries the first failed run; the lists do not (RF-RIS-25)
  const incidents = (await gia.api('GET', `incidents?monitor=${mon.id}`)).data;
  assert.equal(incidents.length, 1);
  assert.equal('firstRun' in incidents[0], false);
  const incident = (await gia.api('GET', `incidents/${incidents[0].id}`)).data;
  assert.equal(incident.firstRun.status, 502);
  assert.equal(incident.firstRun.id, all.filter((x) => x.outcome === 'error').at(-1).id, 'the oldest failed run');

  // isolation: another user cannot see them
  assert.equal((await hal.api('GET', `monitors/${mon.id}/runs`)).status, 404);
  assert.equal((await hal.api('GET', `monitors/${mon.id}/analysis`)).status, 404);
  assert.equal((await hal.api('GET', `monitors/${mon.id}/runs/${failed.id}`)).status, 404);
});
