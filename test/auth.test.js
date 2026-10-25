import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFixture } from './fixture-server.js';
import { serve } from '../src/server.js';
import { Auth, AUTH_LIMITS } from '../src/auth/index.js';
import { FsAuthStore } from '../src/auth/store-fs.js';
import { PgAuthStore } from '../src/auth/store-pg.js';
import { VercelBackend, pgliteDb, MemoryBlob } from '../src/storage/vercel/backend.js';
import { hashPassword, verifyPassword, needsRehash, passwordProblem, generatePassword } from '../src/auth/passwords.js';
import { isBlockedAddress } from '../src/net-guard.js';

const BIN = fileURLToPath(new URL('../bin/sitescanner.js', import.meta.url));
const ADMIN_PW = 'admin-iniziale-123';
let fixture, home, server, base;

before(async () => {
  fixture = await startFixture();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-auth-'));
  process.env.SITESCANNER_HOME = home;
  process.env.SITESCANNER_ADMIN_USER = 'admin';
  process.env.SITESCANNER_ADMIN_PASSWORD = ADMIN_PW;
  server = await serve({ port: 0, multi: true });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await fixture.close();
  for (const k of ['SITESCANNER_ADMIN_USER', 'SITESCANNER_ADMIN_PASSWORD', 'SITESCANNER_ALLOW_PRIVATE_NETWORKS', 'SITESCANNER_MAX_PAGES', 'SITESCANNER_MAX_JOBS_PER_USER']) delete process.env[k];
  fs.rmSync(home, { recursive: true, force: true });
});

/** A browser: keeps the session cookie, sends same-origin JSON. */
function client() {
  let cookie = '';
  const req = async (method, p, body, headers = {}) => {
    const res = await fetch(`${base}${p}`, {
      method,
      redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data, headers: res.headers };
  };
  return {
    req,
    api: (method, p, body, headers) => req(method, `/api/${p}`, body, headers),
    async login(username, password) {
      return req('POST', '/api/login', { username, password });
    },
    get cookie() { return cookie; },
  };
}

async function waitJob(c, id) {
  for (let i = 0; i < 300; i++) {
    const { data } = await c.api('GET', `jobs/${id}`);
    if (data.status !== 'running') return data;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`job ${id} ancora in corso`);
}

/** Logs in with a temporary password and replaces it. */
async function firstLogin(c, username, temp, final) {
  assert.equal((await c.login(username, temp)).status, 200);
  const r = await c.api('PUT', 'me/password', { current: temp, password: final });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}

test('passwords: scrypt hash, rehash, rules, generator', async () => {
  const h = await hashPassword('una frase abbastanza lunga');
  assert.match(h, /^scrypt\$32768\$8\$1\$/);
  assert.ok(await verifyPassword('una frase abbastanza lunga', h));
  assert.ok(!(await verifyPassword('una frase abbastanza lungA', h)));
  assert.ok(!(await verifyPassword('x', null)), 'a missing hash never matches');
  assert.ok(!needsRehash(h));
  assert.ok(needsRehash(await hashPassword('una frase abbastanza lunga', { N: 1024, r: 8, p: 1, keylen: 32 })));
  assert.match(passwordProblem('corta'), /almeno 12/);
  assert.match(passwordProblem('mario.rossi.1', 'Mario.Rossi.1'), /username/);
  assert.equal(passwordProblem('dodici-caratteri'), null);
  const g = generatePassword();
  assert.equal(g.length, 20);
  assert.match(g, /^[a-km-zA-HJ-NP-Z2-9]+$/, 'no look-alike characters');
});

test('network guard: private and metadata addresses are blocked (RF-SEC-01)', () => {
  for (const ip of ['127.0.0.1', '127.8.8.8', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', '::ffff:127.0.0.1', '::ffff:169.254.169.254', 'fe80::1', 'fd00::1', 'ff02::1']) {
    assert.ok(isBlockedAddress(ip), ip);
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700::1111', '::ffff:8.8.8.8']) assert.ok(!isBlockedAddress(ip), ip);
});

// The same rules on both stores of the accounts: files (local) and Postgres (Vercel, here on PGlite).
const AUTH_STORES = [
  { name: 'file', async make() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-authunit-')); return { store: new FsAuthStore(dir), close: async () => fs.rmSync(dir, { recursive: true, force: true }) }; } },
  { name: 'postgres', async make() { const { PGlite } = await import('@electric-sql/pglite'); const b = new VercelBackend({ db: pgliteDb(new PGlite()), blob: new MemoryBlob() }); return { store: new PgAuthStore(b), close: () => b.db.close() }; } },
];

for (const kind of AUTH_STORES) test(`auth rules [${kind.name}]: session expiry, IP limit, last admin`, async () => {
  const { store, close } = await kind.make();
  try {
    let now = Date.parse('2026-10-25T10:00:00Z');
    const auth = new Auth(store, { now: () => now });
    const { user } = await auth.createUser({ username: 'root', role: 'admin', password: 'password-di-root' });
    const { token } = await auth.login('ROOT', 'password-di-root', { ip: '1.2.3.4' });
    assert.equal((await auth.authenticate(token)).user.id, user.id, 'usernames are case-insensitive');
    now += AUTH_LIMITS.idleMs - 60000;
    assert.ok(await auth.authenticate(token), 'still valid just before the idle limit');
    now += AUTH_LIMITS.idleMs + 1;
    assert.equal(await auth.authenticate(token), null, 'expired after 7 days without activity');

    // 20 failures from one IP block every username from it
    for (let i = 0; i < AUTH_LIMITS.ipFailures; i++) await assert.rejects(auth.login(`nessuno${i}`, 'x', { ip: '9.9.9.9' }), { status: 401 });
    await assert.rejects(auth.login('root', 'password-di-root', { ip: '9.9.9.9' }), { status: 429 });
    assert.ok(await auth.login('root', 'password-di-root', { ip: '1.2.3.4' }), 'other IPs are not affected');
    now += AUTH_LIMITS.failWindowMs + 1;
    assert.ok(await auth.login('root', 'password-di-root', { ip: '9.9.9.9' }), 'unblocked after 15 minutes');

    await assert.rejects(auth.setUser('root', { role: 'user' }), { status: 409 });
    await assert.rejects(auth.setUser('root', { active: false }), { status: 409 });
    await assert.rejects(auth.deleteUser('root'), { status: 409 });
    await auth.createUser({ username: 'second', role: 'admin', password: 'password-second' });
    await auth.setUser('root', { role: 'user' });
    assert.equal((await auth.activeAdmins()).length, 1);
    await assert.rejects(auth.createUser({ username: 'Ab' }), /Username non valido/);
    await assert.rejects(auth.createUser({ username: 'second' }), /già usato/);
    // RF-AUTH-07: a password change closes the other sessions only
    const s1 = await auth.login('second', 'password-second', { ip: '1.2.3.4' });
    const s2 = await auth.login('second', 'password-second', { ip: '1.2.3.4' });
    const { tokenHash } = await import('../src/auth/passwords.js');
    await auth.changeOwnPassword(s1.user, 'password-second', 'password-nuova-2', { sessionHash: tokenHash(s1.token) });
    assert.ok(await auth.authenticate(s1.token));
    assert.equal(await auth.authenticate(s2.token), null);
    await auth.logout(s1.token);
    assert.equal(await auth.authenticate(s1.token), null);
    assert.ok((await auth.listAudit()).some((e) => e.action === 'password-changed'));
  } finally {
    await close();
  }
});

test('multi-user web app: login, temporary password, isolation, admin, limits', async () => {
  const anon = client();
  // RF-AUTH-01: nothing without a session, except the login page
  let r = await anon.req('GET', '/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/login?next=%2F');
  assert.equal((await anon.req('GET', '/login')).status, 200);
  assert.equal((await anon.req('GET', '/app/login.js')).status, 200);
  assert.equal((await anon.req('GET', '/app/app.js')).status, 401);
  assert.equal((await anon.api('GET', 'state')).status, 401);
  assert.equal((await anon.req('GET', '/report/data/index.js')).status, 401);
  r = await anon.req('GET', '/login');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await anon.api('GET', 'login')).data.needsSetup, false, 'the first admin comes from the environment');

  // RF-AUTH-02: same message whatever the cause
  r = await anon.login('admin', 'sbagliata-sbagliata');
  assert.equal(r.status, 401);
  assert.equal(r.data.error, 'Username o password non validi');
  assert.equal((await anon.login('nessuno', 'sbagliata-sbagliata')).data.error, 'Username o password non validi');
  assert.equal((await anon.req('POST', '/api/login', { username: 'admin', password: ADMIN_PW }, { origin: 'http://evil.example' })).status, 403, 'login is same-origin too');

  // RF-USR-05 / RF-USR-20: the bootstrap admin has a temporary password
  const admin = client();
  r = await admin.login('admin', ADMIN_PW);
  assert.equal(r.status, 200);
  assert.ok(r.data.user.mustChangePassword);
  assert.match(admin.cookie, /^sitescanner_session=/);
  r = await admin.api('GET', 'state');
  assert.equal(r.status, 403);
  assert.ok(r.data.mustChangePassword);
  assert.equal((await admin.api('PUT', 'me/password', { current: 'sbagliata-sbagliata', password: 'admin-definitiva-1' })).status, 400);
  assert.equal((await admin.api('PUT', 'me/password', { current: ADMIN_PW, password: 'corta' })).status, 400);
  assert.equal((await admin.api('PUT', 'me/password', { current: ADMIN_PW, password: 'admin-definitiva-1' })).status, 200);
  r = await admin.api('GET', 'state');
  assert.equal(r.status, 200);
  assert.equal(r.data.mode, 'multi');
  assert.equal(r.data.user.username, 'admin');
  assert.equal(r.data.root, null, 'no server paths in multi-user mode');

  // RF-ADM-01: accounts with a generated or given temporary password
  r = await admin.api('POST', 'users', { username: 'alice', name: 'Alice' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const alicePw = r.data.password;
  assert.equal(alicePw.length, 20);
  assert.equal((await admin.api('POST', 'users', { username: 'bob', password: 'bob-temporanea-1' })).data.password, null);
  assert.equal((await admin.api('POST', 'users', { username: 'alice' })).status, 400);
  assert.equal((await admin.api('POST', 'users', { username: 'x' })).status, 400);

  const alice = client();
  await firstLogin(alice, 'alice', alicePw, 'alice-definitiva-1');
  const bob = client();
  await firstLogin(bob, 'bob', 'bob-temporanea-1', 'bob-definitiva-12');

  // RF-SEC-02: no ${VAR} in private areas
  r = await alice.api('POST', 'sites', { id: 'demo', raw: 'envs:\n  local:\n    baseUrl: http://x.example/\n    auth: { username: u, password: "${DATABASE_URL}" }\n' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /variabili d'ambiente/);

  r = await alice.api('POST', 'sites', { id: 'demo', form: { name: 'Demo di Alice', envs: { local: { baseUrl: fixture.url } }, concurrency: 2, screenshots: { enabled: false } } });
  assert.equal(r.status, 201, JSON.stringify(r.data));

  // RF-SEC-01: the fixture is on 127.0.0.1, a private destination
  r = await alice.api('POST', 'jobs', { type: 'scan', site: 'demo', env: 'local' });
  let job = await waitJob(alice, r.data.id);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /destinazione non ammessa/);
  r = await alice.api('POST', 'jobs', { type: 'inventory', url: 'http://169.254.169.254/' });
  job = await waitJob(alice, r.data.id);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /destinazione non ammessa/);

  // allowed locally on request, with the server limits (RF-SEC-03)
  process.env.SITESCANNER_ALLOW_PRIVATE_NETWORKS = '1';
  process.env.SITESCANNER_MAX_PAGES = '4';
  r = await alice.api('POST', 'jobs', { type: 'scan', site: 'demo', env: 'local', label: 'v1' });
  job = await waitJob(alice, r.data.id);
  assert.equal(job.status, 'done', job.error);
  delete process.env.SITESCANNER_MAX_PAGES;
  const scanId = job.result.scanId;
  assert.ok(job.result.stats.pages <= 4);
  assert.ok(fs.existsSync(path.join(home, 'users', 'alice', 'data', 'demo', 'scans', scanId, 'scan.json')), 'stored in the area of the user');
  assert.ok(!fs.existsSync(path.join(home, 'data')), 'nothing in the single-user folder');

  // RF-ISO-04: the report is generated for the user, scan files under /files/
  r = await alice.req('GET', '/report/data/index.js');
  assert.equal(r.status, 200);
  assert.match(r.data, /"name":"Demo di Alice"/);
  assert.match(r.data, new RegExp(`"assets":"/files/demo/${scanId}/"`));
  assert.match(r.headers.get('cache-control'), /private/);
  assert.equal((await alice.req('GET', `/report/data/demo/${scanId}.js`)).status, 200);
  assert.equal((await alice.req('GET', `/report/data/demo/${scanId}.text.js`)).status, 200);
  assert.equal((await alice.req('GET', `/files/demo/${scanId}/text.json`)).status, 200);
  assert.equal((await alice.req('GET', `/files/demo/${scanId}/../../../auth/users.json`)).status, 404);
  assert.equal((await alice.req('GET', '/report/')).status, 200);

  // RF-ISO-02/03: another user sees nothing of it, not even that it exists
  assert.deepEqual((await bob.api('GET', 'sites')).data, []);
  assert.equal((await bob.api('GET', 'sites/demo')).status, 404);
  assert.equal((await bob.api('GET', `jobs/${job.id}`)).status, 404);
  assert.equal((await bob.api('POST', `jobs/${job.id}/cancel`, {})).status, 404);
  assert.equal((await bob.api('GET', 'jobs')).data.length, 0);
  assert.equal((await bob.req('GET', `/report/data/demo/${scanId}.js`)).status, 404);
  assert.equal((await bob.req('GET', `/files/demo/${scanId}/text.json`)).status, 404);
  assert.equal((await bob.api('GET', `pdf?site=demo&base=${scanId}`)).status, 400);
  assert.doesNotMatch((await bob.req('GET', '/report/data/index.js')).data, /demo/);
  assert.equal((await bob.api('POST', 'sites', { id: 'demo', form: { envs: { prod: { baseUrl: 'https://example.com/' } } } })).status, 201, 'same site id in another area');
  assert.equal((await admin.api('GET', 'sites/demo')).status, 404, 'the admin does not see the sites of other users');

  // RF-ISO-05: jobs per user
  process.env.SITESCANNER_MAX_JOBS_PER_USER = '1';
  fixture.setDelay(300);
  const running = await alice.api('POST', 'jobs', { type: 'inventory', site: 'demo', env: 'local' });
  r = await alice.api('POST', 'jobs', { type: 'inventory', url: fixture.url });
  assert.equal(r.status, 429);
  delete process.env.SITESCANNER_MAX_JOBS_PER_USER;

  // Administration
  assert.equal((await alice.api('GET', 'users')).status, 403);
  assert.equal((await alice.api('GET', 'audit')).status, 403);
  r = await admin.api('GET', 'users');
  const row = r.data.find((u) => u.username === 'alice');
  assert.deepEqual([row.sites, row.scans, row.runningJobs], [1, 1, 1]);
  assert.ok(!('passwordHash' in row));
  assert.equal((await admin.api('DELETE', 'users/alice')).status, 409, 'not while a job runs');
  await alice.api('POST', `jobs/${running.data.id}/cancel`, {});
  await waitJob(alice, running.data.id);
  fixture.setDelay(0);
  assert.equal((await admin.api('PUT', 'users/admin', { role: 'user' })).status, 409, 'RF-USR-07');
  assert.equal((await admin.api('PUT', 'users/admin', { active: false })).status, 409);
  assert.equal((await admin.api('DELETE', 'users/admin')).status, 409);

  // RF-ADM-02 / RF-AUTH-07: a reset closes the sessions of the user
  r = await admin.api('POST', 'users/alice/reset-password', {});
  assert.equal(r.status, 200);
  assert.equal((await alice.api('GET', 'state')).status, 401);
  const alice2 = client();
  assert.ok((await alice2.login('alice', r.data.password)).data.user.mustChangePassword);

  // RF-ADM-03: a disabled user cannot log in, with the usual message
  assert.equal((await admin.api('PUT', 'users/bob', { active: false })).status, 200);
  assert.equal((await bob.api('GET', 'state')).status, 401);
  assert.equal((await client().login('bob', 'bob-definitiva-12')).data.error, 'Username o password non validi');
  assert.equal((await admin.api('PUT', 'users/bob', { active: true })).status, 200);

  // RF-AUTH-03: 5 failures lock the username
  for (let i = 0; i < 5; i++) assert.equal((await anon.login('zeta', 'sbagliata-sbagliata')).status, 401);
  r = await anon.login('zeta', 'sbagliata-sbagliata');
  assert.equal(r.status, 429);
  assert.match(r.data.error, /15 minuti/);
  assert.equal((await client().login('bob', 'bob-definitiva-12')).status, 200, 'other usernames are not affected');

  // RF-ADM-05: deleting a user deletes the area
  r = await admin.api('DELETE', 'users/alice');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.sites, r.data.scans], [1, 1]);
  assert.ok(!fs.existsSync(path.join(home, 'users', 'alice')));
  assert.equal((await alice2.api('GET', 'me')).status, 401);

  // RF-ADM-06: access log
  const audit = (await admin.api('GET', 'audit')).data;
  for (const a of ['login', 'login-failed', 'login-blocked', 'user-created', 'password-reset', 'user-disabled', 'user-deleted', 'password-changed']) {
    assert.ok(audit.some((e) => e.action === a), a);
  }
  assert.ok(!JSON.stringify(audit).includes('bob-definitiva-12'), 'passwords are never logged');

  // RF-AUTH-06
  assert.equal((await admin.api('POST', 'logout', {})).status, 200);
  assert.equal((await admin.api('GET', 'state')).status, 401);
});

function run(...args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { cwd: home, env: { ...process.env, NO_COLOR: '1', SITESCANNER_PASSWORD: 'password-da-cli-1' } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

test('CLI: sitescanner user add, list, set, reset-password, import', async () => {
  let r = await run('user', 'add', 'carla', '--name', 'Carla');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Creato user carla/);
  assert.match((await run('user', 'list')).out, /carla\s+user\s+attivo/);
  assert.equal((await run('user', 'set', 'carla', '--active', 'forse')).code, 2);
  assert.match((await run('user', 'set', 'carla', '--role', 'admin')).out, /carla: admin, attivo/);
  assert.match((await run('user', 'reset-password', 'carla')).out, /reimpostata/);
  assert.equal((await run('user', 'add')).code, 2);
  assert.equal((await run('user', 'bogus')).code, 2);

  // a single-user folder with one site and one scan, imported into the area of carla
  const from = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-import-'));
  try {
    fs.mkdirSync(path.join(from, 'sites'));
    fs.writeFileSync(path.join(from, 'sites', 'demo.yml'), `name: Demo\nenvs:\n  local:\n    baseUrl: ${fixture.url}\nscreenshots: { enabled: false }\n`);
    const scan = spawn(process.execPath, [BIN, 'scan', '--site', 'demo', '--env', 'local', '--label', 'v1', '-q'], { cwd: from, env: { ...process.env, SITESCANNER_HOME: from } });
    assert.equal(await new Promise((res) => scan.on('close', res)), 0);
    r = await run('user', 'import', 'carla', '--from', from);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /1 siti, 1 scan/);
    const scans = fs.readdirSync(path.join(home, 'users', 'carla', 'data', 'demo', 'scans'));
    assert.equal(scans.length, 1);
    assert.match((await run('user', 'import', 'carla', '--from', from)).out, /saltato demo/);
  } finally {
    fs.rmSync(from, { recursive: true, force: true });
  }
});
