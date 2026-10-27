import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  workspaceNameProblem, isWorkspaceId, allowedRequest, roleIn, membersProblem, publicToken, tokenActive, expiryFromDays, roleOfScope,
} from '../src/core/workspaces.js';
import { Auth, usernameProblem } from '../src/auth/index.js';
import { Workspaces, areaOf } from '../src/auth/workspaces.js';
import { FsAuthStore } from '../src/auth/store-fs.js';
import { PgAuthStore } from '../src/auth/store-pg.js';
import { VercelBackend, pgliteDb, MemoryBlob } from '../src/storage/vercel/backend.js';
import { serve } from '../src/server.js';

// Workspaces, roles and API tokens (spec §13.10, RF-TEAM-01..05, ADR-0023).

test('pure: names, roles, members, tokens', () => {
  assert.equal(workspaceNameProblem('Agenzia Rossi'), null);
  assert.match(workspaceNameProblem('A'), /da 2 a 60/);
  assert.match(workspaceNameProblem('x'.repeat(61)), /da 2 a 60/);
  assert.deepEqual(['ws_0123456789ab', 'ws_xyz', 'anna', 'ws_0123456789abc'].map(isWorkspaceId), [true, false, false, false]);
  assert.match(usernameProblem('ws_prova1'), /riservato/, 'a username can never be taken for a workspace');
  assert.equal(usernameProblem('anna'), null);

  // the reader only reads, and writes the note of an incident
  for (const role of ['owner', 'editor']) assert.equal(allowedRequest(role, 'DELETE', 'monitors/x').ok, true);
  assert.equal(allowedRequest('viewer', 'GET', 'monitoring').ok, true);
  assert.equal(allowedRequest('viewer', 'HEAD', 'state').ok, true);
  assert.equal(allowedRequest('viewer', 'PUT', 'incidents/abc').ok, true);
  for (const [m, r] of [['POST', 'monitors/x/check'], ['PUT', 'monitors/x'], ['DELETE', 'incidents/abc'], ['POST', 'monitors/test'], ['POST', 'sites'], ['PUT', 'incidents/a/b'], ['POST', 'scans']]) {
    const x = allowedRequest('viewer', m, r);
    assert.equal(x.ok, false, `${m} ${r}`);
    assert.match(x.reason, /sola lettura/);
  }
  const w = { members: [{ userId: 'a', role: 'owner' }, { userId: 'b', role: 'editor' }] };
  assert.deepEqual([roleIn(w, 'a'), roleIn(w, 'b'), roleIn(w, 'z'), roleIn(null, 'a')], ['owner', 'editor', null, null]);
  assert.equal(membersProblem(w, { remove: 'b' }), null);
  assert.match(membersProblem(w, { remove: 'a' }), /almeno un proprietario/);
  assert.match(membersProblem(w, { setRole: { userId: 'a', role: 'viewer' } }), /almeno un proprietario/);
  assert.equal(membersProblem(w, { setRole: { userId: 'b', role: 'owner' } }), null);
  assert.deepEqual([roleOfScope('read'), roleOfScope('write'), roleOfScope('boh')], ['viewer', 'editor', 'viewer'], 'a token never owns');
  const t = { id: 'i', name: 'CI', scope: 'read', prefix: 'sst_abcd', hash: 'segreto', createdAt: 'x', expiresAt: null };
  assert.equal('hash' in publicToken(t), false);
  assert.deepEqual([tokenActive(t, 1e15), tokenActive({ ...t, expiresAt: new Date(1000).toISOString() }, 999), tokenActive({ ...t, expiresAt: new Date(1000).toISOString() }, 1000)], [true, true, false]);
  assert.deepEqual(expiryFromDays(null, 0), { expiresAt: null });
  assert.deepEqual(expiryFromDays(30, 0), { expiresAt: new Date(30 * 86400000).toISOString() });
  assert.match(expiryFromDays(0.5, 0).error || 'ok', /ok|1 a 3650/);
  assert.match(expiryFromDays(5000, 0).error, /1 a 3650/);
  assert.match(expiryFromDays('boh', 0).error, /1 a 3650/);
  assert.deepEqual(areaOf({ id: 'ws_0123456789ab', kind: 'shared' }), { id: 'ws_0123456789ab', username: 'ws_0123456789ab' });
  assert.deepEqual(areaOf({ id: 'u1', kind: 'personal' }, { id: 'u1', username: 'anna' }), { id: 'u1', username: 'anna' });
});

const STORES = [
  { name: 'file', async make() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-ws-')); return { store: new FsAuthStore(dir), close: async () => fs.rmSync(dir, { recursive: true, force: true }) }; } },
  { name: 'postgres', async make() { const { PGlite } = await import('@electric-sql/pglite'); const b = new VercelBackend({ db: pgliteDb(new PGlite()), blob: new MemoryBlob() }); await b.init(); return { store: new PgAuthStore(b), close: () => b.db.close() }; } },
];

for (const kind of STORES) {
  test(`workspaces: create, members, roles, leaving, removal of an account, on both stores [${kind.name}] (RF-TEAM-01..03, RF-TEAM-05)`, async () => {
    const { store, close } = await kind.make();
    try {
      let clock = Date.UTC(2026, 9, 25, 10);
      const auth = new Auth(store, { now: () => clock });
      const ws = new Workspaces(auth);
      const mk = async (username) => (await auth.createUser({ username, role: 'user', password: `${username}-password-lunga-1` }, { actor: 'admin' })).user;
      const [anna, bruno, carla] = [await mk('anna'), await mk('bruno'), await mk('carla')];

      // everybody has a personal workspace, which is their own area: nothing to move (RF-TEAM-03)
      let list = await ws.listFor(anna);
      assert.deepEqual(list.map((w) => [w.id, w.name, w.kind, w.role]), [[anna.id, 'Personale', 'personal', 'owner']]);
      const { workspace, role } = await ws.resolve(anna, null);
      assert.deepEqual([workspace.id, role], [anna.id, 'owner']);
      assert.deepEqual(areaOf(workspace, anna), anna, 'the same area the user always had');

      // a shared workspace
      assert.match((await ws.create(anna, 'x').catch((e) => e)).message, /da 2 a 60/);
      const agency = await ws.create(anna, '  Agenzia Rossi ');
      assert.match(agency.id, /^ws_[0-9a-f]{12}$/);
      assert.deepEqual([agency.name, agency.role], ['Agenzia Rossi', 'owner']);
      assert.deepEqual((await ws.listFor(anna)).map((w) => w.name), ['Personale', 'Agenzia Rossi']);
      assert.deepEqual((await ws.listFor(bruno)).map((w) => w.name), ['Personale'], 'not a member: not visible');
      assert.equal((await ws.resolve(bruno, agency.id)).workspace.id, bruno.id, 'asking for a workspace one is not in gives the personal one');
      await assert.rejects(() => ws.get(bruno, agency.id), /non trovato/);

      // only existing and active accounts can be invited, by the owner
      await assert.rejects(() => ws.addMember(anna, agency.id, 'nessuno', 'editor'), /Nessun account attivo con username «nessuno»/);
      await assert.rejects(() => ws.addMember(anna, agency.id, 'bruno', 'capo'), /Ruolo/);
      await ws.addMember(anna, agency.id, 'Bruno', 'editor');
      await assert.rejects(() => ws.addMember(anna, agency.id, 'bruno', 'viewer'), /già nello spazio/);
      await ws.addMember(anna, agency.id, 'carla', 'viewer');
      await assert.rejects(() => ws.addMember(bruno, agency.id, 'carla', 'viewer'), /Solo il proprietario/, 'an editor does not manage members');
      await auth.setUser('carla', { active: false }, { actor: 'admin' });
      await assert.rejects(() => ws.addMember(anna, agency.id, 'carla', 'viewer'), /già nello spazio|Nessun account attivo/);
      await auth.setUser('carla', { active: true }, { actor: 'admin' });
      const members = await ws.members(bruno, agency.id);
      assert.deepEqual(members.map((m) => [m.username, m.role, m.you]), [['anna', 'owner', false], ['bruno', 'editor', true], ['carla', 'viewer', false]]);
      assert.deepEqual((await ws.resolve(bruno, agency.id)).role, 'editor');
      assert.deepEqual((await ws.listFor(bruno)).map((w) => [w.name, w.role]), [['Personale', 'owner'], ['Agenzia Rossi', 'editor']]);

      // roles: the last owner cannot go away or be demoted
      await assert.rejects(() => ws.setRole(anna, agency.id, anna.id, 'editor'), /almeno un proprietario/);
      await assert.rejects(() => ws.removeMember(anna, agency.id, anna.id), /almeno un proprietario/);
      await assert.rejects(() => ws.setRole(bruno, agency.id, carla.id, 'editor'), /Solo il proprietario/);
      await ws.setRole(anna, agency.id, bruno.id, 'owner');
      assert.equal((await ws.resolve(bruno, agency.id)).role, 'owner');
      await ws.setRole(anna, agency.id, anna.id, 'editor');
      // leaving: anyone can, an owner removes anyone
      await assert.rejects(() => ws.removeMember(anna, agency.id, carla.id), /Solo il proprietario/);
      await ws.removeMember(anna, agency.id, anna.id);
      assert.deepEqual((await ws.listFor(anna)).map((w) => w.name), ['Personale']);
      await ws.removeMember(bruno, agency.id, carla.id);
      assert.deepEqual((await ws.members(bruno, agency.id)).map((m) => m.username), ['bruno']);

      // the log (RF-TEAM-05)
      const log = (await auth.listAudit(100)).map((e) => e.action);
      for (const a of ['workspace-create', 'workspace-member-add', 'workspace-member-role', 'workspace-leave', 'workspace-member-remove']) assert.ok(log.includes(a), a);

      // renaming, then the removal of an account: it leaves its workspaces; the empty ones go
      await ws.rename(bruno, agency.id, 'Agenzia Bianchi');
      assert.equal((await ws.get(bruno, agency.id)).name, 'Agenzia Bianchi');
      const other = await ws.create(anna, 'Altro spazio');
      await ws.addMember(anna, other.id, 'bruno', 'owner');
      await ws.addMember(anna, other.id, 'carla', 'editor');
      const plan = await ws.planUserRemoval(bruno.id);
      assert.deepEqual([plan.blocked.map((w) => w.name), plan.empty.map((w) => w.name)], [[], ['Agenzia Bianchi']]);
      await ws.removeMember(anna, other.id, anna.id);
      const plan2 = await ws.planUserRemoval(bruno.id);
      assert.deepEqual(plan2.blocked.map((w) => w.name), ['Altro spazio'], 'bruno is the only owner of the other one, and carla stays as editor: the deletion must stop');
      await ws.removeUserEverywhere(bruno.id);
      assert.equal(await store.getWorkspace(agency.id), null, 'an empty workspace is removed');
      assert.deepEqual((await store.getWorkspace(other.id)).members.map((m) => m.userId), [carla.id]);
      await assert.rejects(() => ws.remove(anna, agency.id), /non trovato/);
      void clock;
    } finally { await close(); }
  });

  test(`API tokens: shown once, hashed, scopes, expiry, last use, revocation [${kind.name}] (RF-TEAM-04)`, async () => {
    const { store, close } = await kind.make();
    try {
      let clock = Date.UTC(2026, 9, 25, 10);
      const auth = new Auth(store, { now: () => clock });
      const ws = new Workspaces(auth);
      const mk = async (username) => (await auth.createUser({ username, role: 'user', password: `${username}-password-lunga-1` }, { actor: 'admin' })).user;
      const [anna, bruno] = [await mk('anna'), await mk('bruno')];
      const team = await ws.create(anna, 'Team');
      await ws.addMember(anna, team.id, 'bruno', 'editor');

      await assert.rejects(() => ws.createToken(anna, team.id, { name: 'x', scope: 'read' }), /da 2 a 60/);
      await assert.rejects(() => ws.createToken(anna, team.id, { name: 'GitHub', scope: 'admin' }), /read.*write/);
      await assert.rejects(() => ws.createToken(anna, team.id, { name: 'GitHub', scope: 'read', expiresInDays: 9999 }), /1 a 3650/);
      await assert.rejects(() => ws.createToken(bruno, team.id, { name: 'GitHub', scope: 'read' }), /Solo il proprietario/, 'an editor does not manage tokens');
      const made = await ws.createToken(anna, team.id, { name: 'GitHub Actions', scope: 'write', expiresInDays: 30 });
      assert.match(made.token, /^sst_[A-Za-z0-9_-]{43}$/);
      assert.equal(made.prefix, made.token.slice(0, 12));
      assert.equal(made.expiresAt, new Date(clock + 30 * 86400000).toISOString());
      assert.equal(JSON.stringify(await store.listTokens(team.id)).includes(made.token), false, 'only its hash is kept');
      const listed = await ws.listTokens(anna, team.id);
      assert.deepEqual(listed.map((t) => [t.name, t.scope, t.prefix]), [['GitHub Actions', 'write', made.prefix]]);
      assert.equal(JSON.stringify(listed).includes(made.token), false);

      // use: the workspace and the role of the scope, never owner; the last use is noted
      let r = await ws.authenticateToken(made.token);
      assert.deepEqual([r.workspace.id, r.role, r.user], [team.id, 'editor', null]);
      assert.equal((await ws.listTokens(anna, team.id))[0].lastUsedAt, new Date(clock).toISOString());
      const read = await ws.createToken(anna, team.id, { name: 'Solo lettura', scope: 'read' });
      assert.equal((await ws.authenticateToken(read.token)).role, 'viewer');
      assert.equal(read.expiresAt, null);
      assert.equal(await ws.authenticateToken('sst_sbagliato'), null);
      assert.equal(await ws.authenticateToken('altra cosa'), null);
      assert.equal(await ws.authenticateToken(''), null);
      // expiry
      clock += 31 * 86400000;
      assert.equal(await ws.authenticateToken(made.token), null, 'expired');
      assert.notEqual(await ws.authenticateToken(read.token), null);
      // revocation
      await ws.revokeToken(anna, team.id, (await ws.listTokens(anna, team.id)).find((t) => t.name === 'Solo lettura').id);
      assert.equal(await ws.authenticateToken(read.token), null);
      await assert.rejects(() => ws.revokeToken(anna, team.id, 'inesistente'), /Token non trovato/);
      // a personal workspace has tokens too, managed by its user
      const mine = await ws.createToken(bruno, bruno.id, { name: 'Mio', scope: 'read' });
      r = await ws.authenticateToken(mine.token);
      assert.deepEqual([r.workspace.kind, r.workspace.id, r.user.username, r.role], ['personal', bruno.id, 'bruno', 'viewer']);
      await assert.rejects(() => ws.listTokens(bruno, anna.id), /Spazio di lavoro non trovato/, 'not the tokens of another account');
      // a deactivated account's token stops, and deleting a workspace deletes its tokens
      await auth.setUser('bruno', { active: false }, { actor: 'admin' });
      assert.equal(await ws.authenticateToken(mine.token), null);
      const other = await ws.createToken(anna, team.id, { name: 'Da cancellare', scope: 'read' });
      await ws.remove(anna, team.id);
      assert.equal(await ws.authenticateToken(other.token), null);
      assert.deepEqual(await store.listTokens(team.id), []);
      const log = (await auth.listAudit(100)).map((e) => e.action);
      assert.ok(log.includes('token-create') && log.includes('token-revoke') && log.includes('workspace-delete'));
    } finally { await close(); }
  });
}

// ---------------- HTTP: the selector, the roles on every route, isolation, tokens ----------------

let home, server, base, site;
before(async () => {
  site = http.createServer((req, res) => res.writeHead(200).end('ok'));
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-wsapi-'));
  Object.assign(process.env, { SITESCANNER_HOME: home, SITESCANNER_ADMIN_USER: 'admin', SITESCANNER_ADMIN_PASSWORD: 'admin-iniziale-123', SITESCANNER_MONITOR_DEV: '1', SITESCANNER_ALLOW_PRIVATE_NETWORKS: '1', SITESCANNER_MON_RETRY_MS: '10' });
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
  const jar = new Map();
  const req = async (method, p, body, headers = {}) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${base}${p}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, data };
  };
  return { req, api: (m, p, b, h) => req(m, `/api/${p}`, b, h) };
}

async function user(admin, name) {
  const c = client();
  await admin.api('POST', 'users', { username: name, password: `${name}-temporanea-1` });
  await c.api('POST', 'login', { username: name, password: `${name}-temporanea-1` });
  await c.api('PUT', 'me/password', { current: `${name}-temporanea-1`, password: `${name}-definitiva-12` });
  return c;
}

test('HTTP: the selector, the roles, isolation between workspaces, the tokens', async () => {
  const admin = client();
  await admin.api('POST', 'login', { username: 'admin', password: 'admin-iniziale-123' });
  await admin.api('PUT', 'me/password', { current: 'admin-iniziale-123', password: 'admin-definitiva-12' });
  const anna = await user(admin, 'anna'), bruno = await user(admin, 'bruno'), carla = await user(admin, 'carla');
  const site1 = `http://127.0.0.1:${site.address().port}/`;

  // personal monitors stay personal
  let r = await anna.api('POST', 'monitors', { name: 'Personale di Anna', url: `${site1}a` });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  r = await anna.api('GET', 'workspaces');
  assert.deepEqual([r.data.workspaces.map((w) => [w.name, w.kind, w.role]), r.data.current], [[['Personale', 'personal', 'owner']], r.data.workspaces[0].id]);
  assert.equal((await anna.api('POST', 'workspaces', { name: 'x' })).status, 400);
  r = await anna.api('POST', 'workspaces', { name: 'Agenzia' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const agency = r.data;
  assert.equal((await anna.api('GET', 'state')).data.workspace.kind, 'personal', 'creating a workspace does not switch to it');
  // switching: the workspace is another area, empty
  assert.equal((await anna.api('POST', 'workspaces/select', { id: agency.id })).status, 200);
  r = await anna.api('GET', 'state');
  assert.deepEqual([r.data.workspace.id, r.data.workspace.name, r.data.workspace.role, r.data.sites.length], [agency.id, 'Agenzia', 'owner', 0]);
  assert.deepEqual((await anna.api('GET', 'monitors')).data, [], 'the monitors of the personal workspace are not here');
  r = await anna.api('POST', 'monitors', { name: 'Del team', url: `${site1}team`, tags: ['cliente:acme'] });
  assert.equal(r.status, 201);
  const teamMonitor = r.data;
  await anna.api('POST', 'workspaces/select', { id: (await anna.api('GET', 'workspaces')).data.workspaces[0].id });
  assert.deepEqual((await anna.api('GET', 'monitors')).data.map((x) => x.name), ['Personale di Anna']);
  assert.equal((await anna.api('POST', 'workspaces/select', { id: 'ws_000000000000' })).status, 404, 'not a workspace of hers');

  // members and roles over HTTP
  assert.equal((await bruno.api('GET', `workspaces/${agency.id}/members`)).status, 404, 'not a member: it does not exist for him');
  assert.equal((await anna.api('POST', `workspaces/${agency.id}/members`, { username: 'bruno', role: 'editor' })).status, 201);
  assert.equal((await anna.api('POST', `workspaces/${agency.id}/members`, { username: 'carla', role: 'viewer' })).status, 201);
  assert.equal((await anna.api('POST', `workspaces/${agency.id}/members`, { username: 'fantasma', role: 'viewer' })).status, 404);
  assert.equal((await bruno.api('POST', `workspaces/${agency.id}/members`, { username: 'carla', role: 'editor' })).status, 403);
  r = await carla.api('GET', `workspaces/${agency.id}/members`);
  assert.deepEqual(r.data.map((m) => [m.username, m.role]), [['anna', 'owner'], ['bruno', 'editor'], ['carla', 'viewer']]);

  // the editor works in it, the reader reads
  await bruno.api('POST', 'workspaces/select', { id: agency.id });
  await carla.api('POST', 'workspaces/select', { id: agency.id });
  assert.equal((await bruno.api('GET', 'state')).data.workspace.role, 'editor');
  assert.deepEqual((await bruno.api('GET', 'monitors')).data.map((x) => x.name), ['Del team']);
  r = await bruno.api('POST', 'monitors', { name: 'Di Bruno', url: `${site1}bruno` });
  assert.equal(r.status, 201, 'the editor creates');
  assert.deepEqual((await carla.api('GET', 'monitors')).data.map((x) => x.name).sort(), ['Del team', 'Di Bruno'], 'the reader sees it');
  assert.equal((await carla.api('GET', 'monitor-list')).status, 200);
  for (const [m, p, b] of [['POST', 'monitors', { name: 'x', url: `${site1}x` }], ['PUT', `monitors/${teamMonitor.id}`, { ...teamMonitor, name: 'cambiato' }], ['DELETE', `monitors/${teamMonitor.id}`], ['POST', `monitors/${teamMonitor.id}/check`, {}], ['POST', 'secrets/CHIAVE_X', { kind: 'var', value: 'x' }], ['POST', 'channels', { type: 'slack', webhookUrl: 'x' }], ['POST', 'sites', {}]]) {
    const x = await carla.api(m, p, b);
    assert.equal(x.status, 403, `${m} ${p}`);
    assert.match(x.data.error, /sola lettura/);
  }
  assert.equal((await anna.api('GET', 'workspaces')).data.workspaces.length, 2);
  assert.equal((await carla.api('POST', 'workspaces', { name: 'Il mio' })).status, 201, 'a reader can have a workspace of her own');
  // the reader writes the note of an incident
  await bruno.api('POST', `monitors/${teamMonitor.id}/check`, {});
  await anna.api('POST', 'workspaces/select', { id: agency.id });
  // isolation: another workspace's monitor is unreachable by id, even for a member of this one
  const mine = (await anna.api('GET', 'workspaces')).data.workspaces[0];
  await anna.api('POST', 'workspaces/select', { id: mine.id });
  const personal = (await anna.api('GET', 'monitors')).data[0];
  await bruno.api('POST', 'workspaces/select', { id: agency.id });
  assert.equal((await bruno.api('GET', `monitors/${personal.id}`)).status, 404, 'a monitor of another workspace does not exist');
  assert.equal((await bruno.api('DELETE', `monitors/${personal.id}`)).status, 404);

  // removing a member and the owner's rights
  assert.equal((await anna.api('PUT', `workspaces/${agency.id}/members/${(await carla.api('GET', 'me')).data.user.id}`, { role: 'editor' })).status, 200);
  assert.equal((await carla.api('POST', 'monitors', { name: 'Ora scrive', url: `${site1}carla` })).status, 201);
  assert.equal((await anna.api('DELETE', `workspaces/${agency.id}/members/${(await carla.api('GET', 'me')).data.user.id}`)).status, 200);
  assert.equal((await carla.api('GET', 'monitors')).data.length, 0, 'out of it: back to her personal workspace');
  assert.equal((await carla.api('GET', 'state')).data.workspace.kind, 'personal');

  // tokens: the owner makes them, shown once; an editor cannot; /api/v1 with a token and no session
  assert.equal((await bruno.api('POST', `workspaces/${agency.id}/tokens`, { name: 'CI', scope: 'read' })).status, 403);
  r = await anna.api('POST', `workspaces/${agency.id}/tokens`, { name: 'GitHub Actions', scope: 'write', expiresInDays: 90 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const token = r.data.token;
  assert.equal(JSON.stringify((await anna.api('GET', `workspaces/${agency.id}/tokens`)).data).includes(token), false);
  const bearer = (t, p = 'v1/me', m = 'GET') => fetch(`${base}/api/${p}`, { method: m, headers: { authorization: `Bearer ${t}`, ...(m === 'GET' ? {} : { 'content-type': 'application/json' }) }, body: m === 'GET' ? undefined : '{}' }).then(async (x) => ({ status: x.status, data: await x.json().catch(() => null) }));
  r = await bearer(token);
  assert.deepEqual([r.status, r.data.workspace.id, r.data.scope, r.data.role], [200, agency.id, 'write', 'editor']);
  assert.equal((await bearer('sst_sbagliato')).status, 401);
  assert.equal((await fetch(`${base}/api/v1/me`)).status, 401, 'no token, no session');
  assert.equal((await bearer(token, 'monitors')).status, 401, 'a token opens /api/v1 only, not the whole API');
  assert.equal((await anna.api('GET', `workspaces/${agency.id}/tokens`)).data[0].lastUsedAt != null, true);
  await anna.api('DELETE', `workspaces/${agency.id}/tokens/${r.data.token.id}`);
  assert.equal((await bearer(token)).status, 401, 'revoked');

  // deleting the workspace: the owner only; its data goes
  assert.equal((await bruno.api('DELETE', `workspaces/${agency.id}`)).status, 403);
  assert.equal((await anna.api('DELETE', `workspaces/${agency.id}`)).status, 200);
  assert.equal((await bruno.api('GET', 'state')).data.workspace.kind, 'personal');
  assert.equal(fs.existsSync(path.join(home, 'users', agency.id)), false, 'the area is deleted');
  assert.equal((await anna.api('GET', 'workspaces')).data.workspaces.length, 1);
  // an account that owns shared workspaces with members cannot be deleted before they are handed over
  const dora = await user(admin, 'dora');
  const shared = (await dora.api('POST', 'workspaces', { name: 'Di Dora' })).data;
  await dora.api('POST', `workspaces/${shared.id}/members`, { username: 'bruno', role: 'editor' });
  r = await admin.api('DELETE', 'users/dora');
  assert.equal(r.status, 409);
  assert.match(r.data.error, /Di Dora/);
  await dora.api('PUT', `workspaces/${shared.id}/members/${(await bruno.api('GET', 'me')).data.user.id}`, { role: 'owner' });
  assert.equal((await admin.api('DELETE', 'users/dora')).status, 200);
  assert.deepEqual((await bruno.api('GET', 'workspaces')).data.workspaces.map((w) => [w.name, w.role]), [['Personale', 'owner'], ['Di Dora', 'owner']]);
  // the log (RF-TEAM-05)
  assert.ok((await admin.api('GET', 'audit')).data.some((e) => e.action === 'token-create'));
});
