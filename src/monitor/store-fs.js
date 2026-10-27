import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// Monitoring data on the filesystem (local development, RF-MON-18 / RF-MST-03). Same interface as
// PgMonitorStore. An area is '' (working folder) or a username (users/<username>/):
//   <area>/monitoring/monitors.json, incidents.json, windows.json, events.json
//   <area>/monitoring/checks/<monitor>.jsonl     raw checks, one JSON per line
//   <area>/monitoring/hourly/<monitor>.json, daily/<monitor>.json
//   <root>/monitoring/beats.json, meta.json      rounds of the scheduler (all areas)
// One process serves the folder: writes are synchronous and atomic.

function readJson(f, fallback) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, f);
}

const safeId = (id) => String(id).replace(/[^\w-]/g, '');

export class FsMonitorStore {
  kind = 'fs';

  constructor(root) {
    this.root = root;
    this.locks = new Map();
  }

  dir(area) {
    return area ? path.join(this.root, 'users', area, 'monitoring') : path.join(this.root, 'monitoring');
  }

  file(area, name) {
    return path.join(this.dir(area), name);
  }

  list(area, name) {
    return readJson(this.file(area, `${name}.json`), []);
  }

  put(area, name, list) {
    writeJson(this.file(area, `${name}.json`), list);
  }

  upsert(area, name, item) {
    const list = this.list(area, name);
    const i = list.findIndex((x) => x.id === item.id);
    if (i >= 0) list[i] = item;
    else list.push(item);
    this.put(area, name, list);
    return item;
  }

  async listAreas() {
    const out = [];
    const used = (a) => fs.existsSync(this.file(a, 'monitors.json')) || fs.existsSync(this.file(a, 'channels.json')) || fs.existsSync(this.file(a, 'agents.json'));
    if (used('')) out.push('');
    const users = path.join(this.root, 'users');
    if (fs.existsSync(users)) for (const u of fs.readdirSync(users).sort()) if (used(u)) out.push(u);
    return out;
  }

  // ---------------- monitors ----------------

  async listMonitors(area) {
    return this.list(area, 'monitors');
  }

  async getMonitor(area, id) {
    return this.list(area, 'monitors').find((m) => m.id === id) || null;
  }

  async saveMonitor(area, m) {
    return this.upsert(area, 'monitors', m);
  }

  async deleteMonitor(area, id) {
    this.put(area, 'monitors', this.list(area, 'monitors').filter((m) => m.id !== id));
    this.put(area, 'incidents', this.list(area, 'incidents').filter((i) => i.monitorId !== id));
    for (const sub of ['checks', 'hourly', 'daily']) fs.rmSync(path.join(this.dir(area), sub, `${safeId(id)}.${sub === 'checks' ? 'jsonl' : 'json'}`), { force: true });
    fs.rmSync(this.runDir(area, id), { recursive: true, force: true });
  }

  /** The heartbeat monitor with this token (RF-TYP-01), in any area. */
  async findHeartbeat(token) {
    for (const area of await this.listAreas()) {
      const monitor = this.list(area, 'monitors').find((m) => m.type === 'heartbeat' && m.hbToken === token);
      if (monitor) return { area, monitor };
    }
    return null;
  }

  async dueMonitors(now, limit = 1000) {
    const out = [];
    for (const area of await this.listAreas()) {
      for (const m of this.list(area, 'monitors')) {
        if (!m.paused && (m.state?.nextCheckAt ?? 0) <= now) out.push({ area, monitor: m });
      }
    }
    return out.sort((a, b) => (a.monitor.state?.nextCheckAt ?? 0) - (b.monitor.state?.nextCheckAt ?? 0)).slice(0, limit);
  }

  /** Lock of a monitor for one round (RF-MON-17); here within the process. */
  async claimMonitor(area, id, untilMs, now = Date.now()) {
    const k = `${area}/${id}`;
    if ((this.locks.get(k) || 0) > now) return false;
    this.locks.set(k, untilMs);
    return true;
  }

  async releaseMonitor(area, id) {
    this.locks.delete(`${area}/${id}`);
  }

  // ---------------- checks ----------------

  async addCheck(area, monitorId, check) {
    const f = path.join(this.dir(area), 'checks', `${safeId(monitorId)}.jsonl`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(check) + '\n');
  }

  async listChecks(area, monitorId, from, to) {
    const f = path.join(this.dir(area), 'checks', `${safeId(monitorId)}.jsonl`);
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.at >= from && c.at < to);
  }

  // ---------------- run details (spec §13.4): one gzip JSON per run ----------------

  runDir(area, monitorId) {
    return path.join(this.dir(area), 'runs', safeId(monitorId));
  }

  async saveRunDetail(area, monitorId, runId, detail) {
    const dir = this.runDir(area, monitorId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${safeId(runId)}.json.gz`), zlib.gzipSync(JSON.stringify(detail)));
  }

  async loadRunDetail(area, monitorId, runId) {
    const f = path.join(this.runDir(area, monitorId), `${safeId(runId)}.json.gz`);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'));
  }

  async pruneChecks(before) {
    for (const area of await this.listAreas()) {
      // run ids start with the instant in base 36: the details older than the raw checks go with them
      const runs = path.join(this.dir(area), 'runs');
      if (fs.existsSync(runs)) {
        for (const m of fs.readdirSync(runs)) {
          for (const f of fs.readdirSync(path.join(runs, m))) {
            if (parseInt(f.slice(0, f.length - '.json.gz'.length).slice(0, -6), 36) < before) fs.rmSync(path.join(runs, m, f), { force: true });
          }
        }
      }
    }
    for (const area of await this.listAreas()) {
      const dir = path.join(this.dir(area), 'checks');
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        const keep = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).filter((l) => JSON.parse(l).at >= before);
        fs.writeFileSync(p, keep.map((l) => l + '\n').join(''));
      }
    }
  }

  // ---------------- incidents ----------------

  async saveIncident(area, inc) {
    return this.upsert(area, 'incidents', inc);
  }

  async getIncident(area, id) {
    return this.list(area, 'incidents').find((i) => i.id === id) || null;
  }

  /** Incidents overlapping [from, to), newest first; `open` only those still open. */
  async listIncidents(area, { monitorId = null, from = 0, to = Infinity, open = false, limit = Infinity } = {}) {
    return this.list(area, 'incidents')
      .filter((i) => (!monitorId || i.monitorId === monitorId) && (!open || i.end == null) && i.start < to && (i.end == null || i.end > from))
      .sort((a, b) => b.start - a.start)
      .slice(0, limit);
  }

  // ---------------- maintenance windows ----------------

  async listWindows(area) {
    return this.list(area, 'windows');
  }

  async saveWindow(area, w) {
    return this.upsert(area, 'windows', w);
  }

  async deleteWindow(area, id) {
    this.put(area, 'windows', this.list(area, 'windows').filter((w) => w.id !== id));
  }

  // ---------------- aggregates ----------------

  agg(area, kind, monitorId) {
    return path.join(this.dir(area), kind, `${safeId(monitorId)}.json`);
  }

  async saveAggregates(area, kind, monitorId, rows) {
    const key = kind === 'hourly' ? 'hour' : 'day';
    const f = this.agg(area, kind, monitorId);
    const map = new Map(readJson(f, []).map((r) => [r[key], r]));
    for (const r of rows) map.set(r[key], r);
    writeJson(f, [...map.values()].sort((a, b) => a[key] - b[key]));
  }

  async listAggregates(area, kind, monitorId, from, to) {
    const key = kind === 'hourly' ? 'hour' : 'day';
    return readJson(this.agg(area, kind, monitorId), []).filter((r) => r[key] >= from && r[key] < to);
  }

  /** All the monitors of the area in one go: rows of {kind} in [from, to), with the monitor id (RNF-42). */
  async listAggregatesAll(area, kind, from, to) {
    const key = kind === 'hourly' ? 'hour' : 'day';
    const dir = path.join(this.dir(area), kind);
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const monitorId = f.slice(0, -5);
      for (const r of readJson(path.join(dir, f), [])) if (r[key] >= from && r[key] < to) out.push({ ...r, monitorId });
    }
    return out;
  }

  async pruneHourly(before) {
    for (const area of await this.listAreas()) {
      const dir = path.join(this.dir(area), 'hourly');
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) writeJson(path.join(dir, f), readJson(path.join(dir, f), []).filter((r) => r.hour >= before));
    }
  }

  // ---------------- rounds, events, meta ----------------

  async addBeat(beat) {
    const f = this.file('', 'beats.json');
    const list = readJson(f, []);
    list.push(beat);
    writeJson(f, list.slice(-5000));
  }

  async listBeats(from, to = Infinity) {
    return readJson(this.file('', 'beats.json'), []).filter((b) => b.at >= from && b.at < to);
  }

  async pruneBeats(before) {
    const f = this.file('', 'beats.json');
    writeJson(f, readJson(f, []).filter((b) => b.at >= before));
  }

  async lastBeat() {
    const list = readJson(this.file('', 'beats.json'), []);
    return list[list.length - 1] || null;
  }

  /** Outbox of the events to notify (spec §12.5): delivered by the notifications. */
  async addEvent(area, event) {
    const list = this.list(area, 'events');
    const e = { id: `${event.at}-${Math.random().toString(36).slice(2, 8)}`, status: 'pending', ...event };
    list.push(e);
    this.put(area, 'events', list.slice(-5000));
    return e;
  }

  async listEvents(area, { status = null, limit = 200, from = 0 } = {}) {
    return this.list(area, 'events').filter((e) => (!status || e.status === status) && e.at >= from).slice(-limit);
  }

  async pruneEvents(before) {
    for (const area of ['', ...(await this.listAreas())]) {
      const list = this.list(area, 'events');
      const kept = list.filter((e) => e.at >= before);
      if (kept.length !== list.length) this.put(area, 'events', kept);
    }
  }

  async updateEvent(area, id, patch) {
    const list = this.list(area, 'events');
    const e = list.find((x) => x.id === id);
    if (e) Object.assign(e, patch);
    this.put(area, 'events', list);
    return e;
  }

  async getMeta(key) {
    return readJson(this.file('', 'meta.json'), {})[key] ?? null;
  }

  async setMeta(key, value) {
    const f = this.file('', 'meta.json');
    const meta = readJson(f, {});
    meta[key] = value;
    writeJson(f, meta);
  }

  // ---------------- notification channels (spec §12.5) ----------------

  async listChannels(area) {
    return this.list(area, 'channels');
  }

  async saveChannel(area, c) {
    return this.upsert(area, 'channels', c);
  }

  async deleteChannel(area, id) {
    this.put(area, 'channels', this.list(area, 'channels').filter((c) => c.id !== id));
  }

  /** The channel waiting for the confirmation with this token hash (email). */
  async findChannelByToken(tokenHash) {
    for (const area of await this.listAreas()) {
      const c = this.list(area, 'channels').find((x) => x.tokenHash === tokenHash);
      if (c) return { area, channel: c };
    }
    return null;
  }

  /** Single-use codes of the Telegram links: saved by hash, taken once. */
  async saveLink(codeHash, area, expiresAt) {
    const f = this.file('', 'links.json');
    const links = readJson(f, {});
    links[codeHash] = { area, expiresAt };
    writeJson(f, links);
  }

  async takeLink(codeHash, now = Date.now()) {
    const f = this.file('', 'links.json');
    const links = readJson(f, {});
    const l = links[codeHash];
    delete links[codeHash];
    for (const [k, v] of Object.entries(links)) if (v.expiresAt < now) delete links[k];
    writeJson(f, links);
    return l && l.expiresAt >= now ? l.area : null;
  }

  async getPrefs(area) {
    return readJson(this.file(area, 'prefs.json'), {});
  }

  async savePrefs(area, prefs) {
    writeJson(this.file(area, 'prefs.json'), prefs);
  }

  /** Everything of an area (account deleted). */
  // ---------------- variables and secrets (spec §13.9) ----------------

  async listSecrets(area) {
    return this.list(area, 'secrets');
  }

  async saveSecret(area, rec) {
    return this.upsert(area, 'secrets', { ...rec, id: rec.name });
  }

  async deleteSecret(area, name) {
    this.put(area, 'secrets', this.list(area, 'secrets').filter((s) => s.name !== name));
  }

  async addSecretLog(area, entry) {
    this.put(area, 'secretlog', [...this.list(area, 'secretlog'), entry].slice(-1000));
  }

  async listSecretLog(area, limit = 200) {
    return this.list(area, 'secretlog').slice(-limit).reverse();
  }

  // ---------------- local agents and their queue of runs (spec §13.14, ADR-0025) ----------------

  async listAgents(area) {
    return this.list(area, 'agents');
  }

  async getAgent(area, id) {
    return this.list(area, 'agents').find((a) => a.id === id) || null;
  }

  async saveAgent(area, a) {
    return this.upsert(area, 'agents', a);
  }

  async deleteAgent(area, id) {
    this.put(area, 'agents', this.list(area, 'agents').filter((a) => a.id !== id));
    const f = this.file('', 'agentjobs.json');
    writeJson(f, readJson(f, []).filter((j) => j.agentId !== id));
  }

  async findAgentByHash(hash) {
    for (const area of await this.listAreas()) {
      const agent = this.list(area, 'agents').find((a) => a.hash === hash);
      if (agent) return { area, agent };
    }
    return null;
  }

  async enqueueJob(job) {
    const f = this.file('', 'agentjobs.json');
    writeJson(f, [...readJson(f, []), { ...job, state: 'queued' }]);
  }

  async claimJobs(agentId, now, max) {
    const f = this.file('', 'agentjobs.json');
    const all = readJson(f, []);
    const mine = all.filter((j) => j.agentId === agentId && j.state === 'queued').sort((a, b) => a.createdAt - b.createdAt).slice(0, max);
    for (const j of mine) Object.assign(j, { state: 'claimed', claimedAt: now });
    if (mine.length) writeJson(f, all);
    return mine;
  }

  async getJob(id) {
    return readJson(this.file('', 'agentjobs.json'), []).find((j) => j.id === id) || null;
  }

  async completeJob(id, agentId, result, now) {
    const f = this.file('', 'agentjobs.json');
    const all = readJson(f, []);
    const j = all.find((x) => x.id === id && x.agentId === agentId && x.state === 'claimed');
    if (!j) return false;
    Object.assign(j, { state: 'done', doneAt: now, result });
    writeJson(f, all);
    return true;
  }

  async expireJob(id) {
    const f = this.file('', 'agentjobs.json');
    const all = readJson(f, []);
    const j = all.find((x) => x.id === id && ['queued', 'claimed'].includes(x.state));
    if (j) { j.state = 'expired'; writeJson(f, all); }
  }

  async pruneJobs(before) {
    const f = this.file('', 'agentjobs.json');
    writeJson(f, readJson(f, []).filter((j) => j.createdAt >= before));
  }

  // ---------------- status pages, communications, public links (spec §13.11) ----------------

  async listStatusPages(area) {
    return this.list(area, 'statuspages');
  }

  async getStatusPage(area, id) {
    return this.list(area, 'statuspages').find((p) => p.id === id) || null;
  }

  async saveStatusPage(area, p) {
    return this.upsert(area, 'statuspages', p);
  }

  async deleteStatusPage(area, id) {
    this.put(area, 'statuspages', this.list(area, 'statuspages').filter((p) => p.id !== id));
    this.put(area, 'statusupdates', this.list(area, 'statusupdates').filter((u) => u.pageId !== id));
  }

  /** A public page is found by its address, across every area (it is asked without a session). */
  async findStatusPage({ slug = null, domain = null }) {
    for (const area of await this.listAreas()) {
      const page = this.list(area, 'statuspages').find((p) => (slug && p.slug === slug) || (domain && p.customDomain === domain));
      if (page) return { area, page };
    }
    return null;
  }

  async listStatusUpdates(area, pageId, { limit = 100 } = {}) {
    return this.list(area, 'statusupdates').filter((u) => u.pageId === pageId).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  async getStatusUpdate(area, id) {
    return this.list(area, 'statusupdates').find((u) => u.id === id) || null;
  }

  async saveStatusUpdate(area, u) {
    return this.upsert(area, 'statusupdates', u);
  }

  async deleteStatusUpdate(area, id) {
    this.put(area, 'statusupdates', this.list(area, 'statusupdates').filter((u) => u.id !== id));
  }

  async listPublicLinks(area) {
    return this.list(area, 'publiclinks');
  }

  async savePublicLink(area, link) {
    return this.upsert(area, 'publiclinks', { ...link, id: link.token });
  }

  async deletePublicLink(area, token) {
    this.put(area, 'publiclinks', this.list(area, 'publiclinks').filter((l) => l.token !== token));
  }

  async findPublicLink(token) {
    for (const area of await this.listAreas()) {
      const link = this.list(area, 'publiclinks').find((l) => l.token === token);
      if (link) return { area, link };
    }
    return null;
  }

  async deleteArea(area) {
    fs.rmSync(this.dir(area), { recursive: true, force: true });
  }
}
