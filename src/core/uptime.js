// Availability monitoring: pure computations (spec §12.6, RF-KPI-07). No I/O, no dependencies.
// Times are milliseconds since the epoch; an interval is [start, end) with start < end.
//
// Monitored time is the union of the intervals vouched by the checks (each check covers one check
// interval from its instant) minus maintenance; pauses and rounds without checks (or discarded as
// unreliable) leave gaps, which count neither as up nor as down. Downtime is the part of the
// incidents that falls in the monitored time.

export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;
export const MONITOR_INTERVALS = [5, 10, 15, 30, 60];

// ---------------- intervals ----------------

/** Sorted, merged copy of a list of intervals. */
export function merge(intervals) {
  const list = intervals.filter(([s, e]) => e > s).map(([s, e]) => [s, e]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const iv of list) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push(iv);
  }
  return out;
}

/** Intervals of `a` not covered by `b` (both merged on the fly). */
export function subtract(a, b) {
  const bs = merge(b);
  const out = [];
  for (const [s0, e0] of merge(a)) {
    let s = s0;
    for (const [bs0, be0] of bs) {
      if (be0 <= s) continue;
      if (bs0 >= e0) break;
      if (bs0 > s) out.push([s, bs0]);
      s = Math.max(s, be0);
      if (s >= e0) break;
    }
    if (s < e0) out.push([s, e0]);
  }
  return out;
}

/** Intersection of two lists of intervals. */
export function intersect(a, b) {
  const as = merge(a), bs = merge(b);
  const out = [];
  let i = 0, j = 0;
  while (i < as.length && j < bs.length) {
    const s = Math.max(as[i][0], bs[j][0]);
    const e = Math.min(as[i][1], bs[j][1]);
    if (s < e) out.push([s, e]);
    if (as[i][1] < bs[j][1]) i++;
    else j++;
  }
  return out;
}

export const total = (intervals) => merge(intervals).reduce((n, [s, e]) => n + (e - s), 0);
export const clip = (intervals, from, to) => intersect(intervals, [[from, to]]);

/** Time vouched by the checks: each check covers [at, at + interval); callers clip it at `now`. */
export const coverage = (checks, intervalMs) => merge(checks.map((c) => [c.at, c.at + intervalMs]));

/** Monitored time: coverage minus maintenance. */
export const monitoredTime = (checks, intervalMs, maintenance = []) => subtract(coverage(checks, intervalMs), maintenance);

/** Incidents as intervals; an open incident lasts until `now`. */
export const incidentIntervals = (incidents, now) => incidents.map((i) => [i.start, i.end ?? now]).filter(([s, e]) => e > s);

// ---------------- response times ----------------

// Histogram with fixed log-spaced buckets, so that hourly aggregates can be summed (RF-MST-01).
// Bucket i covers (BOUNDS[i-1], BOUNDS[i]] ms; percentiles from it are approximate (upper bound of the bucket).
export const BOUNDS = [25, 50, 75, 100, 150, 200, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 20000, 30000, 60000, Infinity];

export function histogram(values) {
  const h = new Array(BOUNDS.length).fill(0);
  for (const v of values) h[BOUNDS.findIndex((b) => v <= b)]++;
  return h;
}

export const addHistograms = (a, b) => a.map((x, i) => x + (b[i] || 0));

export function histogramPercentile(h, p) {
  const n = h.reduce((s, x) => s + x, 0);
  if (!n) return null;
  let acc = 0;
  for (let i = 0; i < h.length; i++) {
    acc += h[i];
    if (acc >= p * n) return Number.isFinite(BOUNDS[i]) ? BOUNDS[i] : BOUNDS[i - 1];
  }
  return null;
}

/** Exact percentile of a list (nearest rank). */
export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}

// ---------------- aggregates ----------------

/**
 * Hourly aggregates of one monitor for the complete hours in [fromHour, toHour): the same numbers
 * the KPIs use, so that KPIs from aggregates equal KPIs from raw data (RF-KPI-07).
 * `monitored` and `downtime` are interval lists (already clipped by maintenance).
 */
export function hourlyAggregates({ checks, monitored, downtime, fromHour, toHour }) {
  const out = [];
  for (let h = fromHour; h < toHour; h += HOUR) {
    const cs = checks.filter((c) => c.at >= h && c.at < h + HOUR);
    const okMs = cs.filter((c) => c.outcome !== 'error').map((c) => c.ms);
    out.push({
      hour: h,
      checks: cs.length,
      ok: cs.filter((c) => c.outcome === 'ok').length,
      slow: cs.filter((c) => c.outcome === 'slow').length,
      errors: cs.filter((c) => c.outcome === 'error').length,
      msSum: okMs.reduce((s, x) => s + x, 0),
      msCount: okMs.length,
      minMs: okMs.length ? Math.min(...okMs) : null,
      maxMs: okMs.length ? Math.max(...okMs) : null,
      p95Ms: percentile(okMs, 0.95),
      hist: histogram(okMs),
      monitoredMs: total(clip(monitored, h, h + HOUR)),
      downtimeMs: total(clip(downtime, h, h + HOUR)),
    });
  }
  return out;
}

/** Daily aggregates (UTC days) from hourly ones. */
export function dailyAggregates(hourly) {
  const days = new Map();
  for (const a of hourly) {
    const d = Math.floor(a.hour / DAY) * DAY;
    const cur = days.get(d) || { day: d, checks: 0, ok: 0, slow: 0, errors: 0, msSum: 0, msCount: 0, monitoredMs: 0, downtimeMs: 0, hist: new Array(BOUNDS.length).fill(0) };
    for (const k of ['checks', 'ok', 'slow', 'errors', 'msSum', 'msCount', 'monitoredMs', 'downtimeMs']) cur[k] += a[k];
    cur.hist = addHistograms(cur.hist, a.hist);
    days.set(d, cur);
  }
  return [...days.values()].sort((a, b) => a.day - b.day);
}

// ---------------- KPIs ----------------

/** Availability as a percentage with two decimals, never rounded up to 100 if there was downtime. */
export function availabilityPct(monitoredMs, downtimeMs) {
  if (!monitoredMs) return null;
  const pct = 100 * (1 - downtimeMs / monitoredMs);
  const floor2 = Math.floor(pct * 100) / 100;
  return downtimeMs > 0 ? Math.min(floor2, 99.99) : 100;
}

/**
 * KPIs of a period [from, to) from monitored time, downtime and the incidents (spec §12.6).
 * responses: { hist, sum, count } of the ok checks, or exact values `values`.
 * `since`: when the monitor was created; coverage is measured from then, not from before it existed.
 */
export function kpis({ from, to, monitoredMs, downtimeMs, incidents, now, responses = null, slaPct = 99.9, since = from }) {
  const started = incidents.filter((i) => i.start >= from && i.start < to).sort((a, b) => a.start - b.start);
  const closed = started.filter((i) => i.end != null && i.end <= to);
  const durations = closed.map((i) => i.end - i.start);
  const gaps = started.slice(1).map((i, k) => i.start - started[k].start);
  const longest = started.map((i) => ({ start: i.start, ms: (i.end ?? now) - i.start })).sort((a, b) => b.ms - a.ms)[0] || null;
  let response = null;
  if (responses) {
    if (responses.values) {
      const v = responses.values;
      response = v.length ? { avg: Math.round(v.reduce((s, x) => s + x, 0) / v.length), median: percentile(v, 0.5), p95: percentile(v, 0.95), count: v.length } : null;
    } else if (responses.count) {
      response = { avg: Math.round(responses.sum / responses.count), median: histogramPercentile(responses.hist, 0.5), p95: histogramPercentile(responses.hist, 0.95), count: responses.count, approximate: true };
    }
  }
  const period = to - Math.max(from, since);
  return {
    from,
    to,
    monitoredMs,
    downtimeMs,
    availability: availabilityPct(monitoredMs, downtimeMs),
    coverage: period > 0 ? Math.min(1, monitoredMs / period) : null,
    incidents: started.length,
    mttrMs: durations.length ? Math.round(durations.reduce((s, x) => s + x, 0) / durations.length) : null,
    mtbfMs: gaps.length ? Math.round(gaps.reduce((s, x) => s + x, 0) / gaps.length) : null,
    longest,
    response,
    slaPct,
  };
}

/**
 * Error budget of the current month: downtime allowed by the SLA over the month (e.g. 43 min with
 * 99.9% in 30 days) minus the downtime so far (spec §12.6).
 */
export function errorBudget({ monthMs, downtimeMs, slaPct }) {
  const allowedMs = Math.round(monthMs * (1 - slaPct / 100));
  return { allowedMs, usedMs: downtimeMs, leftMs: allowedMs - downtimeMs };
}

/**
 * Health of a monitor on its last 30 days, with the reasons (RF-KPI-01).
 * @returns {{ level: 'buona'|'attenzione'|'critica', reasons: string[] }}
 */
export function health({ status, k30, slaPct = 99.9, slowMs = null, certDays = null, budgetLeftMs = null }) {
  const critical = [], warn = [];
  if (status === 'down') critical.push('il sito è giù');
  const a = k30 && k30.availability;
  if (a != null && a < slaPct - 0.1) critical.push(`disponibilità ${fmtPct(a)} sotto l'obiettivo ${fmtPct(slaPct)}`);
  else if (a != null && a < slaPct) warn.push(`disponibilità ${fmtPct(a)} sotto l'obiettivo ${fmtPct(slaPct)}`);
  if (certDays != null && certDays <= 7) critical.push(certDays < 0 ? 'certificato scaduto' : `il certificato scade tra ${certDays} giorni`);
  else if (certDays != null && certDays <= 14) warn.push(`il certificato scade tra ${certDays} giorni`);
  const p95 = k30 && k30.response && k30.response.p95;
  if (slowMs && p95 != null && p95 > slowMs) warn.push(`tempo di risposta p95 ${p95} ms oltre la soglia di ${slowMs} ms`);
  if (budgetLeftMs != null && budgetLeftMs < 0 && !critical.length) warn.push('budget di errore del mese esaurito');
  if (k30 && k30.coverage != null && k30.coverage < 0.5) warn.push('dati insufficienti: monitorato meno di metà del periodo');
  if (critical.length) return { level: 'critica', reasons: critical.concat(warn) };
  if (warn.length) return { level: 'attenzione', reasons: warn };
  return { level: 'buona', reasons: [] };
}

export const fmtPct = (p) => (p == null ? '—' : `${p.toFixed(2).replace('.', ',')}%`);

/** «1 h 12 min», «3 g 4 h», «45 s». */
export function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
  const d = Math.floor(h / 24);
  return `${d} g${h % 24 ? ` ${h % 24} h` : ''}`;
}

// ---------------- expected status ----------------

/** "200-399", "200,301", "200-299,304" → predicate; null if the text is not valid. */
export function parseExpect(text) {
  const parts = String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const ranges = [];
  for (const p of parts) {
    const m = /^(\d{3})(?:\s*-\s*(\d{3}))?$/.exec(p);
    if (!m) return null;
    const a = Number(m[1]), b = Number(m[2] || m[1]);
    if (a < 100 || b > 599 || a > b) return null;
    ranges.push([a, b]);
  }
  return (status) => ranges.some(([a, b]) => status >= a && status <= b);
}

// ---------------- maintenance windows ----------------

// Offset (ms) of a time zone at an instant, from Intl: local wall time minus UTC.
function tzOffset(t, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(t / 1000) * 1000;
}

/** Instant of a wall-clock time in a time zone (DST-aware). */
export function zonedTime(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo, d, h, mi);
  let t = guess - tzOffset(guess, tz);
  t = guess - tzOffset(t, tz);
  return t;
}

/** Wall-clock parts of an instant in a time zone. */
export function zonedParts(t, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month) - 1, d: Number(p.day), wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}

/**
 * Occurrences of a maintenance window that overlap [from, to) (RF-MNT-02):
 *   once:    { type: 'once', start (ms), durationMin }
 *   weekly:  { type: 'weekly', days: [0..6] (0 = Sunday), time: 'HH:MM', durationMin }
 *   monthly: { type: 'monthly', dayOfMonth: 1..31, time: 'HH:MM', durationMin }
 * `endedAt` (ms) closes the window early (RF-MNT-05). Recurring times are in `tz`.
 */
export function windowOccurrences(w, from, to, tz = 'Europe/Rome') {
  const dur = w.durationMin * 60000;
  const out = [];
  if (w.type === 'once') out.push([w.start, w.start + dur]);
  else {
    const [hh, mm] = String(w.time || '00:00').split(':').map(Number);
    // walk the local days from one day before `from` (a window may start the day before)
    for (let t = from - DAY - dur; t < to + DAY; t += DAY) {
      const { y, mo, d, wd } = zonedParts(t, tz);
      const match = w.type === 'weekly' ? (w.days || []).includes(wd) : d === Number(w.dayOfMonth);
      if (!match) continue;
      const s = zonedTime(y, mo, d, hh, mm, tz);
      if (!out.some(([x]) => x === s)) out.push([s, s + dur]);
    }
  }
  return merge(out.map(([s, e]) => [s, w.endedAt ? Math.min(e, w.endedAt) : e])).filter(([s, e]) => e > from && s < to);
}

/** Whether a window applies to a monitor: listed by id or sharing a tag (RF-MNT-01). */
export const windowAppliesTo = (w, m) => (w.monitorIds || []).includes(m.id) || (w.tags || []).some((t) => (m.tags || []).includes(t));

/** Maintenance intervals of a monitor in [from, to). */
export const maintenanceFor = (windows, m, from, to, tz) => merge(windows.filter((w) => windowAppliesTo(w, m)).flatMap((w) => windowOccurrences(w, from, to, tz)));

export const inIntervals = (t, intervals) => intervals.some(([s, e]) => t >= s && t < e);

/** Days to a certificate's expiry (negative when expired). */
export const certDaysLeft = (expiresAt, now) => (expiresAt == null ? null : Math.floor((expiresAt - now) / DAY));

/** Fixed delay (0–60 s) of a monitor within a round, from its id (RF-MON-14). */
export function spreadDelayMs(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % 61) * 1000;
}
