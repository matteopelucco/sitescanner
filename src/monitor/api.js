import { UserError, loadSite } from '../config.js';
import { send, readJson, NotFound } from '../api.js';
import { DAY, HOUR, maintenanceFor, windowOccurrences, fmtDuration, phaseSums, REPEAT_UNITS } from '../core/uptime.js';
import { periodRange, filterRuns, groupErrors, paginate, phaseAverages, outcomeOf, errorFingerprint } from '../core/runs.js';
import { monitorRows, listResponse, LIST_PERIODS } from './list.js';
import { SORTS } from '../core/listquery.js';
import { normalizePolicy, normalizeKinds, channelReach, filterHistory, groupByDay, newProblems, DEFAULT_CHANNEL_EVENTS, EVENT_KINDS, KIND_LABELS, HISTORY_GROUPS } from '../core/alerting.js';
import {
  monitoringEnabled, monitoringConfig, monitorStoreFor, monitorArea, normalizeMonitor, publicMonitor, unmask, checkMonitor, applyResult, describeError,
  monitorSummary, monitorKpis, displayStatus, EVENT_DAYS, recordPing, evaluatePassive, loadScope,
} from './engine.js';
import { networkGuardEnabled, assertUrlAllowed } from '../net-guard.js';
import { performCheck } from './check.js';
import { isPassive, TYPE_INFO } from './types.js';
import { internalSecret, verifySignature } from './runner.js';
import { hashPassword } from '../auth/passwords.js';
import { reportData, reportCsv, reportPdf, reportFileName, sendOne } from './reports.js';
import { isManaged, MANAGED_MESSAGE, exportYaml } from './code.js';
import { normalizePage, normalizeCommunication, normalizePost, UPDATE_STATUSES, COMPONENT_STATUS } from '../core/statuspage.js';
import { locationStats, STRATEGY_LABELS as LOC_STRATEGY_LABELS } from '../core/locations.js';
import { isPrivateLocation, agentLocationId } from '../core/agent.js';
import { createAgent, publicAgent, privateLocations, agentCheck } from './agent.js';
import { STRATEGY_LABELS as RETRY_LABELS, MAX_TOTAL_WAIT_SEC } from '../core/retry.js';
import { substitute, maskValues, refsOf, secretsKeys, secretsAvailable, encrypt, decrypt, isCurrent, validateEntry, MAX_PER_AREA } from './secrets.js';
import crypto from 'node:crypto';
import { teamsOk, discordOk, publicChannel, emailAvailable, telegramAvailable, slackPrefix, sendToChannel, publicBaseUrl, telegramBotUsername, telegramReply } from './channels.js';
import { testChannel } from './notify.js';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const token = () => crypto.randomBytes(24).toString('base64url');

// /api/monitoring, /api/monitors…, /api/incidents…, /api/maintenance… (spec §12). Everything is
// limited to the area of the request, like the rest of the API (RF-ISO-02).

const PERIODS = [['24h', DAY], ['7d', 7 * DAY], ['30d', 30 * DAY], ['90d', 90 * DAY], ['12m', 365 * DAY]];
// RF-RIS-07: test runs call the target from the server, so they are limited (per area, 10 a minute)
const testRuns = new Map();
function allowTestRun(area, now) {
  const list = (testRuns.get(area) || []).filter((t) => t > now - 60000);
  if (list.length >= 10) return false;
  list.push(now);
  testRuns.set(area, list);
  return true;
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

/** Minimal CSV parser: comma separated, double quotes, header row. */
export function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  const s = String(text || '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; } else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  return head ? body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()]))) : [];
}

// The CSV carries the simple configuration: the expected statuses and one word; other assertions are not exported
const simpleExpect = (m) => (m.assertions || []).find((a) => a.source === 'status' && a.comparison === 'in')?.target || '200-399';
const simpleKeyword = (m) => (m.assertions || []).find((a) => a.source === 'body' && (a.comparison === 'contains' || a.comparison === 'notContains'));
const CSV_COLUMNS = ['name', 'url', 'intervalMin', 'timeoutS', 'method', 'expect', 'keyword', 'keywordMode', 'degradedMs', 'failedMs', 'slaPct', 'tags', 'description'];
const monitorFromCsv = (r) => ({
  name: r.name, url: r.url, intervalMin: r.intervalMin || 5, timeoutS: r.timeoutS || 30, method: r.method || 'GET', expect: r.expect || '200-399',
  keyword: r.keyword ? { text: r.keyword, mode: r.keywordMode === 'absent' ? 'absent' : 'present', caseInsensitive: true } : null,
  // «slowMs» is the column of the first version
  degradedMs: r.degradedMs || r.slowMs || null, failedMs: r.failedMs || null, slaPct: r.slaPct || 99.9, description: r.description || '',
  tags: (r.tags || '').split(';').map((t) => t.trim()).filter(Boolean),
});

export function monitoringContext(st, user) {
  return { by: (user && user.username) || null, store: monitorStoreFor(), area: monitorArea(st), tz: (user && user.tz) || monitoringConfig().tz, guard: st.isolated ? networkGuardEnabled(true) : false };
}

/** RF-ALR-06: a change to a monitor goes in the history of the account. */
async function logChange(ctx, mon, action, now = Date.now()) {
  await ctx.store.addEvent(ctx.area, { type: 'monitor-change', status: 'info', at: now, monitorId: mon.id, monitorName: mon.name, url: mon.url, tags: mon.tags || [], action, by: ctx.by });
}

/** Runs one check now (after creating a monitor: the result is visible at once, §12.8). */
async function checkNow(ctx, m) {
  if (isPassive(m.type)) {
    // nothing to request: the deadlines passed so far are evaluated
    await evaluatePassive(ctx.store, ctx.area, m, Date.now(), { windows: await ctx.store.listWindows(ctx.area), tz: ctx.tz });
    const { deliverArea } = await import('./notify.js');
    await deliverArea(ctx.store, ctx.area);
    return m;
  }
  // «run now» runs here, whatever the locations of the monitor; except in a private one, which only its agent can reach
  const runner = (m.locations || []).some(isPrivateLocation) ? (loc, c) => (isPrivateLocation(loc) ? agentCheck(loc, c) : performCheck(c.monitor, { guard: !!c.guard, now: c.now, detail: true, location: loc })) : null;
  const r = await checkMonitor(m, { guard: ctx.guard, retryMs: Math.min(monitoringConfig().retryMs, 2000), scope: await loadScope(ctx.store, ctx.area), area: ctx.area, runner });
  if (r.unconfigured) {
    m.state.unconfigured = r.unconfigured;
    await ctx.store.saveMonitor(ctx.area, m);
    return m;
  }
  if (m.state.unconfigured) m.state.unconfigured = null;
  await applyResult(ctx.store, ctx.area, m, r, { windows: await ctx.store.listWindows(ctx.area), tz: ctx.tz });
  const { deliverArea } = await import('./notify.js');
  await deliverArea(ctx.store, ctx.area);
  return m;
}

async function createMonitors(ctx, inputs, { isolated, check = false }) {
  const existing = await ctx.store.listMonitors(ctx.area);
  const max = monitoringConfig().maxMonitors;
  const urls = new Set(existing.map((m) => m.url));
  const created = [], skipped = [];
  for (const { line, input } of inputs) {
    try {
      if (existing.length + created.length >= max) throw new UserError(`Limite di ${max} monitor raggiunto`);
      const m = normalizeMonitor(input, null, { isolated });
      if (m.url && urls.has(m.url)) throw new UserError('URL già monitorato');
      urls.add(m.url);
      await ctx.store.saveMonitor(ctx.area, m);
      await logChange(ctx, m, 'creato');
      created.push(m);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      skipped.push({ line, reason: e.message });
    }
  }
  if (check) for (const m of created) await checkNow(ctx, m);
  return { created, skipped };
}

/** "nome, URL" or "URL", one per line (RF-MON-02). */
function parseBulk(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((line) => {
    const i = line.lastIndexOf(',');
    const [name, url] = i > 0 && /^https?:\/\//i.test(line.slice(i + 1).trim()) ? [line.slice(0, i).trim(), line.slice(i + 1).trim()] : ['', line];
    return { line, input: { name, url } };
  });
}

async function selection(ctx, body) {
  const all = await ctx.store.listMonitors(ctx.area);
  if (body.tag) return all.filter((m) => m.tags.includes(String(body.tag).toLowerCase()));
  const ids = new Set(body.ids || []);
  return all.filter((m) => ids.has(m.id));
}

async function dashboard(ctx, { now }) {
  const monitors = await ctx.store.listMonitors(ctx.area);
  const windows = await ctx.store.listWindows(ctx.area);
  // the ones that are down first, then the critical ones, then by availability (RF-KPI-02)
  const summaries = listResponse(await monitorRows(ctx.store, ctx.area, monitors, { now, windows, tz: ctx.tz }), { now, pageSize: 200 }).rows;
  const incidents = await ctx.store.listIncidents(ctx.area, { from: now - 90 * DAY, limit: 50 });
  const byId = new Map(monitors.map((m) => [m.id, m]));
  const incView = (i) => ({ ...i, monitorName: byId.get(i.monitorId)?.name || '(eliminato)', durationMs: (i.end ?? now) - i.start, excerpt: undefined, firstRun: undefined });
  const last = await ctx.store.lastBeat();
  const beats = await ctx.store.listBeats(now - DAY);
  const occurrences = windows.flatMap((w) => windowOccurrences(w, now - HOUR, now + 7 * DAY, ctx.tz).map(([s, e]) => ({ id: w.id, name: w.name, start: s, end: e, active: s <= now && now < e, monitors: monitors.filter((m) => maintenanceFor([w], m, s, e, ctx.tz).length).map((m) => m.name) })));
  const channels = await ctx.store.listChannels(ctx.area);
  return {
    now,
    channelsInError: channels.filter((ch) => ch.status === 'error').map(publicChannel),
    channelCount: channels.filter((ch) => ch.status !== 'pending').length,
    dev: process.env.VERCEL !== '1',
    tz: ctx.tz,
    monitors: summaries,
    tags: [...new Set(monitors.flatMap((m) => m.tags))].sort(),
    openIncidents: incidents.filter((i) => i.end == null).map(incView),
    recentIncidents: incidents.slice(0, 10).map(incView),
    certs: summaries.filter((s) => s.certDays != null && s.certDays <= 30).map((s) => ({ id: s.id, name: s.name, days: s.certDays, issuer: s.certIssuer })).sort((a, b) => a.days - b.days),
    beat: { last: last ? last.at : null, stale: !last || now - last.at > 12 * 60000, unreliable: beats.filter((b) => b.unreliable).map((b) => b.at) },
    windows: occurrences.filter((o) => o.end > now).sort((a, b) => a.start - b.start),
    heartbeatConfigured: !!monitoringConfig().heartbeatUrl,
  };
}

async function monitorDetail(ctx, m, { now }) {
  const windows = await ctx.store.listWindows(ctx.area);
  const summary = await monitorSummary(ctx.store, ctx.area, m, { now, windows, tz: ctx.tz });
  const periods = {};
  for (const [k, ms] of PERIODS) periods[k] = await monitorKpis(ctx.store, ctx.area, m, { from: now - ms, to: now, now, windows, tz: ctx.tz });
  const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
  periods.month = await monitorKpis(ctx.store, ctx.area, m, { from: monthStart, to: now, now, windows, tz: ctx.tz });
  const checks = (await ctx.store.listChecks(ctx.area, m.id, now - DAY, now + 1)).slice(-288);
  const hourly = await ctx.store.listAggregates(ctx.area, 'hourly', m.id, now - 7 * DAY, now);
  const incidents = await ctx.store.listIncidents(ctx.area, { monitorId: m.id, limit: 100 });
  return {
    ...summary,
    periods,
    checks: checks.reverse(),
    responses7d: hourly.map((a) => ({ t: a.hour, avgMs: a.msCount ? Math.round(a.msSum / a.msCount) : null, p95Ms: a.p95Ms, downtimeMs: a.downtimeMs })),
    incidents: incidents.map((i) => ({ ...i, durationMs: (i.end ?? now) - i.start, excerpt: undefined, firstRun: undefined })),
    ...(m.type === 'heartbeat' ? { hbUrl: `${publicBaseUrl()}/hb/${m.hbToken}`, pings: [...(m.state.pings || [])].reverse(), nextDeadline: m.state.nextCheckAt } : {}),
    typeInfo: TYPE_INFO[m.type] || null,
  };
}

// ---------------- the public address of the heartbeats (spec §13.5, RF-TYP-01) ----------------

const hbHits = new Map(); // key → instants of the last minute
const HB_PER_TOKEN = 60, HB_PER_IP = 240;
function hbAllowed(key, limit, now) {
  const hits = (hbHits.get(key) || []).filter((t) => t > now - 60000);
  if (hits.length >= limit) { hbHits.set(key, hits); return false; }
  hits.push(now);
  hbHits.set(key, hits);
  if (hbHits.size > 5000) for (const [k, v] of hbHits) if (!v.some((t) => t > now - 60000)) hbHits.delete(k);
  return true;
}

/**
 * `/hb/<token>`, `/hb/<token>/start` and `/hb/<token>/fail`, GET or POST, with no session: the token is the
 * secret. Rate limited; an unknown token and a wrong one answer the same. Returns false for other paths.
 */
export async function handleHeartbeatPublic(req, res, url, { ip = null } = {}) {
  const m = /^\/hb\/([\w-]{16,64})(?:\/(start|fail))?\/?$/.exec(url.pathname);
  if (!m) return false;
  const text = (code, body) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); return true; };
  if (!monitoringEnabled()) return text(404, 'Monitoraggio non attivo');
  if (!['GET', 'POST', 'HEAD'].includes(req.method)) return text(405, 'Usa GET o POST');
  const now = Date.now();
  if (!hbAllowed(`ip:${ip}`, HB_PER_IP, now) || !hbAllowed(`t:${m[1]}`, HB_PER_TOKEN, now)) return text(429, 'Troppe chiamate: al massimo 60 al minuto per heartbeat');
  const store = monitorStoreFor();
  const found = await store.findHeartbeat(m[1]);
  if (!found) return text(404, 'Heartbeat sconosciuto');
  let message = url.searchParams.get('msg') || '';
  if (req.method === 'POST') {
    let body = '';
    for await (const c of req) { body += c; if (body.length > 2048) break; }
    message = message || body.trim();
  }
  const kind = m[2] || 'ok';
  const r = await recordPing(store, found.area, found.monitor, kind, now, { ip, message: message.slice(0, 200) });
  if (kind !== 'start') {
    const { deliverArea } = await import('./notify.js');
    await deliverArea(store, found.area);
  }
  return text(200, 'ok');
}

/** Handles the monitoring routes; returns false if the path is not one of them. */
export async function handleMonitorApi(req, res, url, { st, user = null }) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1);
  const [a, b, c] = parts;
  if (!['monitoring', 'monitors', 'monitors.csv', 'incidents', 'incidents.csv', 'maintenance', 'channels', 'notify-prefs', 'history', 'notification-log', 'new-problems', 'monitor-list', 'monitor-views', 'monitor-types', 'monitor-locations', 'agents', 'secrets', 'tags', 'statuspages', 'public-links', 'report', 'report.csv', 'report.pdf', 'report-subscriptions'].includes(a)) return false;
  if (!monitoringEnabled()) throw new NotFound('Monitoraggio non attivo: in locale si abilita con SITESCANNER_MONITOR_DEV=1');
  const ctx = monitoringContext(st, user);
  const m = req.method;
  const now = Date.now();
  const getMonitor = async (id) => {
    const mon = await ctx.store.getMonitor(ctx.area, id);
    if (!mon) throw new NotFound('Monitor non trovato');
    return mon;
  };

  if (a === 'monitoring' && m === 'GET') return send(res, 200, await dashboard(ctx, { now })), true;
  if (a === 'channels' || a === 'notify-prefs') return handleChannels(req, res, ctx, parts, now);
  if (a === 'monitor-list' && m === 'GET') {
    // RF-LST-01..04: the list with period, search, filters, sorting and pages, computed in bulk
    const q = url.searchParams;
    const period = LIST_PERIODS[q.get('period')] ? q.get('period') : '30d';
    const sort = SORTS.includes(q.get('sort')) ? q.get('sort') : 'default';
    const rows = await monitorRows(ctx.store, ctx.area, await ctx.store.listMonitors(ctx.area), { now, windows: await ctx.store.listWindows(ctx.area), tz: ctx.tz, period });
    return send(res, 200, listResponse(rows, { now, period, query: q.get('q') || '', status: q.get('status') || '', tag: q.get('tag') || '', sort, dir: q.get('dir') === 'desc' ? 'desc' : 'asc', page: q.get('page'), pageSize: q.get('pageSize') })), true;
  }
  if (a === 'report' || a === 'report.csv' || a === 'report.pdf') {
    // RF-RPT-01/02: the KPIs of the dashboard for a period and a group of monitors, as JSON, CSV or PDF
    const q = url.searchParams;
    let report;
    try {
      report = await reportData(ctx.store, ctx.area, { period: q.get('period') || 'month', from: q.get('from'), to: q.get('to'), tags: (q.get('tag') || '').split(',').filter(Boolean), text: q.get('q') || '', now, tz: ctx.tz });
    } catch (e) { throw new UserError(e.message); }
    if (a === 'report') return send(res, 200, report), true;
    if (a === 'report.csv') {
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="report-disponibilita.csv"' });
      return res.end(`\ufeff${reportCsv(report)}`), true;
    }
    const buffer = await reportPdf(report, { client: q.get('client') || q.get('tag') || '' });
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': buffer.length, 'content-disposition': `attachment; filename="${reportFileName(report, q.get('client') || q.get('tag'))}"` });
    return res.end(buffer), true;
  }
  if (a === 'report-subscriptions') {
    // RF-RPT-03: who receives the monthly report of which tag
    const prefs = await ctx.store.getPrefs(ctx.area);
    const subs = prefs.monthlyReports || [];
    const [, id, action] = parts;
    if (!id && m === 'GET') return send(res, 200, subs), true;
    if (!id && m === 'POST') {
      const body = await readJson(req);
      const name = String(body.name || '').trim().slice(0, 60);
      if (!name) throw new UserError('Dai un nome al report (di solito il cliente)');
      const channels = (await ctx.store.listChannels(ctx.area)).filter((c) => c.type === 'email' && c.status === 'active');
      const ids = [...new Set((body.channelIds || []).map(String))];
      if (!ids.length || ids.some((x) => !channels.some((c) => c.id === x))) throw new UserError('Scegli almeno un indirizzo email confermato tra i canali');
      if (subs.length >= 30) throw new UserError('Al massimo 30 report mensili');
      const sub = { id: crypto.randomBytes(4).toString('hex'), name, tag: String(body.tag || '').trim().toLowerCase(), channelIds: ids, createdAt: now };
      await ctx.store.savePrefs(ctx.area, { ...prefs, monthlyReports: [...subs, sub] });
      return send(res, 201, sub), true;
    }
    const sub = subs.find((x) => x.id === id);
    if (!sub) throw new NotFound('Report non trovato');
    if (m === 'DELETE' && !action) {
      await ctx.store.savePrefs(ctx.area, { ...prefs, monthlyReports: subs.filter((x) => x.id !== id) });
      return send(res, 200, { ok: true }), true;
    }
    if (action === 'send' && m === 'POST') return send(res, 200, await sendOne(ctx.store, ctx.area, sub, { now, tz: ctx.tz })), true;
    throw new NotFound('API sconosciuta');
  }
  if (a === 'statuspages' || a === 'public-links') {
    await handleStatus(req, res, ctx, parts, now);
    return true;
  }
  if (a === 'secrets' || a === 'tags') {
    await (a === 'secrets' ? handleSecrets : handleTags)(req, res, ctx, parts, now);
    return true;
  }
  if (a === 'monitor-locations' && m === 'GET') {
    const cfg = monitoringConfig();
    return send(res, 200, { locations: [...cfg.locations, ...(await privateLocations(ctx.store, ctx.area))], main: cfg.locations[0].id, strategies: LOC_STRATEGY_LABELS, retryStrategies: RETRY_LABELS, maxRetryWaitSec: MAX_TOTAL_WAIT_SEC }), true;
  }
  if (a === 'agents') {
    // RF-AGT-01: the agents of the workspace, private locations that run in the network of a customer (ADR-0025)
    if (!b && m === 'GET') {
      const monitors = await ctx.store.listMonitors(ctx.area);
      const list = await ctx.store.listAgents(ctx.area);
      return send(res, 200, { agents: list.map((a) => ({ ...publicAgent(a, now), monitors: monitors.filter((x) => (x.locations || []).includes(agentLocationId(a))).map((x) => ({ id: x.id, name: x.name })) })), now }), true;
    }
    if (!b && m === 'POST') {
      const { agent, token } = await createAgent(ctx.store, ctx.area, (await readJson(req)).name, { by: ctx.by, now });
      return send(res, 201, { agent: publicAgent(agent, now), token }), true;
    }
    if (b && m === 'DELETE') {
      const agent = await ctx.store.getAgent(ctx.area, b);
      if (!agent) throw new NotFound('Agente non trovato');
      const using = (await ctx.store.listMonitors(ctx.area)).filter((x) => (x.locations || []).includes(agentLocationId(agent)));
      if (using.length) return send(res, 409, { error: `L'agente è usato da ${using.length} monitor (${using.slice(0, 3).map((x) => x.name).join(', ')}${using.length > 3 ? '…' : ''}): toglilo prima dalle loro località` }), true;
      await ctx.store.deleteAgent(ctx.area, b);
      return send(res, 200, { ok: true }), true;
    }
    return send(res, 405, { error: 'Metodo non ammesso' }), true;
  }
  if (a === 'monitor-types' && m === 'GET') return send(res, 200, TYPE_INFO), true;
  if (a === 'monitor-views') {
    await handleViews(req, res, ctx, parts, now);
    return true;
  }
  if (a === 'history' && m === 'GET') return send(res, 200, await history(ctx, url.searchParams, now)), true;
  if (a === 'notification-log' && m === 'GET') return send(res, 200, await notificationLog(ctx, url.searchParams, now)), true;
  if (a === 'new-problems' && m === 'GET') return send(res, 200, await problems(ctx, url.searchParams, now)), true;

  if (a === 'monitors.csv' && m === 'GET') {
    const list = await ctx.store.listMonitors(ctx.area);
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="monitor.csv"' });
    res.end(toCsv([CSV_COLUMNS, ...list.map((x) => [x.name, x.url, x.intervalMin, x.timeoutS, x.method, simpleExpect(x), simpleKeyword(x)?.target || '', simpleKeyword(x) ? (simpleKeyword(x).comparison === 'notContains' ? 'absent' : 'present') : '', x.degradedMs || '', x.failedMs || '', x.slaPct, x.tags.join(';'), x.description || ''])]));
    return true;
  }

  if (a === 'monitors') {
    if (!b && m === 'GET') return send(res, 200, (await ctx.store.listMonitors(ctx.area)).map(publicMonitor)), true;
    if (!b && m === 'POST') {
      const body = await readJson(req);
      const { created, skipped } = await createMonitors(ctx, [{ line: body.url, input: body }], { isolated: st.isolated, check: true });
      if (!created.length) throw new UserError(skipped[0].reason);
      return send(res, 201, await monitorSummary(ctx.store, ctx.area, created[0], { now: Date.now(), windows: await ctx.store.listWindows(ctx.area), tz: ctx.tz })), true;
    }
    if (b === 'export' && m === 'GET') {
      // RF-MAC-03: the YAML of some monitors (or all), to paste into the file
      const ids = url.searchParams.get('ids');
      const yaml = await exportYaml(ctx.store, ctx.area, { ids: ids ? ids.split(',').filter(Boolean) : null, tags: (url.searchParams.get('tag') || '').split(',').filter(Boolean) });
      res.writeHead(200, { 'content-type': 'text/yaml; charset=utf-8', 'content-disposition': 'attachment; filename="sitescanner.monitors.yml"' });
      return res.end(yaml), true;
    }
    if (b === 'test' && m === 'POST') {
      // RF-RIS-07: one run with the configuration of the form, not saved and not in the history
      if (!allowTestRun(ctx.area, now)) throw Object.assign(new UserError('Troppe prove: al massimo 10 al minuto'), { status: 429 });
      const body = await readJson(req);
      const existing = body.id ? await ctx.store.getMonitor(ctx.area, String(body.id)) : null;
      const mon = normalizeMonitor(unmask(body, existing), existing, { isolated: st.isolated });
      if (isPassive(mon.type)) throw new UserError('La prova non vale per un heartbeat: è il job a chiamare');
      if ((mon.locations || []).some(isPrivateLocation)) throw new UserError("Un monitor che gira da un agente si prova dopo averlo salvato, con «Esegui ora»: la prova partirebbe dal servizio, che non vede la rete dell'agente");
      const sub = substitute(mon, await loadScope(ctx.store, ctx.area));
      if (sub.missing.length) throw new UserError(`Manca la variabile ${sub.missing.join(', ')}: aggiungila nella pagina Variabili`);
      const r0 = await performCheck(sub.monitor, { guard: ctx.guard, detail: true });
      const r = sub.secretValues.length ? maskValues(r0, sub.secretValues) : r0;
      return send(res, 200, { ...r, message: r.outcome === 'error' ? describeError(r, mon.timeoutS) : r.error || null, thresholds: { degradedMs: mon.degradedMs, failedMs: mon.failedMs || mon.timeoutS * 1000 } }), true;
    }
    if (b === 'bulk' && m === 'POST') {
      const body = await readJson(req);
      const common = { intervalMin: body.intervalMin || 5, tags: body.tags || [], channels: body.channels || null };
      const r = await createMonitors(ctx, parseBulk(body.text).map((x) => ({ ...x, input: { ...common, ...x.input } })), { isolated: st.isolated, check: !!body.check });
      return send(res, 200, { created: r.created.map(publicMonitor), skipped: r.skipped }), true;
    }
    if (b === 'import-csv' && m === 'POST') {
      const body = await readJson(req);
      const rows = parseCsv(body.csv);
      const r = await createMonitors(ctx, rows.map((row, i) => ({ line: `riga ${i + 2}: ${row.url || ''}`, input: monitorFromCsv(row) })), { isolated: st.isolated });
      return send(res, 200, { created: r.created.map(publicMonitor), skipped: r.skipped }), true;
    }
    if (b === 'import-site' && m === 'POST') {
      // RF-MON-03: one monitor per environment of a site, with its basic auth
      const body = await readJson(req);
      const cfg = await loadSite(st, body.site);
      const inputs = Object.entries(cfg.envs).map(([env, e]) => ({ line: `${cfg.id} · ${env}`, input: { name: `${cfg.name} · ${env}`, url: e.baseUrl, auth: e.auth || null, tags: [cfg.id], source: { site: cfg.id, env } } }));
      const r = await createMonitors(ctx, inputs, { isolated: st.isolated, check: true });
      return send(res, 200, { created: r.created.map(publicMonitor), skipped: r.skipped }), true;
    }
    if (b === 'actions' && m === 'POST') {
      // RF-MON-04 and RF-MNT-05
      const body = await readJson(req);
      const list = await selection(ctx, body);
      if (!list.length) throw new UserError('Nessun monitor selezionato');
      // the configuration of a monitor of the file changes in the file; running, muting, pausing and copying are not configuration
      if (!['check', 'mute', 'unmute', 'pause', 'resume', 'duplicate', 'maintenance'].includes(body.action) && list.some(isManaged)) throw Object.assign(new UserError(MANAGED_MESSAGE), { status: 409 });
      if (body.action === 'maintenance') {
        const minutes = Number(body.value);
        if (![15, 30, 60].includes(minutes)) throw new UserError('Durata della manutenzione: 15, 30 o 60 minuti');
        const w = { id: crypto.randomBytes(5).toString('hex'), name: `Manutenzione immediata (${minutes} min)`, type: 'once', start: now, durationMin: minutes, monitorIds: body.tag ? [] : list.map((x) => x.id), tags: body.tag ? [String(body.tag).toLowerCase()] : [], createdAt: now };
        await ctx.store.saveWindow(ctx.area, w);
        return send(res, 200, { ok: true, window: w, count: list.length }), true;
      }
      if (body.action === 'check') {
        // RF-LST-05: run now, for a handful of monitors at a time
        if (list.length > 20) throw new UserError('Esegui ora al massimo 20 monitor alla volta');
        for (const mon of list.filter((x) => !x.paused)) await checkNow(ctx, mon);
        return send(res, 200, { ok: true, count: list.length }), true;
      }
      if (body.action === 'duplicate') {
        const max = monitoringConfig().maxMonitors;
        const existing = (await ctx.store.listMonitors(ctx.area)).length;
        if (existing + list.length > max) throw new UserError(`Limite di ${max} monitor raggiunto`);
        for (const mon of list) {
          const { id, state, createdAt, ...config } = mon;
          const copy = normalizeMonitor({ ...config, name: `Copia di ${mon.name}`.slice(0, 80), muted: null, source: null, managedBy: null, codeId: null }, null, { isolated: st.isolated });
          await ctx.store.saveMonitor(ctx.area, copy);
          await logChange(ctx, copy, 'creato (copia)', now);
        }
        return send(res, 200, { ok: true, count: list.length }), true;
      }
      if (body.action === 'mute') {
        // RF-RIS-03: for a number of minutes, or (0) until unmuted
        const minutes = Number(body.value ?? 0);
        if (!Number.isInteger(minutes) || minutes < 0 || minutes > 43200) throw new UserError('Durata del silenziamento: da 1 minuto a 30 giorni, oppure 0 fino alla riattivazione');
        for (const mon of list) {
          mon.muted = { until: minutes ? now + minutes * 60000 : null };
          await ctx.store.saveMonitor(ctx.area, mon);
          await logChange(ctx, mon, 'silenziato', now);
        }
        return send(res, 200, { ok: true, count: list.length }), true;
      }
      for (const mon of list) {
        if (body.action === 'unmute') { mon.muted = null; await ctx.store.saveMonitor(ctx.area, mon); await logChange(ctx, mon, 'avvisi riattivati', now); continue; }
        if (body.action === 'delete') { await ctx.store.deleteMonitor(ctx.area, mon.id); await logChange(ctx, mon, 'eliminato', now); continue; }
        if (body.action === 'pause' && !mon.paused) await pause(ctx, mon, now);
        else if (body.action === 'resume') { mon.paused = false; mon.state.nextCheckAt = 0; mon.state.since = now; }
        else if (body.action === 'interval') Object.assign(mon, normalizeMonitor({ intervalMin: Number(body.value) }, mon));
        else if (body.action === 'tags') mon.tags = normalizeMonitor({ tags: body.value || [] }, mon).tags;
        else if (body.action === 'add-tag') mon.tags = normalizeMonitor({ tags: [...mon.tags, body.value] }, mon).tags;
        else if (body.action === 'channels') mon.channels = Array.isArray(body.value) ? body.value : null;
        else if (body.action !== 'pause') throw new UserError(`Azione sconosciuta: ${body.action}`);
        await ctx.store.saveMonitor(ctx.area, mon);
        await logChange(ctx, mon, body.action === 'pause' ? 'messo in pausa' : body.action === 'resume' ? 'ripreso' : 'modificato', now);
      }
      return send(res, 200, { ok: true, count: list.length }), true;
    }
    if (b === 'daily.csv' && m === 'GET') {
      // RF-KPI-06: daily availability (UTC days) of one or all monitors in a period
      const q = url.searchParams;
      const from = q.get('from') ? Date.parse(q.get('from')) : now - 30 * DAY;
      const to = q.get('to') ? Date.parse(q.get('to')) + DAY : now;
      const list = (await ctx.store.listMonitors(ctx.area)).filter((x) => !q.get('monitor') || x.id === q.get('monitor'));
      const rows = [['monitor', 'url', 'giorno', 'disponibilita', 'downtime_s', 'monitorato_s', 'controlli', 'errori', 'risposta_media_ms']];
      for (const x of list) {
        for (const d of await ctx.store.listAggregates(ctx.area, 'daily', x.id, Math.floor(from / DAY) * DAY, to)) {
          rows.push([x.name, x.url, new Date(d.day).toISOString().slice(0, 10), d.monitoredMs ? ((1 - d.downtimeMs / d.monitoredMs) * 100).toFixed(3) : '', Math.round(d.downtimeMs / 1000), Math.round(d.monitoredMs / 1000), d.checks, d.errors, d.msCount ? Math.round(d.msSum / d.msCount) : '']);
        }
      }
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="disponibilita-giornaliera.csv"' });
      res.end(toCsv(rows));
      return true;
    }
    if (b && !c) {
      const mon = await getMonitor(b);
      if (m === 'GET') return send(res, 200, await monitorDetail(ctx, mon, { now })), true;
      if ((m === 'PUT' || m === 'DELETE') && isManaged(mon)) throw Object.assign(new UserError(MANAGED_MESSAGE), { status: 409 });
      if (m === 'PUT') {
        const body = unmask(await readJson(req), mon);
        const wasPaused = mon.paused;
        // muting has its own action; the summary fields sent back by the form are not configuration
        const { state, id, createdAt, muted, mutedUntil, status, health, k30, budget, certDays, degradedShare, maintenance, last24, last90, target, hbUrl, pings, nextDeadline, typeInfo, ...fields } = body;
        const next = normalizeMonitor(fields, mon, { isolated: st.isolated });
        if (!wasPaused && next.paused) { next.paused = false; await pause(ctx, next, now); }
        if (wasPaused && !next.paused) { next.state.nextCheckAt = 0; next.state.since = now; }
        await ctx.store.saveMonitor(ctx.area, next);
        await logChange(ctx, next, wasPaused !== next.paused ? (next.paused ? 'messo in pausa' : 'ripreso') : 'modificato', now);
        return send(res, 200, publicMonitor(next)), true;
      }
      if (m === 'DELETE') {
        await ctx.store.deleteMonitor(ctx.area, mon.id);
        await logChange(ctx, mon, 'eliminato', now);
        return send(res, 200, { ok: true }), true;
      }
    }
    if (b && c === 'analysis' && m === 'GET') {
      // RF-RIS-20/23/24: KPIs, percentiles, groups of errors and phases of a period of the detail page
      return send(res, 200, await analysis(ctx, await getMonitor(b), url.searchParams, now)), true;
    }
    if (b && c === 'runs' && m === 'GET') {
      const mon = await getMonitor(b);
      const runId = parts[3];
      if (runId) {
        // RF-RIS-21: the detail of a run; runs without it only have the light record
        const detail = await ctx.store.loadRunDetail(ctx.area, mon.id, runId);
        const light = (await ctx.store.listChecks(ctx.area, mon.id, 0, Infinity)).find((x) => x.id === runId);
        if (!detail && !light) throw new NotFound('Run non trovato: i dati grezzi si conservano per un periodo limitato');
        return send(res, 200, { run: light || null, detail, monitor: { id: mon.id, name: mon.name, url: mon.url } }), true;
      }
      return send(res, 200, await listRuns(ctx, mon, url.searchParams, now)), true;
    }
    if (b && c === 'duplicate' && m === 'POST') {
      // RF-RIS-04: the configuration, not the history; the copy is created (the same URL is allowed on purpose:
      // the usual use is the same site in another environment, edited right after)
      const mon = await getMonitor(b);
      const max = monitoringConfig().maxMonitors;
      if ((await ctx.store.listMonitors(ctx.area)).length >= max) throw new UserError(`Limite di ${max} monitor raggiunto`);
      const { id, state, createdAt, ...config } = mon;
      const copy = normalizeMonitor({ ...config, name: `Copia di ${mon.name}`.slice(0, 80), muted: null, source: null, managedBy: null, codeId: null }, null, { isolated: st.isolated });
      await ctx.store.saveMonitor(ctx.area, copy);
      return send(res, 201, publicMonitor(copy)), true;
    }
    if (b && c === 'check' && m === 'POST') {
      const mon = await getMonitor(b);
      if (mon.paused) throw new UserError('Il monitor è in pausa');
      await checkNow(ctx, mon);
      return send(res, 200, await monitorSummary(ctx.store, ctx.area, mon, { now: Date.now(), windows: await ctx.store.listWindows(ctx.area), tz: ctx.tz })), true;
    }
  }

  if (a === 'incidents.csv' && m === 'GET') {
    // RF-KPI-06: incidents of a period, optionally of one monitor
    const q = url.searchParams;
    const from = q.get('from') ? Date.parse(q.get('from')) : now - 30 * DAY;
    const to = q.get('to') ? Date.parse(q.get('to')) + DAY : now;
    const monitors = new Map((await ctx.store.listMonitors(ctx.area)).map((x) => [x.id, x]));
    const list = await ctx.store.listIncidents(ctx.area, { monitorId: q.get('monitor') || null, from, to });
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="incidenti.csv"' });
    res.end(toCsv([['monitor', 'url', 'inizio', 'fine', 'durata', 'causa'], ...list.map((i) => [monitors.get(i.monitorId)?.name || '', monitors.get(i.monitorId)?.url || '', new Date(i.start).toISOString(), i.end ? new Date(i.end).toISOString() : '', fmtDuration((i.end ?? now) - i.start), i.cause.message])]));
    return true;
  }

  if (a === 'incidents') {
    if (!b && m === 'GET') {
      const q = url.searchParams;
      return send(res, 200, (await ctx.store.listIncidents(ctx.area, { monitorId: q.get('monitor') || null, limit: Number(q.get('limit')) || 100 })).map((i) => ({ ...i, firstRun: undefined }))), true;
    }
    if (b) {
      const inc = await ctx.store.getIncident(ctx.area, b);
      if (!inc) throw new NotFound('Incidente non trovato');
      if (m === 'GET') {
        const mon = await ctx.store.getMonitor(ctx.area, inc.monitorId);
        const checks = await ctx.store.listChecks(ctx.area, inc.monitorId, inc.start - HOUR, (inc.end ?? now) + HOUR);
        const events = (await ctx.store.listEvents(ctx.area, { limit: 2000 })).filter((e) => e.incidentId === inc.id);
        return send(res, 200, { ...inc, durationMs: (inc.end ?? now) - inc.start, monitor: mon ? publicMonitor(mon) : null, checks, events }), true;
      }
      if (m === 'PUT') {
        const body = await readJson(req);
        inc.note = String(body.note ?? '').slice(0, 5000);
        await ctx.store.saveIncident(ctx.area, inc);
        return send(res, 200, inc), true;
      }
    }
  }

  if (a === 'maintenance') {
    if (!b && m === 'GET') return send(res, 200, await ctx.store.listWindows(ctx.area)), true;
    if (!b && m === 'POST') {
      const w = normalizeWindow(await readJson(req), null, ctx.tz);
      await ctx.store.saveWindow(ctx.area, w);
      return send(res, 201, w), true;
    }
    if (b) {
      const w = (await ctx.store.listWindows(ctx.area)).find((x) => x.id === b);
      if (!w) throw new NotFound('Finestra di manutenzione non trovata');
      if (!c && (m === 'PUT' || m === 'DELETE') && isManaged(w)) throw Object.assign(new UserError(MANAGED_MESSAGE), { status: 409 });
      if (!c && m === 'PUT') {
        const next = normalizeWindow(await readJson(req), w, ctx.tz);
        await ctx.store.saveWindow(ctx.area, next);
        return send(res, 200, next), true;
      }
      if (!c && m === 'DELETE') {
        await ctx.store.deleteWindow(ctx.area, b);
        return send(res, 200, { ok: true }), true;
      }
      if (c === 'end' && m === 'POST') {
        w.endedAt = now;
        await ctx.store.saveWindow(ctx.area, w);
        return send(res, 200, w), true;
      }
    }
  }
  throw new NotFound(`API sconosciuta: ${m} ${url.pathname}`);
}

// ---------------- status pages, TV dashboard, badges (spec §13.11, RF-PUB-01..06) ----------------

const randomToken = () => crypto.randomBytes(18).toString('base64url');

/** What the API shows of a page: never the hash of the password, with its public addresses. */
function publicPage(p) {
  const { passwordHash, ...rest } = p;
  const base = publicBaseUrl();
  return { ...rest, hasPassword: !!passwordHash, url: `${base}/status/${p.slug}`, jsonUrl: `${base}/status/${p.slug}.json`, ...(p.customDomain ? { customUrl: `https://${p.customDomain}/` } : {}) };
}

function publicLink(l) {
  const base = publicBaseUrl();
  return l.kind === 'tv'
    ? { ...l, url: `${base}/tv/${l.token}` }
    : { ...l, url: `${base}/badge/${l.token}.svg`, markdown: `![stato](${base}/badge/${l.token}.svg)` };
}

async function handleStatus(req, res, ctx, parts, now) {
  const [a, b, c, d] = parts;
  const method = req.method;
  const store = ctx.store;
  const fail = (msg) => { throw new UserError(msg); };
  if (a === 'public-links') {
    if (!b && method === 'GET') return send(res, 200, (await store.listPublicLinks(ctx.area)).map(publicLink));
    if (!b && method === 'POST') {
      const body = await readJson(req);
      if ((await store.listPublicLinks(ctx.area)).length >= 100) fail('Al massimo 100 link pubblici');
      let link;
      if (body.kind === 'tv') {
        const name = String(body.name || '').trim().slice(0, 60) || 'Stato dei servizi';
        const tags = [...new Set((body.tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 10);
        link = { token: randomToken(), kind: 'tv', name, tags, createdAt: now, createdBy: ctx.by };
      } else if (body.kind === 'badge') {
        if (body.monitorId) {
          if (!(await store.getMonitor(ctx.area, String(body.monitorId)))) throw new NotFound('Monitor non trovato');
          link = { token: randomToken(), kind: 'badge', target: { monitorId: String(body.monitorId) }, createdAt: now, createdBy: ctx.by };
        } else {
          const page = await store.getStatusPage(ctx.area, String(body.pageId || ''));
          if (!page || !page.components.some((x) => x.id === body.componentId)) throw new NotFound('Componente non trovato');
          link = { token: randomToken(), kind: 'badge', target: { pageId: page.id, componentId: String(body.componentId) }, createdAt: now, createdBy: ctx.by };
        }
      } else fail('Tipo di link: tv o badge');
      await store.savePublicLink(ctx.area, link);
      return send(res, 201, publicLink(link));
    }
    if (b && method === 'DELETE') {
      if (!(await store.listPublicLinks(ctx.area)).some((l) => l.token === b)) throw new NotFound('Link non trovato');
      await store.deletePublicLink(ctx.area, b);
      return send(res, 200, { ok: true });
    }
    throw new NotFound('API sconosciuta');
  }

  // status pages
  const monitorIds = new Set((await store.listMonitors(ctx.area)).map((m) => m.id));
  const build = async (body, existing) => {
    let norm;
    try { norm = normalizePage({ ...(existing || {}), ...body }, { newId: () => crypto.randomBytes(3).toString('hex') }); } catch (e) { throw new UserError(e.message); }
    const bySlug = await store.findStatusPage({ slug: norm.slug });
    if (bySlug && !(bySlug.area === ctx.area && existing && bySlug.page.id === existing.id)) fail(`L'indirizzo «${norm.slug}» è già usato: scegline un altro`);
    if (norm.customDomain) {
      const byDomain = await store.findStatusPage({ domain: norm.customDomain });
      if (byDomain && !(byDomain.area === ctx.area && existing && byDomain.page.id === existing.id)) fail(`Il dominio ${norm.customDomain} è già usato da un'altra pagina`);
    }
    for (const comp of norm.components) if (comp.monitorIds.some((id) => !monitorIds.has(id))) fail(`Il componente «${comp.name}» usa un monitor che non esiste`);
    let passwordHash = existing ? existing.passwordHash : undefined;
    if (body.clearPassword) passwordHash = undefined;
    if (body.password) {
      if (String(body.password).length < 8) fail('La password della pagina ha almeno 8 caratteri');
      passwordHash = await hashPassword(String(body.password));
    }
    return { ...norm, ...(passwordHash ? { passwordHash } : {}) };
  };
  if (!b) {
    if (method === 'GET') return send(res, 200, (await store.listStatusPages(ctx.area)).map(publicPage));
    if (method === 'POST') {
      if ((await store.listStatusPages(ctx.area)).length >= 20) fail('Al massimo 20 status page per spazio');
      const page = { id: crypto.randomBytes(5).toString('hex'), createdAt: now, ...(await build(await readJson(req), null)) };
      await store.saveStatusPage(ctx.area, page);
      return send(res, 201, publicPage(page));
    }
  }
  const page = await store.getStatusPage(ctx.area, b);
  if (!page) throw new NotFound('Status page non trovata');
  if (!c) {
    if (method === 'GET') return send(res, 200, publicPage(page));
    if (method === 'PUT') {
      const next = { id: page.id, createdAt: page.createdAt, ...(await build(await readJson(req), page)) };
      await store.saveStatusPage(ctx.area, next);
      return send(res, 200, publicPage(next));
    }
    if (method === 'DELETE') {
      await store.deleteStatusPage(ctx.area, page.id);
      for (const l of await store.listPublicLinks(ctx.area)) if (l.target && l.target.pageId === page.id) await store.deletePublicLink(ctx.area, l.token);
      return send(res, 200, { ok: true });
    }
  }
  if (c === 'communications') {
    if (!d && method === 'GET') return send(res, 200, await store.listStatusUpdates(ctx.area, page.id, { limit: 100 }));
    if (!d && method === 'POST') {
      // RF-PUB-02: written by the team; a technical incident only suggests one, it publishes nothing
      let n;
      const body = await readJson(req);
      try { n = normalizeCommunication(body, page); } catch (e) { throw new UserError(e.message); }
      const u = { id: crypto.randomBytes(5).toString('hex'), pageId: page.id, title: n.title, status: n.status, components: n.components, incidentId: body.incidentId ? String(body.incidentId) : null, createdAt: now, resolvedAt: n.status === 'resolved' ? now : null, posts: [{ at: now, status: n.status, text: n.text, by: ctx.by }] };
      await store.saveStatusUpdate(ctx.area, u);
      await logChange(ctx, { id: '', name: page.name, url: '', tags: [] }, `comunicazione pubblicata: ${n.title}`, now);
      return send(res, 201, u);
    }
    const u = d && (await store.getStatusUpdate(ctx.area, d));
    if (d && (!u || u.pageId !== page.id)) throw new NotFound('Comunicazione non trovata');
    if (d && method === 'POST') {
      let p;
      try { p = normalizePost(await readJson(req)); } catch (e) { throw new UserError(e.message); }
      u.posts.push({ at: now, ...p, by: ctx.by });
      u.status = p.status;
      u.resolvedAt = p.status === 'resolved' ? now : null;
      await store.saveStatusUpdate(ctx.area, u);
      return send(res, 200, u);
    }
    if (d && method === 'DELETE') {
      await store.deleteStatusUpdate(ctx.area, u.id);
      return send(res, 200, { ok: true });
    }
  }
  throw new NotFound('API sconosciuta');
}

// ---------------- variables and secrets (spec §13.9, RF-SEG-01..04) ----------------

/** Variables are visible, secrets can be written but never read back. `usedBy`: the monitors that reference each name. */
async function handleSecrets(req, res, ctx, parts, now) {
  const [, b, c] = parts;
  const method = req.method;
  const keys = secretsKeys();
  const log = (action, name, kind) => ctx.store.addSecretLog(ctx.area, { at: now, by: ctx.by, action, name, kind });
  if (!b && method === 'GET') {
    const [items, monitors] = await Promise.all([ctx.store.listSecrets(ctx.area), ctx.store.listMonitors(ctx.area)]);
    const used = new Map();
    for (const mon of monitors) for (const n of refsOf({ ...mon, state: undefined, name: undefined, description: undefined, tags: undefined, vars: undefined })) used.set(n, [...(used.get(n) || []), { id: mon.id, name: mon.name }]);
    const names = new Set(items.map((s) => s.name));
    return send(res, 200, {
      available: secretsAvailable(), max: MAX_PER_AREA,
      items: [...items].sort((x, y) => x.name.localeCompare(y.name)).map((s) => ({ name: s.name, kind: s.kind, ...(s.kind === 'var' ? { value: s.value } : { value: null, current: isCurrent(s.enc, keys) }), updatedAt: s.updatedAt, updatedBy: s.updatedBy || null, usedBy: used.get(s.name) || [] })),
      missing: [...used].filter(([n]) => !names.has(n)).map(([name, by]) => ({ name, usedBy: by })),
    });
  }
  if (b === 'log' && method === 'GET') return send(res, 200, await ctx.store.listSecretLog(ctx.area, 300));
  if (b === 'rotate' && method === 'POST') {
    // RF-SEG-01: with a new key in SITESCANNER_SECRETS_KEY (the old one in SITESCANNER_SECRETS_KEY_OLD), everything is encrypted again
    if (!keys.current) throw new UserError('I segreti non sono disponibili: il deploy non ha SITESCANNER_SECRETS_KEY');
    let n = 0;
    for (const s of await ctx.store.listSecrets(ctx.area)) {
      if (s.kind !== 'secret' || isCurrent(s.enc, keys)) continue;
      await ctx.store.saveSecret(ctx.area, { ...s, enc: encrypt(decrypt(s.enc, s.name, keys), s.name, keys) });
      n++;
    }
    await log(`chiave ruotata (${n} segreti)`, null, 'secret');
    return send(res, 200, { ok: true, rotated: n });
  }
  const name = String(b || '').toUpperCase();
  if (method === 'PUT' && b) {
    const body = await readJson(req);
    let entry;
    try { entry = validateEntry({ name, kind: body.kind, value: body.value }); } catch (e) { throw new UserError(e.message); }
    if (entry.kind === 'secret' && !keys.current) throw new UserError('I segreti non sono disponibili: il deploy non ha SITESCANNER_SECRETS_KEY (le variabili sì)');
    const existing = (await ctx.store.listSecrets(ctx.area)).find((s) => s.name === entry.name);
    const count = (await ctx.store.listSecrets(ctx.area)).length;
    if (!existing && count >= MAX_PER_AREA) throw new UserError(`Limite di ${MAX_PER_AREA} variabili raggiunto`);
    const rec = { name: entry.name, kind: entry.kind, updatedAt: now, updatedBy: ctx.by, ...(entry.kind === 'var' ? { value: entry.value } : { enc: encrypt(entry.value, entry.name, keys) }) };
    await ctx.store.saveSecret(ctx.area, rec);
    await log(existing ? 'modificata' : 'creata', entry.name, entry.kind);
    return send(res, existing ? 200 : 201, { name: rec.name, kind: rec.kind, updatedAt: now });
  }
  if (method === 'DELETE' && b) {
    const existing = (await ctx.store.listSecrets(ctx.area)).find((s) => s.name === name);
    if (!existing) throw new NotFound('Variabile non trovata');
    await ctx.store.deleteSecret(ctx.area, name);
    await log('eliminata', name, existing.kind);
    return send(res, 200, { ok: true });
  }
  throw new NotFound('API sconosciuta');
}

// ---------------- tag manager (spec §13.9, RF-TAG-01) ----------------

const cleanTag = (t) => String(t ?? '').trim().toLowerCase();

async function handleTags(req, res, ctx, parts, now) {
  const [, b] = parts;
  const method = req.method;
  const prefs = await ctx.store.getPrefs(ctx.area);
  const info = prefs.tagInfo || {};
  if (!b && method === 'GET') {
    const [monitors, windows, channels] = await Promise.all([ctx.store.listMonitors(ctx.area), ctx.store.listWindows(ctx.area), ctx.store.listChannels(ctx.area)]);
    const rows = new Map();
    const row = (t) => rows.get(t) || rows.set(t, { tag: t, namespace: t.includes(':') ? t.slice(0, t.indexOf(':')) : null, monitors: 0, windows: 0, channels: 0, description: (info[t] || {}).description || '', color: (info[t] || {}).color || null }).get(t);
    for (const m of monitors) for (const t of m.tags || []) row(t).monitors++;
    for (const w of windows) for (const t of w.tags || []) row(t).windows++;
    for (const c of channels) for (const t of c.tags || []) row(t).channels++;
    for (const t of Object.keys(info)) if (rows.has(t)) continue; // a description of a tag nobody uses is not shown
    const list = [...rows.values()].sort((a, b2) => a.tag.localeCompare(b2.tag));
    return send(res, 200, { tags: list, namespaces: [...new Set(list.map((x) => x.namespace).filter(Boolean))].sort() });
  }
  if (b === 'rename' && method === 'POST') return send(res, 200, await retag(ctx, await readJson(req), now, false));
  if (b === 'merge' && method === 'POST') return send(res, 200, await retag(ctx, await readJson(req), now, true));
  if (b && method === 'PUT') {
    const tag = cleanTag(decodeURIComponent(b));
    const body = await readJson(req);
    const color = body.color == null || body.color === '' ? null : String(body.color);
    if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw new UserError('Il colore è un codice come #2e7d32');
    const description = String(body.description || '').trim().slice(0, 200);
    const next = { ...info };
    if (description || color) next[tag] = { description, color };
    else delete next[tag];
    await ctx.store.savePrefs(ctx.area, { ...prefs, tagInfo: next });
    return send(res, 200, { tag, description, color });
  }
  throw new NotFound('API sconosciuta');
}

/**
 * Rename or merge tags in monitors, maintenance windows, channel subscriptions and the tag details (RF-TAG-01). `merge`
 * takes several tags into one; a rename onto an existing tag is a merge too.
 */
async function retag(ctx, body, now, merge) {
  const from = [...new Set((merge ? body.from || [] : [body.from]).map(cleanTag).filter(Boolean))];
  const to = cleanTag(body.to);
  if (!from.length) throw new UserError('Scegli il tag da cambiare');
  if (!to || to.length > 60) throw new UserError('Il nuovo tag è vuoto o troppo lungo (al massimo 60 caratteri)');
  const sources = from.filter((t) => t !== to);
  if (!sources.length) throw new UserError('Il tag è già quello');
  const swap = (list) => {
    const l = list || [];
    if (!l.some((t) => sources.includes(t))) return null;
    return [...new Set(l.map((t) => (sources.includes(t) ? to : t)))];
  };
  const touched = { monitors: 0, windows: 0, channels: 0 };
  for (const m of await ctx.store.listMonitors(ctx.area)) {
    const tags = swap(m.tags);
    if (!tags) continue;
    m.tags = tags;
    await ctx.store.saveMonitor(ctx.area, m);
    await logChange(ctx, m, `tag «${sources.join('», «')}» → «${to}»`, now);
    touched.monitors++;
  }
  for (const w of await ctx.store.listWindows(ctx.area)) {
    const tags = swap(w.tags);
    if (!tags) continue;
    await ctx.store.saveWindow(ctx.area, { ...w, tags });
    touched.windows++;
  }
  for (const c of await ctx.store.listChannels(ctx.area)) {
    const tags = swap(c.tags);
    if (!tags) continue;
    await ctx.store.saveChannel(ctx.area, { ...c, tags });
    touched.channels++;
  }
  const prefs = await ctx.store.getPrefs(ctx.area);
  const info = { ...(prefs.tagInfo || {}) };
  for (const t of sources) {
    if (info[t] && !info[to]) info[to] = info[t];
    delete info[t];
  }
  await ctx.store.savePrefs(ctx.area, { ...prefs, tagInfo: info });
  return { ok: true, to, ...touched };
}

// ---------------- saved views of the list (RF-LST-04) ----------------

/** Views are kept with the preferences of the account: name, search, period, sorting; one can be the home. */
async function handleViews(req, res, ctx, parts, now) {
  const [, id] = parts;
  const prefs = await ctx.store.getPrefs(ctx.area);
  const views = prefs.views || [];
  if (!id && req.method === 'GET') return send(res, 200, views);
  if (!id && req.method === 'POST') {
    const body = await readJson(req);
    const name = String(body.name || '').trim().slice(0, 60);
    if (!name) throw new UserError('Dai un nome alla vista');
    if (views.length >= 30) throw new UserError('Al massimo 30 viste salvate');
    if (views.some((v) => v.name.toLowerCase() === name.toLowerCase())) throw new UserError('Esiste già una vista con questo nome');
    const view = {
      id: crypto.randomBytes(4).toString('hex'), name, q: String(body.q || '').slice(0, 300), period: LIST_PERIODS[body.period] ? body.period : '30d',
      sort: SORTS.includes(body.sort) ? body.sort : 'default', dir: body.dir === 'desc' ? 'desc' : 'asc', status: String(body.status || '').slice(0, 60), createdAt: now,
    };
    const next = body.home ? views.map((v) => ({ ...v, home: false })) : views;
    next.push({ ...view, home: !!body.home });
    await ctx.store.savePrefs(ctx.area, { ...prefs, views: next });
    return send(res, 201, view);
  }
  const view = views.find((v) => v.id === id);
  if (!view) throw new NotFound('Vista non trovata');
  if (req.method === 'PUT') {
    const body = await readJson(req);
    if (body.home !== undefined) for (const v of views) v.home = body.home ? v.id === id : v.home && v.id !== id;
    await ctx.store.savePrefs(ctx.area, { ...prefs, views });
    return send(res, 200, views.find((v) => v.id === id));
  }
  if (req.method === 'DELETE') {
    await ctx.store.savePrefs(ctx.area, { ...prefs, views: views.filter((v) => v.id !== id) });
    return send(res, 200, { ok: true });
  }
  throw new NotFound('API sconosciuta');
}

// ---------------- history, notification log, new problems (spec §13.7) ----------------

/** Event kinds and tags of a channel (RF-ALR-03/04), validated. */
function channelScope(body) {
  let events;
  try { events = normalizeKinds(body.events) || [...DEFAULT_CHANNEL_EVENTS]; } catch (e) { throw new UserError(e.message); }
  if (!events.length) throw new UserError('Scegli almeno un tipo di evento per il canale');
  return { events, tags: [...new Set((body.tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 20) };
}

const EVENT_VIEW = ({ deliveries, cause, ...e }) => ({ ...e, cause: cause ? { message: cause.message, class: cause.class, status: cause.status } : undefined, delivered: deliveries ? deliveries.filter((d) => d.ok).length : undefined, deliveryCount: deliveries ? deliveries.length : undefined });

/** RF-ALR-06: events of the account by day, filtered by type and tag. */
async function history(ctx, q, now) {
  const from = q.get('from') ? Date.parse(q.get('from')) : now - 30 * DAY;
  const to = q.get('to') ? Date.parse(q.get('to')) + DAY : now + 1;
  const groups = (q.get('type') || '').split(',').filter((g) => HISTORY_GROUPS[g]);
  const limit = Math.min(2000, Number(q.get('limit')) || 500);
  const events = (await ctx.store.listEvents(ctx.area, { limit: 20000, from })).filter((e) => !e.admin && e.type !== 'test');
  const list = filterHistory(events, { groups, tag: q.get('tag') || null, from, to, monitorId: q.get('monitor') || null });
  return { total: list.length, groups: Object.keys(HISTORY_GROUPS), days: groupByDay(list.slice(0, limit).map(EVENT_VIEW), ctx.tz), tz: ctx.tz };
}

/** RF-ALR-07: every delivery, successful or not. */
async function notificationLog(ctx, q, now) {
  const from = now - EVENT_DAYS * DAY;
  const channel = q.get('channel') || null;
  const ok = q.get('ok');
  const out = [];
  for (const e of await ctx.store.listEvents(ctx.area, { limit: 20000, from })) {
    for (const d of e.deliveries || []) {
      if ((channel && d.channelId !== channel) || (ok === '1' && !d.ok) || (ok === '0' && d.ok)) continue;
      out.push({ at: d.at, eventId: e.id, event: e.type, monitorId: e.monitorId || null, monitorName: e.monitorName || null, channelId: d.channelId, channel: d.channel, channelType: d.type, ok: d.ok, attempts: d.attempts || 1, error: d.error || null, response: d.response || null });
    }
    // events nobody received: the answer to «why did I not get the alert?»
    if (!(e.deliveries || []).length && ['no-channels', 'suppressed'].includes(e.status) && (!channel || ok === '0')) {
      out.push({ at: e.at, eventId: e.id, event: e.type, monitorId: e.monitorId || null, monitorName: e.monitorName || null, channelId: null, channel: null, ok: false, attempts: 0, error: e.status === 'no-channels' ? 'nessun canale iscritto a questo evento' : `non inviato: ${e.reason || 'soppresso'}`, response: null });
    }
  }
  out.sort((a, b) => b.at - a.at);
  return { total: out.length, entries: out.slice(0, Math.min(1000, Number(q.get('limit')) || 200)), days: EVENT_DAYS };
}

/** RF-ALR-08: monitors and error groups that started failing in the last N days. */
async function problems(ctx, q, now) {
  const prefs = await ctx.store.getPrefs(ctx.area);
  const days = Math.max(1, Math.min(monitoringConfig().rawDays, Number(q.get('days')) || prefs.newProblemsDays || 7));
  const from = now - days * DAY;
  const rawFrom = now - monitoringConfig().rawDays * DAY;
  const out = [];
  for (const mon of await ctx.store.listMonitors(ctx.area)) {
    if ((q.get('tag') && !(mon.tags || []).includes(q.get('tag'))) || (q.get('type') && (mon.type || 'http') !== q.get('type'))) continue;
    const runs = await ctx.store.listChecks(ctx.area, mon.id, rawFrom, now + 1);
    const groups = newProblems(runs, { from, now, groupOf: errorFingerprint });
    if (groups.length) out.push({ monitor: { id: mon.id, name: mon.name, url: mon.url, type: mon.type || 'http', tags: mon.tags || [], status: mon.state.openIncident ? 'down' : mon.state.lastOutcome }, groups, firstSeen: Math.min(...groups.map((g) => g.firstSeen)), lastSeen: Math.max(...groups.map((g) => g.lastSeen)), count: groups.reduce((n, g) => n + g.count, 0) });
  }
  out.sort((a, b) => b.lastSeen - a.lastSeen);
  return { days, from, to: now, problems: out };
}

// ---------------- notification channels (spec §12.5) ----------------

async function handleChannels(req, res, ctx, parts, now) {
  const [a, b, c] = parts;
  const m = req.method;
  if (a === 'notify-prefs' && m === 'PUT') {
    const body = await readJson(req);
    const prefs = { ...(await ctx.store.getPrefs(ctx.area)) };
    if (body.tz !== undefined) {
      try { new Intl.DateTimeFormat('it-IT', { timeZone: String(body.tz) }); } catch { throw new UserError(`Fuso orario non valido: ${body.tz}`); }
      prefs.tz = String(body.tz);
    }
    if (body.policy !== undefined) {
      try { prefs.policy = normalizePolicy(body.policy); } catch (e) { throw new UserError(e.message); }
    }
    if (body.newProblemsDays !== undefined) {
      const d = Number(body.newProblemsDays);
      if (!Number.isInteger(d) || d < 1 || d > monitoringConfig().rawDays) throw new UserError(`«Nuovi problemi» guarda gli ultimi giorni, da 1 a ${monitoringConfig().rawDays} (quanti ne conservano i dati grezzi)`);
      prefs.newProblemsDays = d;
    }
    await ctx.store.savePrefs(ctx.area, prefs);
    return send(res, 200, { ok: true, policy: normalizePolicy(prefs.policy), newProblemsDays: prefs.newProblemsDays || 7 }), true;
  }
  if (!b && m === 'GET') {
    const prefs = await ctx.store.getPrefs(ctx.area);
    const monitors = await ctx.store.listMonitors(ctx.area);
    return send(res, 200, {
      channels: (await ctx.store.listChannels(ctx.area)).map((c) => ({ ...publicChannel(c), reach: channelReach(c, monitors) })),
      available: { email: emailAvailable(), slack: true, telegram: telegramAvailable() }, tz: prefs.tz || monitoringConfig().tz,
      policy: normalizePolicy(prefs.policy), newProblemsDays: prefs.newProblemsDays || 7, kinds: EVENT_KINDS.map((k) => ({ id: k, label: KIND_LABELS[k] })), monitorCount: monitors.length,
    }), true;
  }
  if (!b && m === 'POST') {
    const body = await readJson(req);
    let secret = null; // the secret of a webhook is shown once
    const ch = { id: crypto.randomBytes(5).toString('hex'), type: body.type, createdAt: now, status: 'active', ...channelScope(body) };
    if (body.type === 'email') {
      if (!emailAvailable()) throw new UserError('Il canale email non è disponibile: il deploy non ha RESEND_API_KEY e SITESCANNER_EMAIL_FROM');
      const address = String(body.address || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new UserError('Indirizzo email non valido');
      // the address works only after its owner confirms it (§12.5)
      const t = token();
      Object.assign(ch, { name: body.name || address, config: { address }, status: 'pending', tokenHash: sha(t), tokenExpiresAt: now + 2 * DAY });
      await sendToChannel(ch, { subject: "Conferma l'indirizzo per gli avvisi di sitescanner", lines: ["Conferma l'indirizzo", `Per ricevere gli avvisi del monitoraggio su ${address}, apri il link entro 48 ore.`, 'Se non hai chiesto tu questi avvisi, ignora questo messaggio.'], link: `${publicBaseUrl()}/api/notify/confirm?token=${t}` })
        .catch((e) => { throw new UserError(`Email di conferma non inviata: ${e.message}`); });
    } else if (body.type === 'slack') {
      const url = String(body.webhookUrl || '').trim();
      if (!url.startsWith(slackPrefix())) throw new UserError(`Serve l'URL di un Incoming Webhook di Slack (${slackPrefix()}…)`);
      Object.assign(ch, { name: body.name || 'Slack', config: { webhookUrl: url } });
    } else if (body.type === 'teams') {
      const url = String(body.webhookUrl || '').trim();
      if (!teamsOk(url)) throw new UserError("Serve l'URL di un webhook di Microsoft Teams (Workflows: «Quando si riceve una richiesta webhook»)");
      Object.assign(ch, { name: body.name || 'Teams', config: { webhookUrl: url } });
    } else if (body.type === 'discord') {
      const url = String(body.webhookUrl || '').trim();
      if (!discordOk(url)) throw new UserError("Serve l'URL di un webhook di Discord (Impostazioni del canale → Integrazioni → Webhook)");
      Object.assign(ch, { name: body.name || 'Discord', config: { webhookUrl: url } });
    } else if (body.type === 'webhook') {
      // a webhook of your own (RF-CHN-01): the JSON of the event, signed
      const url = String(body.url || '').trim();
      try { if (!/^https?:$/.test(new URL(url).protocol)) throw new Error('x'); } catch { throw new UserError('Serve un indirizzo http o https'); }
      if (ctx.guard) { try { assertUrlAllowed(url); } catch { throw new UserError('Indirizzo non ammesso (privato o locale)'); } }
      secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
      Object.assign(ch, { name: body.name || 'Webhook', config: { url, secret }, guard: !!ctx.guard });
    } else throw new UserError('Tipo di canale: email, slack, teams, discord o webhook (Telegram si collega con il link)');
    await ctx.store.saveChannel(ctx.area, ch);
    return send(res, 201, { ...publicChannel(ch), ...(secret ? { secret } : {}) }), true;
  }
  if (b === 'telegram-link' && m === 'POST') {
    if (!telegramAvailable()) throw new UserError('Telegram non è disponibile: il deploy non ha SITESCANNER_TELEGRAM_BOT_TOKEN');
    const code = crypto.randomBytes(12).toString('hex');
    const expiresAt = now + 15 * 60000;
    await ctx.store.saveLink(sha(code), ctx.area, expiresAt);
    return send(res, 200, { url: `https://t.me/${await telegramBotUsername()}?start=${code}`, expiresAt }), true;
  }
  const ch = b && (await ctx.store.listChannels(ctx.area)).find((x) => x.id === b);
  if (!ch) throw new NotFound('Canale non trovato');
  if (!c && m === 'PUT') {
    const body = await readJson(req);
    ch.name = String(body.name || ch.name).slice(0, 80);
    if (body.events !== undefined || body.tags !== undefined) Object.assign(ch, channelScope({ events: body.events === undefined ? ch.events : body.events, tags: body.tags === undefined ? ch.tags : body.tags }));
    await ctx.store.saveChannel(ctx.area, ch);
    return send(res, 200, publicChannel(ch)), true;
  }
  if (!c && m === 'DELETE') {
    await ctx.store.deleteChannel(ctx.area, ch.id);
    // monitors that listed only this channel go back to «all the channels»
    for (const mon of await ctx.store.listMonitors(ctx.area)) {
      if (mon.channels && mon.channels.includes(ch.id)) {
        mon.channels = mon.channels.filter((x) => x !== ch.id);
        if (!mon.channels.length) mon.channels = null;
        await ctx.store.saveMonitor(ctx.area, mon);
      }
    }
    return send(res, 200, { ok: true }), true;
  }
  if (c === 'test' && m === 'POST') {
    if (ch.status === 'pending') throw new UserError("Conferma prima l'indirizzo email");
    const d = await testChannel(ctx.store, ctx.area, ch);
    return send(res, 200, { ...d, channel: publicChannel(ch) }), true;
  }
  throw new NotFound('API sconosciuta');
}

const page = (title, text) => `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/app/app.css"></head><body class="loginpage"><main class="login"><div class="card"><h1>${title}</h1><p>${text}</p><p><a href="/#/notifications">Vai alle notifiche</a></p></div></main></body></html>`;

/**
 * Routes reachable without a session: the confirmation link of an email address and the webhook of
 * the Telegram bot (protected by its secret token). Returns false for other paths.
 */
export async function handleNotifyPublic(req, res, url) {
  if (url.pathname === '/api/notify/confirm' && req.method === 'GET') {
    const store = monitorStoreFor();
    const t = url.searchParams.get('token') || '';
    const found = t && (await store.findChannelByToken(sha(t)));
    const valid = found && found.channel.tokenExpiresAt >= Date.now();
    res.writeHead(valid ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    if (!valid) return res.end(page('Link non valido', "Il link di conferma è scaduto o è già stato usato: aggiungi di nuovo l'indirizzo.")), true;
    const { channel } = found;
    channel.status = 'active';
    delete channel.tokenHash;
    delete channel.tokenExpiresAt;
    await store.saveChannel(found.area, channel);
    return res.end(page('Indirizzo confermato', `Gli avvisi del monitoraggio arriveranno a ${channel.config.address.replace(/[<>&"]/g, '')}.`)), true;
  }
  if (url.pathname === '/api/telegram/webhook' && req.method === 'POST') {
    const secret = process.env.SITESCANNER_TELEGRAM_WEBHOOK_SECRET;
    if (!secret || req.headers['x-telegram-bot-api-secret-token'] !== secret) return send(res, 401, { error: 'Non autorizzato' }), true;
    const update = await readJson(req);
    const msg = update.message || update.channel_post;
    const match = msg && /^\/start(?:@\w+)?\s+([0-9a-f]{24})$/.exec(String(msg.text || '').trim());
    if (match) {
      const store = monitorStoreFor();
      const area = await store.takeLink(sha(match[1]));
      if (area === null) await telegramReply(msg.chat.id, 'Link scaduto o già usato: generane uno nuovo dalla pagina Notifiche di sitescanner.');
      else {
        const chat = msg.chat;
        const title = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || 'Telegram';
        const existing = (await store.listChannels(area)).find((x) => x.type === 'telegram' && String(x.config.chatId) === String(chat.id));
        const ch = existing || { id: crypto.randomBytes(5).toString('hex'), type: 'telegram', createdAt: Date.now() };
        Object.assign(ch, { name: `Telegram · ${title}`, status: 'active', config: { chatId: chat.id, chatTitle: title } });
        await store.saveChannel(area, ch);
        await telegramReply(chat.id, '✅ Chat collegata: qui arriveranno gli avvisi del monitoraggio di sitescanner.');
      }
    }
    return send(res, 200, { ok: true }), true;
  }
  return false;
}

// ---------------- runs and analysis (spec §13.4) ----------------

function rangeOf(q, ctx, now) {
  try {
    return periodRange(q.get('period') || '24h', now, { tz: ctx.tz, from: q.get('from') ? Date.parse(q.get('from')) : null, to: q.get('to') ? Date.parse(q.get('to')) + DAY : null });
  } catch (e) {
    throw new UserError(e.message);
  }
}

const RAW_DAYS = () => monitoringConfig().rawDays;

/** The runs of a period, newest first, filtered (RF-RIS-23). */
async function listRuns(ctx, mon, q, now) {
  const [from, to] = rangeOf(q, ctx, now);
  let runs = await ctx.store.listChecks(ctx.area, mon.id, from, to + 1);
  runs = filterRuns(runs, {
    outcomes: q.get('outcome') ? q.get('outcome').split(',') : null, retried: q.get('retried') === '1', location: q.get('location') || null, group: q.get('group') || null,
  });
  runs.sort((a, b) => b.at - a.at);
  const page = paginate(runs, q.get('page'), q.get('pageSize'));
  return { from, to, retentionFrom: now - RAW_DAYS() * DAY, total: page.total, page: page.page, pageSize: page.pageSize, pages: page.pages, runs: page.items };
}

/** KPIs with p50/p95/p99, groups of errors and average phases of a period of the detail page. */
async function analysis(ctx, mon, q, now) {
  const [from, to] = rangeOf(q, ctx, now);
  const windows = await ctx.store.listWindows(ctx.area);
  const kpisOfPeriod = await monitorKpis(ctx.store, ctx.area, mon, { from, to, now, windows, tz: ctx.tz });
  const runs = await ctx.store.listChecks(ctx.area, mon.id, from, to + 1);
  // phases: hourly aggregates for the complete hours, the runs for the rest; daily ones beyond a week
  let granularity = 'hour', series = [];
  if (to - from > 7 * DAY) {
    granularity = 'day';
    series = (await ctx.store.listAggregates(ctx.area, 'daily', mon.id, Math.floor(from / DAY) * DAY, to)).map((a) => ({ t: a.day, ...(phaseAverages(a.phases) || { n: 0 }) }));
  } else {
    const aggUntil = Math.min(mon.state.aggregatedUntil || 0, to);
    const rows = await ctx.store.listAggregates(ctx.area, 'hourly', mon.id, Math.floor(from / HOUR) * HOUR, aggUntil);
    series = rows.map((a) => ({ t: a.hour, ...(phaseAverages(a.phases) || { n: 0 }) }));
    const byHour = new Map();
    for (const r of runs.filter((x) => x.at >= aggUntil)) {
      const h = Math.floor(r.at / HOUR) * HOUR;
      byHour.set(h, [...(byHour.get(h) || []), r]);
    }
    for (const [h, rs] of [...byHour].sort((a, b) => a[0] - b[0])) series.push({ t: h, ...(phaseAverages(phaseSums(rs)) || { n: 0 }) });
  }
  const total = phaseSums(runs);
  return {
    from, to, retentionFrom: now - RAW_DAYS() * DAY,
    kpis: kpisOfPeriod,
    runs: { total: runs.length, ok: runs.filter((r) => outcomeOf(r) === 'ok').length, degraded: runs.filter((r) => outcomeOf(r) === 'degraded').length, failed: runs.filter((r) => r.outcome === 'error').length, retried: runs.filter((r) => r.retried).length },
    groups: groupErrors(runs).slice(0, 50),
    locations: locationStats(runs), // RF-LOC-04
    phases: { granularity, average: phaseAverages(total), series },
  };
}

// RF-INC-04: pausing a monitor that is down closes its incident
async function pause(ctx, mon, now) {
  mon.paused = true;
  mon.state.since = now;
  if (mon.state.openIncident) {
    const inc = await ctx.store.getIncident(ctx.area, mon.state.openIncident);
    if (inc) {
      inc.end = now;
      inc.closedBy = 'paused';
      inc.causes.push({ at: now, class: 'pausa', status: null, message: 'messo in pausa' });
      await ctx.store.saveIncident(ctx.area, inc);
    }
    mon.state.openIncident = null;
  }
  mon.state.status = displayStatus(mon, now, []);
  await ctx.store.saveMonitor(ctx.area, mon);
}

/** RF-MNT-01/02: name, type, times, duration, monitors and tags. */
export function normalizeWindow(input, existing, tz) {
  const w = { ...(existing || {}), ...input };
  w.name = String(w.name || '').trim().slice(0, 80) || 'Manutenzione';
  w.durationMin = Number(w.durationMin);
  if (!(w.durationMin >= 5 && w.durationMin <= 1440)) throw new UserError('Durata della finestra tra 5 minuti e 24 ore');
  if (!['once', 'weekly', 'monthly', 'repeat'].includes(w.type)) throw new UserError('Tipo di finestra: singola, settimanale, mensile o che si ripete');
  if (w.type === 'repeat') {
    // RF-MNT-10: every N days, weeks or months from a first date, until a last one
    w.start = typeof w.start === 'number' ? w.start : Date.parse(w.start);
    if (!Number.isFinite(w.start)) throw new UserError('Data e ora della prima volta non valide');
    const unit = REPEAT_UNITS[w.unit];
    if (!unit) throw new UserError('Si ripete ogni N giorni, settimane o mesi');
    w.every = Number(w.every);
    if (!Number.isInteger(w.every) || w.every < 1 || w.every > unit.max) throw new UserError(`Si ripete ogni 1–${unit.max} ${unit.label}`);
    if (w.until == null || w.until === '') w.until = null;
    else {
      w.until = typeof w.until === 'number' ? w.until : Date.parse(w.until);
      if (!Number.isFinite(w.until)) throw new UserError('Data di fine della ripetizione non valida');
      // a date without time is the whole day
      if (typeof input.until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.until)) w.until += 86400000 - 1;
      if (w.until < w.start) throw new UserError('La ripetizione finisce prima di cominciare');
    }
  }
  if (w.type === 'once') {
    w.start = typeof w.start === 'number' ? w.start : Date.parse(w.start);
    if (!Number.isFinite(w.start)) throw new UserError('Data e ora di inizio non valide');
  } else if (w.type !== 'repeat') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(w.time || ''))) throw new UserError('Ora non valida (HH:MM)');
    if (w.type === 'weekly') {
      w.days = [...new Set((w.days || []).map(Number).filter((d) => d >= 0 && d <= 6))].sort();
      if (!w.days.length) throw new UserError('Scegli almeno un giorno della settimana');
    } else if (!(Number(w.dayOfMonth) >= 1 && Number(w.dayOfMonth) <= 31)) throw new UserError('Giorno del mese tra 1 e 31');
  }
  w.monitorIds = (w.monitorIds || []).map(String);
  w.tags = (w.tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  if (!w.monitorIds.length && !w.tags.length) throw new UserError('Scegli i monitor o un tag');
  w.tz = tz;
  w.id ||= crypto.randomBytes(5).toString('hex');
  w.createdAt ||= Date.now();
  return w;
}


// ---------------- the checks of the other locations (spec §13.6, RF-LOC-02) ----------------

const rawBody = async (req, max = 8192) => {
  let body = '';
  for await (const c of req) { body += c; if (body.length > max) break; }
  return body;
};

/**
 * `POST /api/check/<location>`: one check asked by the main Function, signed with the internal secret. The request
 * carries ids; this Function reads the monitor and its variables by itself and answers with the masked result.
 * Returns false for other paths.
 */
export async function handleInternalCheck(req, res, url) {
  const m = /^\/api\/check\/([a-z0-9-]{2,12})\/?$/.exec(url.pathname);
  if (!m) return false;
  if (!monitoringEnabled()) throw new NotFound('Monitoraggio non attivo');
  if (req.method !== 'POST') return send(res, 405, { error: 'Usa POST' }), true;
  const body = await rawBody(req);
  const problem = verifySignature(internalSecret(), { ts: req.headers['x-sitescanner-ts'], sig: req.headers['x-sitescanner-sig'] }, body);
  if (problem) return send(res, 401, { error: problem }), true;
  let ask;
  try { ask = JSON.parse(body); } catch { return send(res, 400, { error: 'Richiesta non valida' }), true; }
  if (ask.canary) {
    // a reference URL, to tell whether the network of this location works (RF-MON-13)
    const r = await performCheck({ type: 'http', url: String(ask.canary), timeoutS: 10, method: 'GET', assertions: [{ source: 'status', comparison: 'in', target: '200-399' }] }, { detail: false });
    return send(res, 200, { result: r, location: m[1] }), true;
  }
  const store = monitorStoreFor();
  const mon = await store.getMonitor(String(ask.area ?? ''), String(ask.monitorId || ''));
  if (!mon) return send(res, 404, { error: 'Monitor non trovato' }), true;
  const sub = substitute(mon, await loadScope(store, String(ask.area ?? '')));
  if (sub.missing.length) return send(res, 200, { result: { at: Date.now(), outcome: 'error', errorClass: 'configurazione', error: `Manca la variabile ${sub.missing.join(', ')}` }, location: m[1] }), true;
  const r = await performCheck(sub.monitor, { guard: ask.area ? networkGuardEnabled(true) : false, detail: true, location: m[1] });
  return send(res, 200, { result: sub.secretValues.length ? maskValues(r, sub.secretValues) : r, location: m[1] }), true;
}
