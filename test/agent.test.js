import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FsMonitorStore } from '../src/monitor/store-fs.js';
import { PgMonitorStore } from '../src/monitor/store-pg.js';
import { VercelBackend, pgliteDb, MemoryBlob } from '../src/storage/vercel/backend.js';
import { agentStatus, agentTransition, offlineAfterMs, agentLocationId, isPrivateLocation, normalizeAgentName } from '../src/core/agent.js';
import { normalizeLocations } from '../src/core/locations.js';
import { monitorStoreFor, runRound } from '../src/monitor/engine.js';
import { resetAgentLimits } from '../src/monitor/agent.js';
import { serve } from '../src/server.js';

// The local agent (spec §13.14, RF-AGT-01, ADR-0025): the pure rules, the queue on the two stores, and a whole run with
// a deployment (in this process) and an agent (`sitescanner monitor agent`, in another one).

const MIN = 60000;
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sitescanner.js');

test('the beat, the states and the private locations (pure)', () => {
  const a = { id: 'a1b2c3d4e5', name: 'Sede', lastSeenAt: null, pollS: 30, alerted: false };
  const t = 1_000_000_000;
  assert.equal(agentLocationId(a), 'p-a1b2c3d4e5');
  assert.deepEqual(['p-a1b2c3d4e5', 'p-xyz', 'fra1', 'p-A1B2C3D4E5', ''].map(isPrivateLocation), [true, false, false, false, false]);
  assert.equal(agentStatus(a, t), 'waiting', 'never connected');
  assert.equal(agentTransition(a, t), null, 'an agent that never connected is not «stopped»');
  a.lastSeenAt = t - 60 * 1000;
  assert.equal(agentStatus(a, t), 'online');
  a.lastSeenAt = t - 2 * MIN - 1;
  assert.equal(agentStatus(a, t), 'offline');
  assert.equal(agentTransition(a, t), 'missed');
  a.alerted = true;
  assert.equal(agentTransition(a, t), null, 'reported once');
  a.lastSeenAt = t;
  assert.equal(agentTransition(a, t), 'back');
  assert.equal(offlineAfterMs(30), 2 * MIN);
  assert.equal(offlineAfterMs(120), 6 * MIN, 'three polls when the agent asks rarely');
  assert.throws(() => normalizeAgentName(' '), /Dai un nome/);
  assert.throws(() => normalizeAgentName('x'.repeat(41)), /40 caratteri/);
  // a monitor may name a private location; an unknown public one is still refused
  const avail = [{ id: 'fra1', name: 'Francoforte' }];
  assert.deepEqual(normalizeLocations(['fra1', 'p-a1b2c3d4e5'], avail), ['fra1', 'p-a1b2c3d4e5']);
  assert.throws(() => normalizeLocations(['mars1'], avail), /Località sconosciuta/);
});

const STORES = [
  { name: 'file', async make() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-agent-')); return { store: new FsMonitorStore(dir), area: '', close: async () => fs.rmSync(dir, { recursive: true, force: true }) }; } },
  { name: 'postgres', async make() { const { PGlite } = await import('@electric-sql/pglite'); const b = new VercelBackend({ db: pgliteDb(new PGlite()), blob: new MemoryBlob() }); return { store: new PgMonitorStore(b), area: 'u1', close: () => b.db.close() }; } },
];

for (const kind of STORES) {
  test(`${kind.name} store: agents and the queue of runs`, async () => {
    const { store, area, close } = await kind.make();
    try {
      const a = { id: 'a1b2c3d4e5', name: 'Sede', hash: 'h1', createdAt: 1, lastSeenAt: null, alerted: false };
      await store.saveAgent(area, a);
      await store.saveAgent(area, { id: 'f6a7b8c9d0', name: 'Magazzino', hash: 'h2', createdAt: 2 });
      assert.deepEqual((await store.listAgents(area)).map((x) => x.name), ['Sede', 'Magazzino']);
      assert.equal((await store.findAgentByHash('h2')).agent.name, 'Magazzino');
      assert.equal((await store.findAgentByHash('h2')).area, area);
      assert.equal(await store.findAgentByHash('nessuno'), null);
      assert.ok((await store.listAreas()).includes(area), 'an area with agents exists');
      await store.saveAgent(area, { ...a, lastSeenAt: 99 });
      assert.equal((await store.getAgent(area, a.id)).lastSeenAt, 99);

      // the queue: each agent takes its own runs, once, in order
      for (let i = 1; i <= 3; i++) await store.enqueueJob({ id: `j${i}`, area, agentId: a.id, monitorId: 'm1', createdAt: 10 + i });
      await store.enqueueJob({ id: 'other', area, agentId: 'f6a7b8c9d0', monitorId: 'm1', createdAt: 5 });
      assert.deepEqual((await store.claimJobs(a.id, 100, 2)).map((j) => j.id), ['j1', 'j2']);
      assert.deepEqual((await store.claimJobs(a.id, 100, 5)).map((j) => j.id), ['j3'], 'a run is taken once');
      assert.deepEqual((await store.claimJobs(a.id, 100, 5)), []);
      assert.equal((await store.getJob('j1')).state, 'claimed');
      // the result: only by the agent that took it, only once
      assert.equal(await store.completeJob('j1', 'f6a7b8c9d0', { outcome: 'ok' }, 120), false, 'not by another agent');
      assert.equal(await store.completeJob('j1', a.id, { outcome: 'ok', ms: 7 }, 120), true);
      assert.equal(await store.completeJob('j1', a.id, { outcome: 'ok' }, 121), false, 'not twice');
      const done = await store.getJob('j1');
      assert.deepEqual([done.state, done.result.ms, done.doneAt], ['done', 7, 120]);
      assert.equal(await store.completeJob('other', 'f6a7b8c9d0', { outcome: 'ok' }, 1), false, 'a run still queued was not taken');
      // a run that is not waited for any more is closed, and its late result refused
      await store.expireJob('j2');
      assert.equal((await store.getJob('j2')).state, 'expired');
      assert.equal(await store.completeJob('j2', a.id, { outcome: 'ok' }, 130), false);
      await store.expireJob('j1');
      assert.equal((await store.getJob('j1')).state, 'done', 'a run already done stays so');
      // clean-up
      await store.pruneJobs(11);
      assert.equal(await store.getJob('other'), null, 'old runs go');
      assert.ok(await store.getJob('j3'));
      await store.deleteAgent(area, a.id);
      assert.equal(await store.getAgent(area, a.id), null);
      assert.equal(await store.getJob('j3'), null, 'the runs of a deleted agent go with it');
      assert.equal((await store.listAgents(area)).length, 1);
    } finally { await close(); }
  });
}

// ---------------- a deployment and an agent, two processes ----------------

let home, server, base, target, slack, children = [];
const sent = [];
const seen = [];
const mode = { value: 'ok' };

const until = async (fn, ms = 20000, what = 'condizione') => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

before(async () => {
  // the site of the customer: only reachable from «inside» (the deployment refuses private addresses, the agent does not)
  target = http.createServer((req, res) => {
    seen.push({ url: req.url, location: req.headers['x-sitescanner-location'] || null });
    res.writeHead(mode.value === 'ok' ? 200 : 503, { 'content-type': 'text/html' }).end(mode.value === 'ok' ? '<h1>Intranet</h1>' : 'giù');
  });
  slack = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    sent.push(body);
    res.writeHead(200).end('ok');
  });
  for (const s of [target, slack]) await new Promise((r) => s.listen(0, '127.0.0.1', r));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-agentproc-'));
  Object.assign(process.env, {
    SITESCANNER_HOME: home, SITESCANNER_ADMIN_USER: 'admin', SITESCANNER_ADMIN_PASSWORD: 'admin-iniziale-123', SITESCANNER_MONITOR_DEV: '1',
    SITESCANNER_MON_RETRY_MS: '10', SITESCANNER_MON_SPREAD: '0', SITESCANNER_NOTIFY_RETRY_MS: '1,1,1', SITESCANNER_PUBLIC_URL: 'https://monitor.example.com', SITESCANNER_AGENT_WAIT_MS: '15000',
    SITESCANNER_SLACK_WEBHOOK_PREFIX: `http://127.0.0.1:${slack.address().port}/slack/`,
  });
  delete process.env.SITESCANNER_ALLOW_PRIVATE_NETWORKS;
  resetAgentLimits();
  server = await serve({ port: 0, multi: true });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const c of children) c.kill();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  for (const s of [target, slack]) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  for (const k of ['SITESCANNER_ADMIN_USER', 'SITESCANNER_ADMIN_PASSWORD', 'SITESCANNER_MONITOR_DEV', 'SITESCANNER_MON_RETRY_MS', 'SITESCANNER_MON_SPREAD', 'SITESCANNER_NOTIFY_RETRY_MS', 'SITESCANNER_PUBLIC_URL', 'SITESCANNER_AGENT_WAIT_MS', 'SITESCANNER_SLACK_WEBHOOK_PREFIX']) delete process.env[k];
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

function startAgent(token, extra = []) {
  const child = spawn(process.execPath, [BIN, 'monitor', 'agent', '--url', base, '--token', token, '--interval', '3', ...extra], { env: { ...process.env, SITESCANNER_HOME: path.join(home, 'agent') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { text: '', code: null, exited: false };
  child.stdout.on('data', (d) => { out.text += d; });
  child.stderr.on('data', (d) => { out.text += d; });
  child.on('exit', (c) => { out.code = c; out.exited = true; });
  children.push(child);
  return { child, out };
}

test('a monitor run only by the agent: results, incident, notifications and the beat of the agent', async () => {
  const admin = client();
  await admin('POST', 'login', { username: 'admin', password: 'admin-iniziale-123' });
  await admin('PUT', 'me/password', { current: 'admin-iniziale-123', password: 'admin-definitiva-12' });
  await admin('POST', 'users', { username: 'maria', password: 'maria-temporanea-1' });
  const maria = client();
  await maria('POST', 'login', { username: 'maria', password: 'maria-temporanea-1' });
  await maria('PUT', 'me/password', { current: 'maria-temporanea-1', password: 'maria-definitiva-12' });
  const url = `http://127.0.0.1:${target.address().port}/intranet`;

  // the agent is created: the token is shown once, and the agent waits for its first call
  assert.equal((await maria('POST', 'agents', { name: '' })).status, 400);
  const made = await maria('POST', 'agents', { name: 'Sede di Roma' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.match(made.data.token, /^ssa_[\w-]{32}$/);
  assert.deepEqual([made.data.agent.status, made.data.agent.label], ['waiting', 'Privata · Sede di Roma']);
  assert.equal(JSON.stringify(made.data.agent).includes('hash'), false);
  assert.equal((await maria('POST', 'agents', { name: 'sede di roma' })).status, 400, 'names are unique');
  const listed = (await maria('GET', 'agents')).data.agents;
  assert.equal(JSON.stringify(listed).includes(made.data.token), false, 'the token is not shown again');
  const loc = made.data.agent.location;
  assert.ok((await maria('GET', 'monitor-locations')).data.locations.some((l) => l.id === loc && l.name === 'Privata · Sede di Roma' && l.private));

  // the monitor: only that location. An agent that never connected fails the run at once, saying why
  const mon = (await maria('POST', 'monitors', { name: 'Intranet', url, intervalMin: 5, locations: [loc], retry: { strategy: 'none' } })).data;
  assert.deepEqual(mon.locations, [loc]);
  assert.equal((await maria('POST', 'monitors/test', { name: 'x', url, locations: [loc] })).status, 400, 'the test of the form cannot see the network of the agent');
  const store = monitorStoreFor();
  const area = (await store.listAreas()).find((a) => a !== '');
  const force = async (id) => { const m = await store.getMonitor(area, id); m.state.nextCheckAt = 0; await store.saveMonitor(area, m); };
  await force(mon.id);
  let r = await runRound({ adminAreas: [''] });
  assert.equal(r.failed, 1);
  const lastRun = async () => (await maria('GET', `monitors/${mon.id}/runs`)).data.runs[0];
  let run = await lastRun();
  assert.match(run.error, /non si è ancora collegato/);
  assert.equal(seen.length, 0, 'nothing reached the site');
  await maria('PUT', `incidents/${(await maria('GET', 'monitoring')).data.openIncidents[0].id}`, { note: 'agente non ancora acceso' });

  const { out } = startAgent(made.data.token);
  await until(async () => (await maria('GET', 'agents')).data.agents[0].status === 'online', 15000, 'agente collegato');
  assert.match(out.text, /Collegato come «Sede di Roma»/);
  const ag = (await maria('GET', 'agents')).data.agents[0];
  assert.deepEqual([ag.pollS, typeof ag.host, ag.version], [5, 'string', '1'], 'the interval is kept between 5 s and 5 min');

  await force(mon.id);
  r = await runRound({ adminAreas: [''] });
  assert.equal(r.failed, 0);
  assert.equal(seen.length >= 1, true);
  assert.equal(seen.at(-1).location, 'privata-Sede-di-Roma', 'the site can tell where the request comes from');
  run = await lastRun();
  assert.deepEqual([run.outcome, run.location], ['ok', loc]);
  assert.match(out.text, /✔ Intranet/);
  const detail = (await maria('GET', 'monitoring')).data.monitors.find((m) => m.id === mon.id);
  assert.equal(detail.status, 'up');
  assert.equal((await maria('GET', 'monitoring')).data.openIncidents.length, 0, 'the incident of the first run closed');

  const before = seen.length;
  assert.equal((await maria('POST', `monitors/${mon.id}/check`, {})).status, 200);
  assert.equal(seen.length, before + 1);

  await maria('POST', 'channels', { type: 'slack', name: 'ops', webhookUrl: `${process.env.SITESCANNER_SLACK_WEBHOOK_PREFIX}T/B/X` });
  mode.value = 'down';
  await force(mon.id);
  r = await runRound({ adminAreas: [''] });
  assert.equal(r.failed, 1);
  run = await lastRun();
  assert.deepEqual([run.outcome, run.location], ['error', loc]);
  assert.match(run.error, /503/);
  const open = (await maria('GET', 'monitoring')).data.openIncidents;
  assert.equal(open.length, 1);
  assert.ok(sent.some((b) => /GIÙ/.test(b) && /Intranet/.test(b)), 'the down alert reached Slack');
  mode.value = 'ok';
  await force(mon.id);
  await runRound({ adminAreas: [''] });
  assert.equal((await maria('GET', 'monitoring')).data.openIncidents.length, 0);
  assert.ok(sent.some((b) => /DI NUOVO SU/.test(b)), 'and the recovery');

  children.forEach((c) => c.kill());
  await until(() => out.exited, 10000, 'agente fermato');
  const a = await store.getAgent(area, ag.id);
  a.lastSeenAt = Date.now() - 10 * MIN;
  await store.saveAgent(area, a);
  sent.length = 0;
  await force(mon.id);
  r = await runRound({ adminAreas: [''] });
  run = await lastRun();
  assert.match(run.error, /non si fa sentire da 10 min/);
  assert.ok(sent.some((b) => /AGENTE FERMO/.test(b) && /Sede di Roma/.test(b)), 'the alert about the agent');
  const n = sent.filter((b) => /AGENTE FERMO/.test(b)).length;
  await force(mon.id);
  await runRound({ adminAreas: [''] });
  assert.equal(sent.filter((b) => /AGENTE FERMO/.test(b)).length, n, 'reported once');
  const hist = (await maria('GET', 'history?groups=agents')).data;
  assert.ok(JSON.stringify(hist).includes('agent-missed'));

  const again = startAgent(made.data.token);
  await until(() => sent.some((b) => /AGENTE DI NUOVO COLLEGATO/.test(b)), 15000, 'avviso di ritorno');
  assert.equal((await maria('GET', 'agents')).data.agents[0].status, 'online');
  again.child.kill();

  const wrong = startAgent('ssa_tokenSbagliatoTokenSbagliato12');
  await until(() => wrong.out.exited, 10000, 'agente con token sbagliato');
  assert.equal(wrong.out.code, 2, 'a mistake of use ends with 2');
  assert.match(wrong.out.text, /Token dell'agente non valido/);
  const res = await fetch(`${base}/api/agent/poll`, { method: 'POST', headers: { authorization: 'Bearer ssa_tokenSbagliatoTokenSbagliato12' }, body: '{}' });
  assert.equal(res.status, 401);
  assert.equal((await fetch(`${base}/api/agent/poll`, { method: 'POST', body: '{}' })).status, 401, 'no token');
  assert.equal((await fetch(`${base}/api/agent/poll`)).status, 405);
  assert.equal((await fetch(`${base}/api/agent/result`, { method: 'POST', headers: { authorization: `Bearer ${made.data.token}` }, body: JSON.stringify({ id: 'boh', result: { outcome: 'ok' } }) })).status, 404, 'a run that does not exist');

  const del = await maria('DELETE', `agents/${ag.id}`);
  assert.equal(del.status, 409);
  assert.match(del.data.error, /usato da 1 monitor \(Intranet\)/);
  await maria('PUT', `monitors/${mon.id}`, { locations: [] });
  assert.equal((await maria('DELETE', `agents/${ag.id}`)).status, 200);
  assert.equal((await maria('GET', 'agents')).data.agents.length, 0);
  assert.equal((await fetch(`${base}/api/agent/poll`, { method: 'POST', headers: { authorization: `Bearer ${made.data.token}` }, body: '{}' })).status, 401);
});

test('agents are per workspace: another account does not see them, a reader does not create them', async () => {
  const admin = client();
  await admin('POST', 'login', { username: 'admin', password: 'admin-definitiva-12' });
  await admin('POST', 'users', { username: 'nino', password: 'nino-temporanea-1' });
  const nino = client();
  await nino('POST', 'login', { username: 'nino', password: 'nino-temporanea-1' });
  await nino('PUT', 'me/password', { current: 'nino-temporanea-1', password: 'nino-definitiva-12' });
  const made = (await nino('POST', 'agents', { name: 'Casa' })).data;
  const maria = client();
  await maria('POST', 'login', { username: 'maria', password: 'maria-definitiva-12' });
  assert.deepEqual((await maria('GET', 'agents')).data.agents, []);
  assert.equal((await maria('DELETE', `agents/${made.agent.id}`)).status, 404, 'not theirs');
  // a monitor that names the agent of another account runs nowhere: the run says that the agent does not exist
  const m = (await maria('POST', 'monitors', { name: 'Altrui', url: 'http://localhost:1/', locations: [made.agent.location] })).data;
  const store = monitorStoreFor();
  let owner = null;
  for (const x of await store.listAreas()) if (await store.getMonitor(x, m.id)) owner = x;
  const stored = await store.getMonitor(owner, m.id);
  stored.state.nextCheckAt = 0;
  await store.saveMonitor(owner, stored);
  await runRound({ adminAreas: [''] });
  assert.match((await maria('GET', `monitors/${m.id}/runs`)).data.runs[0].error, /L'agente di questa località non esiste più/);
});
