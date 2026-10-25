import crypto from 'node:crypto';

// Accounts on Postgres (Vercel backend, ADR-0016/0017): same interface as FsAuthStore.

const iso = (v) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

const userOut = (r) => r && {
  id: r.id,
  username: r.username,
  name: r.name,
  role: r.role,
  active: r.active,
  mustChangePassword: r.must_change_password,
  passwordHash: r.password_hash,
  createdAt: iso(r.created_at),
  lastLoginAt: iso(r.last_login_at),
};

const sessionOut = (r) => r && { hash: r.hash, userId: r.user_id, createdAt: iso(r.created_at), lastSeenAt: iso(r.last_seen_at), ip: r.ip, userAgent: r.user_agent };

const COLUMNS = { name: 'name', role: 'role', active: 'active', mustChangePassword: 'must_change_password', passwordHash: 'password_hash', lastLoginAt: 'last_login_at' };

export class PgAuthStore {
  kind = 'pg';

  constructor(backend) {
    this.b = backend;
  }

  async db() {
    await this.b.init();
    return this.b.db;
  }

  async listUsers() {
    return (await (await this.db()).query('SELECT * FROM users ORDER BY username')).map(userOut);
  }

  async getUser(username) {
    const rows = await (await this.db()).query('SELECT * FROM users WHERE username = $1', [String(username || '').toLowerCase()]);
    return userOut(rows[0]) || null;
  }

  async getUserById(id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
    const rows = await (await this.db()).query('SELECT * FROM users WHERE id = $1', [id]);
    return userOut(rows[0]) || null;
  }

  async createUser(user) {
    const rows = await (await this.db()).query(
      `INSERT INTO users (id, username, name, role, active, must_change_password, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (username) DO NOTHING RETURNING *`,
      [crypto.randomUUID(), user.username, user.name || '', user.role, user.active !== false, !!user.mustChangePassword, user.passwordHash],
    );
    if (!rows.length) throw Object.assign(new Error('exists'), { code: 'EXISTS' });
    return userOut(rows[0]);
  }

  async updateUser(id, patch) {
    const sets = [];
    const params = [id];
    for (const [k, v] of Object.entries(patch)) {
      if (!COLUMNS[k]) continue;
      params.push(v);
      sets.push(`${COLUMNS[k]} = $${params.length}`);
    }
    if (!sets.length) return this.getUserById(id);
    const rows = await (await this.db()).query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    return userOut(rows[0]) || null;
  }

  async deleteUser(id) {
    await (await this.db()).query('DELETE FROM users WHERE id = $1', [id]); // sessions: ON DELETE CASCADE
  }

  async createSession(s) {
    await (await this.db()).query('INSERT INTO sessions (hash, user_id, created_at, last_seen_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5, $6)', [s.hash, s.userId, s.createdAt, s.lastSeenAt, s.ip, s.userAgent]);
    return s;
  }

  async getSession(hash) {
    return sessionOut((await (await this.db()).query('SELECT * FROM sessions WHERE hash = $1', [hash]))[0]) || null;
  }

  async touchSession(hash, lastSeenAt) {
    await (await this.db()).query('UPDATE sessions SET last_seen_at = $2 WHERE hash = $1', [hash, lastSeenAt]);
  }

  async deleteSession(hash) {
    await (await this.db()).query('DELETE FROM sessions WHERE hash = $1', [hash]);
  }

  async deleteSessions(userId, except = null) {
    await (await this.db()).query('DELETE FROM sessions WHERE user_id = $1 AND hash IS DISTINCT FROM $2', [userId, except]);
  }

  async countSessions(userId) {
    return Number((await (await this.db()).query('SELECT count(*) AS n FROM sessions WHERE user_id = $1', [userId]))[0].n);
  }

  async pruneSessions(isExpired) {
    const db = await this.db();
    for (const r of await db.query('SELECT * FROM sessions')) if (isExpired(sessionOut(r))) await db.query('DELETE FROM sessions WHERE hash = $1', [r.hash]);
  }

  async addFailures(keys, now, since) {
    const db = await this.db();
    await db.query('DELETE FROM login_failures WHERE at < $1', [new Date(since).toISOString()]);
    for (const k of keys) await db.query('INSERT INTO login_failures (key, at) VALUES ($1, $2)', [k, new Date(now).toISOString()]);
    return this.countFailures(keys, since);
  }

  async countFailures(keys, since) {
    const db = await this.db();
    const out = [];
    for (const k of keys) out.push(Number((await db.query('SELECT count(*) AS n FROM login_failures WHERE key = $1 AND at >= $2', [k, new Date(since).toISOString()]))[0].n));
    return out;
  }

  async clearFailures(key) {
    await (await this.db()).query('DELETE FROM login_failures WHERE key = $1', [key]);
  }

  async addAudit(e, keepSince) {
    const db = await this.db();
    await db.query('INSERT INTO audit (at, actor, action, target, ip, detail) VALUES ($1, $2, $3, $4, $5, $6)', [e.at, e.actor, e.action, e.target, e.ip, e.detail]);
    await db.query('DELETE FROM audit WHERE at < $1', [keepSince]);
  }

  async listAudit(limit) {
    const rows = await (await this.db()).query(`SELECT * FROM audit ORDER BY at DESC, id DESC LIMIT ${Number(limit)}`);
    return rows.map((r) => ({ at: iso(r.at), actor: r.actor, action: r.action, target: r.target, ip: r.ip, detail: r.detail }));
  }
}
