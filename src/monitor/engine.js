import crypto from 'node:crypto';
import path from 'node:path';
import { rootDir, UserError } from '../config.js';
import { currentVercelBackend } from '../storage/vercel/backend.js';
import { networkGuardEnabled } from '../net-guard.js';
import { FsMonitorStore } from './store-fs.js';
import { PgMonitorStore } from './store-pg.js';
import { performCheck, certInfo, describeError, NETWORK_CLASSES } from './check.js';
import { normalizePolicy, normalizeKinds, policyFromLegacy } from '../core/alerting.js';
import { isPassive, isWeb, TYPE_INFO, targetOf, normalizeSpecial, normalizeBrowser, hostKey, heartbeatDeadline, heartbeatMisses, pingResult, notePing } from './types.js';
import { rdapLookup } from './net-checks.js';
import { secretsKeys, decrypt, substitute, maskValues, refsOf, withoutRefs, NAME_RE } from './secrets.js';
import { runnerFor } from './runner.js';
import { normalizeRetry, retryDelays, shouldRetry, DEFAULT_RETRY } from '../core/retry.js';
import { isPrivateLocation } from '../core/agent.js';
import { parseLocations, normalizeLocations, pickLocations, combineRound, unreliableLocations } from '../core/locations.js';
import { dueThreshold } from '../core/netchecks.js';
import { normalizeAssertions, assertionsFromLegacy, DEFAULT_ASSERTIONS, hasWildcard } from '../core/assertions.js';
import {
  HOUR, DAY, MONITOR_INTERVALS, parseExpect, isDegraded, isMuted, maintenanceFor, inIntervals, monitoredTime, incidentIntervals, intersect, clip, total,
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
  // RF-LOC-02: the locations of the deploy, the main one first; `region` is the one this process runs in (null: all of them are «here»)
  locations: parseLocations(process.env.SITESCANNER_LOCATIONS),
  region: process.env.SITESCANNER_REGION || process.env.VERCEL_REGION || null,
});

/** The store with the monitors it returns brought to the current shape (RNF-47). */
export function upgrading(store) {
  return new Proxy(store, {
    get(t, k) {
      if (k === 'listMonitors') return async (...a) => (await t.listMonitors(...a)).map(upgradeMonitor);
      if (k === 'getMonitor') return async (...a) => upgradeMonitor(await t.getMonitor(...a));
      if (k === 'dueMonitors') return async (...a) => (await t.dueMonitors(...a)).map((d) => ({ ...d, monitor: upgradeMonitor(d.monitor) }));
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

/** The store that goes with the active storage backend. */
export function monitorStoreFor(root = rootDir()) {
  const b = currentVercelBackend();
  return upgrading(b ? new PgMonitorStore(b) : new FsMonitorStore(root));
}

/** The monitoring area of a storage area: '' (working folder), the username (filesystem) or the user id (Vercel). */
export const monitorArea = (st) => (st.kind === 'vercel' ? st.area : st.isolated ? path.basename(st.root) : '');

// Private destinations are refused for accounts (RF-SEC-01), not for the working folder.
const guardFor = (area) => (area ? networkGuardEnabled(true) : false);

// ---------------- monitors ----------------

const DEFAULTS = {
  type: 'http', waitSelector: '', waitText: '', failOnJsErrors: true, expectedMin: 60, toleranceMin: null, hbToken: null, host: '', port: null, tcpSend: '', tcpExpect: '', minTls: 'TLSv1.2', checkDomain: true, domainDays: [30, 14, 7, 1], dnsName: '', recordType: 'A', resolver: 'system', dnsAssertions: [], intervalMin: 5, timeoutS: 30, method: 'GET', assertions: null, bodyType: 'none', body: '', contentType: '', headers: {}, auth: null,
  degradedMs: 3000, failedMs: null, notifyDegraded: false, followRedirects: true, skipSsl: false, shouldFail: false, ipVersion: 'auto', description: '', muted: null,
  vars: {}, retry: null, locations: [], locStrategy: 'rotate', sslDays: [30, 14, 7, 1], alertPolicy: null, channels: null, tags: [], slaPct: 99.9, paused: false, source: null,
};

/**
 * Brings a monitor stored by an older version to the current shape (spec §13.2, RNF-47): the
 * slowness threshold becomes the «degraded after» threshold (null stays off, so the behaviour of
 * existing monitors does not change), «slow» becomes «degraded». Idempotent; returns a copy.
 */
export function upgradeMonitor(m) {
  if (!m) return m;
  const out = { ...m };
  if (!('degradedMs' in out) && ('slowMs' in out)) out.degradedMs = out.slowMs || null;
  if (!('notifyDegraded' in out) && ('notifySlow' in out)) out.notifyDegraded = !!out.notifySlow;
  delete out.slowMs;
  delete out.notifySlow;
  // RF-AST-02: the status list and the keyword of the first version are assertions now
  if (('expect' in out || 'keyword' in out) && !(out.assertions && out.assertions.length)) out.assertions = assertionsFromLegacy(out);
  delete out.expect;
  delete out.keyword;
  // RF-ALR-05: the delay and the reminder of each monitor are its own alert policy now
  if (('notifyDelayMin' in out || 'reminderMin' in out)) {
    if (!out.alertPolicy) out.alertPolicy = policyFromLegacy(out);
    delete out.notifyDelayMin;
    delete out.reminderMin;
  }
  if (out.state) {
    out.state = { ...out.state };
    if (out.state.lastOutcome === 'slow') out.state.lastOutcome = 'degraded';
    if (out.state.status === 'slow') out.state.status = 'degraded';
    delete out.state.slow;
    delete out.state.slowStreak;
  }
  return out;
}

const usesEnv = (v) => (typeof v === 'string' ? /\$\{\w+\}/.test(v) : v && typeof v === 'object' ? Object.values(v).some(usesEnv) : false);
const bad = (msg) => new UserError(msg);

/** Validates and normalizes a monitor from the form (RF-MON-01, table of §12.2). */
export function normalizeMonitor(input, existing = null, { isolated = false } = {}) {
  // an input with the old field names (CSV, old clients) means the same thing as the new ones
  const given = input && ('slowMs' in input || 'notifySlow' in input || 'expect' in input || 'keyword' in input || 'notifyDelayMin' in input || 'reminderMin' in input) ? upgradeMonitor(input) : input;
  const m = { ...DEFAULTS, ...(upgradeMonitor(existing) || {}), ...(given || {}) };
  if (!TYPE_INFO[m.type]) throw bad(`Tipo di monitor: ${Object.keys(TYPE_INFO).join(', ')}`);
  const web = isWeb(m.type);
  const hb = m.type === 'heartbeat';
  if (m.type === 'browser') {
    // RF-BRW-01: a page opened in a browser; no method, body or assertions on the response
    m.method = 'GET';
    m.assertions = [];
    normalizeBrowser(m, bad, (raw) => {
      const rawUrl = String(raw || '').trim();
      let u;
      try { u = new URL(withoutRefs(rawUrl)); } catch { throw bad(`URL non valido: ${raw || '(vuoto)'}`); }
      if (!/^https?:$/.test(u.protocol)) throw bad('Solo URL http o https');
      return refsOf(rawUrl).size ? rawUrl : u.toString();
    });
  } else if (!web) {
    // RF-TYP-01..04: no URL; the heartbeat is called by the job, the others look at a name, a port or a host
    m.url = '';
    m.method = 'GET';
    m.assertions = [];
    normalizeSpecial(m, bad, MONITOR_INTERVALS);
  } else {
    let u;
    const rawUrl = String(m.url || '').trim();
    // RF-SEG-02: {{NAME}} in the URL is checked with a stand-in and kept as written
    try { u = new URL(withoutRefs(rawUrl)); } catch { throw bad(`URL non valido: ${m.url || '(vuoto)'}`); }
    if (!/^https?:$/.test(u.protocol)) throw bad('Solo URL http o https');
    m.url = refsOf(rawUrl).size ? rawUrl : u.toString();
    m.name = String(m.name || '').trim().slice(0, 80) || u.host;
    m.intervalMin = Number(m.intervalMin);
    if (!MONITOR_INTERVALS.includes(m.intervalMin)) throw bad(`Intervallo non valido: ammessi ${MONITOR_INTERVALS.join(', ')} minuti`);
  }
  m.timeoutS = Number(m.timeoutS);
  if (!(m.timeoutS >= 5 && m.timeoutS <= 60)) throw bad('Timeout tra 5 e 60 secondi');
  m.method = String(m.method || 'GET').toUpperCase();
  if (web && !(m.type === 'api' ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] : ['GET', 'HEAD']).includes(m.method)) throw bad(m.type === 'api' ? 'Metodo: GET, POST, PUT, PATCH, DELETE, HEAD o OPTIONS' : 'Metodo GET o HEAD');
  // RF-AST-01/02: without assertions, a site must answer 200–399 and an API 200–299
  try { m.assertions = normalizeAssertions(m.assertions || []); } catch (e) { throw bad(e.message); }
  if (web && !m.assertions.length) m.assertions = m.type === 'api' ? [{ source: 'status', comparison: 'in', target: '200-299' }] : DEFAULT_ASSERTIONS.map((a) => ({ ...a }));
  if (m.method === 'HEAD' && m.assertions.some((a) => ['body', 'json'].includes(a.source))) throw bad('Le asserzioni sul corpo richiedono il metodo GET: con HEAD la risposta non ha corpo');
  m.bodyType = ['none', 'text', 'json'].includes(m.bodyType) ? m.bodyType : 'none';
  m.body = m.bodyType === 'none' ? '' : String(m.body ?? '');
  if (m.body.length > 102400) throw bad('Il corpo della richiesta può avere al massimo 100 KB');
  if (m.bodyType === 'json' && m.body.trim()) { try { JSON.parse(withoutRefs(m.body, '0')); } catch (e) { throw bad(`Il corpo JSON non è valido: ${e.message}`); } }
  m.contentType = String(m.contentType || '').slice(0, 200);
  delete m.expect;
  delete m.keyword;
  m.headers = Object.fromEntries(Object.entries(m.headers || {}).map(([k, v]) => [String(k), String(v)]));
  m.auth = m.auth && m.auth.username ? { username: String(m.auth.username), password: String(m.auth.password || '') } : null;
  if (isolated && (usesEnv(m.headers) || usesEnv(m.auth))) throw bad("Le variabili d'ambiente (${…}) non sono disponibili in modalità multi-utente");
  m.degradedMs = m.degradedMs ? Number(m.degradedMs) : null;
  if (m.degradedMs != null && !(m.degradedMs > 0)) throw bad('Soglia di degrado in millisecondi');
  m.failedMs = m.failedMs ? Number(m.failedMs) : null;
  if (m.failedMs != null && !(m.failedMs > 0 && m.failedMs <= (hb ? DAY : 60000))) throw bad(hb ? 'Soglia di guasto tra 1 ms e 24 ore' : 'Soglia di guasto tra 1 ms e 60 secondi');
  if (m.failedMs != null && m.degradedMs != null && m.failedMs < m.degradedMs) throw bad('La soglia di guasto deve essere maggiore di quella di degrado');
  if (!hb && m.failedMs != null && m.failedMs > m.timeoutS * 1000) throw bad(`La soglia di guasto non può superare il timeout (${m.timeoutS} s)`);
  m.followRedirects = m.followRedirects !== false;
  m.skipSsl = !!m.skipSsl;
  m.shouldFail = !!m.shouldFail;
  m.ipVersion = ['auto', '4', '6'].includes(String(m.ipVersion)) ? String(m.ipVersion) : 'auto';
  m.description = String(m.description || '').trim();
  if (m.description.length > 500) throw bad('La descrizione può avere al massimo 500 caratteri');
  if (m.muted && typeof m.muted === 'object') {
    const until = m.muted.until == null ? null : Number(m.muted.until);
    if (until != null && !Number.isFinite(until)) throw bad('Scadenza del silenziamento non valida');
    m.muted = { until };
  } else m.muted = null;
  // the variables of this monitor, which win over those of the workspace (RF-SEG-03)
  const vars = m.vars && typeof m.vars === 'object' ? m.vars : {};
  if (Object.keys(vars).length > 20) throw bad('Al massimo 20 variabili per monitor');
  m.vars = Object.fromEntries(Object.entries(vars).map(([k, v]) => {
    const name = String(k).trim().toUpperCase();
    if (!NAME_RE.test(name)) throw bad(`Nome di variabile non valido: ${k}`);
    if (String(v).length > 1024) throw bad(`La variabile ${name} è troppo lunga (al massimo 1 KB)`);
    return [name, String(v)];
  }));
  // RF-LOC-01: how a failed run is tried again; RF-LOC-02/03: where it runs
  if (m.retry) { try { m.retry = normalizeRetry(m.retry); } catch (e) { throw bad(e.message); } } else m.retry = null;
  try { m.locations = normalizeLocations(m.locations && m.locations.length ? m.locations : null, monitoringConfig().locations); } catch (e) { throw bad(e.message); }
  // the main location alone is what monitors had before: nothing to show, and the same behaviour
  if (m.locations.length === 1 && m.locations[0] === monitoringConfig().locations[0].id && !(existing && existing.locations && existing.locations.length)) m.locations = [];
  m.locStrategy = ['rotate', 'parallel'].includes(m.locStrategy) ? m.locStrategy : 'rotate';
  m.sslDays = [...new Set((m.sslDays || []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 365))].sort((a, b) => b - a);
  if (m.alertPolicy) {
    try { m.alertPolicy = { ...normalizePolicy(m.alertPolicy), events: normalizeKinds(m.alertPolicy.events) }; } catch (e) { throw bad(`Politica di allerta: ${e.message}`); }
  } else m.alertPolicy = null;
  m.channels = Array.isArray(m.channels) ? m.channels.map(String) : null;
  m.tags = [...new Set((m.tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
  m.slaPct = Number(m.slaPct);
  if (!(m.slaPct >= 90 && m.slaPct <= 100)) throw bad('Obiettivo di disponibilità tra 90 e 100%');
  m.paused = !!m.paused;
  m.notifyDegraded = !!m.notifyDegraded;
  m.id ||= newId();
  m.createdAt ||= Date.now();
  m.state ||= { status: 'pending', since: m.createdAt, nextCheckAt: 0 };
  // a heartbeat is due at its deadline, not at once; a change of period moves it
  if (hb && (!existing || !m.state.nextCheckAt || existing.expectedMin !== m.expectedMin || existing.toleranceMin !== m.toleranceMin)) m.state.nextCheckAt = heartbeatDeadline(m);
  return m;
}

/**
 * A call of a heartbeat (RF-TYP-01): `start` marks the beginning, `ok` ends the run, `fail` is a failure.
 * Goes through the same path as the result of a check: run, incident, events.
 */
export async function recordPing(store, area, monitor, kind, now, { ip = null, message = '', windows = null, tz = null } = {}) {
  const m = upgradeMonitor((await store.getMonitor(area, monitor.id)) || monitor);
  if (m.type !== 'heartbeat') throw bad('Non è un heartbeat');
  if (m.paused) return { ok: true, ignored: 'il monitor è in pausa' };
  const r = kind === 'start' ? null : pingResult(m, kind, now, { message });
  notePing(m, kind, now, { ip, note: message });
  if (!r) {
    await store.saveMonitor(area, m);
    return { ok: true, kind };
  }
  const prefs = await store.getPrefs(area);
  await applyResult(store, area, m, r, { windows: windows || (await store.listWindows(area)), tz: tz || prefs.tz || monitoringConfig().tz });
  return { ok: true, kind, outcome: r.outcome };
}

/** The deadlines passed by `now` of a passive monitor become failed runs (RF-TYP-01). */
export async function evaluatePassive(store, area, m, now, { windows, tz }) {
  for (const r of heartbeatMisses(m, now)) await applyResult(store, area, m, r, { windows, tz });
  return m;
}

/** Status shown for a monitor (§12.4). */
export function displayStatus(m, now, maint) {
  if (m.paused) return 'paused';
  if (inIntervals(now, maint)) return 'maintenance';
  if (m.state.unconfigured && m.state.unconfigured.length) return 'unconfigured';
  if (m.state.openIncident) return 'down';
  if (!m.state.lastCheckAt) return 'pending';
  return m.state.lastOutcome === 'degraded' ? 'degraded' : 'up';
}

// ---------------- checks and state ----------------

/** One check with the confirmation retry (RF-MON-12) and, once a day, the certificate (RF-MON-16). */
export async function checkMonitor(orig, { guard, retryMs, now = Date.now, scope = {}, area = null, runner = null, locationPct = 50 }) {
  // RF-SEG-02/03: the references are replaced only here, for this run; what is stored never has the values
  const sub = substitute(orig, scope);
  if (sub.missing.length) return { at: now(), unconfigured: sub.missing };
  const m = sub.monitor;
  if (isWeb(m.type) || m.type === 'browser') {
    try { new URL(m.url); } catch { return { at: now(), outcome: 'error', status: null, ms: null, errorClass: 'configurazione', error: 'URL non valido dopo la sostituzione delle variabili' }; }
  }
  const r = await runCheck(m, { guard, retryMs, now, area, runner, locationPct });
  return sub.secretValues.length ? maskValues(r, sub.secretValues) : r;
}

/** The variables and secrets of an area, decrypted: name → { kind, value } (the ones that cannot be read are left out). */
export async function loadScope(store, area, keys = secretsKeys()) {
  const scope = {};
  for (const s of await store.listSecrets(area)) {
    if (s.kind === 'var') scope[s.name] = { kind: 'var', value: s.value };
    else {
      try { scope[s.name] = { kind: 'secret', value: decrypt(s.enc, s.name, keys) }; } catch { /* unreadable: the monitors that use it are «non configurati» */ }
    }
  }
  return scope;
}

/** A monitor that uses a name nobody defined does not run, and says so (RF-SEG-03). */
async function markUnconfigured(store, area, m, names, t) {
  const before = (m.state.unconfigured || []).join(',');
  m.state.unconfigured = names;
  m.state.nextCheckAt = t + m.intervalMin * 60000 - 60000;
  await store.saveMonitor(area, m);
  if (before !== names.join(',')) await store.addEvent(area, { type: 'monitor-unconfigured', status: 'info', at: t, monitorId: m.id, monitorName: m.name, url: m.url, tags: m.tags, names });
}

/**
 * One check of a monitor with its retries and its locations (RF-LOC-01..04). The runs of the locations chosen for this
 * round (one, rotating; or all of them, in parallel) each try again as the monitor says; the round is one result for the
 * state machine, and when more locations ran its `locationRuns` hold what each of them saw.
 */
async function runCheck(m, { guard, retryMs, now, area = null, runner = null, locationPct = 50 }) {
  const retry = m.retry || DEFAULT_RETRY;
  const delays = retryDelays(retry);
  // SITESCANNER_MON_RETRY_MS is the wait of the first version (10 s): the tests make it short, with it the waits scale
  const scale = retryMs == null ? 1 : retryMs / 10000;
  const labelled = !!(m.locations && m.locations.length);
  const chosen = labelled ? pickLocations({ strategy: m.locStrategy || 'rotate', locations: m.locations, last: m.state.lastLocation }) : [null];
  // the detail (headers, 2 KB of the body, assertions) is collected every time; applyResult decides what to keep (RF-RIS-22)
  const exec = (loc) => (runner && loc ? runner(loc, { area, monitor: m, guard, now }) : performCheck(m, { guard, now, detail: true }));
  const attemptsAt = async (first) => {
    const log = [];
    let loc = first, r;
    for (let i = 0; ; i++) {
      const t = now(); // the time of the run is the one of the orchestrator: a remote Function has its own clock
      r = await exec(loc);
      log.push({ at: t, location: loc, outcome: r.outcome, errorClass: r.errorClass || null, error: r.error || null, ms: r.ms ?? null });
      if (i >= delays.length || !shouldRetry(r, retry, NETWORK_CLASSES)) break;
      if (delays[i] * 1000 * scale) await sleep(delays[i] * 1000 * scale);
      if (!retry.sameLocation && labelled && m.locations.length > 1) loc = pickLocations({ strategy: 'rotate', locations: m.locations, last: loc })[0];
    }
    // the run is dated by its first attempt; a failure that persists keeps the time of the first failure
    const out = { ...r, at: log[0].at, location: loc };
    if (log.length > 1) Object.assign(out, { retried: true, attempts: log.length, attemptLog: log });
    return out;
  };
  const runs = await Promise.all(chosen.map(attemptsAt));
  if (labelled) m.state.lastLocation = chosen[chosen.length - 1];

  // the certificate comes from the connection of the run; a separate look once a day when the run did not get that far
  const seen = runs.find((x) => x.tls && x.tls.cert);
  if (seen) m.state.cert = { ...seen.tls.cert, valid: seen.tls.authorized, checkedAt: now() };
  else if (m.url.startsWith('https:') && (!m.state.cert || now() - (m.state.cert.checkedAt || 0) > DAY)) {
    const c = await certInfo(runs[0].finalUrl || m.url, { guard });
    if (c) m.state.cert = { ...c, checkedAt: now() };
  }
  // the registry says when the domain expires: once a day, never failing the check by itself (RF-TYP-04)
  if (m.type === 'ssl' && m.checkDomain && (!m.state.domain || now() - (m.state.domain.checkedAt || 0) > DAY)) m.state.domain = { ...(await rdapLookup(m.host)), checkedAt: now() };
  for (const r of runs) {
    if (m.type === 'ssl' && r.outcome !== 'error' && m.state.domain && m.state.domain.expiresAt && m.state.domain.expiresAt < r.at) {
      Object.assign(r, { outcome: 'error', errorClass: 'dominio', error: `dominio ${m.state.domain.domain} scaduto il ${new Date(m.state.domain.expiresAt).toISOString().slice(0, 10)}` });
    }
    // with «ignore certificate errors» an expired certificate does not fail the check (the monitor shows a warning)
    if (r.outcome !== 'error' && !m.skipSsl && m.state.cert && m.state.cert.expiresAt < r.at) {
      Object.assign(r, { outcome: 'error', errorClass: 'tls', error: 'certificato scaduto' });
    }
  }
  if (runs.length === 1) return runs[0];
  const { combined, runs: marked } = combineRound(runs, locationPct);
  return { ...combined, locationRuns: marked };
}

const DETAIL_EVERY_MS = 55 * 60000;
// ids sort by time: the instant in base 36, then 3 random bytes
const newRunId = (at) => `${at.toString(36)}${crypto.randomBytes(3).toString('hex')}`;

/**
 * The detail of a run (RF-RIS-21): what is needed to understand it without repeating it. Sensitive
 * headers are already masked; the body is the first 2 KB.
 */
export function runDetail(m, r, id) {
  return {
    id, monitorId: m.id, at: r.at, location: r.location ?? null, localFailure: !!r.localFailure, attemptLog: r.attemptLog || null, outcome: r.outcome, status: r.status, method: m.method, url: m.url, finalUrl: r.finalUrl,
    ms: r.ms, ttfbMs: r.ttfbMs, phases: r.phases || null, ip: r.ip || null, tls: r.tls || null, chain: r.chain || [], assertions: r.assertions || [],
    headers: r.headers || null, excerpt: r.excerpt || null, errorClass: r.errorClass || null, error: r.error || null, attempts: r.attempts || 1,
    ...(r.browser ? { browser: r.browser } : {}), ...(r.screenshot ? { screenshot: r.screenshot } : {}), // RF-BRW-01: the screenshot of the failure stays with the run and the incident
  };
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
  const ev = (type, extra = {}) => events.push({ type, at: r.at, monitorId: m.id, monitorName: m.name, url: m.url, tags: m.tags, ...(m.description ? { description: m.description } : {}), ...extra });
  const prev = s.lastOutcome;
  // each location that ran is a run of its own (RF-LOC-04); the combined result is what the state machine below follows
  let detail = null;
  for (const run of r.locationRuns || [r]) {
    // RF-RIS-22: the full detail of failed and degraded runs, and of one run an hour among the successful ones
    const runId = newRunId(run.at);
    const detailed = run.outcome !== 'ok' || !s.lastDetailAt || run.at - s.lastDetailAt >= DETAIL_EVERY_MS;
    const d = detailed ? runDetail(m, run, runId) : null;
    if (d) {
      await store.saveRunDetail(area, m.id, runId, d);
      if (run.outcome === 'ok') s.lastDetailAt = run.at;
    }
    await store.addCheck(area, m.id, { id: runId, at: run.at, outcome: run.outcome, status: run.status, ms: run.ms, ttfbMs: run.ttfbMs, finalUrl: run.finalUrl, errorClass: run.errorClass, error: run.error, retried: !!run.retried, ...(run.attempts ? { attempts: run.attempts } : {}), ...(run.phases ? { phases: run.phases } : {}), location: run.location ?? null, ...(run.localFailure ? { localFailure: true } : {}), hasDetail: !!d });
    if (!detail && (!r.locationRuns || run.location === r.location)) detail = d;
  }
  s.lastCheckAt = r.at;
  s.lastOutcome = r.outcome;
  s.recent = [...(s.recent || []), r.outcome === 'error' ? 'e' : r.outcome === 'ok' ? 'o' : 'd'].slice(-20); // RF-LST-03: the mini-bars of the list
  s.lastMs = r.ms;
  s.lastError = r.outcome === 'error' ? causeOf(r, m) : null;
  // a 5-minute monitor is due at every 5-minute round, even if the previous round started a bit late
  s.nextCheckAt = r.nextCheckAt ?? r.at + m.intervalMin * 60000 - 60000;

  if (r.outcome !== 'error') {
    // RF-RIS-02: degraded when the last run is slow; it never opens incidents
    if ((r.outcome === 'degraded') !== (prev === 'degraded') && !s.openIncident) s.since = r.at;
    if (r.outcome === 'degraded' && prev !== 'degraded' && prev !== 'error' && m.notifyDegraded && !inMaint) ev('degraded', { ms: r.ms, degradedMs: m.degradedMs });
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
      // RF-RIS-25: the first failed run, in full, stays with the incident when the raw data expire
      const inc = { id: newId(), monitorId: m.id, start: r.at, end: null, cause, causes: [cause], failures: 1, excerpt: r.excerpt || null, firstRun: detail, note: '', notifications: [] };
      await store.saveIncident(area, inc);
      s.openIncident = inc.id;
      s.since = r.at;
      ev(r.errorClass === 'heartbeat' ? 'heartbeat-missed' : 'down', { incidentId: inc.id, cause, ...(m.type === 'heartbeat' ? { expectedMin: m.expectedMin + m.toleranceMin, lastAt: s.lastPingAt || null } : {}) });
    } else {
      const inc = await store.getIncident(area, s.openIncident);
      const last = inc && inc.causes[inc.causes.length - 1];
      if (inc) {
        // RF-ALR-01: failed runs in a row, to decide when to alert
        inc.failures = (inc.failures || 1) + 1;
        if (last && (last.class !== cause.class || last.status !== cause.status)) inc.causes.push(cause);
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
  // domain expiry, like the certificate (RF-TYP-04)
  if (s.domain && s.domain.expiresAt) {
    const days = certDaysLeft(s.domain.expiresAt, r.at);
    const sent = s.domainNotified && s.domainNotified.expiresAt === s.domain.expiresAt ? s.domainNotified.sent : [];
    const t = dueThreshold(days, m.domainDays || [], sent);
    if (t) {
      s.domainNotified = { expiresAt: s.domain.expiresAt, sent: t.sent };
      ev(days < 0 ? 'domain-expired' : 'domain', { days, expiresAt: s.domain.expiresAt, domain: s.domain.domain });
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
  // monitors stored by an older version are brought to the current shape here (RNF-47)
  const due = (await store.dueMonitors(t0)).map((d) => ({ ...d, monitor: upgradeMonitor(d.monitor) }));
  const claimed = [];
  for (const d of due) if (await store.claimMonitor(d.area, d.monitor.id, t0 + config.budgetMs + 120000, t0)) claimed.push(d);

  const windowsOf = new Map();
  for (const area of new Set(claimed.map((d) => d.area))) windowsOf.set(area, await store.listWindows(area));

  // checks, spread in the round and limited per host
  const perHost = new Map();
  const scopes = new Map(); // the variables of each area, read once per round
  const prefsOf = new Map();
  const runner = runnerFor(config);
  const primary = config.locations[0].id;
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < claimed.length) {
      const d = claimed[next++];
      if (now() - t0 > config.budgetMs) break; // the rest stays due for the next round
      if (isPassive(d.monitor.type)) {
        // a heartbeat is not requested: the periods without a call are its failures (RF-TYP-01)
        for (const r of heartbeatMisses(d.monitor, now())) results.push({ ...d, r });
        continue;
      }
      const host = hostKey(d.monitor);
      if (config.spread) await sleep(Math.max(0, spreadDelayMs(d.monitor.id) - (now() - t0)));
      while ((perHost.get(host) || 0) >= 2) await sleep(50);
      perHost.set(host, (perHost.get(host) || 0) + 1);
      try {
        if (!scopes.has(d.area)) scopes.set(d.area, await loadScope(store, d.area));
        if (!prefsOf.has(d.area)) prefsOf.set(d.area, await store.getPrefs(d.area));
        // RF-ALR-01: how many of the locations must fail for the monitor to be down
        const locationPct = (d.monitor.alertPolicy && d.monitor.alertPolicy.locationPct) || (prefsOf.get(d.area).policy && prefsOf.get(d.area).policy.locationPct) || 50;
        const r = await checkMonitor(d.monitor, { guard: guardFor(d.area), retryMs: config.retryMs, now, scope: scopes.get(d.area), area: d.area, runner, locationPct });
        if (r.unconfigured) await markUnconfigured(store, d.area, d.monitor, r.unconfigured, now());
        else {
          if (d.monitor.state.unconfigured) d.monitor.state.unconfigured = null;
          results.push({ ...d, r });
        }
      } finally {
        perHost.set(host, perHost.get(host) - 1);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, claimed.length) }, worker));

  // RF-MON-13 per location (RF-LOC-05): many network failures at once from a location are probably that location's own
  // network. Only the runs of the locations that look unreliable are discarded, the others still decide.
  const runsOf = (x) => (x.r.locationRuns || [{ ...x.r, location: x.r.location || primary }]);
  // a private location (an agent) has no canary to ask: it is judged by its own beat, not by RF-LOC-05
  const flat = results.flatMap((x) => runsOf(x).map((run) => ({ location: run.location || primary, r: run }))).filter((x) => !isPrivateLocation(x.location));
  const candidates = config.canaries.length ? unreliableLocations(flat, { networkClasses: NETWORK_CLASSES, canaryOk: () => false }) : new Set();
  const canary = new Map();
  for (const loc of candidates) {
    const probe = { type: 'http', url: '', timeoutS: 10, method: 'GET', assertions: [{ source: 'status', comparison: 'in', target: '200-399' }] };
    const oks = await Promise.all(config.canaries.map((url) => runner(loc, { area: null, monitor: { ...probe, url }, canary: url }).then((c) => c.outcome !== 'error', () => false)));
    canary.set(loc, oks.some(Boolean));
  }
  const bad = unreliableLocations(flat, { networkClasses: NETWORK_CLASSES, canaryOk: (loc) => canary.get(loc) ?? true });
  const unreliable = bad.size > 0;
  const netFailures = flat.filter((x) => bad.has(x.location) && x.r.outcome === 'error').length;

  const events = [];
  for (const x of results) {
    const { area, monitor } = x;
    let r = x.r;
    if (unreliable) {
      const runs = runsOf(x);
      const keep = runs.filter((run) => !bad.has(run.location || primary));
      if (keep.length !== runs.length) {
        if (!keep.length) {
          // results discarded: no check stored, no incident; retried at the next round
          monitor.state.nextCheckAt = r.at;
          await store.saveMonitor(area, monitor);
          continue;
        }
        const pct = (monitor.alertPolicy && monitor.alertPolicy.locationPct) || (prefsOf.get(area) && prefsOf.get(area).policy && prefsOf.get(area).policy.locationPct) || 50;
        const again = combineRound(keep, pct);
        r = keep.length === 1 ? keep[0] : { ...again.combined, locationRuns: again.runs };
      }
    }
    events.push(...(await applyResult(store, area, monitor, r, { windows: windowsOf.get(area) || [], tz: config.tz })));
  }
  for (const d of claimed) await store.releaseMonitor(d.area, d.monitor.id);
  if (unreliable) await store.addEvent('', { type: 'monitor-unreliable', at: t0, checked: flat.length, failed: netFailures, locations: [...bad], admin: true });

  const beat = { at: t0, checked: results.length, failed: results.filter((x) => x.r.outcome === 'error').length, unreliable, durationMs: now() - t0 };
  await store.addBeat(beat);
  if (config.heartbeatUrl) {
    // RF-MON-19: a dead man's switch outside (healthchecks.io and the like); its errors do not stop the round
    await fetch(config.heartbeatUrl, { signal: AbortSignal.timeout(10000) }).then((r) => r.body?.cancel(), () => {});
  }

  const { evaluateAgents } = await import('./agent.js');
  for (const area of await store.listAreas()) {
    await evaluateAgents(store, area, now());
    const windows = windowsOf.get(area) || (await store.listWindows(area));
    for (const m of (await store.listMonitors(area)).map(upgradeMonitor)) {
      await maintenanceTransition(store, area, m, windows, config.tz, now());
      await aggregate(store, area, m, { now: now(), windows, tz: config.tz });
    }
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
    await store.pruneEvents(now() - EVENT_DAYS * DAY); // RF-ALR-07: history and notification log
    await store.pruneJobs(now() - DAY);
    await store.setMeta('lastPrune', now());
  }
  return { ...beat, events };
}

/** Events and the log of the notifications are kept this long (RF-ALR-07). */
export const EVENT_DAYS = 90;

/** RF-ALR-03: «maintenance started / ended» events when a monitor enters or leaves a window. */
async function maintenanceTransition(store, area, m, windows, tz, t) {
  if (m.paused) return;
  const inM = inIntervals(t, maintenanceFor(windows, m, t - DAY, t + DAY, tz));
  if (inM === !!m.state.inMaintenance) return;
  const fresh = upgradeMonitor((await store.getMonitor(area, m.id)) || m);
  fresh.state.inMaintenance = inM;
  m.state.inMaintenance = inM;
  await store.saveMonitor(area, fresh);
  await store.addEvent(area, { type: inM ? 'maintenance-start' : 'maintenance-end', at: t, monitorId: m.id, monitorName: m.name, url: m.url, tags: m.tags });
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
  const fresh = upgradeMonitor((await store.getMonitor(area, m.id)) || m);
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

/**
 * Share of degraded runs in the last 24 hours (RF-RIS-02): complete hours from the aggregates, the
 * rest from the raw checks.
 */
async function degradedShare(store, area, m, hourly, now) {
  const from = now - DAY;
  const aggUntil = Math.min(m.state.aggregatedUntil || 0, now);
  const rows = hourly.filter((a) => a.hour >= from && a.hour < aggUntil);
  let checks = rows.reduce((n, a) => n + a.checks, 0);
  let degraded = rows.reduce((n, a) => n + (a.degraded || 0) + (a.slow || 0), 0);
  const rawFrom = Math.max(from, rows.length ? aggUntil : from);
  for (const c of await store.listChecks(area, m.id, rawFrom, now + 1)) {
    checks++;
    if (isDegraded(c.outcome)) degraded++;
  }
  // too few runs say nothing: an hour of 5-minute checks at least
  return checks >= 12 ? degraded / checks : 0;
}

/** Summary of a monitor for the dashboard: status, health, 30-day KPIs, 24 hours, 90 days. */
export async function monitorSummary(store, area, m, { now, windows, tz }) {
  m = upgradeMonitor(m);
  const maint = maintenanceFor(windows, m, now - DAY, now + 7 * DAY, tz);
  const status = displayStatus(m, now, maint);
  const k30 = await monitorKpis(store, area, m, { from: now - 30 * DAY, to: now, now, windows, tz });
  const d = new Date(now);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const km = await monitorKpis(store, area, m, { from: monthStart, to: now, now, windows, tz });
  const budget = errorBudget({ monthMs: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - monthStart, downtimeMs: km.downtimeMs, slaPct: m.slaPct });
  const certDays = m.state.cert ? certDaysLeft(m.state.cert.expiresAt, now) : null;
  const hourly = await store.listAggregates(area, 'hourly', m.id, Math.floor((now - DAY) / HOUR) * HOUR, now);
  const share = await degradedShare(store, area, m, hourly, now);
  const h = health({ status, k30, slaPct: m.slaPct, degradedMs: m.degradedMs, certDays, budgetLeftMs: budget.leftMs, degradedShare: share, ageMs: now - m.createdAt });
  const daily = await store.listAggregates(area, 'daily', m.id, Math.floor((now - 90 * DAY) / DAY) * DAY, now);
  const pctOf = (a) => (a.monitoredMs ? (1 - a.downtimeMs / a.monitoredMs) * 100 : null);
  return {
    ...publicMonitor(m),
    status,
    health: h,
    k30,
    budget,
    certDays,
    muted: isMuted(m, now),
    mutedUntil: isMuted(m, now) ? m.muted.until : null,
    degradedShare: share,
    maintenance: maint.filter(([s, e]) => e > now).slice(0, 3),
    last24: hourly.map((a) => ({ t: a.hour, pct: pctOf(a), avgMs: a.msCount ? Math.round(a.msSum / a.msCount) : null })),
    last90: daily.map((a) => ({ t: a.day, pct: pctOf(a) })),
  };
}

/** What the API shows of a monitor: credentials masked (RF-NOT-09 spirit, RF-SEC-02). */
export function publicMonitor(m) {
  const { auth, headers, ...rest } = m;
  return { ...rest, target: targetOf(m), auth: auth ? { username: auth.username, password: auth.password ? '••••••' : '' } : null, headers: Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k, /auth|cookie|token|key/i.test(k) ? '••••••' : v])) };
}

/** Keeps stored secrets when the form sends back the masked values. */
export function unmask(input, existing) {
  const out = { ...input };
  if (out.auth && out.auth.password === '••••••' && existing && existing.auth) out.auth = { ...out.auth, password: existing.auth.password };
  if (out.headers && existing) for (const [k, v] of Object.entries(out.headers)) if (v === '••••••' && existing.headers && existing.headers[k]) out.headers[k] = existing.headers[k];
  return out;
}

export { describeError };
