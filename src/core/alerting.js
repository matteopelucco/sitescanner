// Alert policy of the monitoring (spec §13.7): when to alert, reminders, which channel gets which
// event. Pure functions, no I/O.

/** The kinds of event a channel can be subscribed to (RF-ALR-03). */
export const EVENT_KINDS = ['down', 'up', 'degraded', 'cert', 'maintenance', 'heartbeat'];
export const KIND_LABELS = { down: 'Giù', up: 'Di nuovo su', degraded: 'Degradato', cert: 'Certificato e dominio', maintenance: 'Manutenzione', heartbeat: 'Heartbeat mancato' };
export const DEFAULT_CHANNEL_EVENTS = ['down', 'up', 'cert', 'heartbeat']; // a missed heartbeat is a down: it must reach whoever listens to the downs

export const DEFAULT_POLICY = Object.freeze({ mode: 'failures', failures: 1, minutes: 0, locationPct: 50, reminders: { max: 0, everyMin: 60 } });

const int = (v, def) => (v === undefined || v === null || v === '' ? def : Number(v));

/** Validates a policy (RF-ALR-01/02); throws an Error with a message for the form. */
export function normalizePolicy(input = {}) {
  const p = { ...DEFAULT_POLICY, ...(input || {}), reminders: { ...DEFAULT_POLICY.reminders, ...((input && input.reminders) || {}) } };
  if (!['failures', 'minutes'].includes(p.mode)) throw new Error('Avvisa dopo un numero di fallimenti o dopo un tempo');
  p.failures = int(p.failures, 1);
  if (!Number.isInteger(p.failures) || p.failures < 1 || p.failures > 5) throw new Error('Il numero di run falliti di fila va da 1 a 5');
  p.minutes = int(p.minutes, 0);
  if (!Number.isInteger(p.minutes) || p.minutes < 0 || p.minutes > 60) throw new Error('I minuti di attesa vanno da 0 a 60');
  p.locationPct = int(p.locationPct, 50);
  if (!Number.isInteger(p.locationPct) || p.locationPct < 1 || p.locationPct > 100) throw new Error('La percentuale di località va da 1 a 100');
  p.reminders.max = int(p.reminders.max, 0);
  if (!Number.isInteger(p.reminders.max) || p.reminders.max < 0 || p.reminders.max > 10) throw new Error('I promemoria vanno da 0 a 10');
  p.reminders.everyMin = int(p.reminders.everyMin, 60);
  if (!Number.isInteger(p.reminders.everyMin) || p.reminders.everyMin < 10 || p.reminders.everyMin > 240) throw new Error('Il promemoria si ripete ogni 10–240 minuti');
  return { mode: p.mode, failures: p.failures, minutes: p.minutes, locationPct: p.locationPct, reminders: { max: p.reminders.max, everyMin: p.reminders.everyMin } };
}

/** The policy of a monitor: its own, or the account's (RF-ALR-05). */
export const effectivePolicy = (monitor, account) => normalizePolicy((monitor && monitor.alertPolicy) || account || DEFAULT_POLICY);

/**
 * Converts the delay and reminder of the first version (RF-NOT-05/07) into a policy of the monitor;
 * null when they were at their defaults. The old reminder had no limit: it becomes the maximum of 10.
 */
export function policyFromLegacy({ notifyDelayMin = 0, reminderMin = null } = {}) {
  const delay = Number(notifyDelayMin) || 0;
  const rem = Number(reminderMin) || 0;
  if (!delay && !rem) return null;
  return normalizePolicy({
    mode: delay ? 'minutes' : 'failures', minutes: Math.min(60, delay), failures: 1,
    reminders: { max: rem ? 10 : 0, everyMin: Math.min(240, Math.max(10, rem || 60)) },
  });
}

/** True when the policy alerts at the first failure, with no waiting. */
export const isImmediate = (policy) => (policy.mode === 'failures' ? policy.failures <= 1 : policy.minutes <= 0);

/**
 * Is the «down» alert due? `failures`: failed runs in a row of the incident; `downSince`: its start;
 * `locationsFailingPct`: share of locations failing (null with one location, RF-ALR-01).
 */
export function shouldAlertDown({ policy, failures, downSince, now, locationsFailingPct = null }) {
  if (locationsFailingPct != null && locationsFailingPct < policy.locationPct) return false;
  if (policy.mode === 'failures') return failures >= policy.failures;
  return now - downSince >= policy.minutes * 60000;
}

/** Is a reminder due (RF-ALR-02)? `sent`: reminders already sent; `lastAt`: when the last alert went out. */
export function reminderDue({ policy, sent = 0, lastAt, now }) {
  const r = policy.reminders;
  return r.max > 0 && sent < r.max && lastAt != null && now - lastAt >= r.everyMin * 60000;
}

/** The kind of an event, or null for events that always go out (about the monitor itself, channels). */
export function eventKind(type) {
  switch (type) {
    case 'down': case 'reminder': return 'down';
    case 'up': return 'up';
    case 'degraded': case 'slow': return 'degraded';
    case 'cert': case 'cert-expired': case 'domain': case 'domain-expired': return 'cert';
    case 'maintenance-start': case 'maintenance-end': return 'maintenance';
    case 'heartbeat-missed': return 'heartbeat';
    default: return null;
  }
}

/**
 * Does the channel get this event for this monitor (RF-ALR-03/04/05)? The channel lists its event kinds
 * and may be limited to monitors with some tags; a monitor with its own policy may choose the kinds.
 */
export function channelAccepts(channel, event, monitor = null) {
  const kind = eventKind(event.type);
  if (kind) {
    const kinds = (monitor && monitor.alertPolicy && Array.isArray(monitor.alertPolicy.events)) ? monitor.alertPolicy.events : (channel.events || DEFAULT_CHANNEL_EVENTS);
    if (!kinds.includes(kind)) return false;
  }
  const tags = channel.tags || [];
  if (tags.length && monitor) return (monitor.tags || []).some((t) => tags.includes(t));
  return true;
}

/** Validates the event kinds of a channel or of a monitor. */
export function normalizeKinds(kinds) {
  if (kinds == null) return null;
  if (!Array.isArray(kinds)) throw new Error('I tipi di evento sono un elenco');
  const bad = kinds.find((k) => !EVENT_KINDS.includes(k));
  if (bad) throw new Error(`Tipo di evento sconosciuto: ${bad}`);
  return [...new Set(kinds)];
}

/** Monitors a channel reaches (RF-ALR-04): all of them, or those with one of its tags. */
export const channelReach = (channel, monitors) => (channel.tags && channel.tags.length ? monitors.filter((m) => (m.tags || []).some((t) => channel.tags.includes(t))) : monitors).length;

// ---------------- history and new problems (RF-ALR-06/08) ----------------

export const HISTORY_GROUPS = {
  down: ['down', 'reminder'], up: ['up'], degraded: ['degraded', 'slow'], maintenance: ['maintenance-start', 'maintenance-end'],
  changes: ['monitor-change'], ci: ['ci-test', 'ci-apply'], cert: ['cert', 'cert-expired', 'domain', 'domain-expired'], heartbeat: ['heartbeat-missed'], agents: ['agent-missed', 'agent-back'],
};

/** Filters the events of the account for the history: type groups, tag, period. Newest first. */
export function filterHistory(events, { groups = null, tag = null, from = 0, to = Infinity, monitorId = null } = {}) {
  const types = groups && groups.length ? new Set(groups.flatMap((g) => HISTORY_GROUPS[g] || [])) : null;
  return events
    .filter((e) => e.at >= from && e.at < to && (!types || types.has(e.type)) && (!tag || (e.tags || []).includes(tag)) && (!monitorId || e.monitorId === monitorId))
    .sort((a, b) => b.at - a.at);
}

/** Day key «YYYY-MM-DD» of an instant in a time zone, to group the history by day. */
export const dayKey = (t, tz = 'UTC') => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));

export function groupByDay(events, tz) {
  const days = [];
  for (const e of events) {
    const k = dayKey(e.at, tz);
    if (!days.length || days[days.length - 1].day !== k) days.push({ day: k, events: [] });
    days[days.length - 1].events.push(e);
  }
  return days;
}

/**
 * «New problems» (RF-ALR-08): from the failed runs of a monitor, the error groups that started
 * in the last `days` days, i.e. whose fingerprint did not appear before the window.
 * `groupOf(run)` returns the fingerprint of a failed run (src/core/runs.js).
 */
export function newProblems(runs, { from, now, groupOf }) {
  const before = new Set();
  const found = new Map();
  for (const r of runs) {
    if (r.outcome !== 'error') continue;
    const fp = groupOf(r);
    if (r.at < from) { before.add(fp); continue; }
    if (r.at > now) continue;
    const g = found.get(fp) || { fingerprint: fp, message: r.error, errorClass: r.errorClass || null, count: 0, firstSeen: r.at, lastSeen: r.at };
    g.count++;
    g.firstSeen = Math.min(g.firstSeen, r.at);
    g.lastSeen = Math.max(g.lastSeen, r.at);
    found.set(fp, g);
  }
  return [...found.values()].filter((g) => !before.has(g.fingerprint)).sort((a, b) => b.lastSeen - a.lastSeen);
}
