import crypto from 'node:crypto';
import { UserError } from '../errors.js';
import { tokenHash } from './passwords.js';
import {
  ROLES, TOKEN_SCOPES, TOKEN_PREFIX, WORKSPACE_PREFIX, workspaceNameProblem, roleIn, ownersOf, membersProblem, publicToken, tokenActive, expiryFromDays, roleOfScope,
} from '../core/workspaces.js';

// Workspaces, members and API tokens (spec §13.10, ADR-0023). The personal workspace of a user is their own area,
// with the id of the account: nothing moves. A shared workspace is an area of its own (`ws_<12 hex>`), with its
// members and their roles in a record of the auth store.

const fail = (status, message) => Object.assign(new UserError(message), { status });

export const PERSONAL_NAME = 'Personale';

/** The `{ id, username }` that `storageFor` takes for a workspace: the account itself for a personal one. */
export const areaOf = (workspace, user = null) => (workspace.kind === 'personal' && user ? user : { id: workspace.id, username: workspace.id });

export class Workspaces {
  constructor(auth) {
    this.auth = auth;
    this.store = auth.store;
  }

  now() {
    return this.auth.now();
  }

  personal(user) {
    return { id: user.id, name: PERSONAL_NAME, kind: 'personal', role: 'owner', members: [], createdAt: user.createdAt };
  }

  /** The workspaces a user can open: the personal one first, then the shared ones they are a member of. */
  async listFor(user) {
    const shared = (await this.store.listWorkspaces()).map((w) => ({ ...w, kind: 'shared', role: roleIn(w, user.id) })).filter((w) => w.role);
    return [this.personal(user), ...shared.sort((a, b) => a.name.localeCompare(b.name, 'it'))];
  }

  /** The workspace the request works in: the one asked for if the user can open it, otherwise the personal one. */
  async resolve(user, id) {
    if (id && id !== user.id) {
      const w = await this.store.getWorkspace(String(id));
      const role = w && roleIn(w, user.id);
      if (role) return { workspace: { ...w, kind: 'shared', role }, role };
    }
    const p = this.personal(user);
    return { workspace: p, role: 'owner' };
  }

  async get(user, id) {
    const w = await this.store.getWorkspace(String(id));
    const role = w && roleIn(w, user.id);
    if (!w || !role) throw fail(404, 'Spazio di lavoro non trovato');
    return { ...w, kind: 'shared', role };
  }

  async requireOwner(user, id) {
    const w = await this.get(user, id);
    if (w.role !== 'owner') throw fail(403, 'Solo il proprietario dello spazio può farlo');
    return w;
  }

  // ---------------- workspaces ----------------

  async create(user, name, actor = {}) {
    const problem = workspaceNameProblem(name);
    if (problem) throw fail(400, problem);
    const mine = (await this.store.listWorkspaces()).filter((w) => roleIn(w, user.id) === 'owner');
    if (mine.length >= 20) throw fail(400, 'Al massimo 20 spazi di lavoro condivisi come proprietario');
    const w = { id: `${WORKSPACE_PREFIX}${crypto.randomBytes(6).toString('hex')}`, name: String(name).trim(), createdAt: new Date(this.now()).toISOString(), createdBy: user.username, members: [{ userId: user.id, role: 'owner', addedAt: new Date(this.now()).toISOString() }] };
    await this.store.saveWorkspace(w);
    await this.auth.audit(user.username, 'workspace-create', { target: w.id, ip: actor.ip, detail: w.name });
    return { ...w, kind: 'shared', role: 'owner' };
  }

  async rename(user, id, name, actor = {}) {
    const w = await this.requireOwner(user, id);
    const problem = workspaceNameProblem(name);
    if (problem) throw fail(400, problem);
    await this.store.saveWorkspace({ ...stripRole(w), name: String(name).trim() });
    await this.auth.audit(user.username, 'workspace-rename', { target: w.id, ip: actor.ip, detail: `${w.name} → ${String(name).trim()}` });
    return { ...w, name: String(name).trim() };
  }

  /** Removes the record, the tokens and the memberships; the caller deletes the data of the area. */
  async remove(user, id, actor = {}) {
    const w = await this.requireOwner(user, id);
    await this.store.deleteTokensOf(w.id);
    await this.store.deleteWorkspace(w.id);
    await this.auth.audit(user.username, 'workspace-delete', { target: w.id, ip: actor.ip, detail: w.name });
    return w;
  }

  // ---------------- members ----------------

  async members(user, id) {
    const w = await this.get(user, id);
    const out = [];
    for (const m of w.members) {
      const u = await this.store.getUserById(m.userId);
      out.push({ userId: m.userId, username: u ? u.username : '(eliminato)', name: u ? u.name || '' : '', active: u ? u.active : false, role: m.role, addedAt: m.addedAt, you: m.userId === user.id });
    }
    return out;
  }

  /** RF-TEAM-02: only accounts that already exist can be invited; the accounts stay managed by the admin. */
  async addMember(user, id, username, role, actor = {}) {
    const w = await this.requireOwner(user, id);
    if (!ROLES.includes(role)) throw fail(400, `Ruolo: ${ROLES.join(', ')}`);
    const target = await this.store.getUser(String(username || '').trim().toLowerCase());
    if (!target || !target.active) throw fail(404, `Nessun account attivo con username «${username}»: gli account li crea l'admin`);
    if (roleIn(w, target.id)) throw fail(409, `${target.username} è già nello spazio`);
    if (w.members.length >= 50) throw fail(400, 'Al massimo 50 membri per spazio');
    await this.store.saveWorkspace({ ...stripRole(w), members: [...w.members, { userId: target.id, role, addedAt: new Date(this.now()).toISOString() }] });
    await this.auth.audit(user.username, 'workspace-member-add', { target: w.id, ip: actor.ip, detail: `${target.username} (${role})` });
    return { userId: target.id, username: target.username, role };
  }

  async setRole(user, id, userId, role, actor = {}) {
    const w = await this.requireOwner(user, id);
    if (!ROLES.includes(role)) throw fail(400, `Ruolo: ${ROLES.join(', ')}`);
    if (!roleIn(w, userId)) throw fail(404, 'Membro non trovato');
    const problem = membersProblem(w, { setRole: { userId, role } });
    if (problem) throw fail(409, problem);
    await this.store.saveWorkspace({ ...stripRole(w), members: w.members.map((m) => (m.userId === userId ? { ...m, role } : m)) });
    const u = await this.store.getUserById(userId);
    await this.auth.audit(user.username, 'workspace-member-role', { target: w.id, ip: actor.ip, detail: `${u ? u.username : userId} → ${role}` });
  }

  /** The owner removes anyone; anyone leaves by themselves, unless they are the last owner. */
  async removeMember(user, id, userId, actor = {}) {
    const w = await this.get(user, id);
    if (userId !== user.id && w.role !== 'owner') throw fail(403, 'Solo il proprietario può togliere un membro');
    if (!roleIn(w, userId)) throw fail(404, 'Membro non trovato');
    const problem = membersProblem(w, { remove: userId });
    if (problem) throw fail(409, problem);
    await this.store.saveWorkspace({ ...stripRole(w), members: w.members.filter((m) => m.userId !== userId) });
    const u = await this.store.getUserById(userId);
    await this.auth.audit(user.username, userId === user.id ? 'workspace-leave' : 'workspace-member-remove', { target: w.id, ip: actor.ip, detail: u ? u.username : userId });
  }

  /**
   * Before an account is deleted: it leaves every workspace. Returns the workspaces that would be left with members
   * but no owner (the deletion must stop), and those that would be left empty (their data goes with them).
   */
  async planUserRemoval(userId) {
    const blocked = [], empty = [];
    for (const w of await this.store.listWorkspaces()) {
      if (!roleIn(w, userId)) continue;
      const rest = w.members.filter((m) => m.userId !== userId);
      if (!rest.length) empty.push(w);
      else if (!rest.some((m) => m.role === 'owner')) blocked.push(w);
    }
    return { blocked, empty };
  }

  async removeUserEverywhere(userId) {
    for (const w of await this.store.listWorkspaces()) {
      if (!roleIn(w, userId)) continue;
      const rest = w.members.filter((m) => m.userId !== userId);
      if (rest.length) await this.store.saveWorkspace({ ...stripRole(w), members: rest });
      else {
        await this.store.deleteTokensOf(w.id);
        await this.store.deleteWorkspace(w.id);
      }
    }
  }

  // ---------------- API tokens (RF-TEAM-04) ----------------

  /** Who manages the tokens of a workspace: its owner; of a personal workspace, its user. */
  async tokenWorkspace(user, id) {
    if (!id || id === user.id) return this.personal(user);
    return this.requireOwner(user, id);
  }

  /** Creates a token; the secret is returned this once, only its hash is kept. */
  async createToken(user, id, { name, scope, expiresInDays = null }, actor = {}) {
    const w = await this.tokenWorkspace(user, id);
    const n = String(name ?? '').trim();
    if (n.length < 2 || n.length > 60) throw fail(400, 'Dai al token un nome da 2 a 60 caratteri (per esempio «GitHub Actions»)');
    if (!TOKEN_SCOPES.includes(scope)) throw fail(400, 'Permesso del token: read (sola lettura) o write (lettura e scrittura)');
    const exp = expiryFromDays(expiresInDays, this.now());
    if (exp.error) throw fail(400, exp.error);
    if ((await this.store.listTokens(w.id)).length >= 50) throw fail(400, 'Al massimo 50 token per spazio');
    const secret = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
    const t = { id: crypto.randomBytes(6).toString('hex'), workspaceId: w.id, name: n, scope, prefix: secret.slice(0, 12), hash: tokenHash(secret), createdAt: new Date(this.now()).toISOString(), createdBy: user.username, expiresAt: exp.expiresAt, lastUsedAt: null };
    await this.store.saveToken(t);
    await this.auth.audit(user.username, 'token-create', { target: w.id, ip: actor.ip, detail: `${n} (${scope})` });
    return { token: secret, ...publicToken(t) };
  }

  async listTokens(user, id) {
    const w = await this.tokenWorkspace(user, id);
    return (await this.store.listTokens(w.id)).map(publicToken);
  }

  async revokeToken(user, id, tokenId, actor = {}) {
    const w = await this.tokenWorkspace(user, id);
    const t = (await this.store.listTokens(w.id)).find((x) => x.id === tokenId);
    if (!t) throw fail(404, 'Token non trovato');
    await this.store.deleteToken(t.id);
    await this.auth.audit(user.username, 'token-revoke', { target: w.id, ip: actor.ip, detail: t.name });
  }

  /** The workspace and the role of a request that carries a token; null if it is unknown, expired, or its workspace is gone. */
  async authenticateToken(secret) {
    if (!String(secret || '').startsWith(TOKEN_PREFIX)) return null;
    const t = await this.store.getTokenByHash(tokenHash(secret));
    if (!t || !tokenActive(t, this.now())) return null;
    let workspace = await this.store.getWorkspace(t.workspaceId);
    let user = null;
    if (workspace) workspace = { ...workspace, kind: 'shared' };
    else {
      // the token of a personal workspace: its id is the account's
      user = await this.store.getUserById(t.workspaceId);
      if (!user || !user.active) return null;
      workspace = this.personal(user);
    }
    // «last used» is updated at most once a minute
    if (!t.lastUsedAt || this.now() - Date.parse(t.lastUsedAt) > 60000) await this.store.touchToken(t.id, new Date(this.now()).toISOString());
    return { token: publicToken(t), workspace, user, role: roleOfScope(t.scope) };
  }
}

const stripRole = (w) => {
  const { role, kind, ...rest } = w;
  return rest;
};
void ownersOf;
