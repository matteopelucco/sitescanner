import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { parseMonitorsFile, formatFileError, codeIdFrom, rebaseUrl, monitorsToYaml, MONITOR_FIELDS, WINDOW_FIELDS } from '../src/core/monitorsfile.js';
import { serve } from '../src/server.js';

// Monitoring as code and tests from the CI (spec §13.13, RF-MAC-01..04): the file, its errors with line and field, the plan, the
// idempotence, the lock of the managed monitors, the export that closes the circle, the test on a preview, and the command line.

test('the file: monitors, maintenance, errors with line and field (RF-MAC-01)', () => {
  const ok = parseMonitorsFile(`version: 1
monitors:
  - id: negozio
    type: http
    name: Negozio
    url: https://negozio.acme.it/
    tags: [cliente:acme]
    channels: [Slack ops]
  - id: backup
    type: heartbeat
    name: Backup notturno
    expectedMin: 1440
maintenance:
  - id: notturna
    name: Aggiornamenti
    type: weekly
    days: [0]
    time: "03:00"
    durationMin: 60
    monitors: [negozio]
`);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.monitors.map((m) => [m.id, m.line, m.lines.url]), [['negozio', 3, 6], ['backup', 9, undefined]]);
  assert.equal(ok.monitors[0].fields.tags[0], 'cliente:acme');
  assert.equal(ok.maintenance[0].fields.monitors[0], 'negozio');

  const bad = (text) => parseMonitorsFile(text, { file: 'm.yml' }).errors.map((e) => formatFileError('m.yml', e));
  assert.match(bad('monitors: [')[0], /^m\.yml:\d+: YAML non valido/);
  assert.deepEqual(bad('- a\n- b'), ['m.yml:1: Il file deve essere una mappa con «monitors» (e, se serve, «maintenance»)']);
  assert.deepEqual(bad('versione: 1\nmonitors:\n  - id: a\n    type: http\n    url: https://a.it/'), ['m.yml:1: versione: campo sconosciuto «versione» (ammessi: version, monitors, maintenance)']);
  assert.match(bad('version: 2\nmonitors:\n  - id: a\n    url: https://a.it/')[0], /m\.yml:1: version: versione 2 non supportata/);
  assert.deepEqual(bad('monitors:\n  - id: a\n    url: https://a.it/\n    colore: rosso'), ['m.yml:4: monitors[0].colore: campo sconosciuto «colore»']);
  assert.match(bad('monitors:\n  - name: senza id\n    url: https://a.it/')[0], /m\.yml:2: monitors\[0\]\.id: monitor 1: serve un «id» stabile/);
  assert.match(bad('monitors:\n  - id: Maiuscolo!\n    url: https://a.it/')[0], /serve un «id» stabile/);
  assert.match(bad('monitors:\n  - id: a\n    url: https://a.it/\n  - id: a\n    url: https://b.it/')[0], /m\.yml:4: monitors\[1\]\.id: l'id «a» è usato due volte/);
  assert.match(bad('monitors:\n  - id: a\n    url: https://a.it/\n    auth: { username: u, password: p }')[0], /m\.yml:4: monitors\[0\]\.auth: auth: le credenziali non vanno nel file.*\{\{SEGRETO\}\}/);
  assert.match(bad('monitors:\n  - id: a\n    type: heartbeat\n    hbToken: x')[0], /hbToken: l'indirizzo segreto di un heartbeat lo genera il servizio/);
  assert.match(bad('monitors:\n  - id: a\n    url: https://a.it/\n    channels: Slack')[0], /m\.yml:4: .*channels è un elenco di nomi/);
  assert.match(bad('monitors:\n  - id: a\n    url: https://a.it/\nmaintenance:\n  - id: m\n    name: x\n    monitors: [zeta]')[0], /m\.yml:7: .*il monitor «zeta» non è nel file/);
  assert.match(bad('monitors: 5')[0], /«monitors» deve essere un elenco/);
  assert.match(bad('version: 1')[0], /non descrive nessun monitor/);
  assert.match(bad('monitors:\n  - pippo')[0], /monitor 1: deve essere una mappa/);

  assert.equal(codeIdFrom('Shop Acme – Città'), 'shop-acme-citta');
  assert.equal(codeIdFrom('Sito', new Set(['sito', 'sito-2'])), 'sito-3');
  assert.equal(codeIdFrom('***'), 'monitor');
  assert.equal(rebaseUrl('https://www.acme.it/shop/a?x=1', 'https://anteprima-git-x.vercel.app'), 'https://anteprima-git-x.vercel.app/shop/a?x=1');
  assert.equal(rebaseUrl('https://www.acme.it/shop', 'https://staging.acme.it/sotto/'), 'https://staging.acme.it/sotto/shop');
  const yaml = monitorsToYaml({ monitors: [{ id: 'a', fields: { type: 'http', name: 'A', url: 'https://a.it/' } }] });
  assert.match(yaml, /^# sitescanner\.monitors\.yml/);
  assert.deepEqual(parseMonitorsFile(yaml).monitors.map((m) => m.fields.url), ['https://a.it/'], 'what is written can be read');
});

test('the documented schema lists the same fields as the reader', () => {
  const schema = JSON.parse(fs.readFileSync(new URL('../docs/specs/monitors.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(schema.properties.monitors.items.properties).sort(), [...MONITOR_FIELDS].sort());
  assert.deepEqual(Object.keys(schema.properties.maintenance.items.properties).sort(), [...WINDOW_FIELDS].sort());
});

// ---------------- the service ----------------

let home, server, base, site, siteUrl, siteMode = 'ok', slack, slackUrl;
const hits = [];

before(async () => {
  site = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/rotto') return res.writeHead(500).end('rotto');
    if (req.url === '/senza-parola') return res.writeHead(200).end('ciao mondo');
    res.writeHead(siteMode === 'down' ? 503 : 200, { 'content-type': 'text/html' }).end('<h1>Benvenuti</h1> ok');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
  slack = http.createServer((req, res) => res.writeHead(200).end('ok'));
  await new Promise((r) => slack.listen(0, '127.0.0.1', r));
  slackUrl = `http://127.0.0.1:${slack.address().port}/slack/`;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-mac-'));
  Object.assign(process.env, { SITESCANNER_HOME: home, SITESCANNER_ADMIN_USER: 'admin', SITESCANNER_ADMIN_PASSWORD: 'admin-iniziale-123', SITESCANNER_MONITOR_DEV: '1', SITESCANNER_ALLOW_PRIVATE_NETWORKS: '1', SITESCANNER_SLACK_WEBHOOK_PREFIX: slackUrl, SITESCANNER_SECRETS_KEY: 'd'.repeat(64) });
  server = await serve({ port: 0, multi: true });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await new Promise((r) => site.close(r));
  await new Promise((r) => slack.close(r));
  for (const k of ['SITESCANNER_ADMIN_USER', 'SITESCANNER_ADMIN_PASSWORD', 'SITESCANNER_MONITOR_DEV', 'SITESCANNER_ALLOW_PRIVATE_NETWORKS', 'SITESCANNER_SLACK_WEBHOOK_PREFIX', 'SITESCANNER_SECRETS_KEY']) delete process.env[k];
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

const v1 = (token, method, p, body) => fetch(`${base}/api/v1/${p}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => { const t = await r.text(); let data = t; try { data = JSON.parse(t); } catch { /* yaml */ } return { status: r.status, data }; });
const cli = (args, env = {}) => new Promise((resolve) => execFile(process.execPath, [path.resolve('bin/sitescanner.js'), ...args], { env: { ...process.env, ...env, NO_COLOR: '1' }, cwd: home }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));

const FILE = (extra = '') => `version: 1
monitors:
  - id: negozio
    type: http
    name: Negozio
    url: ${siteUrl}/
    intervalMin: 5
    tags: [cliente:acme, prod]
    assertions:
      - { source: status, comparison: in, target: "200" }
      - { source: body, comparison: contains, target: Benvenuti }
    channels: [Slack ops]
  - id: api-ordini
    type: api
    name: API ordini
    url: ${siteUrl}/api/ordini
    method: POST
    bodyType: json
    body: '{"a": 1}'
    tags: [cliente:acme]
  - id: backup
    type: heartbeat
    name: Backup notturno
    expectedMin: 1440
maintenance:
  - id: notturna
    name: Aggiornamenti notturni
    type: weekly
    days: [0]
    time: "03:00"
    durationMin: 60
    monitors: [negozio, api-ordini]
${extra}`;

test('apply: plan, dry run, idempotence, changes, deletion, the lock, export, test on a preview, history', async () => {
  const admin = client();
  await admin('POST', 'login', { username: 'admin', password: 'admin-iniziale-123' });
  await admin('PUT', 'me/password', { current: 'admin-iniziale-123', password: 'admin-definitiva-12' });
  await admin('POST', 'users', { username: 'gigi', password: 'gigi-temporanea-1' });
  const gigi = client();
  await gigi('POST', 'login', { username: 'gigi', password: 'gigi-temporanea-1' });
  await gigi('PUT', 'me/password', { current: 'gigi-temporanea-1', password: 'gigi-definitiva-12' });
  const personal = (await gigi('GET', 'workspaces')).data.workspaces[0].id;
  const write = (await gigi('POST', `workspaces/${personal}/tokens`, { name: 'CI', scope: 'write' })).data.token;
  const read = (await gigi('POST', `workspaces/${personal}/tokens`, { name: 'Solo lettura', scope: 'read' })).data.token;
  await gigi('POST', 'channels', { type: 'slack', name: 'Slack ops', webhookUrl: `${slackUrl}ops` });

  // the errors come with file, line and field; nothing is applied
  let r = await v1(write, 'POST', 'apply', { name: 'm.yml', file: FILE().replace('intervalMin: 5', 'intervalMin: 7').replace('[Slack ops]', '[Canale che non c\'è]') });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /2 problemi/);
  assert.deepEqual(r.data.errors.map((e) => e.text), ["m.yml:12: monitors.negozio.channels: il canale «Canale che non c'è» non esiste: aggiungilo nella pagina Notifiche", 'm.yml:3: monitors.negozio: Intervallo non valido: ammessi 5, 10, 15, 30, 60 minuti']);
  assert.equal((await gigi('GET', 'monitors')).data.length, 0, 'nothing was created');
  r = await v1(write, 'POST', 'apply', { name: 'm.yml', file: FILE().replace('[Slack ops]', "[Canale che non c'è]") });
  assert.match(r.data.errors[0].text, /^m\.yml:\d+: monitors\.negozio\.channels: il canale «Canale che non c'è» non esiste/);
  assert.equal((await v1(write, 'POST', 'apply', { file: 'monitors: [' })).status, 400);
  assert.equal((await v1(write, 'POST', 'apply', {})).status, 400);

  // dry run: the plan, nothing written; a read token may do it, not apply
  r = await v1(read, 'POST', 'apply', { file: FILE(), dryRun: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.dryRun, r.data.applied, r.data.plan.create.map((x) => x.id), r.data.plan.windows.create.map((x) => x.id)], [true, false, ['negozio', 'api-ordini', 'backup'], ['notturna']]);
  assert.equal((await gigi('GET', 'monitors')).data.length, 0);
  assert.equal((await v1(read, 'POST', 'apply', { file: FILE() })).status, 403, 'a read token cannot apply');
  assert.equal((await v1(read, 'POST', 'test', { file: FILE(), baseUrl: siteUrl })).status, 403, 'nor test: it makes requests');

  // apply: created, managed by code, with the channel by name
  r = await v1(write, 'POST', 'apply', { file: FILE() });
  assert.deepEqual([r.status, r.data.applied, r.data.plan.create.length], [200, true, 3]);
  const list = (await gigi('GET', 'monitors')).data;
  assert.deepEqual(list.map((m) => [m.codeId, m.managedBy, m.type]).sort(), [['api-ordini', 'code', 'api'], ['backup', 'code', 'heartbeat'], ['negozio', 'code', 'http']]);
  const shop = list.find((m) => m.codeId === 'negozio');
  assert.equal(shop.channels.length, 1);
  assert.equal(shop.assertions.length, 2);
  assert.equal((await gigi('GET', 'maintenance')).data[0].codeId, 'notturna');
  assert.equal((await gigi('GET', 'maintenance')).data[0].monitorIds.length, 2);
  const hbToken = (await gigi('GET', `monitors/${list.find((m) => m.codeId === 'backup').id}`)).data.hbToken;

  // idempotent: the second time nothing changes (and the ids and tokens stay)
  r = await v1(write, 'POST', 'apply', { file: FILE() });
  assert.deepEqual([r.data.plan.create.length, r.data.plan.update.length, r.data.plan.delete.length, r.data.plan.unchanged, r.data.plan.windows.unchanged], [0, 0, 0, 3, 1]);
  assert.deepEqual((await gigi('GET', 'monitors')).data.map((m) => m.id).sort(), list.map((m) => m.id).sort());

  // the lock (RF-MAC-02): from the interface a managed monitor is not changed, but it can be run, silenced, paused and copied
  assert.equal((await gigi('PUT', `monitors/${shop.id}`, { ...shop, name: 'Cambiato' })).status, 409);
  assert.match((await gigi('DELETE', `monitors/${shop.id}`)).data.error, /gestito da codice/);
  assert.equal((await gigi('POST', 'monitors/actions', { ids: [shop.id], action: 'tags', value: ['x'] })).status, 409);
  assert.equal((await gigi('POST', 'monitors/actions', { ids: [shop.id], action: 'delete' })).status, 409);
  assert.equal((await gigi('POST', 'monitors/actions', { ids: [shop.id], action: 'pause' })).status, 200);
  assert.equal((await gigi('POST', 'monitors/actions', { ids: [shop.id], action: 'resume' })).status, 200);
  assert.equal((await gigi('POST', `monitors/${shop.id}/check`, {})).status, 200);
  const copy = (await gigi('POST', `monitors/${shop.id}/duplicate`, {})).data;
  assert.deepEqual([copy.managedBy ?? null, copy.codeId ?? null], [null, null], 'the copy is free');
  assert.equal((await gigi('PUT', `monitors/${copy.id}`, { ...copy, name: 'Copia libera' })).status, 200);
  assert.equal((await gigi('DELETE', `monitors/${copy.id}`)).status, 200);
  assert.equal((await gigi('DELETE', `maintenance/${(await gigi('GET', 'maintenance')).data[0].id}`)).status, 409);

  // a change in the file: a plan field by field, a deletion; pause is not configuration and survives
  await gigi('POST', 'monitors/actions', { ids: [shop.id], action: 'mute', value: 0 });
  const edited = FILE().replace('intervalMin: 5', 'intervalMin: 10').replace('  - id: api-ordini', '  - id: zzz-da-eliminare\n    type: http\n    name: Da eliminare\n    url: ' + siteUrl + '/x\n  - id: api-ordini').replace('expectedMin: 1440', 'expectedMin: 720').replace('durationMin: 60', 'durationMin: 90');
  r = await v1(write, 'POST', 'apply', { file: edited, dryRun: true });
  const upd = Object.fromEntries(r.data.plan.update.map((u) => [u.id, u.changes.map((c) => [c.field, c.from, c.to])]));
  assert.deepEqual(Object.keys(upd).sort(), ['backup', 'negozio']);
  assert.deepEqual(upd.negozio, [['intervalMin', 5, 10]], 'field by field, with the old and the new value');
  assert.deepEqual(upd.backup.find((c) => c[0] === 'expectedMin'), ['expectedMin', 1440, 720]);
  assert.deepEqual([r.data.plan.create.map((x) => x.id), r.data.plan.windows.update.map((x) => x.id)], [['zzz-da-eliminare'], ['notturna']]);
  const without = `version: 1
monitors:
  - id: negozio
    type: http
    name: Negozio
    url: ${siteUrl}/
    intervalMin: 10
    tags: [cliente:acme, prod]
    assertions:
      - { source: status, comparison: in, target: "200" }
      - { source: body, comparison: contains, target: Benvenuti }
    channels: [Slack ops]
  - id: zzz-da-eliminare
    type: http
    name: Da eliminare
    url: ${siteUrl}/x
  - id: backup
    type: heartbeat
    name: Backup notturno
    expectedMin: 720
maintenance:
  - id: notturna
    name: Aggiornamenti notturni
    type: weekly
    days: [0]
    time: "03:00"
    durationMin: 90
    monitors: [negozio]
`;
  r = await v1(write, 'POST', 'apply', { file: without });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.plan.delete.map((x) => x.id), ['api-ordini'], 'what the file no longer lists is deleted, only among the managed');
  const after = (await gigi('GET', 'monitors')).data;
  assert.deepEqual(after.map((m) => m.codeId).sort(), ['backup', 'negozio', 'zzz-da-eliminare']);
  const shopNow = (await gigi('GET', `monitors/${shop.id}`)).data;
  assert.deepEqual([shopNow.intervalMin, shopNow.muted, shopNow.id], [10, true, shop.id], 'the id and the silence stay');
  assert.equal((await gigi('GET', `monitors/${list.find((m) => m.codeId === 'backup').id}`)).data.hbToken, hbToken, 'the token of a heartbeat stays');
  // a free monitor is never touched by the file
  const free = (await gigi('POST', 'monitors', { name: 'Libero', url: `${siteUrl}/libero` })).data;
  r = await v1(write, 'POST', 'apply', { file: without });
  assert.equal(r.data.plan.delete.length, 0);
  assert.equal((await gigi('GET', `monitors/${free.id}`)).status, 200);

  // export closes the circle (RF-MAC-03): the file of what exists applies with no changes
  const exported = await gigi('GET', 'monitors/export');
  assert.equal(exported.status, 200);
  assert.match(exported.data, /^# sitescanner\.monitors\.yml/);
  assert.match(exported.data, /id: negozio/);
  assert.match(exported.data, /id: libero/, 'also the free ones, with an id made from the name');
  assert.equal(exported.data.includes('hbToken'), false);
  assert.equal(exported.data.includes('state:'), false);
  assert.match(exported.data, /channels:\n\s+- Slack ops/, 'channels by name');
  r = await v1(write, 'POST', 'apply', { file: exported.data, dryRun: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.plan.update.length, r.data.plan.delete.length], [0, 0], 'the export of the managed ones changes nothing');
  assert.equal(r.data.plan.create.map((x) => x.id).join(), 'libero', 'the free one would become managed');
  const viaToken = await v1(read, 'GET', `export?ids=${shop.id}`);
  assert.match(viaToken.data, /id: negozio/);
  assert.equal((await v1(read, 'GET', 'monitors')).data.length, 4);

  // test on a preview (RF-MAC-04): the addresses are moved, the history of the monitors is not touched
  hits.length = 0;
  const before = (await gigi('GET', 'monitors')).data.map((m) => m.state && m.state.lastCheckAt);
  r = await v1(write, 'POST', 'test', { file: without, baseUrl: siteUrl, branch: 'fix/carrello', commit: 'abc1234' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.ok, r.data.passed, r.data.failed, r.data.skipped], [true, 2, 0, 1], 'the heartbeat is skipped');
  assert.equal(r.data.results.find((x) => x.id === 'negozio').assertions.every((a) => a.ok), true);
  assert.ok(hits.includes('/'), 'the request went to the preview');
  assert.deepEqual((await gigi('GET', 'monitors')).data.map((m) => m.state && m.state.lastCheckAt), before, 'no run was stored');
  // a failing assertion: ok false
  const failing = without.replace('target: Benvenuti', 'target: Parola che non c\'è');
  r = await v1(write, 'POST', 'test', { file: failing, baseUrl: siteUrl, tags: ['cliente:acme'] });
  assert.deepEqual([r.data.ok, r.data.failed], [false, 1]);
  assert.match(r.data.results[0].message, /Parola «Parola che non c'è» non trovata/);
  assert.equal(r.data.results.length, 1, 'only the tag asked for');
  assert.equal((await v1(write, 'POST', 'test', { file: without, baseUrl: 'non un indirizzo' })).status, 400);
  assert.equal((await v1(write, 'POST', 'test', { file: without })).status, 400);
  // the history knows (RF-ALR-06)
  const hist = (await gigi('GET', 'history?type=ci')).data.days.flatMap((d) => d.events);
  assert.ok(hist.some((e) => e.type === 'ci-test' && e.branch === 'fix/carrello' && e.commit === 'abc1234' && e.failed === 0));
  assert.ok(hist.some((e) => e.type === 'ci-test' && e.failed === 1));
  assert.ok(hist.some((e) => e.type === 'ci-apply'));
  assert.ok((await gigi('GET', 'history?type=changes')).data.days.flatMap((d) => d.events).some((e) => /creato da codice/.test(e.action) && e.by === 'token «CI»'));
  // a revoked token, and a token of another workspace, open nothing
  assert.equal((await v1('sst_inesistente', 'GET', 'monitors')).status, 401);
  assert.equal((await v1(write, 'GET', 'tutt-altro')).status, 404);
  assert.equal((await v1(write, 'POST', 'apply', { file: 'x'.repeat(600000) })).status, 400, 'a file that is too big');
});

test('the command line: apply, test with an exit code for the CI, export (e2e)', async () => {
  const admin = client();
  await admin('POST', 'login', { username: 'admin', password: 'admin-definitiva-12' });
  await admin('POST', 'users', { username: 'hana', password: 'hana-temporanea-1' });
  const hana = client();
  await hana('POST', 'login', { username: 'hana', password: 'hana-temporanea-1' });
  await hana('PUT', 'me/password', { current: 'hana-temporanea-1', password: 'hana-definitiva-12' });
  const token = (await hana('POST', `workspaces/${(await hana('GET', 'workspaces')).data.workspaces[0].id}/tokens`, { name: 'GitHub', scope: 'write' })).data.token;
  const file = path.join(home, 'sitescanner.monitors.yml');
  const env = { SITESCANNER_URL: base, SITESCANNER_TOKEN: token };
  const simple = `version: 1\nmonitors:\n  - id: home\n    type: http\n    name: Home\n    url: ${siteUrl}/\n    assertions:\n      - { source: body, comparison: contains, target: Benvenuti }\n  - id: pagina\n    type: http\n    name: Pagina\n    url: ${siteUrl}/senza-parola\n`;
  fs.writeFileSync(file, simple);

  let r = await cli(['monitor', 'apply', '--dry-run'], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\+ home\s+crea «Home» \(http\)/);
  assert.match(r.stdout, /Piano \(nessuna modifica fatta\): 2 da creare, 0 da modificare, 0 da eliminare, 0 invariati/);
  assert.equal((await hana('GET', 'monitors')).data.length, 0);
  r = await cli(['monitor', 'apply', file], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Applicato: 2 da creare/);
  r = await cli(['monitor', 'apply'], env);
  assert.match(r.stdout, /Applicato: 0 da creare, 0 da modificare, 0 da eliminare, 2 invariati — niente da fare/, 'idempotent');
  // a test that passes (exit 0) and one that fails an assertion (exit 1, the CI stops)
  r = await cli(['monitor', 'test', '--base-url', siteUrl, '--tag', 'nessuno'], env);
  assert.equal(r.code, 0);
  fs.writeFileSync(file, simple.replace('Benvenuti', 'Parola assente'));
  r = await cli(['monitor', 'test', '--base-url', siteUrl, '--branch', 'main', '--commit', 'deadbeef'], env);
  assert.equal(r.code, 1, 'exit code 1 on a failed assertion');
  assert.match(r.stdout, /✖ Home/);
  assert.match(r.stdout, /Parola «Parola assente» non trovata/);
  assert.match(r.stdout, /✔ Pagina/);
  assert.match(r.stdout, /Falliti: 1 riusciti, 1 falliti|Falliti: 1 riuscit/);
  fs.writeFileSync(file, simple);
  r = await cli(['monitor', 'test', '--base-url', siteUrl], env);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Tutto a posto: 2 riusciti, 0 falliti/);
  // errors: a file with a problem says where; no service, no token, no file
  fs.writeFileSync(file, simple.replace('type: http\n    name: Home', 'type: http\n    colore: rosso\n    name: Home'));
  r = await cli(['monitor', 'apply'], env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /sitescanner\.monitors\.yml:5: monitors\[0\]\.colore: campo sconosciuto «colore»/);
  assert.match((await cli(['monitor', 'apply'], { SITESCANNER_URL: base })).stderr, /Manca il token API/);
  assert.match((await cli(['monitor', 'apply'], { SITESCANNER_TOKEN: token })).stderr, /Manca l'indirizzo del servizio/);
  assert.match((await cli(['monitor', 'apply', 'non-c-e.yml'], env)).stderr, /File non trovato/);
  assert.match((await cli(['monitor', 'test'], env)).stderr, /Serve l'indirizzo dell'anteprima/);
  assert.match((await cli(['monitor', 'apply'], { SITESCANNER_URL: 'http://127.0.0.1:1', SITESCANNER_TOKEN: token })).stderr, /non risponde/);
  assert.match((await cli(['monitor', 'apply'], { ...env, SITESCANNER_TOKEN: 'sst_sbagliato' })).stderr, /Token non valido o scaduto/);
  // export
  fs.writeFileSync(file, simple);
  r = await cli(['monitor', 'export'], env);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /id: home/);
  const out = path.join(home, 'esportato.yml');
  r = await cli(['monitor', 'export', '--out', out], env);
  assert.match(fs.readFileSync(out, 'utf8'), /id: pagina/);
  void siteMode;
});
