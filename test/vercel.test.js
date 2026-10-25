import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startFixture } from './fixture-server.js';
import { createVercelHandler } from '../src/vercel.js';
import { VercelBackend, pgliteDb, MemoryBlob } from '../src/storage/vercel/backend.js';

// The Vercel Function end to end (spec §11), with Postgres on PGlite and Blob in memory:
// accounts, areas, scans committed to Blob, jobs shared through the database, report, cron.

let fixture, backend, server, base;

before(async () => {
  fixture = await startFixture();
  const { PGlite } = await import('@electric-sql/pglite');
  backend = new VercelBackend({ db: pgliteDb(new PGlite()), blob: new MemoryBlob() });
  Object.assign(process.env, { SITESCANNER_ADMIN_USER: 'admin', SITESCANNER_ADMIN_PASSWORD: 'admin-iniziale-123', SITESCANNER_ALLOW_PRIVATE_NETWORKS: '1', CRON_SECRET: 'segreto-del-cron' });
  server = http.createServer(createVercelHandler({ backend }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await fixture.close();
  await backend.db.close();
  for (const k of ['SITESCANNER_ADMIN_USER', 'SITESCANNER_ADMIN_PASSWORD', 'SITESCANNER_ALLOW_PRIVATE_NETWORKS', 'CRON_SECRET']) delete process.env[k];
});

// Behind Vercel's proxy: HTTPS from the client's point of view.
function client() {
  let cookie = '';
  const req = async (method, p, body, headers = {}) => {
    const res = await fetch(`${base}${p}`, {
      method,
      redirect: 'manual',
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.7', ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data, headers: res.headers, setCookie: set };
  };
  return { req, api: (m, p, b, h) => req(m, `/api/${p}`, b, h) };
}

test('without configuration every request gets 503 with the missing variables (RF-VER-04)', async () => {
  const h = createVercelHandler({ env: {} });
  const s = http.createServer(h);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/`);
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.deepEqual(body.missing, ['DATABASE_URL', 'BLOB_READ_WRITE_TOKEN (o BLOB_STORE_ID con OIDC)']);
  } finally {
    await new Promise((r) => s.close(r));
  }
});

test('Vercel function: accounts on Postgres, scans on Blob, jobs shared, report, cron', async () => {
  const admin = client();
  let r = await admin.api('POST', 'login', { username: 'admin', password: 'admin-iniziale-123' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.setCookie, /^__Host-sitescanner_session=.*; Secure$/, 'HTTPS cookie with the __Host- prefix (RF-AUTH-04)');
  assert.equal((await admin.api('PUT', 'me/password', { current: 'admin-iniziale-123', password: 'admin-definitiva-1' })).status, 200);
  r = await admin.req('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('strict-transport-security'), /max-age/);

  r = await admin.api('GET', 'state');
  assert.equal(r.data.polling, true, 'job progress is polled on Vercel');
  const users = await backend.db.query('SELECT username, ip FROM users JOIN audit ON audit.actor = users.username WHERE action = $1', ['login']);
  assert.equal(users[0].ip, '203.0.113.7', 'client IP from the proxy');

  r = await admin.api('POST', 'sites', { id: 'demo', form: { name: 'Demo', envs: { local: { baseUrl: fixture.url } }, concurrency: 2, screenshots: { enabled: false } } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  r = await admin.api('POST', 'jobs', { type: 'scan', site: 'demo', env: 'local', label: 'v1' });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  let job;
  for (let i = 0; i < 300; i++) {
    job = (await admin.api('GET', `jobs/${r.data.id}`)).data;
    if (job.status !== 'running') break;
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.equal(job.status, 'done', job.error);
  const scanId = job.result.scanId;

  // what other function instances see: the job row and the committed scan
  const [row] = await backend.db.query('SELECT status, view FROM jobs WHERE id = $1', [job.id]);
  assert.equal(row.status, 'done');
  assert.equal(row.view.result.scanId, scanId);
  const area = (await backend.db.query('SELECT id FROM users WHERE username = $1', ['admin']))[0].id;
  assert.ok(await backend.blob.get(`u/${area}/demo/scans/${scanId}/scan.json`), 'snapshot on Blob, under the area of the user');
  assert.ok(await backend.blob.get(`u/${area}/demo/scans/${scanId}/text.json`));

  r = await admin.api('GET', 'sites/demo');
  assert.equal(r.data.history.length, 1);
  assert.equal((await admin.api('PUT', `sites/demo/scans/${scanId}`, { label: 'v1-bis' })).data.history[0].label, 'v1-bis');
  r = await admin.req('GET', '/report/data/index.js');
  assert.match(r.data, /"label":"v1-bis"/);
  assert.match(r.data, /"hasText":true/);
  r = await admin.req('GET', `/report/data/demo/${scanId}.js`);
  assert.equal(r.status, 200);
  assert.match(r.data, /^SS_LOAD\("scan"/);
  assert.equal((await admin.req('GET', `/files/demo/${scanId}/text.json`)).status, 200);

  // a second user, a separate area
  r = await admin.api('POST', 'users', { username: 'bea', password: 'bea-temporanea-1' });
  const bea = client();
  await bea.api('POST', 'login', { username: 'bea', password: 'bea-temporanea-1' });
  await bea.api('PUT', 'me/password', { current: 'bea-temporanea-1', password: 'bea-definitiva-12' });
  assert.deepEqual((await bea.api('GET', 'sites')).data, []);
  assert.equal((await bea.req('GET', `/files/demo/${scanId}/text.json`)).status, 404);
  assert.equal((await bea.api('GET', `jobs/${job.id}`)).status, 404);

  // inventory on Blob
  r = await admin.api('POST', 'jobs', { type: 'inventory', url: fixture.url });
  for (let i = 0; i < 300; i++) {
    job = (await admin.api('GET', `jobs/${r.data.id}`)).data;
    if (job.status !== 'running') break;
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.equal(job.status, 'done', job.error);
  const invId = job.result.inventoryId;
  assert.equal((await admin.api('GET', `inventories/${invId}`)).data.id, invId);
  assert.equal((await admin.api('DELETE', `inventories/${invId}`)).status, 200);

  // deleting the history removes rows and files
  r = await admin.api('DELETE', 'sites/demo?history=delete');
  assert.deepEqual(r.data, { ok: true, configDeleted: true, scansDeleted: 1 });
  assert.equal((await backend.blob.list(`u/${area}/`)).length, 0);

  // daily maintenance, only with the cron secret
  assert.equal((await admin.api('GET', 'cron/daily')).status, 401);
  r = await admin.api('GET', 'cron/daily', undefined, { authorization: 'Bearer segreto-del-cron' });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});
