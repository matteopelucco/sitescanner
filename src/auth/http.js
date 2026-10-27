import { UserError } from '../errors.js';
import { send, readJson, NotFound } from '../api.js';
import { storageFor } from '../storage/index.js';
import { allSiteIds } from '../store.js';
import { runningJobsOf, cancelJobOf } from '../jobs.js';
import { publicUser } from './index.js';
import { tokenHash } from './passwords.js';
import { areaOf } from './workspaces.js';

// Cookie and /api/ routes of multi-user mode (spec §10.3, §10.5, §10.8).

const COOKIE = 'sitescanner_session';
export const cookieName = (secure) => (secure ? `__Host-${COOKIE}` : COOKIE);

export function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export const readSessionToken = (req, secure) => readCookie(req, cookieName(secure));

/** The workspace the user works in, chosen with the selector (spec §13.10): a cookie, checked against the memberships at every request. */
export const WORKSPACE_COOKIE = 'sitescanner_ws';
export const readWorkspaceId = (req) => readCookie(req, WORKSPACE_COOKIE);
const workspaceCookie = (id, secure) => [`${WORKSPACE_COOKIE}=${encodeURIComponent(id)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${365 * 24 * 3600}`, ...(secure ? ['Secure'] : [])].join('; ');

// RF-AUTH-04: HttpOnly, SameSite=Lax, Path=/; Secure (and the __Host- prefix) on HTTPS.
function sessionCookie(token, secure, maxAgeSec) {
  return [`${cookieName(secure)}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`, ...(secure ? ['Secure'] : [])].join('; ');
}

const forbidden = (message, extra = {}) => Object.assign(new UserError(message), { status: 403, ...extra });

/** Account routes allowed while the password must be changed (RF-USR-05). */
export const OPEN_WITH_TEMP_PASSWORD = new Set(['me', 'me/password', 'logout', 'logout-all']);

/** Counts shown to the admin: never the content of the sites (RF-ADM, ADR-0016). */
async function areaCounts(user) {
  const st = storageFor(user);
  const sites = await allSiteIds(st);
  let scans = 0;
  for (const s of sites) scans += (await st.listScans(s)).length;
  return { sites: sites.length, scans };
}

/**
 * Handles the account routes; returns false if the path is not one of them.
 * ctx: { auth, ip, secure, session: { user, session } | null, token }
 */
export async function handleAuthApi(req, res, url, ctx) {
  const { auth, ip, secure } = ctx;
  const parts = url.pathname.split('/').filter(Boolean).slice(1);
  const route = parts.join('/');
  const m = req.method;

  // Tells the login page whether the first admin still has to be created (RF-USR-20)
  if (route === 'login' && m === 'GET') {
    send(res, 200, { needsSetup: !(await auth.store.listUsers()).length });
    return true;
  }
  if (route === 'login' && m === 'POST') {
    const body = await readJson(req);
    const { user, token } = await auth.login(body.username, body.password, { ip, userAgent: req.headers['user-agent'] });
    send(res, 200, { user: publicUser(user) }, { 'set-cookie': sessionCookie(token, secure, 30 * 24 * 3600) });
    return true;
  }

  const known = ['logout', 'logout-all', 'me', 'me/password', 'audit'].includes(route) || parts[0] === 'users' || parts[0] === 'workspaces';
  if (!known) return false;
  const s = ctx.session;
  if (!s) throw Object.assign(new UserError('Accesso richiesto'), { status: 401 });
  const user = s.user;

  if (route === 'logout' && m === 'POST') {
    await auth.logout(ctx.token);
    send(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', secure, 0) });
    return true;
  }
  if (route === 'logout-all' && m === 'POST') {
    await auth.logoutAll(user);
    send(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', secure, 0) });
    return true;
  }
  if (route === 'me') {
    if (m === 'GET') {
      send(res, 200, { user: publicUser(user), sessions: await auth.store.countSessions(user.id) });
      return true;
    }
    if (m === 'PUT') {
      const body = await readJson(req);
      send(res, 200, { user: publicUser(await auth.updateProfile(user, body)) });
      return true;
    }
  }
  if (route === 'me/password' && m === 'PUT') {
    const body = await readJson(req);
    const u = await auth.changeOwnPassword(user, body.current, body.password, { sessionHash: tokenHash(ctx.token), ip });
    send(res, 200, { user: publicUser(u) });
    return true;
  }

  if (parts[0] === 'workspaces') return handleWorkspaceRoutes(req, res, parts, ctx, user);

  // Administration: admins only
  if (user.role !== 'admin') throw forbidden('Riservato agli admin');
  const actor = { actor: user.username, ip };

  if (route === 'audit' && m === 'GET') {
    send(res, 200, await auth.listAudit(200));
    return true;
  }
  const [, name, action] = parts;
  if (!name) {
    if (m === 'GET') {
      const users = await auth.listUsers();
      send(res, 200, await Promise.all(users.map(async (u) => ({ ...publicUser(u), ...(await areaCounts(u)), runningJobs: (await runningJobsOf(storageFor(u))).length }))));
      return true;
    }
    if (m === 'POST') {
      const body = await readJson(req);
      const { user: created, password } = await auth.createUser({ username: body.username, name: body.name, role: body.role || 'user', password: body.password || null }, actor);
      send(res, 201, { user: publicUser(created), password });
      return true;
    }
  } else if (!action) {
    if (m === 'PUT') {
      const body = await readJson(req);
      const updated = await auth.setUser(name, { name: body.name, role: body.role, active: body.active }, actor);
      // RF-ADM-03: a disabled account stops its running jobs
      if (body.active === false) {
        const st = storageFor(updated);
        for (const j of await runningJobsOf(st)) await cancelJobOf(j.id, st).catch(() => {});
      }
      send(res, 200, { user: publicUser(updated) });
      return true;
    }
    if (m === 'DELETE') {
      const target = await auth.target(name);
      const st = storageFor(target);
      const busy = await runningJobsOf(st);
      if (busy.length) throw Object.assign(new UserError(`L'utente ha ${busy.length} job in corso: attendi la fine o annullali`), { status: 409 });
      // RF-TEAM-02: it leaves the shared workspaces; it cannot while it is the only owner of one that has other members
      const plan = await ctx.workspaces.planUserRemoval(target.id);
      if (plan.blocked.length) throw Object.assign(new UserError(`L'utente è l'unico proprietario di ${plan.blocked.map((w) => `«${w.name}»`).join(', ')}, che ha altri membri: nomina prima un altro proprietario`), { status: 409 });
      const counts = await areaCounts(target);
      await auth.deleteUser(name, actor);
      await st.deleteArea();
      const { monitorStoreFor, monitorArea } = await import('../monitor/engine.js');
      await monitorStoreFor().deleteArea(monitorArea(st));
      for (const w of plan.empty) await deleteWorkspaceData(w);
      await ctx.workspaces.removeUserEverywhere(target.id);
      send(res, 200, { ok: true, ...counts });
      return true;
    }
  } else if (action === 'reset-password' && m === 'POST') {
    const body = await readJson(req);
    send(res, 200, await auth.resetPassword(name, { password: body.password || null, ...actor }));
    return true;
  }
  throw new NotFound(`API sconosciuta: ${m} ${url.pathname}`);
}

// ---------------- workspaces, members and tokens (spec §13.10) ----------------

const publicWorkspace = (w) => ({ id: w.id, name: w.name, kind: w.kind, role: w.role, memberCount: (w.members || []).length || 1 });

/** Deletes everything of a workspace: scans, inventories, monitoring. */
async function deleteWorkspaceData(w) {
  const st = storageFor(areaOf(w));
  await st.deleteArea();
  const { monitorStoreFor, monitorArea } = await import('../monitor/engine.js');
  await monitorStoreFor().deleteArea(monitorArea(st));
}

async function handleWorkspaceRoutes(req, res, parts, ctx, user) {
  const ws = ctx.workspaces;
  const m = req.method;
  const actor = { ip: ctx.ip };
  const [, id, sub, subId] = parts;
  if (!id) {
    if (m === 'GET') {
      const list = await ws.listFor(user);
      const { workspace } = await ws.resolve(user, readWorkspaceId(req));
      send(res, 200, { workspaces: list.map(publicWorkspace), current: workspace.id });
      return true;
    }
    if (m === 'POST') {
      const body = await readJson(req);
      send(res, 201, publicWorkspace(await ws.create(user, body.name, actor)));
      return true;
    }
  } else if (id === 'select' && m === 'POST') {
    const body = await readJson(req);
    const { workspace } = await ws.resolve(user, body.id);
    if (body.id && workspace.id !== body.id) throw new NotFound('Spazio di lavoro non trovato');
    send(res, 200, publicWorkspace(workspace), { 'set-cookie': workspaceCookie(workspace.id, ctx.secure) });
    return true;
  } else if (!sub) {
    if (m === 'PUT') {
      const body = await readJson(req);
      send(res, 200, publicWorkspace(await ws.rename(user, id, body.name, actor)));
      return true;
    }
    if (m === 'DELETE') {
      const w = await ws.requireOwner(user, id);
      const busy = await runningJobsOf(storageFor(areaOf(w)));
      if (busy.length) throw Object.assign(new UserError(`Lo spazio ha ${busy.length} job in corso: attendi la fine o annullali`), { status: 409 });
      await ws.remove(user, id, actor);
      await deleteWorkspaceData(w);
      send(res, 200, { ok: true });
      return true;
    }
  } else if (sub === 'members') {
    if (!subId && m === 'GET') {
      send(res, 200, await ws.members(user, id));
      return true;
    }
    if (!subId && m === 'POST') {
      const body = await readJson(req);
      send(res, 201, await ws.addMember(user, id, body.username, body.role, actor));
      return true;
    }
    if (subId && m === 'PUT') {
      const body = await readJson(req);
      await ws.setRole(user, id, subId, body.role, actor);
      send(res, 200, { ok: true });
      return true;
    }
    if (subId && m === 'DELETE') {
      await ws.removeMember(user, id, subId, actor);
      send(res, 200, { ok: true });
      return true;
    }
  } else if (sub === 'tokens') {
    if (!subId && m === 'GET') {
      send(res, 200, await ws.listTokens(user, id));
      return true;
    }
    if (!subId && m === 'POST') {
      const body = await readJson(req);
      send(res, 201, await ws.createToken(user, id, { name: body.name, scope: body.scope, expiresInDays: body.expiresInDays }, actor));
      return true;
    }
    if (subId && m === 'DELETE') {
      await ws.revokeToken(user, id, subId, actor);
      send(res, 200, { ok: true });
      return true;
    }
  }
  throw new NotFound(`API sconosciuta: ${m} ${parts.join('/')}`);
}
