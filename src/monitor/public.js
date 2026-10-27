import crypto from 'node:crypto';
import { monitorStoreFor, monitoringEnabled, monitoringConfig } from './engine.js';
import { monitorRows } from './list.js';
import { windowOccurrences, maintenanceFor, DAY } from '../core/uptime.js';
import { verifyPassword } from '../auth/passwords.js';
import {
  pageHtml, passwordHtml, tvHtml, tvOrder, badgeSvg, badgeValue, componentDays, monitorToComponent, worstStatus,
} from '../core/statuspage.js';

// What the public sees (spec §13.11): the status page, the TV dashboard and the badges. They are asked without a session,
// so they are built from names, statuses and texts written by the team, and from numbers: no URL, cause, address or
// header ever reaches them (RF-PUB-03).

const SHORT_DAYS = 90;

// ---------------- the data ----------------

const dayStart = (t) => Math.floor(t / DAY) * DAY;

/** 90 slots, one a day, of the availability of a component; days with no data are null. */
function slots(days, now) {
  const by = new Map(days.map((d) => [d.day, d.pct]));
  const first = dayStart(now) - (SHORT_DAYS - 1) * DAY;
  return Array.from({ length: SHORT_DAYS }, (_, i) => ({ day: first + i * DAY, pct: by.get(first + i * DAY) ?? null }));
}

const weighted = (perMonitor, from) => {
  let mon = 0, down = 0;
  for (const rows of perMonitor) for (const r of rows) if (r.day >= from) { mon += r.monitoredMs; down += r.downtimeMs; }
  return mon ? (down ? Math.min(Math.floor((1 - down / mon) * 10000) / 100, 99.99) : 100) : null;
};

async function loadBase(store, area, now, tz) {
  const [monitors, windows, daily] = await Promise.all([store.listMonitors(area), store.listWindows(area), store.listAggregatesAll(area, 'daily', dayStart(now) - SHORT_DAYS * DAY, now + DAY)]);
  const rows = await monitorRows(store, area, monitors, { now, windows, tz, period: '30d' });
  const status = new Map(rows.map((r) => [r.id, r.status]));
  const dailyOf = new Map();
  for (const r of daily) (dailyOf.get(r.monitorId) || dailyOf.set(r.monitorId, []).get(r.monitorId)).push(r);
  return { monitors, windows, rows, status, dailyOf };
}

/** The view of a status page: only what the page may show (RF-PUB-01/03). */
export async function pageView(store, area, page, { now = Date.now(), tz = monitoringConfig().tz } = {}) {
  const base = await loadBase(store, area, now, tz);
  const components = page.components.map((c) => {
    const per = c.monitorIds.map((id) => base.dailyOf.get(id) || []);
    return {
      id: c.id, name: c.name,
      status: worstStatus(c.monitorIds.map((id) => monitorToComponent(base.status.get(id)))),
      days: slots(componentDays(per), now), availability: weighted(per, dayStart(now) - SHORT_DAYS * DAY),
    };
  });
  const all = await store.listStatusUpdates(area, page.id, { limit: 60 });
  const recent = all.filter((u) => u.status !== 'resolved' || (u.resolvedAt && now - u.resolvedAt < 14 * DAY));
  const updates = recent.map((u) => ({ title: u.title, status: u.status, components: u.components, posts: u.posts.map((p) => ({ at: p.at, status: p.status, text: p.text })) }));
  // planned maintenance of the next two weeks, with the names of the components it touches and nothing of its own name
  const maintenance = [];
  for (const w of base.windows) {
    for (const [s, e] of windowOccurrences(w, now, now + 14 * DAY, tz)) {
      if (e <= now) continue;
      const touched = page.components.filter((c) => c.monitorIds.some((id) => { const m = base.monitors.find((x) => x.id === id); return m && maintenanceFor([w], m, s, e, tz).length; }));
      if (touched.length) maintenance.push({ start: s, end: e, components: touched.map((c) => c.name) });
    }
  }
  maintenance.sort((a, b) => a.start - b.start);
  return {
    page: { name: page.name, logoUrl: page.logoUrl, siteUrl: page.siteUrl, description: page.description, noindex: page.noindex, components: page.components.map((c) => ({ id: c.id, name: c.name })) },
    components, updates, maintenance: maintenance.slice(0, 10), now, tz,
  };
}

/** The same, as JSON for a program (the same fields, nothing more). */
export const pageJson = (view) => ({
  name: view.page.name, status: worstStatus(view.components.map((c) => c.status)), updatedAt: view.now,
  components: view.components.map((c) => ({ name: c.name, status: c.status, availability90d: c.availability })),
  communications: view.updates, maintenance: view.maintenance,
});

export async function tvView(store, area, link, { now = Date.now(), tz = monitoringConfig().tz } = {}) {
  const base = await loadBase(store, area, now, tz);
  const tags = link.tags || [];
  const rows = base.rows.filter((r) => !r.paused && (!tags.length || r.tags.some((t) => tags.includes(t) || tags.some((x) => t.startsWith(`${x}:`)))));
  return { name: link.name || 'Stato dei servizi', rows: tvOrder(rows.map((r) => ({ name: r.name, status: monitorToComponent(r.status), availability: r.availability }))), now, tz };
}

export async function badgeData(store, area, link, { now = Date.now(), tz = monitoringConfig().tz } = {}) {
  const t = link.target || {};
  if (t.monitorId) {
    const m = await store.getMonitor(area, t.monitorId);
    if (!m) return null;
    const [row] = await monitorRows(store, area, [m], { now, windows: await store.listWindows(area), tz, period: '30d' });
    return { status: monitorToComponent(row.status), availability: row.availability };
  }
  const page = await store.getStatusPage(area, t.pageId);
  const comp = page && page.components.find((c) => c.id === t.componentId);
  if (!comp) return null;
  const base = await loadBase(store, area, now, tz);
  return {
    status: worstStatus(comp.monitorIds.map((id) => monitorToComponent(base.status.get(id)))),
    availability: weighted(comp.monitorIds.map((id) => base.dailyOf.get(id) || []), dayStart(now) - 30 * DAY),
  };
}

// ---------------- the cookie of a protected page ----------------

const COOKIE_PREFIX = 'sc_sp_';
const sessionValue = (page, exp) => `${exp}.${crypto.createHmac('sha256', page.passwordHash).update(`${page.slug}.${exp}`).digest('base64url')}`;
export const passwordCookie = (page, now = Date.now(), secure = false) => `${COOKIE_PREFIX}${page.slug}=${sessionValue(page, now + 12 * 3600000)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 3600}${secure ? '; Secure' : ''}`;
export function hasAccess(page, cookieHeader, now = Date.now()) {
  if (!page.passwordHash) return true;
  for (const part of String(cookieHeader || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === `${COOKIE_PREFIX}${page.slug}`) {
      const v = part.slice(i + 1).trim();
      const exp = Number(v.split('.')[0]);
      const want = Buffer.from(sessionValue(page, exp)), got = Buffer.from(v);
      return exp > now && want.length === got.length && crypto.timingSafeEqual(want, got);
    }
  }
  return false;
}

// ---------------- the public routes ----------------

const hits = new Map();
const PER_IP = 120, FAILS = 10;
function allowed(key, limit, now, windowMs = 60000) {
  const list = (hits.get(key) || []).filter((t) => t > now - windowMs);
  if (list.length >= limit) { hits.set(key, list); return false; }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => t > now - 600000)) hits.delete(k);
  return true;
}

/** For the tests: forgets the requests counted so far. */
export const resetPublicLimits = () => hits.clear();

const PUBLIC_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function reply(res, status, type, body, { cache = 'no-store', noindex = true, headers = {} } = {}) {
  const etag = status === 200 ? `"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 20)}"` : null;
  res.writeHead(status, {
    'content-type': type, 'cache-control': cache, 'content-security-policy': PUBLIC_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    ...(noindex ? { 'x-robots-tag': 'noindex, nofollow' } : {}), ...(etag ? { etag } : {}), ...headers,
  });
  res.end(body);
}

const notFound = (res) => reply(res, 404, 'text/plain; charset=utf-8', 'Non trovato');
const HTML = 'text/html; charset=utf-8';

/** The cache of the open pages: the CDN keeps them for 30 seconds, and the page reloads itself (a change shows within a minute). */
const OPEN_CACHE = 'public, max-age=0, s-maxage=30, stale-while-revalidate=120';

/**
 * `/status/<slug>[.json]`, `/tv/<token>[.json]`, `/badge/<token>.svg`, or `page` given by the custom domain (served at `/`).
 * Returns false for other paths. Without a session, with a limit on the requests of each address.
 */
export async function handlePublic(req, res, url, { ip = null, secure = false, domainPage = null } = {}) {
  const path = url.pathname;
  const m = /^\/status\/([a-z0-9-]{3,40})(\.json)?\/?$/.exec(path) || /^\/(tv)\/([A-Za-z0-9_-]{16,64})(\.json)?$/.exec(path) || /^\/(badge)\/([A-Za-z0-9_-]{16,64})\.svg$/.exec(path);
  if (!m && !domainPage) return false;
  if (!monitoringEnabled()) return reply(res, 404, 'text/plain; charset=utf-8', 'Monitoraggio non attivo'), true;
  if (!['GET', 'HEAD', 'POST'].includes(req.method)) return reply(res, 405, 'text/plain; charset=utf-8', 'Metodo non ammesso'), true;
  const now = Date.now();
  if (!allowed(`ip:${ip}`, PER_IP, now)) return reply(res, 429, 'text/plain; charset=utf-8', 'Troppe richieste: riprova tra un minuto'), true;
  const store = monitorStoreFor();
  const notModified = (body) => req.headers['if-none-match'] && body && req.headers['if-none-match'] === `"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 20)}"`;

  // ---- badge
  if (m && m[1] === 'badge') {
    const found = await store.findPublicLink(m[2]);
    if (!found || found.link.kind !== 'badge') return notFound(res), true;
    const data = await badgeData(store, found.area, found.link, { now });
    const { value, tone } = data ? badgeValue(data.status, data.availability) : badgeValue('unknown', null);
    const svg = badgeSvg({ label: url.searchParams.get('label') ? String(url.searchParams.get('label')).slice(0, 24) : 'stato', value, tone });
    return reply(res, 200, 'image/svg+xml; charset=utf-8', svg, { cache: 'public, max-age=60, s-maxage=60' }), true;
  }
  // ---- TV dashboard
  if (m && m[1] === 'tv') {
    const found = await store.findPublicLink(m[2]);
    if (!found || found.link.kind !== 'tv') return notFound(res), true;
    const view = await tvView(store, found.area, found.link, { now });
    if (m[3]) return reply(res, 200, 'application/json; charset=utf-8', JSON.stringify({ name: view.name, updatedAt: now, rows: view.rows }), { cache: 'private, no-store' }), true;
    return reply(res, 200, HTML, tvHtml(view), { cache: 'private, no-store' }), true;
  }
  // ---- status page
  const found = domainPage || (m && (await store.findStatusPage({ slug: m[1] })));
  if (!found) return notFound(res), true;
  const { area, page } = found;
  const json = !!(m && m[2]);
  if (page.passwordHash && !hasAccess(page, req.headers.cookie, now)) {
    if (req.method === 'POST') {
      if (!allowed(`pw:${ip}`, FAILS, now, 600000)) return reply(res, 429, 'text/plain; charset=utf-8', 'Troppi tentativi: riprova tra qualche minuto'), true;
      let body = '';
      for await (const c of req) { body += c; if (body.length > 2048) break; }
      const pw = new URLSearchParams(body).get('password') || '';
      if (await verifyPassword(pw, page.passwordHash)) {
        res.writeHead(303, { location: url.pathname, 'set-cookie': passwordCookie(page, now, secure), 'cache-control': 'no-store' });
        return res.end(), true;
      }
      return reply(res, 401, HTML, passwordHtml(page, { error: true })), true;
    }
    return reply(res, json ? 401 : 200, json ? 'application/json; charset=utf-8' : HTML, json ? '{"error":"Pagina protetta da password"}' : passwordHtml(page)), true;
  }
  const view = await pageView(store, area, page, { now });
  const body = json ? JSON.stringify(pageJson(view)) : pageHtml(view);
  const cache = page.passwordHash ? 'private, no-store' : OPEN_CACHE;
  if (notModified(body)) return res.writeHead(304, { etag: req.headers['if-none-match'], 'cache-control': cache }), res.end(), true;
  return reply(res, 200, json ? 'application/json; charset=utf-8' : HTML, body, { cache, noindex: page.noindex }), true;
}

/** The page served at the root of a custom domain (RF-PUB-04), if the host is one. */
export async function domainPageFor(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
  if (!h || !monitoringEnabled()) return null;
  return monitorStoreFor().findStatusPage({ domain: h });
}
