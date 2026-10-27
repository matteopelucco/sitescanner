// Workspaces, roles and API tokens (spec §13.10, RF-TEAM-01..05): the rules, as pure functions.

export const ROLES = ['owner', 'editor', 'viewer'];
export const ROLE_LABELS = { owner: 'Proprietario', editor: 'Editor', viewer: 'Lettore' };
export const TOKEN_SCOPES = ['read', 'write'];
export const TOKEN_PREFIX = 'sst_';

/** The role a token has in its workspace: it reads, or reads and writes, but never manages members or tokens. */
export const roleOfScope = (scope) => (scope === 'write' ? 'editor' : 'viewer');

/** Name of a shared workspace (RF-TEAM-01). Returns a message or null. */
export function workspaceNameProblem(name) {
  const n = String(name ?? '').trim();
  if (n.length < 2 || n.length > 60) return 'Il nome dello spazio va da 2 a 60 caratteri';
  return null;
}

/** The id of a shared workspace; it must never look like a username (RF-USR-01 reserves the prefix). */
export const WORKSPACE_PREFIX = 'ws_';
export const isWorkspaceId = (id) => /^ws_[0-9a-f]{12}$/.test(String(id));

/**
 * What a role may do on a request of the API (RF-TEAM-02). The reader sees dashboards, reports and incidents and
 * writes the note of an incident; the editor creates and changes everything; managing members and tokens is
 * checked by the routes of the workspace, for the owner.
 * `route`: the path after /api/, e.g. «monitors/abc/check».
 */
export function allowedRequest(role, method, route) {
  if (role === 'owner' || role === 'editor') return { ok: true };
  const m = String(method).toUpperCase();
  if (m === 'GET' || m === 'HEAD') return { ok: true };
  if (m === 'PUT' && /^incidents\/[^/]+$/.test(route)) return { ok: true }; // the note of an incident
  return { ok: false, reason: 'Hai accesso in sola lettura a questo spazio di lavoro' };
}

/** Role of a user in a workspace record (`members: [{ userId, role }]`); null if not a member. */
export function roleIn(workspace, userId) {
  const m = ((workspace && workspace.members) || []).find((x) => x.userId === userId);
  return m ? m.role : null;
}

/** The owners of a workspace. */
export const ownersOf = (workspace) => ((workspace && workspace.members) || []).filter((m) => m.role === 'owner');

/** Can the change of members leave the workspace without an owner? Returns a message or null. */
export function membersProblem(workspace, { remove = null, setRole = null } = {}) {
  const next = (workspace.members || [])
    .filter((m) => m.userId !== remove)
    .map((m) => (setRole && m.userId === setRole.userId ? { ...m, role: setRole.role } : m));
  if (!next.some((m) => m.role === 'owner')) return 'Lo spazio deve avere almeno un proprietario: nomina prima un altro proprietario';
  return null;
}

/** An API token as the API shows it: never the secret, only its start. */
export function publicToken(t) {
  return { id: t.id, name: t.name, scope: t.scope, prefix: t.prefix, createdAt: t.createdAt, createdBy: t.createdBy || null, expiresAt: t.expiresAt || null, lastUsedAt: t.lastUsedAt || null };
}

/** A token is valid until its expiry (RF-TEAM-04). */
export const tokenActive = (t, now) => !t.expiresAt || Date.parse(t.expiresAt) > now;

/** Days → expiry date from `now`; null for no expiry. Returns a message for values out of range. */
export function expiryFromDays(days, now) {
  if (days == null || days === '' || Number(days) === 0) return { expiresAt: null };
  const d = Number(days);
  if (!Number.isInteger(d) || d < 1 || d > 3650) return { error: 'La scadenza va da 1 a 3650 giorni, oppure nessuna' };
  return { expiresAt: new Date(now + d * 86400000).toISOString() };
}
