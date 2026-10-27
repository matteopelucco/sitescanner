// Assertions on the response of a check (spec §13.3). Pure: no I/O, no dependencies, so that the same
// code judges the runs of the monitors and the test run of the form.
//
// An assertion is { source, property, comparison, target, ci }:
//   source      status | header | body | json | time | url
//   property    header name (header), JSONPath (json); unused otherwise
//   comparison  equals notEquals contains notContains gt lt matches empty notEmpty (+ in, for the status)
//   target      the expected value, as text
//   ci          ignore case (equals, notEquals, contains, notContains)

export const SOURCES = ['status', 'header', 'body', 'json', 'time', 'url'];
export const COMPARISONS = ['equals', 'notEquals', 'contains', 'notContains', 'gt', 'lt', 'matches', 'empty', 'notEmpty', 'in'];

const COMPARISONS_BY_SOURCE = {
  status: ['in', 'equals', 'notEquals', 'gt', 'lt'],
  header: ['equals', 'notEquals', 'contains', 'notContains', 'matches', 'empty', 'notEmpty'],
  body: ['contains', 'notContains', 'equals', 'notEquals', 'matches', 'empty', 'notEmpty'],
  json: ['equals', 'notEquals', 'contains', 'notContains', 'gt', 'lt', 'matches', 'empty', 'notEmpty'],
  time: ['lt', 'gt', 'equals'],
  url: ['equals', 'notEquals', 'contains', 'notContains', 'matches'],
};
export const comparisonsFor = (source) => COMPARISONS_BY_SOURCE[source] || [];

export const COMPARISON_LABELS = {
  equals: 'uguale a', notEquals: 'diverso da', contains: 'contiene', notContains: 'non contiene', gt: 'maggiore di', lt: 'minore di',
  matches: 'corrisponde a', empty: 'vuoto', notEmpty: 'non vuoto', in: 'tra',
};
export const NEEDS_TARGET = (c) => c !== 'empty' && c !== 'notEmpty';
const WILDCARD_OK = new Set(['contains', 'notContains', 'empty', 'notEmpty']);

/** The default assertion of a monitor without any (RF-AST-02). */
export const DEFAULT_ASSERTIONS = [{ source: 'status', comparison: 'in', target: '200-399' }];

// ---------------- status lists ----------------

/** "200-399", "200,301", "200-299, 304" → predicate; null if the text is not valid. */
export function parseStatusList(text) {
  const parts = String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean);
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

// ---------------- JSONPath (a small subset) ----------------

/**
 * Parses `$.a.b[0].c`, `$['a-b'].c`, `$.items[*].id` into tokens; null if invalid.
 * Tokens: { key } | { index } | { all: true }.
 */
export function parseJsonPath(path) {
  const s = String(path ?? '').trim();
  if (!s.startsWith('$')) return null;
  const tokens = [];
  let i = 1;
  while (i < s.length) {
    if (s[i] === '.') {
      const m = /^\.([A-Za-z_$][\w$-]*)/.exec(s.slice(i));
      if (!m) return null;
      tokens.push({ key: m[1] });
      i += m[0].length;
    } else if (s[i] === '[') {
      const m = /^\[(?:(\d+)|\*|'([^']*)'|"([^"]*)")\]/.exec(s.slice(i));
      if (!m) return null;
      if (m[1] !== undefined) tokens.push({ index: Number(m[1]) });
      else if (m[0] === '[*]') tokens.push({ all: true });
      else tokens.push({ key: m[2] ?? m[3] });
      i += m[0].length;
    } else return null;
  }
  return tokens;
}

export const hasWildcard = (path) => (parseJsonPath(path) || []).some((t) => t.all);

/** The values a path points to (several with `[*]`), and whether the path matched anything. */
export function queryJson(value, tokens) {
  let current = [value];
  for (const t of tokens) {
    const next = [];
    for (const v of current) {
      if (t.all) {
        if (Array.isArray(v)) next.push(...v);
      } else if (t.index !== undefined) {
        if (Array.isArray(v) && t.index < v.length) next.push(v[t.index]);
      } else if (v && typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, t.key)) next.push(v[t.key]);
    }
    current = next;
  }
  return current;
}

// ---------------- validation ----------------

/** Normalizes and validates a list of assertions; throws Error with a message in Italian. */
export function normalizeAssertions(list) {
  const out = [];
  for (const [i, a] of (Array.isArray(list) ? list : []).entries()) {
    const n = i + 1;
    const x = { source: String(a.source || ''), comparison: String(a.comparison || ''), target: a.target == null ? '' : String(a.target) };
    if (!SOURCES.includes(x.source)) throw new Error(`Asserzione ${n}: sorgente non valida`);
    if (!COMPARISONS_BY_SOURCE[x.source].includes(x.comparison)) throw new Error(`Asserzione ${n}: il confronto «${COMPARISON_LABELS[x.comparison] || x.comparison}» non vale per «${x.source}»`);
    if (NEEDS_TARGET(x.comparison) && x.target === '') throw new Error(`Asserzione ${n}: manca il valore atteso`);
    if (x.target.length > 500) throw new Error(`Asserzione ${n}: valore atteso troppo lungo (max 500 caratteri)`);
    if (x.source === 'header' || x.source === 'json') {
      x.property = String(a.property || '').trim();
      if (!x.property) throw new Error(`Asserzione ${n}: ${x.source === 'header' ? 'manca il nome dell\'header' : 'manca il percorso JSON (es. $.stato)'}`);
    }
    if (x.source === 'json') {
      if (!parseJsonPath(x.property)) throw new Error(`Asserzione ${n}: percorso JSON non valido (${x.property}); sono ammessi $.a.b, [0], ['chiave'] e [*]`);
      if (hasWildcard(x.property) && !WILDCARD_OK.has(x.comparison)) throw new Error(`Asserzione ${n}: con [*] si usano «contiene», «non contiene», «vuoto» e «non vuoto»`);
    }
    if (x.comparison === 'in' && !parseStatusList(x.target)) throw new Error(`Asserzione ${n}: status non validi (es. 200-399 oppure 200,301)`);
    if (['gt', 'lt'].includes(x.comparison) || x.source === 'time') {
      if (!Number.isFinite(Number(x.target))) throw new Error(`Asserzione ${n}: il valore atteso deve essere un numero`);
    }
    if (x.comparison === 'matches') {
      try { new RegExp(x.target); } catch (e) { throw new Error(`Asserzione ${n}: espressione regolare non valida (${e.message})`); }
    }
    if (a.ci && ['equals', 'notEquals', 'contains', 'notContains'].includes(x.comparison)) x.ci = true;
    out.push(x);
  }
  return out;
}

// ---------------- evaluation ----------------

const show = (v) => {
  if (v === undefined) return 'assente';
  if (typeof v === 'string') return JSON.stringify(v.length > 80 ? `${v.slice(0, 80)}…` : v);
  const t = JSON.stringify(v);
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
};
const cut = (s) => (s.length > 200 ? `${s.slice(0, 199)}…` : s);

function compare(comparison, actual, target, ci) {
  const text = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const norm = (v) => (ci ? text(v).toLowerCase() : text(v));
  switch (comparison) {
    case 'equals': return typeof actual === 'number' && target.trim() !== '' && Number.isFinite(Number(target)) ? actual === Number(target) : norm(actual) === norm(target);
    case 'notEquals': return !compare('equals', actual, target, ci);
    case 'contains': return norm(actual).includes(norm(target));
    case 'notContains': return !norm(actual).includes(norm(target));
    case 'gt': return Number.isFinite(Number(actual)) && actual !== '' && actual !== null && Number(actual) > Number(target);
    case 'lt': return Number.isFinite(Number(actual)) && actual !== '' && actual !== null && Number(actual) < Number(target);
    case 'matches': return new RegExp(target).test(text(actual));
    case 'empty': return actual === undefined || actual === null || actual === '' || (Array.isArray(actual) && !actual.length) || (typeof actual === 'object' && actual !== null && !Array.isArray(actual) && !Object.keys(actual).length);
    case 'notEmpty': return !compare('empty', actual, target, ci);
    case 'in': return typeof actual === 'number' && parseStatusList(target)(actual);
    default: return false;
  }
}

/**
 * Evaluates the assertions on a response.
 * ctx: { status, headers (lowercase names), body (text), ms, url }
 * @returns {{ok: boolean, results: {assertion, ok: boolean, actual: any, message: string|null, errorClass: string|null}[]}}
 */
export function evaluateAssertions(assertions, ctx) {
  const list = assertions && assertions.length ? assertions : DEFAULT_ASSERTIONS;
  let json; // parsed lazily, once
  let jsonError = null;
  let parsed = false;
  const parseBody = () => {
    if (parsed) return;
    parsed = true;
    try { json = JSON.parse(ctx.body); } catch (e) { jsonError = e; }
  };
  const results = list.map((a) => {
    let actual, label, errorClass = 'asserzione';
    let wildcard = false;
    switch (a.source) {
      case 'status': actual = ctx.status; label = 'Status'; errorClass = 'http'; break;
      case 'header': actual = ctx.headers ? ctx.headers[String(a.property).toLowerCase()] : undefined; label = `Header ${a.property}`; break;
      case 'body': actual = ctx.body; label = 'Corpo'; if (a.comparison === 'contains' || a.comparison === 'notContains') errorClass = 'keyword'; break;
      case 'url': actual = ctx.url; label = 'URL finale'; break;
      case 'time': actual = ctx.ms; label = 'Tempo di risposta'; break;
      case 'json': {
        parseBody();
        label = `JSON ${a.property}`;
        if (jsonError) return { assertion: a, ok: false, actual: undefined, errorClass, message: cut('La risposta non è JSON valido') };
        const found = queryJson(json, parseJsonPath(a.property));
        wildcard = hasWildcard(a.property);
        actual = wildcard ? found : found[0];
        break;
      }
      default: return { assertion: a, ok: false, actual: undefined, errorClass, message: `Sorgente sconosciuta: ${a.source}` };
    }
    let ok;
    if (wildcard) {
      // with [*]: «contains» is true if any element contains the target (RF-AST-01)
      if (a.comparison === 'contains') ok = actual.some((v) => compare('contains', v, a.target, a.ci));
      else if (a.comparison === 'notContains') ok = !actual.some((v) => compare('contains', v, a.target, a.ci));
      else ok = compare(a.comparison, actual, a.target, a.ci);
    } else ok = compare(a.comparison, actual, a.target, a.ci);
    if (ok) return { assertion: a, ok, actual, errorClass: null, message: null };
    let message;
    if (a.source === 'body' && a.comparison === 'contains') message = `Parola «${a.target}» non trovata`;
    else if (a.source === 'body' && a.comparison === 'notContains') message = `Parola «${a.target}» presente`;
    else if (a.source === 'status') message = `Status ${actual}, atteso ${a.comparison === 'in' || a.comparison === 'equals' ? a.target : `${COMPARISON_LABELS[a.comparison]} ${a.target}`}`;
    else {
      const shown = a.source === 'body' ? '' : ` = ${wildcard ? show(actual) : show(actual)}`;
      const expected = a.comparison === 'equals' ? show(a.target) : `${COMPARISON_LABELS[a.comparison]}${NEEDS_TARGET(a.comparison) ? ` ${show(a.target)}` : ''}`;
      message = `${label}${shown}, atteso ${expected}`;
    }
    return { assertion: a, ok, actual, errorClass, message: cut(message) };
  });
  return { ok: results.every((r) => r.ok), results };
}

/** An assertion as a sentence, for the interface and the logs. */
export function describeAssertion(a) {
  const what = { status: 'Status', header: `Header ${a.property}`, body: 'Corpo', json: `JSON ${a.property}`, time: 'Tempo di risposta (ms)', url: 'URL finale' }[a.source];
  return `${what} ${COMPARISON_LABELS[a.comparison] || a.comparison}${NEEDS_TARGET(a.comparison) ? ` ${a.target}` : ''}${a.ci ? ' (senza maiuscole)' : ''}`;
}

/** The status list and keyword of the first version as assertions (RF-AST-02). */
export function assertionsFromLegacy({ expect, keyword }) {
  const out = [{ source: 'status', comparison: 'in', target: String(expect || '200-399').replace(/\s+/g, '') }];
  if (keyword && keyword.text) {
    out.push({ source: 'body', comparison: keyword.mode === 'absent' ? 'notContains' : 'contains', target: String(keyword.text), ...(keyword.caseInsensitive ? { ci: true } : {}) });
  }
  return out;
}
