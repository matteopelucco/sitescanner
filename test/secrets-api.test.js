import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { FsMonitorStore } from '../src/monitor/store-fs.js';
import { PgMonitorStore } from '../src/monitor/store-pg.js';
import { VercelBackend, pgliteDb, MemoryBlob } from '../src/storage/vercel/backend.js';
import { normalizeMonitor, runRound, monitoringConfig, loadScope } from '../src/monitor/engine.js';
import { encrypt, secretsKeys } from '../src/monitor/secrets.js';
import { serve } from '../src/server.js';

// Variables, secrets and tags (spec §13.9): {{NAME}} in the monitors, masking in what is stored, «non configurato»,
// rotation of the key, the tag manager. A fixture site echoes what it receives, so that the secret really travels.

const MIN = 60000;
const T0 = Date.UTC(2026, 9, 1, 9, 0);
const TOKEN = 'tok-segretissimo-777';
const K1 = 'a'.repeat(64), K2 = 'b'.repeat(64);
let site, siteHost, siteMode = 'ok';

before(async () => {
  process.env.SITESCANNER_SECRETS_KEY = K1;
  process.env.SITESCANNER_ALLOW_PRIVATE_NETWORKS = '1';
  site = http.createServer((req, res) => {
    const token = req.headers['x-token'] || '';
    if (siteMode === 'bad') return res.writeHead(500, { 'x-echo': token }).end(`errore per ${token}`);
    res.writeHead(200, { 'content-type': 'text/plain', 'x-echo': token }).end(`ciao ${token} da ${req.headers.host}`);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteHost = `127.0.0.1:${site.address().port}`;
});
after(async () => {
  for (const k of ['SITESCANNER_SECRETS_KEY', 'SITESCANNER_SECRETS_KEY_OLD', 'SITESCANNER_ALLOW_PRIVATE_NETWORKS']) delete process.env[k];
  await new Promise((r) => site.close(r));
});

const STORES = [
  { name: 'file', async make() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-sec-')); return { store: new FsMonitorStore(dir), area: '', close: async () => fs.rmSync(dir, { recursive: true, force: true }) }; } },
  { name: 'postgres', async make() { const { PGlite } = await import('@electric-sql/pglite'); const b = new VercelBackend({ db: pgliteDb(new PGlite()), blob: new MemoryBlob() }); return { store: new PgMonitorStore(b), area: 'u1', close: () => b.db.close() }; } },
];

const config = () => ({ ...monitoringConfig(), retryMs: 0, spread: false, canaries: [], heartbeatUrl: null, tz: 'UTC' });
const everything = async (store, area, id) => JSON.stringify({
  checks: await store.listChecks(area, id, 0, Infinity), incidents: await store.listIncidents(area, {}), events: await store.listEvents(area, {}),
  details: await Promise.all((await store.listChecks(area, id, 0, Infinity)).filter((c) => c.hasDetail).map((c) => store.loadRunDetail(area, id, c.id))),
  monitor: await store.getMonitor(area, id),
});

for (const kind of STORES) {
  test(`{{NAME}} reaches the site, never what is stored; a missing name stops the monitor [${kind.name}] (RF-SEG-02/03)`, async () => {
    siteMode = 'ok';
    const { store, area, close } = await kind.make();
    try {
      await store.saveSecret(area, { name: 'SITE', kind: 'var', value: siteHost, updatedAt: T0 });
      await store.saveSecret(area, { name: 'API_TOKEN', kind: 'secret', enc: encrypt(TOKEN, 'API_TOKEN'), updatedAt: T0 });
      assert.equal(JSON.stringify(await store.listSecrets(area)).includes(TOKEN), false, 'the secret is encrypted at rest');
      assert.deepEqual(Object.keys(await loadScope(store, area)).sort(), ['API_TOKEN', 'SITE']);

      const m = normalizeMonitor({ url: 'http://{{SITE}}/stato', name: 'Con segreti', headers: { 'X-Token': '{{API_TOKEN}}' }, assertions: [{ source: 'body', comparison: 'contains', target: 'ciao {{API_TOKEN}}' }] });
      assert.equal(m.url, 'http://{{SITE}}/stato', 'the references stay as written');
      m.createdAt = T0 - 3600000;
      await store.saveMonitor(area, m);
      let clock = T0;
      const round = async (t) => { clock = t; await runRound({ store, now: () => clock, config: config(), notify: false }); };

      await round(T0);
      let [run] = await store.listChecks(area, m.id, 0, Infinity);
      assert.deepEqual([run.outcome, run.status], ['ok', 200], 'the site received the token and the host');
      const detail = await store.loadRunDetail(area, m.id, run.id);
      assert.equal(detail.headers['x-echo'], '••••', 'the value is masked in the stored headers (RF-SEG-02)');
      assert.match(detail.excerpt, /^ciao •••• da 127\.0\.0\.1:/, 'and in the stored body');
      assert.equal(detail.url, 'http://{{SITE}}/stato', 'the address shown is the one written, not the substituted one');
      assert.equal(detail.assertions[0].text.includes(TOKEN), false);

      // a failure whose message would contain the secret
      siteMode = 'bad';
      await store.saveMonitor(area, { ...(await store.getMonitor(area, m.id)), assertions: [{ source: 'body', comparison: 'contains', target: 'mai {{API_TOKEN}}' }] });
      await round(T0 + 5 * MIN);
      const failed = (await store.listChecks(area, m.id, 0, Infinity)).at(-1);
      assert.equal(failed.outcome, 'error');
      assert.match(failed.error, /Parola «mai ••••» non trovata|Status 500/);
      assert.equal((await everything(store, area, m.id)).includes(TOKEN), false, 'no value in checks, incidents, events, run details or the monitor');
      siteMode = 'ok';

      // the variable of the monitor wins over the workspace one (RF-SEG-03)
      const fresh = await store.getMonitor(area, m.id);
      Object.assign(fresh, { vars: { SITE: siteHost }, assertions: [{ source: 'status', comparison: 'in', target: '200' }] });
      await store.saveMonitor(area, fresh);
      await store.saveSecret(area, { name: 'SITE', kind: 'var', value: '127.0.0.1:1', updatedAt: T0 }); // broken in the workspace
      await round(T0 + 10 * MIN);
      assert.equal((await store.listChecks(area, m.id, 0, Infinity)).at(-1).outcome, 'ok', 'the monitor used its own value');

      // a name nobody defined: no run, «non configurato», one event
      await store.deleteSecret(area, 'API_TOKEN');
      const n = (await store.listChecks(area, m.id, 0, Infinity)).length;
      await round(T0 + 15 * MIN);
      await round(T0 + 20 * MIN);
      assert.equal((await store.listChecks(area, m.id, 0, Infinity)).length, n, 'no run');
      const stopped = await store.getMonitor(area, m.id);
      assert.deepEqual(stopped.state.unconfigured, ['API_TOKEN']);
      assert.equal((await store.listEvents(area, {})).filter((e) => e.type === 'monitor-unconfigured').length, 1, 'said once');
      // defined again: it runs
      await store.saveSecret(area, { name: 'API_TOKEN', kind: 'secret', enc: encrypt(TOKEN, 'API_TOKEN'), updatedAt: T0 });
      await round(T0 + 25 * MIN);
      assert.equal((await store.listChecks(area, m.id, 0, Infinity)).length, n + 1);
      assert.equal((await store.getMonitor(area, m.id)).state.unconfigured, null);
      // a secret that cannot be read (the key is gone) counts as missing, it does not crash the round
      await store.saveSecret(area, { name: 'API_TOKEN', kind: 'secret', enc: encrypt(TOKEN, 'API_TOKEN', secretsKeys({ SITESCANNER_SECRETS_KEY: K2 })), updatedAt: T0 });
      await round(T0 + 30 * MIN);
      assert.deepEqual((await store.getMonitor(area, m.id)).state.unconfigured, ['API_TOKEN']);
    } finally { await close(); }
  });
}

test('validation of monitors with references', () => {
  assert.equal(normalizeMonitor({ url: 'https://{{HOST}}/api?k={{KEY}}' }).url, 'https://{{HOST}}/api?k={{KEY}}');
  assert.equal(normalizeMonitor({ url: 'https://www.esempio.it' }).url, 'https://www.esempio.it/', 'without references: normalized as before');
  assert.throws(() => normalizeMonitor({ url: 'boh {{X}}' }), /URL non valido/);
  assert.equal(normalizeMonitor({ url: 'https://a.it/', type: 'api', method: 'POST', bodyType: 'json', body: '{"n": {{N}}, "s": "{{S}}"}' }).bodyType, 'json');
  assert.throws(() => normalizeMonitor({ url: 'https://a.it/', type: 'api', method: 'POST', bodyType: 'json', body: '{"n": }' }), /JSON non è valido/);
  const m = normalizeMonitor({ url: 'https://a.it/', vars: { host: 'x.it' } });
  assert.deepEqual(m.vars, { HOST: 'x.it' });
  assert.throws(() => normalizeMonitor({ url: 'https://a.it/', vars: { 'con spazio': '1' } }), /Nome di variabile non valido/);
  assert.throws(() => normalizeMonitor({ url: 'https://a.it/', vars: { A: 'x'.repeat(2000) } }), /troppo lunga/);
});

// ---------------- API ----------------

let home, server, base, fake;
const slack = [];

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-secapi-'));
  Object.assign(process.env, { SITESCANNER_HOME: home, SITESCANNER_ADMIN_USER: 'admin', SITESCANNER_ADMIN_PASSWORD: 'admin-iniziale-123', SITESCANNER_MONITOR_DEV: '1', SITESCANNER_MON_RETRY_MS: '10' });
  server = await serve({ port: 0, multi: true });
  base = `http://127.0.0.1:${server.address().port}`;
  fake = null;
  void fake; void slack;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  for (const k of ['SITESCANNER_ADMIN_USER', 'SITESCANNER_ADMIN_PASSWORD', 'SITESCANNER_MONITOR_DEV', 'SITESCANNER_MON_RETRY_MS']) delete process.env[k];
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

async function login(admin, name) {
  const c = client();
  await admin('POST', 'users', { username: name, password: `${name}-temporanea-1` });
  await c('POST', 'login', { username: name, password: `${name}-temporanea-1` });
  await c('PUT', 'me/password', { current: `${name}-temporanea-1`, password: `${name}-definitiva-12` });
  return c;
}

test('API: variables and secrets, monitors that use them, rotation of the key, the log (RF-SEG-01..04)', async () => {
  siteMode = 'ok';
  const admin = client();
  await admin('POST', 'login', { username: 'admin', password: 'admin-iniziale-123' });
  await admin('PUT', 'me/password', { current: 'admin-iniziale-123', password: 'admin-definitiva-12' });
  const ugo = await login(admin, 'ugo');
  const vera = await login(admin, 'vera');

  let r = await ugo('GET', 'secrets');
  assert.deepEqual([r.data.available, r.data.items, r.data.missing], [true, [], []]);
  // writing: names and values are validated, a secret needs the key of the deploy
  assert.equal((await ugo('PUT', 'secrets/con%20spazio', { kind: 'var', value: 'x' })).status, 400);
  assert.equal((await ugo('PUT', 'secrets/CORTO', { kind: 'secret', value: 'abc' })).status, 400);
  assert.equal((await ugo('PUT', 'secrets/VUOTO', { kind: 'var', value: '' })).status, 400);
  assert.equal((await ugo('PUT', 'secrets/GRANDE', { kind: 'var', value: 'x'.repeat(5000) })).status, 400);
  r = await ugo('PUT', 'secrets/site', { kind: 'var', value: siteHost });
  assert.deepEqual([r.status, r.data.name], [201, 'SITE']);
  r = await ugo('PUT', 'secrets/API_TOKEN', { kind: 'secret', value: TOKEN });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(JSON.stringify(r.data).includes(TOKEN), false, 'the answer does not repeat it');
  assert.equal((await ugo('PUT', 'secrets/SITE', { kind: 'var', value: siteHost })).status, 200, 'an update');

  // a monitor that uses them, created with a first check
  r = await ugo('POST', 'monitors', { name: 'Con segreti', url: 'http://{{SITE}}/', headers: { 'X-Token': '{{API_TOKEN}}' }, tags: ['cliente:acme'], assertions: [{ source: 'body', comparison: 'contains', target: 'ciao {{API_TOKEN}}' }] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const mon = r.data;
  assert.equal(mon.status, 'up', 'the first check read the values');
  // nothing the API says contains the value: not the secrets, not the monitor, not the runs, not the list
  const seen = [];
  seen.push((await ugo('GET', 'secrets')).data, (await ugo('GET', `monitors/${mon.id}`)).data, (await ugo('GET', 'monitors')).data, (await ugo('GET', 'monitor-list')).data, (await ugo('GET', 'monitoring')).data,
    (await ugo('GET', `monitors/${mon.id}/runs`)).data, (await ugo('GET', `monitors/${mon.id}/analysis`)).data, (await ugo('GET', 'history')).data, (await ugo('GET', 'secrets/log')).data);
  const run = (await ugo('GET', `monitors/${mon.id}/runs`)).data.runs[0];
  seen.push((await ugo('GET', `monitors/${mon.id}/runs/${run.id}`)).data);
  for (const x of seen) assert.equal(JSON.stringify(x).includes(TOKEN), false);
  assert.equal((await ugo('GET', `monitors/${mon.id}/runs/${run.id}`)).data.detail.headers['x-echo'], '••••');
  // the test run of the form is masked too, and refuses a name that does not exist
  r = await ugo('POST', 'monitors/test', { url: 'http://{{SITE}}/', headers: { 'X-Token': '{{API_TOKEN}}' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(JSON.stringify(r.data).includes(TOKEN), false);
  assert.match(r.data.excerpt, /^ciao ••••/);
  r = await ugo('POST', 'monitors/test', { url: 'http://{{SITE}}/', headers: { 'X-Token': '{{MANCA}}' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Manca la variabile MANCA/);

  // the list of variables: values of the variables, not of the secrets; who uses what; what is missing
  r = await ugo('GET', 'secrets');
  assert.deepEqual(r.data.items.map((s) => [s.name, s.kind, s.value, s.usedBy.map((u) => u.name)]), [['API_TOKEN', 'secret', null, ['Con segreti']], ['SITE', 'var', siteHost, ['Con segreti']]]);
  assert.equal(r.data.items[0].current, true);
  r = await ugo('POST', 'monitors', { name: 'Senza variabile', url: 'http://{{SITE}}/{{PERCORSO}}' });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'unconfigured', 'no run, and the list says so (RF-SEG-03)');
  assert.deepEqual((await ugo('GET', 'secrets')).data.missing.map((x) => [x.name, x.usedBy[0].name]), [['PERCORSO', 'Senza variabile']]);
  assert.equal((await ugo('GET', 'monitor-list?q=stato:nonconfigurato')).data.total, 1);
  await ugo('PUT', 'secrets/PERCORSO', { kind: 'var', value: 'pagina' });
  await ugo('POST', `monitors/${(await ugo('GET', 'monitors')).data.find((x) => x.name === 'Senza variabile').id}/check`, {});
  assert.equal((await ugo('GET', 'monitor-list')).data.rows.find((x) => x.name === 'Senza variabile').status, 'up');

  // rotation: a new key, the old one kept for reading
  process.env.SITESCANNER_SECRETS_KEY = K2;
  process.env.SITESCANNER_SECRETS_KEY_OLD = K1;
  assert.equal((await ugo('GET', 'secrets')).data.items.find((s) => s.name === 'API_TOKEN').current, false);
  await ugo('POST', `monitors/${mon.id}/check`, {});
  assert.equal((await ugo('GET', 'monitor-list?q=con')).data.rows[0].status, 'up', 'the old key still reads it');
  r = await ugo('POST', 'secrets/rotate', {});
  assert.deepEqual([r.status, r.data.rotated], [200, 1]);
  assert.equal((await ugo('GET', 'secrets')).data.items.find((s) => s.name === 'API_TOKEN').current, true);
  delete process.env.SITESCANNER_SECRETS_KEY_OLD;
  await ugo('POST', `monitors/${mon.id}/check`, {});
  assert.equal((await ugo('GET', 'monitor-list?q=con')).data.rows[0].status, 'up', 'it works without the old key once re-encrypted');
  assert.equal((await ugo('POST', 'secrets/rotate', {})).data.rotated, 0, 'nothing left to do');
  // without a key of the deploy the variables work, the secrets do not
  delete process.env.SITESCANNER_SECRETS_KEY;
  assert.equal((await ugo('GET', 'secrets')).data.available, false);
  assert.equal((await ugo('PUT', 'secrets/ALTRO', { kind: 'secret', value: 'valore-lungo' })).status, 400);
  assert.equal((await ugo('PUT', 'secrets/ALTRA_VAR', { kind: 'var', value: 'ok' })).status, 201);
  process.env.SITESCANNER_SECRETS_KEY = K2;

  // the log: who, when, what; never the values
  r = await ugo('GET', 'secrets/log');
  assert.ok(r.data.length >= 5);
  assert.deepEqual(r.data.slice(0, 1).map((x) => [x.by, x.action, x.name]), [['ugo', 'creata', 'ALTRA_VAR']]);
  assert.ok(r.data.some((x) => x.action === 'modificata' && x.name === 'SITE'));
  assert.ok(r.data.some((x) => /chiave ruotata \(1 segreti\)/.test(x.action)));
  assert.equal(JSON.stringify(r.data).includes(TOKEN), false);
  // deleting
  assert.equal((await ugo('DELETE', 'secrets/ALTRA_VAR')).status, 200);
  assert.equal((await ugo('DELETE', 'secrets/ALTRA_VAR')).status, 404);
  assert.equal((await ugo('GET', 'secrets/log')).data[0].action, 'eliminata');

  // another user has her own variables
  assert.deepEqual((await vera('GET', 'secrets')).data.items, []);
  assert.equal((await vera('DELETE', 'secrets/SITE')).status, 404);
});

test('API: tag manager, rename and merge reach monitors, maintenance and channels (RF-TAG-01)', async () => {
  const admin = client();
  await admin('POST', 'login', { username: 'admin', password: 'admin-definitiva-12' });
  const tina = await login(admin, 'tina');
  const add = async (name, tags) => (await tina('POST', 'monitors', { name, url: `http://${siteHost}/${name}`, tags })).data;
  const a = await add('uno', ['cliente:acme', 'Prod']);
  const b = await add('due', ['cliente-acme', 'prod']);
  await add('tre', ['cliente:zeta']);
  await tina('POST', 'maintenance', { name: 'Finestra', type: 'once', start: Date.now() + 3600000, durationMin: 30, tags: ['cliente-acme'], monitorIds: [] });
  await tina('POST', 'channels', { type: 'slack', name: 'Hook', webhookUrl: 'http://127.0.0.1:9/slack/x', tags: ['cliente-acme'] }).catch(() => {});

  let r = await tina('GET', 'tags');
  assert.deepEqual(r.data.tags.map((t) => [t.tag, t.monitors, t.windows, t.namespace]), [['cliente-acme', 1, 1, null], ['cliente:acme', 1, 0, 'cliente'], ['cliente:zeta', 1, 0, 'cliente'], ['prod', 2, 0, null]]);
  assert.deepEqual(r.data.namespaces, ['cliente']);
  // details: description and colour
  assert.equal((await tina('PUT', 'tags/cliente%3Aacme', { description: 'Acme Srl, contratto premium', color: 'rosso' })).status, 400);
  r = await tina('PUT', 'tags/cliente%3Aacme', { description: 'Acme Srl, contratto premium', color: '#2e7d32' });
  assert.equal(r.status, 200);
  assert.deepEqual((await tina('GET', 'tags')).data.tags.find((t) => t.tag === 'cliente:acme').color, '#2e7d32');

  // the duplicate «cliente-acme» is merged into the right one: monitors, windows and subscriptions follow
  r = await tina('POST', 'tags/merge', { from: ['cliente-acme'], to: 'Cliente:Acme' });
  assert.deepEqual([r.status, r.data.to, r.data.monitors, r.data.windows], [200, 'cliente:acme', 1, 1]);
  const tags = (await tina('GET', 'tags')).data.tags;
  assert.deepEqual(tags.map((t) => [t.tag, t.monitors, t.windows]), [['cliente:acme', 2, 1], ['cliente:zeta', 1, 0], ['prod', 2, 0]]);
  assert.equal(tags[0].description, 'Acme Srl, contratto premium', 'the details stay with the target');
  assert.deepEqual((await tina('GET', `monitors/${b.id}`)).data.tags, ['cliente:acme', 'prod']);
  assert.deepEqual((await tina('GET', 'maintenance')).data[0].tags, ['cliente:acme']);
  // rename: details move, history keeps track
  r = await tina('POST', 'tags/rename', { from: 'prod', to: 'ambiente:prod' });
  assert.equal(r.data.monitors, 2);
  assert.deepEqual((await tina('GET', `monitors/${a.id}`)).data.tags, ['cliente:acme', 'ambiente:prod']);
  assert.deepEqual((await tina('GET', 'tags')).data.namespaces, ['ambiente', 'cliente']);
  assert.ok((await tina('GET', 'history?type=changes')).data.days.flatMap((d) => d.events).some((e) => /tag «prod» → «ambiente:prod»/.test(e.action)));
  assert.equal((await tina('GET', 'monitor-list?q=tag:ambiente')).data.total, 2, 'a namespace finds its tags');
  // errors
  assert.equal((await tina('POST', 'tags/rename', { from: 'prod', to: '' })).status, 400);
  assert.equal((await tina('POST', 'tags/rename', { from: '', to: 'x' })).status, 400);
  assert.equal((await tina('POST', 'tags/rename', { from: 'x', to: 'x' })).status, 400);
  assert.equal((await tina('POST', 'tags/merge', { from: [], to: 'x' })).status, 400);
  const other = await login(admin, 'ugo2');
  assert.deepEqual((await other('GET', 'tags')).data.tags, []);
});
