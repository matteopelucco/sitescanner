import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Accounts on the local filesystem, for multi-user mode outside Vercel (ADR-0016, ADR-0017):
//   <home>/auth/users.json     accounts (password hashes only)
//   <home>/auth/sessions.json  sessions (SHA-256 of the token only)
//   <home>/auth/attempts.json  failed logins per username and per IP
//   <home>/auth/audit.json     access log
// One process serves the folder: writes are serialized and atomic.

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class FsAuthStore {
  kind = 'fs';

  constructor(root) {
    this.dir = path.join(root, 'auth');
    this.queue = Promise.resolve();
  }

  read(name, fallback) {
    const f = path.join(this.dir, `${name}.json`);
    if (!fs.existsSync(f)) return fallback;
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      return fallback;
    }
  }

  // Read-modify-write of one collection, one at a time.
  update(name, fallback, fn) {
    const run = this.queue.then(() => {
      const data = this.read(name, fallback);
      const out = fn(data);
      writeAtomic(path.join(this.dir, `${name}.json`), data);
      return out;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  // ---------------- users ----------------

  async listUsers() {
    return this.read('users', []);
  }

  async getUser(username) {
    const u = String(username || '').toLowerCase();
    return (await this.listUsers()).find((x) => x.username === u) || null;
  }

  async getUserById(id) {
    return (await this.listUsers()).find((x) => x.id === id) || null;
  }

  async createUser(user) {
    return this.update('users', [], (users) => {
      if (users.some((x) => x.username === user.username)) throw Object.assign(new Error('exists'), { code: 'EXISTS' });
      const u = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), lastLoginAt: null, ...user };
      users.push(u);
      return u;
    });
  }

  async updateUser(id, patch) {
    return this.update('users', [], (users) => {
      const u = users.find((x) => x.id === id);
      if (!u) return null;
      Object.assign(u, patch);
      return u;
    });
  }

  async deleteUser(id) {
    await this.update('users', [], (users) => {
      const i = users.findIndex((x) => x.id === id);
      if (i >= 0) users.splice(i, 1);
    });
    await this.deleteSessions(id);
  }

  // ---------------- sessions ----------------

  async createSession(s) {
    return this.update('sessions', [], (list) => {
      list.push(s);
      return s;
    });
  }

  async getSession(hash) {
    return this.read('sessions', []).find((s) => s.hash === hash) || null;
  }

  async touchSession(hash, lastSeenAt) {
    return this.update('sessions', [], (list) => {
      const s = list.find((x) => x.hash === hash);
      if (s) s.lastSeenAt = lastSeenAt;
    });
  }

  async deleteSession(hash) {
    return this.update('sessions', [], (list) => {
      const i = list.findIndex((x) => x.hash === hash);
      if (i >= 0) list.splice(i, 1);
    });
  }

  /** Deletes the sessions of a user, except the one with hash `except`. */
  async deleteSessions(userId, except = null) {
    return this.update('sessions', [], (list) => {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].userId === userId && list[i].hash !== except) list.splice(i, 1);
    });
  }

  async countSessions(userId) {
    return this.read('sessions', []).filter((s) => s.userId === userId).length;
  }

  async pruneSessions(isExpired) {
    return this.update('sessions', [], (list) => {
      for (let i = list.length - 1; i >= 0; i--) if (isExpired(list[i])) list.splice(i, 1);
    });
  }

  // ---------------- failed logins ----------------

  /** Records a failure for each key and returns the failures of each key since `since`. */
  async addFailures(keys, now, since) {
    return this.update('attempts', {}, (a) => {
      for (const k of Object.keys(a)) {
        a[k] = a[k].filter((t) => t >= since);
        if (!a[k].length) delete a[k];
      }
      for (const k of keys) (a[k] ||= []).push(now);
      return keys.map((k) => a[k].length);
    });
  }

  async countFailures(keys, since) {
    const a = this.read('attempts', {});
    return keys.map((k) => (a[k] || []).filter((t) => t >= since).length);
  }

  async clearFailures(key) {
    return this.update('attempts', {}, (a) => {
      delete a[key];
    });
  }

  // ---------------- access log ----------------

  async addAudit(entry, keepSince) {
    return this.update('audit', [], (list) => {
      list.push(entry);
      const first = list.findIndex((e) => e.at >= keepSince);
      if (first > 0) list.splice(0, first);
    });
  }

  async listAudit(limit) {
    return this.read('audit', []).slice(-limit).reverse();
  }
}
