import crypto from 'node:crypto';
import path from 'node:path';
import { rootDir, UserError } from '../config.js';
import { currentVercelBackend } from '../storage/vercel/backend.js';
import { networkGuardEnabled } from '../net-guard.js';
import { FsMonitorStore } from './store-fs.js';
import { PgMonitorStore } from './store-pg.js';
import { performCheck, certInfo, describeError, NETWORK_CLASSES } from './check.js';
import {
  HOUR, DAY, MONITOR_INTERVALS, parseExpect, maintenanceFor, inIntervals, monitoredTime, incidentIntervals, intersect, clip, total,
  hourlyAggregates, dailyAggregates, kpis, addHistograms, BOUNDS, certDaysLeft, spreadDelayMs, health, errorBudget,
} from '../core/uptime.js';

// Monitoring (spec §12): monitors of an area, rounds of checks, incidents, aggregates, KPIs.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envInt = (name, def) => (process.env[name] !== undefined && process.env[name] !== '' && Number(process.env[name]) >= 0 ? Number(process.env[name]) : def);
const newId = () => crypto.randomBytes(5).toString('hex');

/** Monitoring runs on Vercel; locally only for development (RF-MON-18). */
export const monitoringEnabled = () => process.env.VERCEL === '1' || process.env.SITESCANNER_MONITOR_DEV === '1';

export const monitoringConfig = () => ({
  rawDays: envInt('SITESCANNER_MON_RAW_DAYS', 30),
  maxMonitors: envInt('SITESCANNER_MAX_MONITORS_PER_USER', 200),
  retryMs: envInt('SITESCANNER_MON_RETRY_MS', 10000),
  spread: process.env.SITESCANNER_MON_SPREAD !== '0',
  budgetMs: envInt('SITESCANNER_MON_BUDGET_MS', 240000),
  canaries: (process.env.SITESCANNER_MON_CANARIES || 'https://www.google.com/generate_204,https://www.cloudflare.com/cdn-cgi/trace').split(',').map((s) => s.trim()).filter(Boolean),
  heartbeatUrl: process.env.SITESCANNER_HEARTBEAT_URL || null,
  tz: process.env.SITESCANNER_TZ || 'Europe/Rome',
});

/** The store that goes with the active storage backend. */
export function monitorStoreFor(root = rootDir()) {
  const b = currentVercelBackend();
  return b ? new PgMonitorStore(b) : new FsMonitorStore(root);
}

/** The monitoring area of a storage area: '' (working folder), the username (filesystem) or the user id (Vercel). */
export const monitorArea = (st) => (st.kind === 'vercel' ? st.area : st.isolated ? path.basename(st.root) : '');

// Private destinations are refused for accounts (RF-SEC-01), not for the working folder.
const guardFor = (area) => (area ? networkGuardEnabled(true) : false);

// ---------------- monitors ----------------

const DEFAULTS = { intervalMin: 5, timeoutS: 30, method: 'GET', expect: '200-399', keyword: null, headers: {}, auth: null, slowMs: null, notifySlow: false, sslDays: [30, 14, 7, 1], notifyDelayMin: 0, reminderMin: null, channels: null, tags: [], slaPct: 99.9, paused: false, source: null };

const usesEnv = (v) => (typeof v === 'string' ? /\$\{\w+\}/.test(v) : v && typeof v === 'object' ? Object.values(v).some(usesEnv) : false);
const bad = (msg) => new UserError(msg);

/** Validates and normalizes a monitor from the form (RF-MON-01, table of §12.2). */
export function normalizeMonitor(input, existing = null, { isolated = false } = {}) {
  const m = { ...DEFAULTS, ...(existing || {}), ...(input || {}) };
  let u;
  try { u = new URL(String(m.url || '').trim()); } catch { throw bad(`URL non valido: ${m.url || '(vuoto)'}`); }
  if (!/^https?:$/.test(u.protocol)) throw bad('Solo URL http o https');
  m.url = u.toString();
  m.name = String(m.name || '').trim().slice(0, 80) || u.host;
  m.intervalMin = Number(m.intervalMin);
  if (!MONITOR_INTERVALS.includes(m.intervalMin)) throw bad(`Intervallo non valido: ammessi ${MONITOR_INTERVALS.join(', ')} minuti`);
  m.timeoutS = Number(m.timeoutS);
  if (!(m.timeoutS >= 5 && m.timeoutS <= 60)) throw bad('Timeout tra 5 e 60 secondi');
  if (!['GET', 'HEAD'].includes(m.method)) throw bad('Metodo GET o HEAD');
  m.expect = String(m.expect || '200-399').replace(/\s+/g, '');
  if (!parseExpect(m.expect)) throw bad(`Status attesi non validi: ${m.expect} (es. 200-399 oppure 200,301)`);
  if (m.keyword && m.keyword.text) {
    m.keyword = { text: String(m.keyword.text).slice(0, 200), mode: m.keyword.mode === 'absent' ? 'absent' : 'present', caseInsensitive: !!m.keyword.caseInsensitive };
    if (m.method === 'HEAD') throw bad('La keyword richiede il metodo GET');
  } else m.keyword = null;
  m.headers = Object.fromEntries(Object.entries(m.headers || {}).map(([k, v]) => [String(k), String(v)]));
  m.auth = m.auth && m.auth.username ? { username: String(m.auth.username), password: String(m.auth.password || '') } : null;
  if (isolated && (usesEnv(m.headers) || usesEnv(m.auth))) throw bad("Le variabili d'ambiente (${…}) non sono disponibili in modalità multi-utente");
  m.slowMs = m.slowMs ? Number(m.slowMs) : null;
  if (m.slowMs != null && !(m.slowMs > 0)) throw bad('Soglia di lentezza in millisecondi');
  m.sslDays = [...new Set((m.sslDays || []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 365))].sort((a, b) => b - a);
  m.notifyDelayMin = Number(m.notifyDelayMin || 0);
  if (!(m.notifyDelayMin >= 0 && m.notifyDelayMin <= 1440)) throw bad('Ritardo di notifica tra 0 e 1440 minuti');
  m.reminderMin = m.reminderMin ? Number(m.reminderMin) : null;
  if (m.reminderMin != null && !(m.reminderMin >= 15)) throw bad('Promemoria ogni 15 minuti o più');
  m.channels = Array.isArray(m.channels) ? m.channels.map(String) : null;
  m.tags = [...new Set((m.tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
  m.slaPct = Number(m.slaPct);
  if (!(m.slaPct >= 90 && m.slaPct <= 100)) throw bad('Obiettivo di disponibilità tra 90 e 100%');
  m.paused = !!m.paused;
  m.notifySlow = !!m.notifySlow;
  m.id ||= newId();
  m.createdAt ||= Date.now();
  m.state ||= { status: 'pending', since: m.createdAt, nextCheckAt: 0 };
  return m;
}

/** Status shown for a monitor (§12.4). */
export function displayStatus(m, now, maint) {
  if (m.paused) return 'paused';
  if (inIntervals(now, maint)) return 'maintenance';
  if (m.state.openIncident) return 'down';
  if (!m.state.lastCheckAt) return 'pending';
  return m.state.slow ? 'slow' : 'up';
}

// ---------------- checks and state ----------------

/** One check with the confirmation retry (RF-MON-12) and, once a day, the certificate (RF-MON-16). */
export async function checkMonitor(m, { guard, retryMs, now = Date.now }) {
  let r = await performCheck(m, { guard, now });
  if (r.outcome === 'error') {
    if (retryMs) await sleep(retryMs);
    const again = await performCheck(m, { guard, now });
    r = again.outcome === 'error' ? { ...again, at: r.at, retried: true } : { ...again, retried: true };
  }
  if (m.url.startsWith('https:') && (!m.state.cert || now() - (m.state.cert.checkedAt || 0) > DAY)) {
    const c = await certInfo(r.finalUrl || m.url, { guard });
    if (c) m.state.cert = { ...c, checkedAt: now() };
  }
  if (r.outcome !== 'error' && m.state.cert && m.state.cert.expiresAt < r.at) {
    Object.assign(r, { outcome: 'error', errorClass: 'tls', error: 'certificato scaduto' });
  }
  return r;
}

const causeOf = (r, m) => ({ at: r.at, class: r.errorClass, status: r.status, message: describeError(r, m.timeoutS) });

/**
 * Applies a check to the monitor: stores it, opens or closes incidents (§12.4), records the events
 * to notify (§12.5) and plans the next check. Maintenance (RF-MNT-03/04) keeps checks but no incidents
 * nor alerts.
 */
export async function applyResult(store, area, m, r, { windows = [], tz }) {
  const maint = maintenanceFor(windows, m, r.at - DAY, r.at + DAY, tz);
  const inMaint = inIntervals(r.at, maint);
  const s = m.state;
  const events = [];
  const ev = (type, extra = {}) => events.push({ type, at: r.at, monitorId: m.id, monitorName: m.name, url: m.url, ...extra });
  await store.addCheck(area, m.id, { at: r.at, outcome: r.outcome, status: r.status, ms: r.ms, ttfbMs: r.ttfbMs, finalUrl: r.finalUrl, errorClass: r.errorClass, error: r.error, retried: !!r.retried });
  s.lastCheckAt = r.at;
  s.lastOutcome = r.outcome;
  s.lastMs = r.ms;
  s.lastError = r.outcome === 'error' ? causeOf(r, m) : null;
  // a 5-minute monitor is due at every 5-minute round, even if the previous round started a bit late
  s.nextCheckAt = r.at + m.intervalMin * 60000 - 60000;

  if (r.outcome !== 'error') {
    s.slowStreak = r.outcome === 'slow' ? (s.slowStreak || 0) + 1 : 0;
    const wasSlow = !!s.slow;
    s.slow = !!m.slowMs && s.slowStreak >= 3;
    if (s.slow && !wasSlow && m.notifySlow && !inMaint) ev('slow', { ms: r.ms, slowMs: m.slowMs });
    if (s.openIncident) {
      const inc = await store.getIncident(area, s.openIncident);
      if (inc) {
        inc.end = r.at;
        inc.closedBy = 'ok';
        await store.saveIncident(area, inc);
        if (!inMaint) ev('up', { incidentId: inc.id, durationMs: inc.end - inc.start, cause: inc.cause });
      }
      s.openIncident = null;
      s.since = r.at;
    } else if (!s.status || s.status === 'pending') s.since = r.at;
  } else if (!inMaint) {
    const cause = causeOf(r, m);
    if (!s.openIncident) {
      const inc = { id: newId(), monitorId: m.id, start: r.at, end: null, cause, causes: [cause], excerpt: r.excerpt || null, note: '', notifications: [] };
      await store.saveIncident(area, inc);
      s.openIncident = inc.id;
      s.since = r.at;
      s.slowStreak = 0;
      s.slow = false;
      ev('down', { incidentId: inc.id, cause });
    } else {
      const inc = await store.getIncident(area, s.openIncident);
      const last = inc && inc.causes[inc.causes.length - 1];
      if (inc && last && (last.class !== cause.class || last.status !== cause.status)) {
        inc.causes.push(cause);
        await store.saveIncident(area, inc);
      }
    }
  }

  // certificate expiry (RF-NOT-01): each threshold once per certificate
  if (s.cert && s.cert.expiresAt) {
    const days = certDaysLeft(s.cert.expiresAt, r.at);
    const sent = s.certNotified && s.certNotified.expiresAt === s.cert.expiresAt ? s.certNotified.sent : [];
    // only the closest threshold passed is notified; the larger ones count as sent
    const passed = days < 0 ? ['expired', ...m.sslDays] : m.sslDays.filter((d) => days <= d);
    const due = days < 0 ? 'expired' : passed.length ? Math.min(...passed) : null;
    if (due !== null && !sent.includes(due) && (days < 0 || m.sslDays.length)) {
      s.certNotified = { expiresAt: s.cert.expiresAt, sent: [...new Set([...sent, ...passed])] };
      ev(days < 0 ? 'cert-expired' : 'cert', { days, expiresAt: s.cert.expiresAt, issuer: s.cert.issuer });
    }
  }
  s.status = displayStatus(m, r.at, maint);
  await store.saveMonitor(area, m);
  for (const e of events) await store.addEvent(area, e);
  return events;
}

// ---------------- rounds ----------------

/**
 * One round of checks (RF-MON-17/18): the due monitors of every area, a few at a time and at most
 * two per host (RF-MON-14), then the protection from mass false downs (RF-MON-13), the heartbeat
 * (RF-MON-19), the aggregates and, once a day, the retention (RF-MST-01/02).
 */
export async function runRound({ store = monitorStoreFor(), now = Date.now, config = monitoringConfig(), concurrency = 20, adminAreas = [''], notify = true } = {}) {
  const t0 = now();
  const due = await store.dueMonitors(t0);
  const claimed = [];
  for (const d of due) if (await store.claimMonitor(d.area, d.monitor.id, t0 + config.budgetMs + 120000, t0)) claimed.push(d);

  const windowsOf = new Map();
  for (const area of new Set(claimed.map((d) => d.area))) windowsOf.set(area, await store.listWindows(area));

  // checks, spread in the round and limited per host
  const perHost = new Map();
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < claimed.length) {
      const d = claimed[next++];
      if (now() - t0 > config.budgetMs) break; // the rest stays due for the next round
      const host = new URL(d.monitor.url).host;
      if (config.spread) await sleep(Math.max(0, spreadDelayMs(d.monitor.id) - (now() - t0)));
      while ((perHost.get(host) || 0) >= 2) await sleep(50);
      perHost.set(host, (perHost.get(host) || 0) + 1);
      try {
        results.push({ ...d, r: await checkMonitor(d.monitor, { guard: guardFor(d.area), retryMs: config.retryMs, now }) });
      } finally {
        perHost.set(host, perHost.get(host) - 1);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, claimed.length) }, worker));

  // RF-MON-13: many network failures at once are probably the monitor's own network
  const netFailures = results.filter((x) => x.r.outcome === 'error' && NETWORK_CLASSES.has(x.r.errorClass)).length;
  let unreliable = false;
  if (results.length >= 5 && netFailures * 2 >= results.length && config.canaries.length) {
    const canaries = await Promise.all(config.canaries.map((url) => performCheck({ url, timeoutS: 10, method: 'GET', expect: '200-399' }).then((c) => c.outcome !== 'error')));
    unreliable = !canaries.some(Boolean);
  }

  const events = [];
  for (const { area, monitor, r } of results) {
    if (unreliable) {
      // results discarded: no check stored, no incident; retried at the next round
      monitor.state.nextCheckAt = r.at;
      await store.saveMonitor(area, monitor);
    } else {
      events.push(...(await applyResult(store, area, monitor, r, { windows: windowsOf.get(area) || [], tz: config.tz })));
    }
  }
  for (const d of claimed) await store.releaseMonitor(d.area, d.monitor.id);
  if (unreliable) await store.addEvent('', { type: 'monitor-unreliable', at: t0, checked: results.length, failed: netFailures, admin: true });

  const beat = { at: t0, checked: results.length, failed: results.filter((x) => x.r.outcome === 'error').length, unreliable, durationMs: now() - t0 };
  await store.addBeat(beat);
  if (config.heartbeatUrl) {
    // RF-MON-19: a dead man's switch outside (healthchecks.io and the like); its errors do not stop the round
    await fetch(config.heartbeatUrl, { signal: AbortSignal.timeout(10000) }).then((r) => r.body?.cancel(), () => {});
  }

  for (const area of await store.listAreas()) {
    const windows = windowsOf.get(area) || (await store.listWindows(area));
    for (const m of await store.listMonitors(area)) await aggregate(store, area, m, { now: now(), windows, tz: config.tz });
  }
  if (notify) {
    // alerts of this round and of the previous ones still waiting (delay, retries)
    const { deliverAll } = await import('./notify.js');
    await deliverAll(store, { now, adminAreas });
  }
  const lastPrune = (await store.getMeta('lastPrune')) || 0;
  if (now() - lastPrune > DAY) {
    await store.pruneChecks(now() - config.rawDays * DAY);
    await store.pruneHourly(now() - 395 * DAY);
    await store.pruneBeats(now() - 31 * DAY);
    await store.setMeta('lastPrune', now());
  }
  return { ...beat, events };
}

// ---------------- aggregates and KPIs ----------------

/** Intervals of a monitor in [from, to): monitored time and downtime from raw checks and incidents. */
async function rawIntervals(store, area, m, from, to, { windows, tz, now }) {
  const intervalMs = m.intervalMin * 60000;
  const checks = await store.listChecks(area, m.id, from - intervalMs, to);
  const maint = maintenanceFor(windows, m, from - DAY, to + DAY, tz);
  const monitored = clip(monitoredTime(checks, intervalMs, maint), from, Math.min(to, now));
  const incidents = await store.listIncidents(area, { monitorId: m.id, from, to });
  const downtime = intersect(incidentIntervals(incidents, now), monitored);
  return { checks: checks.filter((c) => c.at >= from && c.at < to), monitored, downtime, incidents };
}

/** Hourly (and daily) aggregates of the hours completed since the last time (RF-MST-02). */
export async function aggregate(store, area, m, { now, windows, tz }) {
  const until = Math.floor(now / HOUR) * HOUR;
  let from = m.state.aggregatedUntil || Math.floor(m.createdAt / HOUR) * HOUR;
  if (from >= until) return;
  from = Math.max(from, until - 400 * DAY);
  const { checks, monitored, downtime } = await rawIntervals(store, area, m, from, until, { windows, tz, now });
  const rows = hourlyAggregates({ checks, monitored, downtime, fromHour: from, toHour: until });
  await store.saveAggregates(area, 'hourly', m.id, rows);
  const dayFrom = Math.floor(from / DAY) * DAY;
  const daily = dailyAggregates(await store.listAggregates(area, 'hourly', m.id, dayFrom, until));
  await store.saveAggregates(area, 'daily', m.id, daily);
  // the monitor may have changed meanwhile: update only this field
  const fresh = (await store.getMonitor(area, m.id)) || m;
  fresh.state.aggregatedUntil = until;
  m.state.aggregatedUntil = until;
  await store.saveMonitor(area, fresh);
}

/**
 * KPIs of a monitor in [from, to) (from rounded down to the hour): aggregates for the aggregated
 * hours, raw data after them (RF-KPI-07).
 */
export async function monitorKpis(store, area, m, { from, to, now, windows, tz }) {
  const f = Math.floor(from / HOUR) * HOUR;
  const aggUntil = Math.min(Math.max(m.state.aggregatedUntil || f, f), to);
  const hourly = aggUntil > f ? await store.listAggregates(area, 'hourly', m.id, f, aggUntil) : [];
  const raw = await rawIntervals(store, area, m, aggUntil, to, { windows, tz, now });
  const okMs = raw.checks.filter((c) => c.outcome !== 'error').map((c) => c.ms);
  const hist = addHistograms(hourly.reduce((h, a) => addHistograms(h, a.hist), new Array(BOUNDS.length).fill(0)), new Array(BOUNDS.length).fill(0));
  const useRawOnly = !hourly.length;
  const responses = useRawOnly
    ? { values: okMs }
    : { hist: okMs.reduce((h, v) => { h[BOUNDS.findIndex((b) => v <= b)]++; return h; }, hist), sum: hourly.reduce((s, a) => s + a.msSum, 0) + okMs.reduce((s, x) => s + x, 0), count: hourly.reduce((s, a) => s + a.msCount, 0) + okMs.length };
  const incidents = await store.listIncidents(area, { monitorId: m.id, from: f, to });
  return kpis({
    from: f,
    to: Math.min(to, now),
    monitoredMs: hourly.reduce((s, a) => s + a.monitoredMs, 0) + total(raw.monitored),
    downtimeMs: hourly.reduce((s, a) => s + a.downtimeMs, 0) + total(raw.downtime),
    incidents,
    now,
    responses,
    slaPct: m.slaPct,
    since: Math.floor(m.createdAt / HOUR) * HOUR,
  });
}

/** Summary of a monitor for the dashboard: status, health, 30-day KPIs, 24 hours, 90 days. */
export async function monitorSummary(store, area, m, { now, windows, tz }) {
  const maint = maintenanceFor(windows, m, now - DAY, now + 7 * DAY, tz);
  const status = displayStatus(m, now, maint);
  const k30 = await monitorKpis(store, area, m, { from: now - 30 * DAY, to: now, now, windows, tz });
  const d = new Date(now);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const km = await monitorKpis(store, area, m, { from: monthStart, to: now, now, windows, tz });
  const budget = errorBudget({ monthMs: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - monthStart, downtimeMs: km.downtimeMs, slaPct: m.slaPct });
  const certDays = m.state.cert ? certDaysLeft(m.state.cert.expiresAt, now) : null;
  const h = health({ status, k30, slaPct: m.slaPct, slowMs: m.slowMs, certDays, budgetLeftMs: budget.leftMs });
  const hourly = await store.listAggregates(area, 'hourly', m.id, Math.floor((now - DAY) / HOUR) * HOUR, now);
  const daily = await store.listAggregates(area, 'daily', m.id, Math.floor((now - 90 * DAY) / DAY) * DAY, now);
  const pctOf = (a) => (a.monitoredMs ? (1 - a.downtimeMs / a.monitoredMs) * 100 : null);
  return {
    ...publicMonitor(m),
    status,
    health: h,
    k30,
    budget,
    certDays,
    maintenance: maint.filter(([s, e]) => e > now).slice(0, 3),
    last24: hourly.map((a) => ({ t: a.hour, pct: pctOf(a), avgMs: a.msCount ? Math.round(a.msSum / a.msCount) : null })),
    last90: daily.map((a) => ({ t: a.day, pct: pctOf(a) })),
  };
}

/** What the API shows of a monitor: credentials masked (RF-NOT-09 spirit, RF-SEC-02). */
export function publicMonitor(m) {
  const { auth, headers, ...rest } = m;
  return { ...rest, auth: auth ? { username: auth.username, password: auth.password ? '••••••' : '' } : null, headers: Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k, /auth|cookie|token|key/i.test(k) ? '••••••' : v])) };
}

/** Keeps stored secrets when the form sends back the masked values. */
export function unmask(input, existing) {
  const out = { ...input };
  if (out.auth && out.auth.password === '••••••' && existing && existing.auth) out.auth = { ...out.auth, password: existing.auth.password };
  if (out.headers && existing) for (const [k, v] of Object.entries(out.headers)) if (v === '••••••' && existing.headers && existing.headers[k]) out.headers[k] = existing.headers[k];
  return out;
}

export { describeError };
