import {
  HOUR, DAY, maintenanceFor, kpis, addHistograms, BOUNDS, certDaysLeft, health, errorBudget, isMuted,
} from '../core/uptime.js';
import { displayStatus, publicMonitor } from './engine.js';
import { targetOf } from './types.js';
import { parseListQuery, matchesQuery, sortRows, statusCounts } from '../core/listquery.js';
import { paginate } from '../core/runs.js';

// The list of the monitors with its columns (spec §13.8): computed in bulk from the aggregates, with a
// handful of queries for the whole account, so that 500 monitors answer in well under a second (RNF-42).

export const LIST_PERIODS = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY };

const empty = () => ({ monitoredMs: 0, downtimeMs: 0, msSum: 0, msCount: 0, hist: new Array(BOUNDS.length).fill(0), checks: 0, degraded: 0 });
const add = (t, a) => {
  t.monitoredMs += a.monitoredMs; t.downtimeMs += a.downtimeMs; t.msSum += a.msSum; t.msCount += a.msCount;
  t.checks += a.checks; t.degraded += (a.degraded || 0) + (a.slow || 0);
  t.hist = addHistograms(t.hist, a.hist);
  return t;
};

/** KPIs of the sums of some aggregates: availability, average and p95 of the response times. */
function kpisOf(t, { from, to, now, slaPct, since }) {
  return kpis({ from, to, monitoredMs: t.monitoredMs, downtimeMs: t.downtimeMs, incidents: [], now, slaPct, since, responses: t.msCount ? { hist: t.hist, sum: t.msSum, count: t.msCount } : null });
}

/**
 * One row per monitor for the list and the dashboard. The period of the columns (24h, 7d, 30d, 90d)
 * comes from the aggregates; the part of the current hour that is not aggregated yet is added to the
 * monitored time, and to the downtime if the monitor is down.
 */
export async function monitorRows(store, area, monitors, { now, windows, tz, period = '30d' }) {
  const span = LIST_PERIODS[period] || LIST_PERIODS['30d'];
  const from = now - span;
  const [hourly, daily] = await Promise.all([
    store.listAggregatesAll(area, 'hourly', now - DAY, now),
    store.listAggregatesAll(area, 'daily', Math.floor((now - 90 * DAY) / DAY) * DAY, now + DAY),
  ]);
  const byMonitor = (rows) => { const m = new Map(); for (const r of rows) (m.get(r.monitorId) || m.set(r.monitorId, []).get(r.monitorId)).push(r); return m; };
  const hourlyOf = byMonitor(hourly), dailyOf = byMonitor(daily);
  const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
  const monthMs = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1) - monthStart;

  return monitors.map((m) => {
    const days = dailyOf.get(m.id) || [], hours = hourlyOf.get(m.id) || [];
    const aggUntil = m.state.aggregatedUntil || Math.floor(m.createdAt / HOUR) * HOUR;
    const lag = Math.max(0, Math.min(2 * HOUR, now - aggUntil));
    const down = !!m.state.openIncident;
    // time not aggregated yet: monitored, and downtime if the incident is open
    const extra = { monitoredMs: m.paused ? 0 : lag, downtimeMs: down ? Math.min(lag, Math.max(0, now - Math.max(m.state.since || now, aggUntil))) : 0, msSum: 0, msCount: 0, checks: 0, degraded: 0, hist: new Array(BOUNDS.length).fill(0) };
    const sum = (rows, since) => add(add(empty(), extra), rows.reduce((t, a) => ((a.day ?? a.hour) >= since ? add(t, a) : t), empty()));
    const maint = maintenanceFor(windows, m, now - DAY, now + 7 * DAY, tz);
    const status = displayStatus(m, now, maint);
    const base = { now, slaPct: m.slaPct, since: Math.floor(m.createdAt / HOUR) * HOUR };
    const day = (t) => Math.floor(t / DAY) * DAY;
    // the period of the columns
    const t = span <= DAY ? sum(hours, now - DAY) : sum(days, day(from));
    const k = kpisOf(t, { from, to: now, ...base });
    // health always on the last 30 days, like the dashboard (RF-KPI-02)
    const k30 = kpisOf(sum(days, day(now - 30 * DAY)), { from: now - 30 * DAY, to: now, ...base });
    const kMonth = sum(days, monthStart);
    const budget = errorBudget({ monthMs, downtimeMs: kMonth.downtimeMs, slaPct: m.slaPct });
    const day24 = hours.reduce((n, a) => ({ checks: n.checks + a.checks, degraded: n.degraded + (a.degraded || 0) + (a.slow || 0) }), { checks: 0, degraded: 0 });
    const share = day24.checks >= 12 ? day24.degraded / day24.checks : 0;
    const certDays = m.state.cert ? certDaysLeft(m.state.cert.expiresAt, now) : null;
    const h = health({ status, k30, slaPct: m.slaPct, degradedMs: m.degradedMs, certDays, budgetLeftMs: budget.leftMs, degradedShare: share, ageMs: now - m.createdAt });
    const pub = publicMonitor(m);
    return {
      id: m.id, name: m.name, url: m.url, target: targetOf(m), type: m.type || 'http', tags: m.tags || [], source: m.source || null, description: m.description || '', intervalMin: m.intervalMin,
      status, muted: isMuted(m, now), mutedUntil: isMuted(m, now) ? m.muted.until : null, paused: !!m.paused, since: m.state.since || null, health: h,
      availability: k.availability, avgMs: k.response ? k.response.avg : null, p95Ms: k.response ? k.response.p95 : null, monitoredMs: k.monitoredMs, downtimeMs: k.downtimeMs, coverage: k.coverage,
      k30: { availability: k30.availability, monitoredMs: k30.monitoredMs, downtimeMs: k30.downtimeMs, coverage: k30.coverage, response: k30.response },
      lastAt: m.state.lastCheckAt || null, lastOutcome: m.state.lastOutcome || null, lastMs: m.state.lastMs ?? null, recent: m.state.recent || [],
      certDays, certIssuer: m.state.cert ? m.state.cert.issuer : null, openIncident: m.state.openIncident || null, managed: m.managedBy === 'code', codeId: m.codeId || null, ...(m.type === 'heartbeat' ? { expectedMin: m.expectedMin, toleranceMin: m.toleranceMin } : {}), alertPolicy: pub.alertPolicy ?? null,
    };
  });
}

/**
 * The answer of the list (RF-LST-01..04): rows of the period, the search and filters, the counts of the
 * status tabs (with every filter but the status), the figures of the shown group, a page of rows.
 */
export function listResponse(rows, { now, period = '30d', query = '', status = '', tag = '', sort = 'default', dir = 'asc', page = 1, pageSize = 50 }) {
  const q = parseListQuery(query);
  if (tag) q.tags.push(String(tag).toLowerCase());
  const filtered = rows.filter((r) => matchesQuery(r, q, { skip: ['status'] }));
  const counts = statusCounts(filtered);
  const wanted = status && status !== 'all' ? status.split(',') : null;
  const shown = filtered.filter((r) => (!wanted || wanted.includes(r.status)) && matchesQuery(r, q, { skip: ['tags', 'health', 'types', 'text', 'muted'] }));
  const sorted = sortRows(shown, sort, dir);
  const mon = shown.reduce((s, r) => s + r.monitoredMs, 0), dt = shown.reduce((s, r) => s + r.downtimeMs, 0);
  const portfolio = mon ? (dt ? Math.min(Math.floor((1 - dt / mon) * 10000) / 100, 99.99) : 100) : null;
  const pg = paginate(sorted, page, pageSize);
  const levels = { critica: 0, attenzione: 0, buona: 0 };
  for (const r of shown) levels[r.health.level]++;
  return {
    now, period, total: pg.total, page: pg.page, pageSize: pg.pageSize, pages: pg.pages, counts, health: levels, availability: portfolio, errors: q.errors, rows: pg.items,
    tags: [...new Set(rows.flatMap((r) => r.tags))].sort(), types: [...new Set(rows.map((r) => r.type))].sort(),
  };
}
