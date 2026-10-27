// DNS, TCP and SSL/domain monitors (spec §13.5, RF-TYP-02..04): the pure parts, validation and verdicts.

export const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'];
export const RESOLVERS = { system: { label: 'Del sistema', servers: null }, cloudflare: { label: 'Cloudflare (1.1.1.1)', servers: ['1.1.1.1'] }, google: { label: 'Google (8.8.8.8)', servers: ['8.8.8.8'] } };
export const DNS_COMPARISONS = { contains: 'contiene', notContains: 'non contiene', equalsSet: 'è esattamente', matches: 'corrisponde a (espressione)', notEmpty: 'esiste almeno un record' };

const HOST_RE = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/i;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** A host name or an IP literal, lower case, without the final dot; null if it is not one. */
export function cleanHost(v) {
  const h = String(v ?? '').trim().toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!h) return null;
  if (h.includes(':') && /^[0-9a-f:.]+$/.test(h)) return h; // IPv6 literal
  if (IPV4_RE.test(h)) return h.split('.').every((p) => Number(p) <= 255) ? h : null;
  return HOST_RE.test(h) ? h : null;
}

/** `system`, `cloudflare`, `google`, or an address with an optional port: «192.0.2.1», «192.0.2.1:5353», «[2001:db8::1]:53». */
export function parseResolver(v) {
  const s = String(v ?? 'system').trim().toLowerCase();
  if (RESOLVERS[s]) return { id: s, servers: RESOLVERS[s].servers };
  const m6 = /^\[([0-9a-f:]+)\](?::(\d{1,5}))?$/.exec(s);
  const m4 = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/.exec(s);
  const m = m6 || m4;
  if (!m || (m4 && !m[1].split('.').every((p) => Number(p) <= 255)) || (m[2] && (Number(m[2]) < 1 || Number(m[2]) > 65535))) return null;
  return { id: s, servers: [m6 ? `[${m[1]}]${m[2] ? `:${m[2]}` : ''}` : `${m[1]}${m[2] ? `:${m[2]}` : ''}`] };
}

/** The values of a DNS answer as strings, sorted: A, AAAA, NS, CNAME as they are; MX «10 mail.x.it»; TXT its chunks joined. */
export function formatRecords(type, answer) {
  const list = (answer || []).map((r) => {
    if (type === 'MX') return `${r.priority} ${String(r.exchange).replace(/\.$/, '')}`;
    if (type === 'TXT') return Array.isArray(r) ? r.join('') : String(r);
    return String(r).replace(/\.$/, '');
  });
  return list.sort();
}

export function normalizeDnsAssertions(list) {
  const out = [];
  for (const [i, a] of (Array.isArray(list) ? list : []).entries()) {
    if (!DNS_COMPARISONS[a.comparison]) throw new Error(`Asserzione ${i + 1}: confronto sconosciuto (${a.comparison})`);
    const target = String(a.target ?? '').trim();
    if (a.comparison !== 'notEmpty' && !target) throw new Error(`Asserzione ${i + 1}: manca il valore atteso`);
    if (a.comparison === 'matches') { try { new RegExp(target); } catch { throw new Error(`Asserzione ${i + 1}: espressione non valida`); } }
    out.push({ comparison: a.comparison, target: a.comparison === 'notEmpty' ? '' : target, ci: a.ci !== false });
  }
  if (out.length > 10) throw new Error('Al massimo 10 asserzioni');
  return out;
}

/** The verdicts on the records (RF-TYP-02): `equalsSet` compares the set, ignoring order and case. */
export function evaluateDnsAssertions(records, assertions) {
  const results = assertions.map((a) => {
    const norm = (s) => (a.ci === false ? String(s) : String(s).toLowerCase());
    const have = records.map(norm);
    const want = norm(a.target);
    let ok, message;
    if (a.comparison === 'notEmpty') { ok = records.length > 0; message = 'Nessun record'; }
    else if (a.comparison === 'contains') { ok = have.some((v) => v === want); message = `Il record «${a.target}» non c'è (trovati: ${records.join(', ') || 'nessuno'})`; }
    else if (a.comparison === 'notContains') { ok = !have.some((v) => v === want); message = `Il record «${a.target}» non dovrebbe esserci`; }
    else if (a.comparison === 'equalsSet') {
      const set = new Set(String(a.target).split(/[\n,;]+/).map((x) => norm(x.trim())).filter(Boolean));
      ok = set.size === new Set(have).size && [...set].every((v) => have.includes(v));
      message = `I record sono ${records.join(', ') || 'nessuno'}, attesi ${[...new Set(String(a.target).split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean))].join(', ')}`;
    } else { ok = new RegExp(a.target, a.ci === false ? '' : 'i').test(records.join('\n')) || records.some((v) => new RegExp(a.target, a.ci === false ? '' : 'i').test(v)); message = `Nessun record corrisponde a «${a.target}» (trovati: ${records.join(', ') || 'nessuno'})`; }
    return { assertion: a, ok, message: ok ? null : message, text: `${DNS_COMPARISONS[a.comparison]}${a.target ? ` «${a.target}»` : ''}` };
  });
  return { ok: results.every((r) => r.ok), results };
}

// ---------------- SSL and domain ----------------

export const TLS_VERSIONS = ['TLSv1.2', 'TLSv1.3'];
const TLS_RANK = { 'TLSv1': 1, 'TLSv1.1': 2, 'TLSv1.2': 3, 'TLSv1.3': 4 };
/** Is the negotiated protocol at least the minimum (RF-TYP-04)? */
export const tlsAtLeast = (protocol, min) => (TLS_RANK[protocol] || 0) >= (TLS_RANK[min] || 0);

// second-level suffixes where the registrable domain has three labels (not the whole public suffix list)
const SECOND_LEVEL = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'com.br', 'com.mx', 'com.ar', 'co.za', 'com.tr', 'com.cn', 'co.in', 'com.pl']);

/** The domain to ask the registry about: «www.esempio.it» → «esempio.it»; null for IPs and single labels. */
export function registrableDomain(host) {
  const h = cleanHost(host);
  if (!h || IPV4_RE.test(h) || h.includes(':')) return null;
  const parts = h.split('.');
  if (parts.length < 2) return null;
  return parts.slice(-(SECOND_LEVEL.has(parts.slice(-2).join('.')) ? 3 : 2)).join('.');
}

/** The expiry date from a RDAP answer (events «expiration»); null if it has none. */
export function rdapExpiry(json) {
  const ev = ((json && json.events) || []).find((e) => /expiration/i.test(e.eventAction || ''));
  const t = ev ? Date.parse(ev.eventDate) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** The thresholds of the certificate and domain alerts: the closest passed one, each once (RF-NOT-01). */
export function dueThreshold(days, thresholds, sent = []) {
  const passed = days < 0 ? ['expired', ...thresholds] : thresholds.filter((d) => days <= d);
  const due = days < 0 ? 'expired' : passed.length ? Math.min(...passed) : null;
  if (due === null || sent.includes(due) || (days >= 0 && !thresholds.length)) return null;
  return { due, sent: [...new Set([...sent, ...passed])] };
}
