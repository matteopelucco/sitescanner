import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootDir, UserError, validSiteId } from './config.js';
import { handleApi, send } from './api.js';
import { storageFor, initStorage } from './storage/index.js';
import { currentVercelBackend } from './storage/vercel/backend.js';
import { cleanupOrphans } from './storage/vercel/storage.js';
import { runRound, monitoringEnabled } from './monitor/engine.js';
import { handleNotifyPublic, handleHeartbeatPublic, handleInternalCheck } from './monitor/api.js';
import { handleAgentPublic } from './monitor/agent.js';
import { handlePublic, domainPageFor } from './monitor/public.js';
import { Workspaces, areaOf } from './auth/workspaces.js';
import { allowedRequest } from './core/workspaces.js';
import { handleApiV1 } from './api-v1.js';
import { areaPolicy } from './policy.js';
import { Auth, publicUser } from './auth/index.js';
import { handleAuthApi, readSessionToken, readWorkspaceId, OPEN_WITH_TEMP_PASSWORD } from './auth/http.js';
import { renderIndexHtml, reportIndex, indexJs, scanJs, textJs } from './report/build.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
};

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
// Pure modules of src/core/ that the web app imports as they are (no dependencies, no I/O)
const coreFile = (name) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'core', name);
const SHARED = { '/app/assertions.js': coreFile('assertions.js'), '/app/mapoverlay.js': coreFile('mapoverlay.js') };
const appFile = (pathname) => (pathname === '/' ? path.join(webDir, 'index.html') : SHARED[pathname] || within(webDir, pathname.slice('/app'.length)));
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
// Files of the web app reachable without a session in multi-user mode (login page).
const PUBLIC_APP_FILES = new Set(['/app/login.js', '/app/app.css']);

/** Whether the web app runs with accounts: always on Vercel, locally with SITESCANNER_AUTH=1 (spec §10). */
export const multiUserMode = () => process.env.VERCEL === '1' || process.env.SITESCANNER_AUTH === '1';

function sendFile(req, res, file, cache = 'no-cache') {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'content-length': st.size, 'cache-control': cache });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function sendText(res, status, body, type = 'text/plain; charset=utf-8', cache = 'no-store') {
  res.writeHead(status, { 'content-type': type, 'cache-control': cache }).end(body);
}

// Inside `root`, or null (path traversal, other folders).
function within(root, pathname) {
  const file = path.join(root, path.normalize(pathname));
  return file === root || file.startsWith(root + path.sep) ? file : null;
}

function apiError(res, e, { hideInternal = false } = {}) {
  const user = e instanceof UserError;
  if (!user) console.error(e);
  if (res.headersSent) return res.end();
  // RF-SEC-07: in multi-user mode unexpected errors do not expose internals
  const body = { error: user || !hideInternal ? e.message : 'Errore interno del server' };
  if (e.mustChangePassword) body.mustChangePassword = true;
  send(res, e.status || (user ? 400 : 500), body);
}

// Writes must come from the app itself: same Origin, JSON body (ADR-0012, RF-SEC-04).
function writeAllowed(req, origin) {
  if (['GET', 'HEAD'].includes(req.method)) return true;
  const o = req.headers.origin;
  const json = /^application\/json\b/i.test(req.headers['content-type'] || '');
  return !(o && o !== origin) && (req.method === 'DELETE' || json);
}

// ---------------- single user (working folder, no login) ----------------

function singleUserHandler({ root, hostCheck }) {
  const allowed = ['report', 'data'].map((d) => path.join(root, d));
  return async (req, res, url) => {
    const pathname = url.pathname;
    if (hostCheck) {
      const h = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (!LOOPBACK.has(h)) return sendText(res, 403, 'Host non ammesso');
    }
    if (pathname.startsWith('/status/') || pathname.startsWith('/tv/') || pathname.startsWith('/badge/')) {
      try {
        if (await handlePublic(req, res, url, { ip: req.socket.remoteAddress })) return;
      } catch (e) {
        return apiError(res, e, { hideInternal: true });
      }
    }
    if (pathname.startsWith('/api/check/')) {
      try {
        if (await handleInternalCheck(req, res, url)) return;
      } catch (e) {
        return apiError(res, e, { hideInternal: true });
      }
    }
    if (pathname.startsWith('/api/agent/')) {
      try {
        if (await handleAgentPublic(req, res, url)) return;
      } catch (e) {
        return apiError(res, e, { hideInternal: true });
      }
    }
    if (pathname.startsWith('/hb/')) {
      try {
        if (await handleHeartbeatPublic(req, res, url, { ip: req.socket.remoteAddress })) return;
      } catch (e) {
        return apiError(res, e, { hideInternal: true });
      }
    }
    if (pathname.startsWith('/api/')) {
      if (!writeAllowed(req, `http://${req.headers.host}`)) return send(res, 403, { error: 'Richiesta non ammessa' });
      try {
        if (await handleNotifyPublic(req, res, url)) return;
        await handleApi(req, res, url);
      } catch (e) {
        apiError(res, e);
      }
      return;
    }
    if (pathname === '/report') return res.writeHead(302, { location: '/report/' }).end();
    if (pathname === '/' || pathname.startsWith('/app/')) {
      const file = appFile(pathname);
      return file ? sendFile(req, res, file) : res.writeHead(404).end('Not found');
    }
    let file = within(root, pathname);
    if (!file || !allowed.some((a) => file === a || file.startsWith(a + path.sep))) return res.writeHead(404).end('Not found');
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    sendFile(req, res, file);
  };
}

// ---------------- multi user (accounts, private areas) ----------------

// RF-SEC-05. The report inlines its scripts and styles (one self-contained file), hence 'unsafe-inline';
// site content is always rendered as text (RF-SEC-06).
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function securityHeaders(res, secure) {
  res.setHeader('content-security-policy', CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('x-frame-options', 'DENY');
  if (secure) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
}

// RF-MON-19: on Vercel, without an external dead man's switch nobody notices that the rounds stopped.
const adminWarnings = (user) => (user.role === 'admin' && process.env.VERCEL === '1' && !process.env.SITESCANNER_HEARTBEAT_URL ? ['Nessun controllo esterno del monitoraggio: imposta SITESCANNER_HEARTBEAT_URL (es. healthchecks.io) per sapere se i giri di controllo si fermano.'] : []);

const enc = encodeURIComponent;
const isPage = (req, pathname) => req.method === 'GET' && (pathname === '/' || pathname === '/report' || pathname === '/report/');

/** Serves the report of the user's area: the page, its data scripts and the scan files (RF-ISO-04). */
async function serveReport(req, res, pathname, st) {
  if (pathname === '/report') return res.writeHead(302, { location: '/report/' }).end();
  if (pathname === '/report/') return sendText(res, 200, renderIndexHtml(), TYPES['.html']);
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'report' && parts[1] === 'data') {
    if (parts.length === 3 && parts[2] === 'index.js') {
      const index = await reportIndex(st, {
        assetsFor: async (site, id) => `/files/${enc(site)}/${enc(id)}/`,
        hasText: async (site, meta) => !!(meta.options && meta.options.text),
      });
      return sendText(res, 200, indexJs(index), TYPES['.js'], 'private, no-cache');
    }
    const m = parts.length === 4 && /^(.+?)(\.text)?\.js$/.exec(parts[3]);
    if (m && validSiteId(parts[2])) {
      const [site, id, text] = [parts[2], m[1], !!m[2]];
      const immutable = 'private, max-age=31536000, immutable';
      if (text) {
        const raw = await st.readScanFile(site, id, 'text.json');
        return raw ? sendText(res, 200, textJs(site, id, raw), TYPES['.js'], immutable) : sendText(res, 404, 'Not found');
      }
      // The label overlay can change: revalidate the scan script.
      const scan = await st.loadScan(site, id).catch(() => null);
      return scan ? sendText(res, 200, scanJs(site, id, scan), TYPES['.js'], 'private, no-cache') : sendText(res, 404, 'Not found');
    }
  }
  if (parts[0] === 'files' && parts.length >= 4) {
    const [, site, id, ...rel] = parts;
    const buf = await st.readScanFile(site, id, rel.join('/'));
    if (!buf) return sendText(res, 404, 'Not found');
    res.writeHead(200, { 'content-type': TYPES[path.extname(rel[rel.length - 1])] || 'application/octet-stream', 'content-length': buf.length, 'cache-control': 'private, max-age=31536000, immutable' });
    return res.end(req.method === 'HEAD' ? undefined : buf);
  }
  return sendText(res, 404, 'Not found');
}

/**
 * Daily maintenance (Vercel Cron, RF-STO-02, RF-RUN-07): expired sessions, orphan blobs.
 * Vercel calls it with `Authorization: Bearer $CRON_SECRET`.
 */
async function dailyMaintenance(req, res, auth) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return send(res, 401, { error: 'Non autorizzato' });
  await auth.pruneSessions();
  const backend = currentVercelBackend();
  const orphans = backend ? await cleanupOrphans(backend) : 0;
  // RF-RPT-03: on the first day of the month, the reports of the previous one
  let reports = [];
  if (monitoringEnabled()) reports = await (await import('./monitor/reports.js')).sendMonthlyReports().catch((e) => { console.error(`Report mensili: ${e.message}`); return []; });
  send(res, 200, { ok: true, orphans, reports: reports.length });
}

/** Monitoring areas of the active admins: they receive the alerts about the monitor itself (RF-MON-13). */
export async function adminAreas(auth) {
  const { monitorArea } = await import('./monitor/engine.js');
  return (await auth.listUsers()).filter((u) => u.role === 'admin' && u.active).map((u) => monitorArea(storageFor(u)));
}

/** A round of monitoring checks (Vercel Cron every 5 minutes, RF-MON-17), with the same secret. */
async function monitorRound(req, res, auth) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return send(res, 401, { error: 'Non autorizzato' });
  if (!monitoringEnabled()) return send(res, 404, { error: 'Monitoraggio non attivo' });
  const { events, ...beat } = await runRound({ adminAreas: await adminAreas(auth) });
  send(res, 200, { ok: true, ...beat, events: events.length });
}

function multiUserHandler({ root, trustProxy, authStore }) {
  let auth = null, workspaces = null;
  const ready = Promise.resolve(authStore || initStorage({ root })).then((store) => {
    auth = new Auth(store);
    workspaces = new Workspaces(auth);
    return auth.bootstrap().catch((e) => console.error(`Primo admin non creato: ${e.message}`));
  });
  let lastPrune = 0;
  return async (req, res, url) => {
    await ready;
    const pathname = url.pathname;
    const secure = trustProxy ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' : !!req.socket.encrypted;
    const ip = (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || null;
    const origin = `${secure ? 'https' : 'http'}://${req.headers.host}`;
    securityHeaders(res, secure);

    if (Date.now() - lastPrune > 3600 * 1000) {
      lastPrune = Date.now();
      auth.pruneSessions().catch(() => {});
    }

    if (pathname === '/api/cron/daily' && req.method === 'GET') return dailyMaintenance(req, res, auth).catch((e) => apiError(res, e, { hideInternal: true }));
    if (pathname === '/api/cron/monitor' && req.method === 'GET') return monitorRound(req, res, auth).catch((e) => apiError(res, e, { hideInternal: true }));

    // the public pages, with no session (RF-PUB-01..06); a custom domain shows its page at the root (RF-PUB-04)
    if (pathname.startsWith('/status/') || pathname.startsWith('/tv/') || pathname.startsWith('/badge/') || (['/', '/status.json'].includes(pathname) && ['GET', 'POST'].includes(req.method) && /\.[a-z]{2,}$/i.test(String(req.headers.host || '').replace(/:\d+$/, '')))) {
      try {
        const domainPage = !pathname.startsWith('/status/') && !pathname.startsWith('/tv/') && !pathname.startsWith('/badge/') ? await domainPageFor(req.headers.host) : null;
        if ((domainPage || !['/', '/status.json'].includes(pathname)) && (await handlePublic(req, res, domainPage && pathname === '/status.json' ? new URL(`${url.origin}/status/${domainPage.page.slug}.json`) : url, { ip, secure, domainPage }))) return;
      } catch (e) {
        return apiError(res, e, { hideInternal: true });
      }
    }
    if (pathname.startsWith('/api/check/')) {
      try {
        if (await handleInternalCheck(req, res, url)) return;
      } catch (e) {
        return apiError(res, e, { hideInternal: true });
      }
    }
    if (pathname.startsWith('/api/agent/')) {
      try {
        if (await handleAgentPublic(req, res, url)) return;
      } catch (e) {
        return apiError(res, e, { hideInternal: true });
      }
    }
    if (pathname.startsWith('/hb/')) {
      try {
        if (await handleHeartbeatPublic(req, res, url, { ip })) return;
      } catch (e) {
        return apiError(res, e, { hideInternal: true });
      }
    }

    if (pathname.startsWith('/api/notify/') || pathname.startsWith('/api/telegram/')) {
      try {
        if (await handleNotifyPublic(req, res, url)) return;
      } catch (e) {
        return apiError(res, e, { hideInternal: true });
      }
    }

    // Login page and its files: the only content reachable without a session (RF-AUTH-01)
    if (pathname === '/login' && req.method === 'GET') return sendFile(req, res, path.join(webDir, 'login.html'), 'no-store');
    if (PUBLIC_APP_FILES.has(pathname)) return sendFile(req, res, path.join(webDir, pathname.slice('/app'.length)));

    const token = readSessionToken(req, secure);
    const session = await auth.authenticate(token);

    // programs use /api/v1 with the token of a workspace, no session (RF-TEAM-04)
    if (pathname.startsWith('/api/v1/')) {
      try {
        if (!writeAllowed(req, origin)) return send(res, 403, { error: 'Richiesta non ammessa' });
        const bearer = /^Bearer (sst_[\w-]+)$/.exec(String(req.headers.authorization || ''));
        if (!bearer) return send(res, 401, { error: 'Serve un token API: Authorization: Bearer sst_…' });
        const t = await workspaces.authenticateToken(bearer[1]);
        if (!t) return send(res, 401, { error: 'Token non valido o scaduto' });
        return await handleApiV1(req, res, url, { st: storageFor(areaOf(t.workspace, t.user)), workspace: t.workspace, role: t.role, token: t.token, user: t.user });
      } catch (e) {
        return apiError(res, e, { hideInternal: true });
      }
    }

    if (pathname.startsWith('/api/')) {
      try {
        if (!writeAllowed(req, origin)) return send(res, 403, { error: 'Richiesta non ammessa' });
        const route = pathname.split('/').filter(Boolean).slice(1).join('/');
        if (route !== 'login') {
          if (!session) return send(res, 401, { error: 'Accesso richiesto' });
          if (session.user.mustChangePassword && !OPEN_WITH_TEMP_PASSWORD.has(route)) {
            return send(res, 403, { error: 'Devi cambiare la password temporanea prima di continuare', mustChangePassword: true });
          }
        }
        if (await handleAuthApi(req, res, url, { auth, ip, secure, session, token, workspaces })) return;
        // the workspace the user works in (RF-TEAM-01): the personal one unless the selector says otherwise and they are a member
        const { workspace, role } = await workspaces.resolve(session.user, readWorkspaceId(req));
        const gate = allowedRequest(role, req.method, route);
        if (!gate.ok) return send(res, 403, { error: gate.reason });
        const st = storageFor(areaOf(workspace, session.user));
        const policy = areaPolicy(st);
        await handleApi(req, res, url, {
          storage: st,
          rebuildReport: false,
          maxJobs: policy.maxJobs || Infinity,
          // polling: job progress comes from the storage, shared by all the function instances (RF-RUN-05)
          extra: { mode: 'multi', user: publicUser(session.user), workspace: { id: workspace.id, name: workspace.name, kind: workspace.kind, role }, polling: !!st.persistsJobs, warnings: adminWarnings(session.user), limits: { maxPages: policy.maxPages, maxConcurrency: policy.maxConcurrency } },
        });
      } catch (e) {
        apiError(res, e, { hideInternal: true });
      }
      return;
    }

    if (!session) {
      if (isPage(req, pathname)) return res.writeHead(302, { location: `/login?next=${enc(pathname + url.search)}` }).end();
      return sendText(res, 401, 'Accesso richiesto');
    }
    if (pathname === '/' || pathname.startsWith('/app/')) {
      const file = appFile(pathname);
      return file ? sendFile(req, res, file) : sendText(res, 404, 'Not found');
    }
    if (session.user.mustChangePassword) return sendText(res, 403, 'Devi cambiare la password temporanea');
    if (pathname === '/report' || pathname.startsWith('/report/') || pathname.startsWith('/files/')) {
      try {
        return await serveReport(req, res, pathname, storageFor(areaOf((await workspaces.resolve(session.user, readWorkspaceId(req))).workspace, session.user)));
      } catch (e) {
        if (!(e instanceof UserError)) console.error(e);
        return sendText(res, e instanceof UserError ? 404 : 500, e instanceof UserError ? 'Not found' : 'Errore interno del server');
      }
    }
    sendText(res, 404, 'Not found');
  };
}

/**
 * Request handler of the web app. Single-user (default locally): working folder, no login (ADR-0012).
 * Multi-user: accounts and private areas (spec §10, ADR-0016).
 *   /            web app (src/web)          /login     login page (multi-user)
 *   /api/…       JSON API (api.js, auth/http.js)
 *   /report/…    report; single-user: static files and /data/…; multi-user: generated per user, files under /files/…
 */
export function createHandler({ root = rootDir(), multi = multiUserMode(), hostCheck = false, trustProxy = process.env.VERCEL === '1' || process.env.SITESCANNER_TRUST_PROXY === '1', authStore = null } = {}) {
  const handler = multi
    ? multiUserHandler({ root, trustProxy, authStore })
    : singleUserHandler({ root, hostCheck });
  return async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://x');
      url.pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    try {
      await handler(req, res, url);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Errore interno del server');
    }
  };
}

/**
 * Starts the web app server. On a loopback address only requests addressed to localhost are accepted
 * (DNS rebinding); in multi-user mode the session protects every route instead.
 */
export function serve({ port = 4173, host = '127.0.0.1', multi = multiUserMode() } = {}) {
  const server = http.createServer(createHandler({ multi, hostCheck: !multi && LOOPBACK.has(host) }));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
