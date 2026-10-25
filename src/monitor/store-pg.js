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
    return (await this.q('SELECT area FROM mon_monitors UNION SELECT area FROM mon_channels ORDER BY area')).map((r) => r.area);
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

  async pruneChecks(before) {
    await this.q('DELETE FROM mon_checks WHERE at < $1', [before]);
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

  async listEvents(area, { status = null, limit = 200 } = {}) {
    const rows = status
      ? await this.q(`SELECT data FROM mon_events WHERE area = $1 AND status = $2 ORDER BY at LIMIT ${Number(limit)}`, [area, status])
      : await this.q(`SELECT data FROM (SELECT data, at FROM mon_events WHERE area = $1 ORDER BY at DESC LIMIT ${Number(limit)}) x ORDER BY at`, [area]);
    return rows.map((r) => r.data);
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

  async getPrefs(area) {
    return (await this.getMeta(`prefs:${area}`)) || {};
  }

  async savePrefs(area, prefs) {
    await this.setMeta(`prefs:${area}`, prefs);
  }

  async deleteArea(area) {
    const db = await this.db();
    await db.tx(async (t) => {
      for (const table of ['mon_monitors', 'mon_checks', 'mon_incidents', 'mon_windows', 'mon_aggregates', 'mon_events', 'mon_channels', 'mon_links']) await t.query(`DELETE FROM ${table} WHERE area = $1`, [area]);
    });
  }
}
