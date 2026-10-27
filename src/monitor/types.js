import crypto from 'node:crypto';
import { cleanHost, RECORD_TYPES, parseResolver, normalizeDnsAssertions, TLS_VERSIONS } from '../core/netchecks.js';

// Types of monitor (spec §13.5). HTTP and API are checked by requests; the other types are in
// this module: the heartbeat (passive, the job calls us) and, later, DNS, TCP and SSL.

const MIN = 60000;
export const DAY = 86400000;

export const TYPE_INFO = {
  http: { label: 'Sito web', hint: 'Controlla che una pagina risponda, con le asserzioni sullo status e sul contenuto.' },
  api: { label: 'API', hint: 'Una richiesta con metodo, corpo e asserzioni sulla risposta, per controllare un endpoint.' },
  heartbeat: { label: 'Heartbeat (cron job)', hint: 'Controlla che un lavoro periodico (backup, feed, sitemap) giri: è lui a chiamare un indirizzo segreto a ogni esecuzione.', passive: true },
  dns: { label: 'DNS', hint: 'Controlla i record di un nome (A, MX, TXT…): rileva domini scaduti, record cambiati per errore e propagazioni non riuscite.' },
  tcp: { label: 'TCP (porta)', hint: 'Controlla che una porta accetti connessioni (SMTP, IMAP, un database), o che non le accetti, con un testo da inviare e la risposta attesa.' },
  ssl: { label: 'SSL e dominio', hint: 'Controlla il certificato di un host (anche senza pagina web: catena, nomi, protocollo, scadenza) e la scadenza del dominio. Un controllo al giorno.' },
};

/** What the monitor looks at, in a short line for the lists (the URL, for the web types). */
export function targetOf(m) {
  switch (m.type) {
    case 'dns': return `${m.dnsName} · record ${m.recordType}${m.resolver && m.resolver !== 'system' ? ` · resolver ${m.resolver}` : ''}`;
    case 'tcp': return `${m.host}:${m.port}`;
    case 'ssl': return `${m.host}:${m.port}`;
    case 'heartbeat': return `cron job: una chiamata ogni ${fmtMin(m.expectedMin)}`;
    default: return m.url || '';
  }
}

/** The key to limit parallel checks of the same destination (RF-MON-14). */
export function hostKey(m) {
  if (m.type === 'dns') return `dns:${m.resolver}`;
  if (m.type === 'tcp' || m.type === 'ssl') return `${m.host}:${m.port}`;
  try { return new URL(m.url).host; } catch { return m.id; }
}

/**
 * Validation of the types that are not a web request (RF-TYP-01..04): sets the fields of the type, the
 * name when empty, and the interval. `intervals`: the allowed ones for the types that are not daily.
 */
export function normalizeSpecial(m, bad, intervals) {
  const interval = () => {
    m.intervalMin = Number(m.intervalMin);
    if (!intervals.includes(m.intervalMin)) throw bad(`Intervallo non valido: ammessi ${intervals.join(', ')} minuti`);
  };
  m.name = String(m.name || '').trim().slice(0, 80);
  if (m.type === 'heartbeat') {
    if (!m.name) throw bad('Dai un nome al heartbeat (per esempio «Backup notturno»)');
    return normalizeHeartbeat(m, bad);
  }
  if (m.type === 'dns') {
    m.dnsName = cleanHost(m.dnsName);
    if (!m.dnsName || /^\d+(\.\d+){3}$/.test(m.dnsName)) throw bad('Nome da risolvere non valido (per esempio www.esempio.it)');
    m.recordType = String(m.recordType || 'A').toUpperCase();
    if (!RECORD_TYPES.includes(m.recordType)) throw bad(`Tipo di record: ${RECORD_TYPES.join(', ')}`);
    const r = parseResolver(m.resolver);
    if (!r) throw bad('Resolver: di sistema, 1.1.1.1, 8.8.8.8 oppure un indirizzo IP (con la porta, se serve)');
    m.resolver = r.id;
    try { m.dnsAssertions = normalizeDnsAssertions(m.dnsAssertions); } catch (e) { throw bad(e.message); }
    interval();
    m.name ||= `${m.dnsName} (${m.recordType})`;
    return m;
  }
  // tcp and ssl: a host and a port
  m.host = cleanHost(m.host);
  if (!m.host) throw bad('Host non valido (un nome o un indirizzo IP)');
  m.port = Number(m.port ?? (m.type === 'ssl' ? 443 : NaN));
  if (!Number.isInteger(m.port) || m.port < 1 || m.port > 65535) throw bad('Porta da 1 a 65535');
  if (m.type === 'tcp') {
    m.tcpSend = String(m.tcpSend ?? '').slice(0, 1024);
    m.tcpExpect = String(m.tcpExpect ?? '').trim().slice(0, 200);
    m.shouldFail = !!m.shouldFail;
    if (m.shouldFail && (m.tcpSend || m.tcpExpect)) throw bad('Se la connessione deve fallire non ha senso inviare un testo né attendere una risposta');
    interval();
    m.name ||= `${m.host}:${m.port}`;
    return m;
  }
  m.minTls = TLS_VERSIONS.includes(m.minTls) ? m.minTls : 'TLSv1.2';
  m.checkDomain = m.checkDomain !== false;
  m.domainDays = [...new Set((m.domainDays || [30, 14, 7, 1]).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 365))].sort((a, b) => b - a);
  m.intervalMin = 1440; // one run a day, whatever the interval of the others (RF-TYP-04)
  m.name ||= m.host;
  return m;
}
export const isPassive = (type) => !!(TYPE_INFO[type] && TYPE_INFO[type].passive);
export const isWeb = (type) => type === 'http' || type === 'api';

export const newHeartbeatToken = () => crypto.randomBytes(18).toString('base64url');

/** The period and tolerance of a heartbeat, validated (RF-TYP-01): 1 minute to 30 days, and a tolerance up to a day. */
export function normalizeHeartbeat(m, bad) {
  m.expectedMin = Number(m.expectedMin ?? 60);
  if (!Number.isInteger(m.expectedMin) || m.expectedMin < 1 || m.expectedMin > 43200) throw bad('Il periodo atteso va da 1 minuto a 30 giorni (43200 minuti)');
  m.toleranceMin = Number(m.toleranceMin ?? Math.max(1, Math.round(m.expectedMin / 10)));
  if (!Number.isInteger(m.toleranceMin) || m.toleranceMin < 0 || m.toleranceMin > 1440) throw bad('La tolleranza va da 0 a 1440 minuti');
  m.hbToken ||= newHeartbeatToken();
  // the coverage of every call lasts a period plus the tolerance: the KPIs count it as the interval of the checks
  m.intervalMin = m.expectedMin + m.toleranceMin;
  return m;
}

/** When the next call is due at the latest (period + tolerance after the last call, or the creation). */
export const heartbeatDeadline = (m) => (m.state.lastPingAt || m.createdAt) + (m.expectedMin + m.toleranceMin) * MIN;

/**
 * The calls missed by `now`, one result per period without a call (RF-TYP-01): each one is a failed run
 * at its deadline, like a failed check of an active monitor, so that downtime and incidents are counted
 * in the same way. Advances `nextCheckAt` to the next deadline. At most `max` per round.
 */
export function heartbeatMisses(m, now, max = 50) {
  const out = [];
  const step = (m.expectedMin + m.toleranceMin) * MIN;
  let due = m.state.nextCheckAt || heartbeatDeadline(m);
  while (due <= now && out.length < max) {
    out.push({
      at: due, outcome: 'error', status: null, ms: null, errorClass: 'heartbeat', nextCheckAt: due + step, retried: false,
      error: `Nessuna chiamata ricevuta da più di ${fmtMin(m.expectedMin + m.toleranceMin)}`,
    });
    due += step;
  }
  return out;
}

/**
 * The result a call produces (RF-TYP-01): `ok` ends the run (its length is the time since `/start`, judged
 * with the thresholds of RF-RIS-01), `fail` is a failure at once. `start` only marks the beginning.
 */
export function pingResult(m, kind, now, { message = '' } = {}) {
  const next = now + (m.expectedMin + m.toleranceMin) * MIN;
  if (kind === 'fail') return { at: now, outcome: 'error', status: null, ms: null, errorClass: 'heartbeat-fail', error: message ? `Il job ha segnalato un errore: ${message}` : 'Il job ha segnalato un errore', nextCheckAt: next };
  const ms = m.state.startedAt && now - m.state.startedAt < 7 * DAY ? now - m.state.startedAt : null;
  if (ms != null && m.failedMs && ms > m.failedMs) return { at: now, outcome: 'error', status: null, ms, errorClass: 'soglia', error: `Esecuzione in ${fmtMs(ms)}, oltre la soglia di guasto di ${fmtMs(m.failedMs)}`, nextCheckAt: next };
  return { at: now, outcome: ms != null && m.degradedMs && ms > m.degradedMs ? 'degraded' : 'ok', status: null, ms, nextCheckAt: next };
}

const fmtMs = (ms) => (ms < 1000 ? `${ms} ms` : ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`);
export function fmtMin(min) {
  if (min < 60) return `${min} minuti`;
  if (min < 2880) return `${Math.round((min / 60) * 10) / 10} ore`.replace('.', ',');
  return `${Math.round(min / 1440)} giorni`;
}

/** Records a call in the state of the monitor (the last 50, shown in the page of the monitor). */
export function notePing(m, kind, now, { ip = null, note = '' } = {}) {
  const s = m.state;
  s.pings = [...(s.pings || []), { at: now, kind, ...(ip ? { ip } : {}), ...(note ? { note: String(note).slice(0, 200) } : {}) }].slice(-50);
  s.lastPingAt = now;
  if (kind === 'start') s.startedAt = now;
  else s.startedAt = null;
}
