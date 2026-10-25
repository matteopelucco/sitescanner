import { UserError } from '../errors.js';
import { hashPassword, verifyPassword, needsRehash, passwordProblem, generatePassword, newToken, tokenHash } from './passwords.js';

// Accounts, sessions, login limits and access log of multi-user mode (spec §10, ADR-0016).
// The store (filesystem or Postgres) only keeps data; every rule lives here.

const MIN = 60 * 1000;
export const AUTH_LIMITS = {
  idleMs: 7 * 24 * 60 * MIN,       // RF-AUTH-05
  maxAgeMs: 30 * 24 * 60 * MIN,
  touchMs: 5 * MIN,
  failWindowMs: 15 * MIN,          // RF-AUTH-03
  userFailures: 5,
  ipFailures: 20,
  auditDays: 90,                   // RF-ADM-06
};

const fail = (status, message, extra = {}) => Object.assign(new UserError(message), { status, ...extra });
const BAD_LOGIN = 'Username o password non validi';

/** RF-USR-01. Returns an error message or null. */
export function usernameProblem(username) {
  const u = String(username ?? '');
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(u)) return 'Username non valido: 3–32 caratteri tra a-z, 0-9, ".", "_", "-", che iniziano con una lettera o una cifra';
  return null;
}

/** What the API shows of an account: never the hash. */
export function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, name: u.name || '', role: u.role, active: u.active, mustChangePassword: !!u.mustChangePassword, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt };
}

export class Auth {
  constructor(store, { now = () => Date.now() } = {}) {
    this.store = store;
    this.now = now;
  }

  iso() {
    return new Date(this.now()).toISOString();
  }

  audit(actor, action, { target = null, ip = null, detail = null } = {}) {
    const keepSince = new Date(this.now() - AUTH_LIMITS.auditDays * 24 * 60 * MIN).toISOString();
    return this.store.addAudit({ at: this.iso(), actor, action, target, ip, detail }, keepSince);
  }

  // ---------------- login and sessions ----------------

  async login(username, password, { ip = null, userAgent = null } = {}) {
    const uname = String(username || '').trim().toLowerCase();
    const keys = [`u:${uname}`, `ip:${ip}`];
    const since = this.now() - AUTH_LIMITS.failWindowMs;
    const [uf, ipf] = await this.store.countFailures(keys, since);
    if (uf >= AUTH_LIMITS.userFailures || ipf >= AUTH_LIMITS.ipFailures) {
      await this.audit(uname || null, 'login-blocked', { ip });
      throw fail(429, 'Troppi tentativi falliti: riprova tra 15 minuti');
    }
    const user = uname ? await this.store.getUser(uname) : null;
    // The hash is computed even for unknown users, so timing does not tell whether the account exists.
    const ok = await verifyPassword(String(password ?? ''), user && user.passwordHash);
    if (!user || !ok || !user.active) {
      await this.store.addFailures(keys, this.now(), since);
      await this.audit(uname || null, 'login-failed', { ip, detail: !user ? 'utente inesistente' : !ok ? 'password errata' : 'utente disattivato' });
      throw fail(401, BAD_LOGIN);
    }
    await this.store.clearFailures(`u:${uname}`);
    const patch = { lastLoginAt: this.iso() };
    if (needsRehash(user.passwordHash)) patch.passwordHash = await hashPassword(password);
    const updated = await this.store.updateUser(user.id, patch);
    const token = newToken();
    const at = this.iso();
    await this.store.createSession({ hash: tokenHash(token), userId: user.id, createdAt: at, lastSeenAt: at, ip, userAgent: userAgent ? String(userAgent).slice(0, 200) : null });
    await this.audit(user.username, 'login', { ip });
    return { user: updated, token };
  }

  expired(s) {
    const now = this.now();
    return now - Date.parse(s.lastSeenAt) > AUTH_LIMITS.idleMs || now - Date.parse(s.createdAt) > AUTH_LIMITS.maxAgeMs;
  }

  /** The session of a token, with its user, or null (expired, revoked, user disabled). */
  async authenticate(token) {
    if (!token) return null;
    const hash = tokenHash(token);
    const s = await this.store.getSession(hash);
    if (!s) return null;
    if (this.expired(s)) {
      await this.store.deleteSession(hash);
      return null;
    }
    const user = await this.store.getUserById(s.userId);
    if (!user || !user.active) return null;
    if (this.now() - Date.parse(s.lastSeenAt) > AUTH_LIMITS.touchMs) await this.store.touchSession(hash, this.iso());
    return { user, session: s };
  }

  async logout(token) {
    if (token) await this.store.deleteSession(tokenHash(token));
  }

  async logoutAll(user) {
    await this.store.deleteSessions(user.id);
    await this.audit(user.username, 'logout-all');
  }

  async pruneSessions() {
    await this.store.pruneSessions((s) => this.expired(s));
  }

  // ---------------- own account ----------------

  async changeOwnPassword(user, current, next, { sessionHash = null, ip = null } = {}) {
    if (!(await verifyPassword(String(current ?? ''), user.passwordHash))) throw fail(400, 'La password attuale non è corretta');
    const problem = passwordProblem(next, user.username);
    if (problem) throw fail(400, problem);
    if (await verifyPassword(next, user.passwordHash)) throw fail(400, 'La nuova password deve essere diversa da quella attuale');
    const u = await this.store.updateUser(user.id, { passwordHash: await hashPassword(next), mustChangePassword: false });
    await this.store.deleteSessions(user.id, sessionHash); // RF-AUTH-07
    await this.audit(user.username, 'password-changed', { ip });
    return u;
  }

  async updateProfile(user, { name }) {
    return this.store.updateUser(user.id, { name: String(name ?? '').trim().slice(0, 80) });
  }

  // ---------------- administration ----------------

  async listUsers() {
    return (await this.store.listUsers()).sort((a, b) => a.username.localeCompare(b.username));
  }

  async target(username) {
    const u = await this.store.getUser(username);
    if (!u) throw fail(404, `Utente "${username}" non trovato`);
    return u;
  }

  async activeAdmins() {
    return (await this.store.listUsers()).filter((u) => u.role === 'admin' && u.active);
  }

  /** Creates an account with a temporary password (given or generated, RF-ADM-01 / RF-USR-05). */
  async createUser({ username, name = '', role = 'user', password = null }, { actor = null, ip = null } = {}) {
    const uname = String(username || '').trim().toLowerCase();
    const problem = usernameProblem(uname);
    if (problem) throw fail(400, problem);
    if (!['admin', 'user'].includes(role)) throw fail(400, 'Ruolo non valido: admin o user');
    const generated = !password;
    const pw = password || generatePassword();
    const pp = passwordProblem(pw, uname);
    if (pp) throw fail(400, pp);
    let user;
    try {
      user = await this.store.createUser({ username: uname, name: String(name).trim().slice(0, 80), role, active: true, mustChangePassword: true, passwordHash: await hashPassword(pw) });
    } catch (e) {
      if (e.code === 'EXISTS') throw fail(400, `Lo username "${uname}" è già usato`);
      throw e;
    }
    await this.audit(actor, 'user-created', { target: uname, ip, detail: role });
    return { user, password: generated ? pw : null };
  }

  async resetPassword(username, { password = null, actor = null, ip = null } = {}) {
    const u = await this.target(username);
    const pw = password || generatePassword();
    const pp = passwordProblem(pw, u.username);
    if (pp) throw fail(400, pp);
    await this.store.updateUser(u.id, { passwordHash: await hashPassword(pw), mustChangePassword: true });
    await this.store.deleteSessions(u.id);
    await this.audit(actor, 'password-reset', { target: u.username, ip });
    return { password: password ? null : pw };
  }

  /** Name, role and status; at least one active admin must remain (RF-USR-07). */
  async setUser(username, { name, role, active }, { actor = null, ip = null } = {}) {
    const u = await this.target(username);
    const patch = {};
    if (name !== undefined) patch.name = String(name ?? '').trim().slice(0, 80);
    if (role !== undefined) {
      if (!['admin', 'user'].includes(role)) throw fail(400, 'Ruolo non valido: admin o user');
      patch.role = role;
    }
    if (active !== undefined) patch.active = !!active;
    const losesAdmin = u.role === 'admin' && u.active && ((patch.role && patch.role !== 'admin') || patch.active === false);
    if (losesAdmin && (await this.activeAdmins()).length <= 1) throw fail(409, 'Deve restare almeno un admin attivo');
    const updated = await this.store.updateUser(u.id, patch);
    if ((patch.role && patch.role !== u.role) || (patch.active === false && u.active)) await this.store.deleteSessions(u.id); // RF-AUTH-07
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'name' || v === u[k]) continue;
      await this.audit(actor, k === 'role' ? 'role-changed' : v ? 'user-enabled' : 'user-disabled', { target: u.username, ip, detail: k === 'role' ? v : null });
    }
    return updated;
  }

  /** Deletes the account and its sessions; the caller deletes the area (RF-ADM-05). */
  async deleteUser(username, { actor = null, ip = null } = {}) {
    const u = await this.target(username);
    if (actor && actor === u.username) throw fail(409, 'Non puoi eliminare il tuo account');
    if (u.role === 'admin' && u.active && (await this.activeAdmins()).length <= 1) throw fail(409, 'Deve restare almeno un admin attivo');
    await this.store.deleteUser(u.id);
    await this.audit(actor, 'user-deleted', { target: u.username, ip });
    return u;
  }

  async listAudit(limit = 200) {
    return this.store.listAudit(limit);
  }

  /** RF-USR-20: the first admin from SITESCANNER_ADMIN_USER / SITESCANNER_ADMIN_PASSWORD, only when there are no accounts. */
  async bootstrap(env = process.env) {
    if ((await this.store.listUsers()).length) return null;
    if (!env.SITESCANNER_ADMIN_USER || !env.SITESCANNER_ADMIN_PASSWORD) return null;
    const { user } = await this.createUser({ username: env.SITESCANNER_ADMIN_USER, role: 'admin', password: env.SITESCANNER_ADMIN_PASSWORD }, { actor: 'sistema' });
    return user;
  }
}
