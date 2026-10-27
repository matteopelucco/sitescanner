import zlib from 'node:zlib';

// Monitoring data on Postgres (Vercel, RF-MST-03): same interface as FsMonitorStore.
// Areas are user ids; instants are milliseconds (double precision columns).

const js = (v) => JSON.stringify(v);

export class PgMonitorStore {
  kind = 'pg';

  constructor(backend) {
    this.b = backend;
  }

  async db() {
    await this.b.init();
    return this.b.db;
  }

  async q(text, params = []) {
    return (await this.db()).query(text, params);
  }

  async listAreas() {
    return (await this.q('SELECT area FROM mon_monitors UNION SELECT area FROM mon_channels UNION SELECT area FROM mon_agents ORDER BY area')).map((r) => r.area);
  }

  // ---------------- monitors ----------------

  async listMonitors(area) {
    return (await this.q('SELECT data FROM mon_monitors WHERE area = $1 ORDER BY id', [area])).map((r) => r.data);
  }

  async getMonitor(area, id) {
    const rows = await this.q('SELECT data FROM mon_monitors WHERE area = $1 AND id = $2', [area, id]);
    return rows.length ? rows[0].data : null;
  }

  async saveMonitor(area, m) {
    await this.q(
      `INSERT INTO mon_monitors (area, id, data, next_check_at, paused) VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (area, id) DO UPDATE SET data = EXCLUDED.data, next_check_at = EXCLUDED.next_check_at, paused = EXCLUDED.paused`,
      [area, m.id, js(m), (m.state && m.state.nextCheckAt) || 0, !!m.paused],
    );
    return m;
  }

  async deleteMonitor(area, id) {
    const db = await this.db();
    await db.tx(async (t) => {
      await t.query('DELETE FROM mon_monitors WHERE area = $1 AND id = $2', [area, id]);
      await t.query('DELETE FROM mon_checks WHERE area = $1 AND monitor_id = $2', [area, id]);
      await t.query('DELETE FROM mon_incidents WHERE area = $1 AND monitor_id = $2', [area, id]);
      await t.query('DELETE FROM mon_aggregates WHERE area = $1 AND monitor_id = $2', [area, id]);
    });
    const runs = await this.b.blob.list(`u/${area}/runs/${String(id).replace(/[^\w-]/g, '')}/`);
    if (runs.length) await this.b.blob.del(runs.map((b) => b.pathname));
  }

  async findHeartbeat(token) {
    const rows = await this.q("SELECT area, data FROM mon_monitors WHERE data->>'hbToken' = $1 LIMIT 1", [String(token)]);
    return rows.length ? { area: rows[0].area, monitor: rows[0].data } : null;
  }

  async dueMonitors(now, limit = 1000) {
    const rows = await this.q(`SELECT area, data FROM mon_monitors WHERE NOT paused AND next_check_at <= $1 AND locked_until < $1 ORDER BY next_check_at LIMIT ${Number(limit)}`, [now]);
    return rows.map((r) => ({ area: r.area, monitor: r.data }));
  }

  /** Lock of a monitor for one round, across function instances (RF-MON-17). */
  async claimMonitor(area, id, untilMs, now = Date.now()) {
    return (await this.q('UPDATE mon_monitors SET locked_until = $3 WHERE area = $1 AND id = $2 AND locked_until < $4 RETURNING id', [area, id, untilMs, now])).length > 0;
  }

  async releaseMonitor(area, id) {
    await this.q('UPDATE mon_monitors SET locked_until = 0 WHERE area = $1 AND id = $2', [area, id]);
  }

  // ---------------- checks ----------------

  async addCheck(area, monitorId, check) {
    await this.q('INSERT INTO mon_checks (area, monitor_id, at, data) VALUES ($1, $2, $3, $4::jsonb)', [area, monitorId, check.at, js(check)]);
  }

  async listChecks(area, monitorId, from, to) {
    return (await this.q('SELECT data FROM mon_checks WHERE area = $1 AND monitor_id = $2 AND at >= $3 AND at < $4 ORDER BY at', [area, monitorId, from, Number.isFinite(to) ? to : Number.MAX_VALUE])).map((r) => r.data);
  }

  // ---------------- run details (spec §13.4): gzip JSON on Blob, u/<area>/runs/<monitor>/<run>.json.gz ----------------

  runPath(area, monitorId, runId) {
    return `u/${area}/runs/${String(monitorId).replace(/[^\w-]/g, '')}/${String(runId).replace(/[^\w-]/g, '')}.json.gz`;
  }

  async saveRunDetail(area, monitorId, runId, detail) {
    await this.b.blob.put(this.runPath(area, monitorId, runId), zlib.gzipSync(JSON.stringify(detail)), { contentType: 'application/gzip', overwrite: true });
  }

  async loadRunDetail(area, monitorId, runId) {
    const buf = await this.b.blob.get(this.runPath(area, monitorId, runId));
    return buf ? JSON.parse(zlib.gunzipSync(buf).toString('utf8')) : null;
  }

  async pruneChecks(before) {
    await this.q('DELETE FROM mon_checks WHERE at < $1', [before]);
    // the details older than the raw checks go with them (the run id starts with its instant in base 36)
    for (const area of await this.listAreas()) {
      const old = (await this.b.blob.list(`u/${area}/runs/`)).filter((b) => {
        const name = b.pathname.slice(b.pathname.lastIndexOf('/') + 1, -'.json.gz'.length);
        return parseInt(name.slice(0, -6), 36) < before;
      });
      if (old.length) await this.b.blob.del(old.map((b) => b.pathname));
    }
  }

  // ---------------- incidents ----------------

  async saveIncident(area, inc) {
    await this.q(
      `INSERT INTO mon_incidents (area, id, monitor_id, start_at, end_at, data) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (area, id) DO UPDATE SET end_at = EXCLUDED.end_at, data = EXCLUDED.data`,
      [area, inc.id, inc.monitorId, inc.start, inc.end ?? null, js(inc)],
    );
    return inc;
  }

  async getIncident(area, id) {
    const rows = await this.q('SELECT data FROM mon_incidents WHERE area = $1 AND id = $2', [area, id]);
    return rows.length ? rows[0].data : null;
  }

  async listIncidents(area, { monitorId = null, from = 0, to = Infinity, open = false, limit = Infinity } = {}) {
    const params = [area, Number.isFinite(to) ? to : Number.MAX_VALUE, from];
    let where = 'area = $1 AND start_at < $2 AND (end_at IS NULL OR end_at > $3)';
    if (monitorId) {
      params.push(monitorId);
      where += ` AND monitor_id = $${params.length}`;
    }
    if (open) where += ' AND end_at IS NULL';
    const lim = Number.isFinite(limit) ? ` LIMIT ${Number(limit)}` : '';
    return (await this.q(`SELECT data FROM mon_incidents WHERE ${where} ORDER BY start_at DESC${lim}`, params)).map((r) => r.data);
  }

  // ---------------- maintenance windows ----------------

  async listWindows(area) {
    return (await this.q('SELECT data FROM mon_windows WHERE area = $1 ORDER BY id', [area])).map((r) => r.data);
  }

  async saveWindow(area, w) {
    await this.q('INSERT INTO mon_windows (area, id, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (area, id) DO UPDATE SET data = EXCLUDED.data', [area, w.id, js(w)]);
    return w;
  }

  async deleteWindow(area, id) {
    await this.q('DELETE FROM mon_windows WHERE area = $1 AND id = $2', [area, id]);
  }

  // ---------------- aggregates ----------------

  async saveAggregates(area, kind, monitorId, rows) {
    const key = kind === 'hourly' ? 'hour' : 'day';
    const db = await this.db();
    await db.tx(async (t) => {
      for (const r of rows) {
        await t.query(
          'INSERT INTO mon_aggregates (area, kind, monitor_id, t, data) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (area, kind, monitor_id, t) DO UPDATE SET data = EXCLUDED.data',
          [area, kind, monitorId, r[key], js(r)],
        );
      }
    });
  }

  async listAggregates(area, kind, monitorId, from, to) {
    return (await this.q('SELECT data FROM mon_aggregates WHERE area = $1 AND kind = $2 AND monitor_id = $3 AND t >= $4 AND t < $5 ORDER BY t', [area, kind, monitorId, from, Number.isFinite(to) ? to : Number.MAX_VALUE])).map((r) => r.data);
  }

  async listAggregatesAll(area, kind, from, to) {
    return (await this.q('SELECT monitor_id, data FROM mon_aggregates WHERE area = $1 AND kind = $2 AND t >= $3 AND t < $4', [area, kind, from, Number.isFinite(to) ? to : Number.MAX_VALUE])).map((r) => ({ ...r.data, monitorId: r.monitor_id }));
  }

  async pruneHourly(before) {
    await this.q("DELETE FROM mon_aggregates WHERE kind = 'hourly' AND t < $1", [before]);
  }

  // ---------------- rounds, events, meta ----------------

  async addBeat(beat) {
    await this.q('INSERT INTO mon_beats (at, data) VALUES ($1, $2::jsonb)', [beat.at, js(beat)]);
  }

  async listBeats(from, to = Infinity) {
    return (await this.q('SELECT data FROM mon_beats WHERE at >= $1 AND at < $2 ORDER BY at', [from, Number.isFinite(to) ? to : Number.MAX_VALUE])).map((r) => r.data);
  }

  async lastBeat() {
    const rows = await this.q('SELECT data FROM mon_beats ORDER BY at DESC LIMIT 1');
    return rows.length ? rows[0].data : null;
  }

  async pruneBeats(before) {
    await this.q('DELETE FROM mon_beats WHERE at < $1', [before]);
  }

  async addEvent(area, event) {
    const e = { id: `${event.at}-${Math.random().toString(36).slice(2, 8)}`, status: 'pending', ...event };
    await this.q('INSERT INTO mon_events (area, id, at, status, data) VALUES ($1, $2, $3, $4, $5::jsonb)', [area, e.id, e.at, e.status, js(e)]);
    return e;
  }

  async listEvents(area, { status = null, limit = 200, from = 0 } = {}) {
    const rows = status
      ? await this.q(`SELECT data FROM mon_events WHERE area = $1 AND status = $2 AND at >= $3 ORDER BY at LIMIT ${Number(limit)}`, [area, status, from])
      : await this.q(`SELECT data FROM (SELECT data, at FROM mon_events WHERE area = $1 AND at >= $2 ORDER BY at DESC LIMIT ${Number(limit)}) x ORDER BY at`, [area, from]);
    return rows.map((r) => r.data);
  }

  async pruneEvents(before) {
    await this.q('DELETE FROM mon_events WHERE at < $1', [before]);
  }

  async updateEvent(area, id, patch) {
    const rows = await this.q('SELECT data FROM mon_events WHERE area = $1 AND id = $2', [area, id]);
    if (!rows.length) return null;
    const e = { ...rows[0].data, ...patch };
    await this.q('UPDATE mon_events SET data = $3::jsonb, status = $4 WHERE area = $1 AND id = $2', [area, id, js(e), e.status]);
    return e;
  }

  async getMeta(key) {
    const rows = await this.q('SELECT value FROM mon_meta WHERE key = $1', [key]);
    return rows.length ? rows[0].value : null;
  }

  async setMeta(key, value) {
    await this.q('INSERT INTO mon_meta (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, js(value)]);
  }

  // ---------------- notification channels (spec §12.5) ----------------

  async listChannels(area) {
    return (await this.q('SELECT data FROM mon_channels WHERE area = $1 ORDER BY id', [area])).map((r) => r.data);
  }

  async saveChannel(area, c) {
    await this.q('INSERT INTO mon_channels (area, id, token_hash, data) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (area, id) DO UPDATE SET token_hash = EXCLUDED.token_hash, data = EXCLUDED.data', [area, c.id, c.tokenHash || null, js(c)]);
    return c;
  }

  async deleteChannel(area, id) {
    await this.q('DELETE FROM mon_channels WHERE area = $1 AND id = $2', [area, id]);
  }

  async findChannelByToken(tokenHash) {
    const rows = await this.q('SELECT area, data FROM mon_channels WHERE token_hash = $1', [tokenHash]);
    return rows.length ? { area: rows[0].area, channel: rows[0].data } : null;
  }

  async saveLink(codeHash, area, expiresAt) {
    await this.q('INSERT INTO mon_links (code_hash, area, expires_at) VALUES ($1, $2, $3)', [codeHash, area, expiresAt]);
  }

  async takeLink(codeHash, now = Date.now()) {
    await this.q('DELETE FROM mon_links WHERE expires_at < $1', [now]);
    const rows = await this.q('DELETE FROM mon_links WHERE code_hash = $1 RETURNING area, expires_at', [codeHash]);
    return rows.length && rows[0].expires_at >= now ? rows[0].area : null;
  }

  // ---------------- variables and secrets (spec §13.9) ----------------

  async listSecrets(area) {
    return (await this.q('SELECT data FROM mon_secrets WHERE area = $1 ORDER BY name', [area])).map((r) => r.data);
  }

  async saveSecret(area, rec) {
    await this.q('INSERT INTO mon_secrets (area, name, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (area, name) DO UPDATE SET data = EXCLUDED.data', [area, rec.name, js(rec)]);
    return rec;
  }

  async deleteSecret(area, name) {
    await this.q('DELETE FROM mon_secrets WHERE area = $1 AND name = $2', [area, name]);
  }

  async addSecretLog(area, entry) {
    await this.q('INSERT INTO mon_secret_log (area, at, data) VALUES ($1, $2, $3::jsonb)', [area, entry.at, js(entry)]);
  }

  async listSecretLog(area, limit = 200) {
    return (await this.q(`SELECT data FROM mon_secret_log WHERE area = $1 ORDER BY at DESC LIMIT ${Number(limit)}`, [area])).map((r) => r.data);
  }

  // ---------------- local agents and their queue of runs (spec §13.14, ADR-0025) ----------------

  async listAgents(area) {
    return (await this.q('SELECT data FROM mon_agents WHERE area = $1 ORDER BY id', [area])).map((r) => r.data);
  }

  async getAgent(area, id) {
    const rows = await this.q('SELECT data FROM mon_agents WHERE area = $1 AND id = $2', [area, id]);
    return rows.length ? rows[0].data : null;
  }

  async saveAgent(area, a) {
    await this.q('INSERT INTO mon_agents (area, id, hash, data) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (area, id) DO UPDATE SET data = EXCLUDED.data, hash = EXCLUDED.hash', [area, a.id, a.hash, js(a)]);
    return a;
  }

  async deleteAgent(area, id) {
    await this.q('DELETE FROM mon_agent_jobs WHERE area = $1 AND agent_id = $2', [area, id]);
    await this.q('DELETE FROM mon_agents WHERE area = $1 AND id = $2', [area, id]);
  }

  async findAgentByHash(hash) {
    const rows = await this.q('SELECT area, data FROM mon_agents WHERE hash = $1', [hash]);
    return rows.length ? { area: rows[0].area, agent: rows[0].data } : null;
  }

  async enqueueJob(job) {
    await this.q("INSERT INTO mon_agent_jobs (id, area, agent_id, state, created_at, data) VALUES ($1, $2, $3, 'queued', $4, $5::jsonb)", [job.id, job.area, job.agentId, job.createdAt, js(job)]);
  }

  async claimJobs(agentId, now, max) {
    const rows = await this.q(
      `UPDATE mon_agent_jobs SET state = 'claimed', data = data || jsonb_build_object('claimedAt', $2::double precision)
       WHERE id IN (SELECT id FROM mon_agent_jobs WHERE agent_id = $1 AND state = 'queued' ORDER BY created_at LIMIT ${Number(max)} FOR UPDATE SKIP LOCKED)
       RETURNING data, state`, [agentId, now]);
    return rows.map((r) => ({ ...r.data, state: r.state })).sort((a, b) => a.createdAt - b.createdAt);
  }

  async getJob(id) {
    const rows = await this.q('SELECT data, state FROM mon_agent_jobs WHERE id = $1', [id]);
    return rows.length ? { ...rows[0].data, state: rows[0].state } : null;
  }

  async completeJob(id, agentId, result, now) {
    const rows = await this.q(
      "UPDATE mon_agent_jobs SET state = 'done', data = data || jsonb_build_object('doneAt', $3::double precision, 'result', $4::jsonb) WHERE id = $1 AND agent_id = $2 AND state = 'claimed' RETURNING id",
      [id, agentId, now, js(result)]);
    return rows.length > 0;
  }

  async expireJob(id) {
    await this.q("UPDATE mon_agent_jobs SET state = 'expired' WHERE id = $1 AND state IN ('queued', 'claimed')", [id]);
  }

  async pruneJobs(before) {
    await this.q('DELETE FROM mon_agent_jobs WHERE created_at < $1', [before]);
  }

  // ---------------- status pages, communications, public links (spec §13.11) ----------------

  async listStatusPages(area) {
    return (await this.q('SELECT data FROM mon_status_pages WHERE area = $1 ORDER BY id', [area])).map((r) => r.data);
  }

  async getStatusPage(area, id) {
    const rows = await this.q('SELECT data FROM mon_status_pages WHERE area = $1 AND id = $2', [area, id]);
    return rows.length ? rows[0].data : null;
  }

  async saveStatusPage(area, p) {
    await this.q(
      'INSERT INTO mon_status_pages (area, id, slug, domain, data) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (area, id) DO UPDATE SET slug = EXCLUDED.slug, domain = EXCLUDED.domain, data = EXCLUDED.data',
      [area, p.id, p.slug, p.customDomain || null, js(p)],
    );
    return p;
  }

  async deleteStatusPage(area, id) {
    await this.q('DELETE FROM mon_status_updates WHERE area = $1 AND page_id = $2', [area, id]);
    await this.q('DELETE FROM mon_status_pages WHERE area = $1 AND id = $2', [area, id]);
  }

  async findStatusPage({ slug = null, domain = null }) {
    const rows = slug ? await this.q('SELECT area, data FROM mon_status_pages WHERE slug = $1', [slug]) : await this.q('SELECT area, data FROM mon_status_pages WHERE lower(domain) = $1', [domain]);
    return rows.length ? { area: rows[0].area, page: rows[0].data } : null;
  }

  async listStatusUpdates(area, pageId, { limit = 100 } = {}) {
    return (await this.q(`SELECT data FROM mon_status_updates WHERE area = $1 AND page_id = $2 ORDER BY at DESC LIMIT ${Number(limit)}`, [area, pageId])).map((r) => r.data);
  }

  async getStatusUpdate(area, id) {
    const rows = await this.q('SELECT data FROM mon_status_updates WHERE area = $1 AND id = $2', [area, id]);
    return rows.length ? rows[0].data : null;
  }

  async saveStatusUpdate(area, u) {
    await this.q('INSERT INTO mon_status_updates (area, id, page_id, at, data) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (area, id) DO UPDATE SET data = EXCLUDED.data', [area, u.id, u.pageId, u.createdAt, js(u)]);
    return u;
  }

  async deleteStatusUpdate(area, id) {
    await this.q('DELETE FROM mon_status_updates WHERE area = $1 AND id = $2', [area, id]);
  }

  async listPublicLinks(area) {
    return (await this.q('SELECT data FROM mon_public_links WHERE area = $1 ORDER BY token', [area])).map((r) => r.data);
  }

  async savePublicLink(area, link) {
    await this.q('INSERT INTO mon_public_links (token, area, kind, data) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (token) DO UPDATE SET data = EXCLUDED.data', [link.token, area, link.kind, js(link)]);
    return link;
  }

  async deletePublicLink(area, token) {
    await this.q('DELETE FROM mon_public_links WHERE area = $1 AND token = $2', [area, token]);
  }

  async findPublicLink(token) {
    const rows = await this.q('SELECT area, data FROM mon_public_links WHERE token = $1', [token]);
    return rows.length ? { area: rows[0].area, link: rows[0].data } : null;
  }

  async getPrefs(area) {
    return (await this.getMeta(`prefs:${area}`)) || {};
  }

  async savePrefs(area, prefs) {
    await this.setMeta(`prefs:${area}`, prefs);
  }

  async deleteArea(area) {
    const db = await this.db();
    await db.tx(async (t) => {
      for (const table of ['mon_monitors', 'mon_checks', 'mon_incidents', 'mon_windows', 'mon_aggregates', 'mon_events', 'mon_channels', 'mon_links', 'mon_secrets', 'mon_secret_log', 'mon_status_pages', 'mon_status_updates', 'mon_public_links']) await t.query(`DELETE FROM ${table} WHERE area = $1`, [area]);
    });
  }
}
