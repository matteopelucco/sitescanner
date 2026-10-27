// The list of the monitors (spec §13.8): the search written as `tag:cliente:x stato:giù tipo:dns testo`,
// filters, sorting and counts. Pure.

export const STATUS_WORDS = {
  su: 'up', up: 'up', degradato: 'degraded', degradati: 'degraded', degraded: 'degraded', giù: 'down', giu: 'down', down: 'down',
  pausa: 'paused', paused: 'paused', nonconfigurato: 'unconfigured', unconfigured: 'unconfigured', manutenzione: 'maintenance', maintenance: 'maintenance', attesa: 'pending', pending: 'pending',
};
export const HEALTH_WORDS = { buona: 'buona', ok: 'buona', attenzione: 'attenzione', critica: 'critica', critico: 'critica' };
export const TYPE_WORDS = { http: 'http', sito: 'http', web: 'http', api: 'api', heartbeat: 'heartbeat', cron: 'heartbeat', dns: 'dns', tcp: 'tcp', ssl: 'ssl', certificato: 'ssl', dominio: 'ssl' };
const YES = new Set(['si', 'sì', 'yes', 'true', '1']);

/** Splits on spaces, keeping «quoted parts» together. */
function tokens(text) {
  const out = [];
  const re = /(-?[\p{L}]+:)?(?:"([^"]*)"|(\S+))/gu;
  let m;
  while ((m = re.exec(String(text || '')))) out.push({ key: m[1] ? m[1].slice(0, -1) : null, value: m[2] ?? m[3] });
  return out;
}

/**
 * Parses the search. Unknown words are free text. `-key:value` excludes. Returns the filters and the
 * words that could not be understood (a status that does not exist, ...), so the page can say so.
 */
export function parseListQuery(text) {
  const q = { text: [], tags: [], status: [], health: [], types: [], not: { tags: [], status: [], health: [], types: [] }, muted: null, errors: [] };
  for (const { key, value } of tokens(text)) {
    const neg = key && key.startsWith('-');
    const k = key ? key.replace(/^-/, '').toLowerCase() : null;
    const v = String(value).toLowerCase();
    const into = (name, list) => (neg ? q.not[name] : q[name]).push(list);
    if (k === 'tag') into('tags', v);
    else if (k === 'stato' || k === 'status') (STATUS_WORDS[v] ? into('status', STATUS_WORDS[v]) : q.errors.push(`stato sconosciuto: ${value}`));
    else if (k === 'salute' || k === 'health') (HEALTH_WORDS[v] ? into('health', HEALTH_WORDS[v]) : q.errors.push(`salute sconosciuta: ${value}`));
    else if (k === 'tipo' || k === 'type') (TYPE_WORDS[v] ? into('types', TYPE_WORDS[v]) : q.errors.push(`tipo sconosciuto: ${value}`));
    else if (k === 'silenziato' || k === 'muto') q.muted = neg ? !YES.has(v) : YES.has(v);
    else if (k) q.text.push(`${key}:${v}`); // «http://…» and the like: a plain word
    else q.text.push(v);
  }
  return q;
}

/** A parsed search back into text (for the saved views and the URL). */
export function formatListQuery(q) {
  const part = (k, list, neg = '') => list.map((v) => `${neg}${k}:${/\s/.test(v) ? `"${v}"` : v}`);
  return [
    ...part('tag', q.tags), ...part('stato', q.status), ...part('salute', q.health), ...part('tipo', q.types),
    ...part('tag', q.not.tags, '-'), ...part('stato', q.not.status, '-'), ...part('salute', q.not.health, '-'), ...part('tipo', q.not.types, '-'),
    ...(q.muted === null ? [] : [`silenziato:${q.muted ? 'sì' : 'no'}`]), ...q.text,
  ].join(' ');
}

const hasTag = (row, t) => (row.tags || []).some((x) => x === t || x.startsWith(t.endsWith(':') ? t : `${t}:`));

/**
 * Does the row match? `tag:cliente` matches the tag `cliente` and every `cliente:…`; a value in the same
 * key is an OR (`stato:giù stato:degradato`), different keys are an AND. `skip` leaves a key out (the status
 * tabs count with every filter but the status).
 */
export function matchesQuery(row, q, { skip = [] } = {}) {
  const any = (list, test) => !list.length || list.some(test);
  if (!skip.includes('tags') && !any(q.tags, (t) => hasTag(row, t))) return false;
  if (!skip.includes('tags') && q.not.tags.some((t) => hasTag(row, t))) return false;
  if (!skip.includes('status') && !any(q.status, (s) => row.status === s)) return false;
  if (!skip.includes('status') && q.not.status.includes(row.status)) return false;
  if (!any(q.health, (h) => row.health.level === h) || q.not.health.includes(row.health.level)) return false;
  if (!any(q.types, (t) => (row.type || 'http') === t) || q.not.types.includes(row.type || 'http')) return false;
  if (q.muted !== null && !!row.muted !== q.muted) return false;
  const hay = `${row.name} ${row.url} ${(row.tags || []).join(' ')}`.toLowerCase();
  return q.text.every((w) => hay.includes(w));
}

const STATUS_ORDER = { down: 0, degraded: 1, maintenance: 2, pending: 3, paused: 4, up: 5 };
const HEALTH_ORDER = { critica: 0, attenzione: 1, buona: 2 };

export const SORTS = ['default', 'name', 'status', 'health', 'availability', 'avg', 'p95', 'last'];

/** Sorts a copy of the rows (RF-LST-03); nulls always last, name as the tie-breaker. */
export function sortRows(rows, sort = 'default', dir = 'asc') {
  const sign = dir === 'desc' ? -1 : 1;
  const val = {
    name: (r) => r.name.toLowerCase(), status: (r) => STATUS_ORDER[r.status] ?? 9, health: (r) => HEALTH_ORDER[r.health.level] ?? 9,
    availability: (r) => r.availability, avg: (r) => r.avgMs, p95: (r) => r.p95Ms, last: (r) => r.lastAt,
  }[sort];
  const byName = (a, b) => a.name.localeCompare(b.name, 'it');
  if (!val) {
    // the ones that are down first, then the critical ones, then by availability (RF-KPI-02)
    const rank = (r) => (r.status === 'down' ? 0 : r.health.level === 'critica' ? 1 : 2);
    return [...rows].sort((a, b) => rank(a) - rank(b) || (a.availability ?? 101) - (b.availability ?? 101) || byName(a, b));
  }
  return [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null && y == null) return byName(a, b);
    if (x == null) return 1;
    if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * sign || byName(a, b);
  });
}

/** The tabs of RF-LST-01: counts per status over the rows that pass every other filter. */
export function statusCounts(rows) {
  const c = { all: rows.length, up: 0, degraded: 0, down: 0, paused: 0, maintenance: 0, pending: 0 };
  for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
  return c;
}
