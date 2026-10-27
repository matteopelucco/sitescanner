// Runs of a monitor: periods, filters, percentiles and error groups (spec §13.4). Pure.
// A run is the stored check: { id, at, outcome, status, ms, ttfbMs, finalUrl, errorClass, error, retried, phases, location, hasDetail }.

import { DAY, HOUR, percentile, isDegraded } from './uptime.js';

export const PERIODS = { '1h': HOUR, '3h': 3 * HOUR, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY };

/**
 * [from, to) of a period of the detail page: `today` (since local midnight in `tz`), the fixed
 * periods, or `custom` with explicit bounds.
 */
export function periodRange(period, now, { tz = 'UTC', from = null, to = null } = {}) {
  if (period === 'custom') {
    const f = Number(from), t = Number(to);
    if (!Number.isFinite(f) || !Number.isFinite(t) || t <= f) throw new Error('Intervallo non valido: serve una data di inizio precedente a quella di fine');
    return [f, Math.min(t, now)];
  }
  if (period === 'today') {
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now)).split('-').map(Number);
    return [zonedMidnight(d[0], d[1] - 1, d[2], tz), now];
  }
  if (!PERIODS[period]) throw new Error(`Periodo sconosciuto: ${period}`);
  return [now - PERIODS[period], now];
}

// Instant of 00:00 of a day in a time zone (DST-aware, like zonedTime of uptime.js without importing it twice).
export function zonedMidnight(y, mo, d, tz) {
  const guess = Date.UTC(y, mo, d);
  const offset = (t) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(t / 1000) * 1000;
  };
  let t = guess - offset(guess);
  t = guess - offset(t);
  return t;
}

/** The three outcomes as the interface names them. */
export const outcomeOf = (run) => (run.outcome === 'error' ? 'error' : isDegraded(run.outcome) ? 'degraded' : 'ok');

/**
 * Filters runs (RF-RIS-23): outcomes (`ok`, `degraded`, `error`), only those with retries,
 * a location, an error group.
 */
export function filterRuns(runs, { outcomes = null, retried = false, location = null, group = null } = {}) {
  const set = outcomes && outcomes.length ? new Set(outcomes) : null;
  return runs.filter((r) => (!set || set.has(outcomeOf(r))) && (!retried || r.retried || (r.attempts || 1) > 1) && (!location || (r.location || '') === location)
    && (!group || (r.outcome === 'error' && errorFingerprint(r) === group)));
}

// ---------------- error groups ----------------

/**
 * The message of a failure without what changes from one run to the next (RF-RIS-24): numbers,
 * ids and dates are replaced, but the HTTP status code stays, because 502 and 503 are not the same problem.
 */
export function normalizeErrorMessage(message) {
  const keep = [];
  let s = String(message ?? '')
    .replace(/\b(HTTP|Status)\s+(\d{3})\b/g, (_, w, c) => { keep.push(`${w} ${c}`); return String.fromCharCode(0xe000 + keep.length - 1); }) // a placeholder without digits
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?\b/g, '<data>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d+(?:[.,]\d+)?/g, '#');
  s = s.replace(/[-]/g, (ch) => keep[ch.charCodeAt(0) - 0xe000]);
  return s.replace(/\s+/g, ' ').trim();
}

/** Short stable identifier of a group of errors. */
export function errorFingerprint(run) {
  const text = `${run.errorClass || ''}|${normalizeErrorMessage(run.error)}`;
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Failures grouped by normalized message, most frequent first. */
export function groupErrors(runs) {
  const groups = new Map();
  for (const r of runs) {
    if (r.outcome !== 'error') continue;
    const fp = errorFingerprint(r);
    const g = groups.get(fp) || { fingerprint: fp, message: r.error, normalized: normalizeErrorMessage(r.error), errorClass: r.errorClass || null, count: 0, firstSeen: r.at, lastSeen: r.at, locations: [] };
    g.count++;
    g.firstSeen = Math.min(g.firstSeen, r.at);
    g.lastSeen = Math.max(g.lastSeen, r.at);
    const loc = r.location || '—';
    if (!g.locations.includes(loc)) g.locations.push(loc);
    groups.set(fp, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen);
}

// ---------------- percentiles and phases ----------------

/** p50, p95, p99 and average of the response times of the runs that got an answer. */
export function responseStats(runs) {
  const v = runs.filter((r) => r.outcome !== 'error' && r.ms != null).map((r) => r.ms);
  if (!v.length) return null;
  return { count: v.length, avg: Math.round(v.reduce((s, x) => s + x, 0) / v.length), p50: percentile(v, 0.5), p95: percentile(v, 0.95), p99: percentile(v, 0.99), min: Math.min(...v), max: Math.max(...v) };
}

export const PHASES = ['dnsMs', 'tcpMs', 'tlsMs', 'waitMs', 'downloadMs'];

/** Sums of the phases of the runs that have them, for the average per phase. */
export function phaseSums(runs) {
  const out = { n: 0, dnsMs: 0, tcpMs: 0, tlsMs: 0, waitMs: 0, downloadMs: 0 };
  for (const r of runs) {
    if (!r.phases || r.outcome === 'error') continue;
    out.n++;
    for (const k of PHASES) out[k] += r.phases[k] || 0;
  }
  return out;
}

/** Average of every phase from the sums of `phaseSums`; null when no run has phases. */
export function phaseAverages(sums) {
  if (!sums || !sums.n) return null;
  return Object.fromEntries([['n', sums.n], ...PHASES.map((k) => [k, Math.round((sums[k] / sums.n) * 10) / 10])]);
}

/** Paginates a list: page is 1-based. */
export function paginate(list, page = 1, pageSize = 50) {
  const p = Math.max(1, Math.floor(Number(page) || 1));
  const size = Math.min(200, Math.max(1, Math.floor(Number(pageSize) || 50)));
  return { total: list.length, page: p, pageSize: size, pages: Math.max(1, Math.ceil(list.length / size)), items: list.slice((p - 1) * size, p * size) };
}
