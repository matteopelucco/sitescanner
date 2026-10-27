import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { blockedError, guardedLookup, isBlockedAddress, BlockedDestinationError } from '../net-guard.js';
import {
  parseResolver, formatRecords, evaluateDnsAssertions, tlsAtLeast, registrableDomain, rdapExpiry,
} from '../core/netchecks.js';

// The checks of the DNS, TCP and SSL monitors (spec §13.5, RF-TYP-02..04). Same result shape as an HTTP check:
// { at, outcome, status, ms, errorClass, error, phases, ip, tls, assertions, excerpt }.

const ms = (t0) => Math.round(performance.now() - t0);
const fail = (r, errorClass, error) => Object.assign(r, { outcome: 'error', errorClass, error });

/** Thresholds of a run length (RF-RIS-01), as for the HTTP checks. */
function judge(r, m) {
  if (r.outcome === 'error') return r;
  const failedMs = m.failedMs && m.failedMs < (m.timeoutS || 30) * 1000 ? m.failedMs : null;
  if (failedMs && r.ms > failedMs) return fail(r, 'soglia', `Risposta in ${r.ms} ms, oltre la soglia di guasto di ${failedMs} ms`);
  if (m.degradedMs && r.ms > m.degradedMs) return Object.assign(r, { outcome: 'degraded', error: `Risposta in ${r.ms} ms, oltre la soglia di degrado di ${m.degradedMs} ms` });
  return r;
}

/** An IP literal never goes through the lookup of the socket, so the guard looks at it first (RF-SEC-01). */
const blockedLiteral = (host, guard) => !!(guard && net.isIP(host) && isBlockedAddress(host));

const base = (now) => ({ at: now(), outcome: 'ok', status: null, ms: null, ttfbMs: null, finalUrl: null, errorClass: null, error: null, excerpt: null, phases: null });

// ---------------- DNS ----------------

const DNS_CODES = { ENOTFOUND: 'dns', ENODATA: 'dns', ESERVFAIL: 'dns', EBADRESP: 'dns', EFORMERR: 'dns', ETIMEOUT: 'timeout', ETIMEDOUT: 'timeout', ECONNREFUSED: 'connessione', ECANCELLED: 'timeout' };

export async function dnsCheck(m, { guard = false, now = Date.now } = {}) {
  const r = base(now);
  const resolver = parseResolver(m.resolver);
  if (guard && resolver.servers && resolver.servers.some((s) => isBlockedAddress(s.replace(/^\[|\](:\d+)?$/g, '').replace(/:\d+$/, '')))) {
    return fail(r, 'destinazione non ammessa', 'destinazione non ammessa');
  }
  const R = new dns.promises.Resolver({ timeout: Math.max(1000, (m.timeoutS || 30) * 1000), tries: 1 });
  if (resolver.servers) R.setServers(resolver.servers);
  const call = { A: 'resolve4', AAAA: 'resolve6', CNAME: 'resolveCname', MX: 'resolveMx', TXT: 'resolveTxt', NS: 'resolveNs' }[m.recordType];
  const t0 = performance.now();
  let answer;
  try {
    answer = await R[call](m.dnsName);
  } catch (e) {
    r.ms = ms(t0);
    const cls = DNS_CODES[e.code] || 'dns';
    return fail(r, cls, cls === 'dns' ? `Nessun record ${m.recordType} per ${m.dnsName} (${e.code || e.message})` : cls === 'timeout' ? `Il resolver non ha risposto entro ${m.timeoutS || 30} s` : `Resolver non raggiungibile (${e.code})`);
  }
  r.ms = ms(t0);
  r.phases = { dnsMs: r.ms, tcpMs: 0, tlsMs: 0, waitMs: 0, downloadMs: 0, totalMs: r.ms };
  const records = formatRecords(m.recordType, answer);
  r.excerpt = records.join('\n') || null;
  r.records = records;
  const verdict = evaluateDnsAssertions(records, m.dnsAssertions && m.dnsAssertions.length ? m.dnsAssertions : [{ comparison: 'notEmpty', target: '', ci: true }]);
  r.assertions = verdict.results.map((x) => ({ text: x.text, ok: x.ok, message: x.message }));
  if (!verdict.ok) return fail(r, 'asserzione', verdict.results.find((x) => !x.ok).message);
  return judge(r, m);
}

// ---------------- TCP ----------------

const unescapeSend = (s) => String(s).replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t');

export function tcpCheck(m, { guard = false, now = Date.now } = {}) {
  const r = base(now);
  if (blockedLiteral(m.host, guard)) return Promise.resolve(fail(r, 'destinazione non ammessa', 'destinazione non ammessa'));
  const timeoutMs = (m.timeoutS || 30) * 1000;
  const t0 = performance.now();
  return new Promise((resolve) => {
    let done = false, lookupAt = null, connectedAt = null, firstDataAt = null, received = '';
    const socket = net.connect({ host: m.host, port: m.port, ...(guard ? { lookup: guardedLookup } : {}) });
    const finish = (patch) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      r.ms = ms(t0);
      const dnsMs = lookupAt != null ? Math.round(lookupAt - t0) : 0;
      const tcpMs = connectedAt != null ? Math.round(connectedAt - (lookupAt ?? t0)) : 0;
      r.phases = { dnsMs, tcpMs, tlsMs: 0, waitMs: firstDataAt != null ? Math.round(firstDataAt - (connectedAt ?? t0)) : 0, downloadMs: 0, totalMs: r.ms };
      if (received) r.excerpt = received.slice(0, 2048);
      resolve(m.shouldFail ? inverted(Object.assign(r, patch)) : judge(Object.assign(r, patch), m));
    };
    // «the connection must fail» (RF-TYP-03): a database exposed by mistake. A failure to connect is the expected result.
    const inverted = (x) => {
      if (x.outcome === 'ok') return fail(x, 'atteso-errore', `La connessione a ${m.host}:${m.port} doveva fallire ma è riuscita`);
      if (['connessione', 'timeout', 'dns'].includes(x.errorClass)) return Object.assign(x, { outcome: 'ok', errorClass: null, error: `Non raggiungibile come previsto (${x.error})` });
      return x;
    };
    const timer = setTimeout(() => finish({ outcome: 'error', errorClass: 'timeout', error: `Nessuna risposta entro ${m.timeoutS || 30} s` }), timeoutMs);
    socket.on('lookup', () => { lookupAt = performance.now(); });
    socket.on('connect', () => {
      connectedAt = performance.now();
      r.ip = socket.remoteAddress;
      if (m.tcpSend) socket.write(unescapeSend(m.tcpSend));
      // nothing to wait for: the connection is the check
      if (!m.tcpExpect && !m.tcpSend) finish({ outcome: 'ok' });
    });
    socket.on('data', (d) => {
      firstDataAt ??= performance.now();
      received += d.toString('utf8');
      if (m.tcpExpect && received.toLowerCase().includes(String(m.tcpExpect).toLowerCase())) finish({ outcome: 'ok' });
      else if (received.length > 4096) finish({ outcome: 'error', errorClass: 'asserzione', error: `La risposta non contiene «${m.tcpExpect}»` });
      else if (!m.tcpExpect && m.tcpSend) finish({ outcome: 'ok' });
    });
    socket.on('end', () => finish(m.tcpExpect ? { outcome: 'error', errorClass: 'asserzione', error: `La risposta non contiene «${m.tcpExpect}»${received ? ` (ricevuto: ${received.trim().slice(0, 60)})` : ''}` } : { outcome: 'ok' }));
    socket.on('error', (e) => {
      if (blockedError(e) || e instanceof BlockedDestinationError) return finish({ outcome: 'error', errorClass: 'destinazione non ammessa', error: 'destinazione non ammessa' });
      const cls = e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN' ? 'dns' : e.code === 'ETIMEDOUT' ? 'timeout' : 'connessione';
      finish({ outcome: 'error', errorClass: cls, error: cls === 'dns' ? `Nome non risolto (${m.host})` : cls === 'timeout' ? `Timeout dopo ${m.timeoutS || 30} s` : `Connessione a ${m.host}:${m.port} rifiutata o interrotta (${e.code || e.message})` });
    });
  });
}

// ---------------- SSL ----------------

const TLS_MESSAGES = {
  CERT_HAS_EXPIRED: 'certificato scaduto', DEPTH_ZERO_SELF_SIGNED_CERT: 'certificato autofirmato', SELF_SIGNED_CERT_IN_CHAIN: 'catena con un certificato autofirmato',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'catena incompleta (manca un certificato intermedio)', UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'emittente non riconosciuto', ERR_TLS_CERT_ALTNAME_INVALID: 'il nome non è coperto dal certificato',
  CERT_NOT_YET_VALID: 'certificato non ancora valido', CERT_REVOKED: 'certificato revocato',
};

export function sslCheck(m, { guard = false, now = Date.now } = {}) {
  const r = base(now);
  if (blockedLiteral(m.host, guard)) return Promise.resolve(fail(r, 'destinazione non ammessa', 'destinazione non ammessa'));
  const t0 = performance.now();
  return new Promise((resolve) => {
    let lookupAt = null, connectedAt = null, done = false;
    const finish = (patch) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      r.ms = ms(t0);
      r.phases = { dnsMs: lookupAt != null ? Math.round(lookupAt - t0) : 0, tcpMs: connectedAt != null ? Math.round(connectedAt - (lookupAt ?? t0)) : 0, tlsMs: connectedAt != null ? Math.round(performance.now() - connectedAt) : 0, waitMs: 0, downloadMs: 0, totalMs: r.ms };
      resolve(judge(Object.assign(r, patch), m));
    };
    const socket = tls.connect({
      host: m.host, port: m.port, servername: net.isIP(m.host) ? undefined : m.host, rejectUnauthorized: false, minVersion: m.minTls || 'TLSv1.2', ...(guard ? { lookup: guardedLookup } : {}),
    });
    const timer = setTimeout(() => finish({ outcome: 'error', errorClass: 'timeout', error: `Nessuna risposta entro ${m.timeoutS || 30} s` }), (m.timeoutS || 30) * 1000);
    socket.on('lookup', () => { lookupAt = performance.now(); });
    socket.on('connect', () => { connectedAt = performance.now(); });
    socket.on('secureConnect', () => {
      const c = socket.getPeerCertificate();
      const cert = c && c.valid_to ? {
        expiresAt: Date.parse(c.valid_to), issuer: (c.issuer && (c.issuer.O || c.issuer.CN)) || null,
        names: String(c.subjectaltname || '').split(',').map((s) => s.trim().replace(/^DNS:/, '')).filter(Boolean),
      } : null;
      const protocol = socket.getProtocol();
      r.ip = socket.remoteAddress;
      r.tls = { protocol, authorized: socket.authorized, cert };
      r.excerpt = [`Protocollo: ${protocol}`, cert ? `Emittente: ${cert.issuer || '—'}` : '', cert ? `Scade: ${new Date(cert.expiresAt).toISOString().slice(0, 10)}` : '', cert ? `Nomi: ${cert.names.join(', ')}` : ''].filter(Boolean).join('\n');
      if (!socket.authorized && !m.skipSsl) {
        const code = String(socket.authorizationError && (socket.authorizationError.code || socket.authorizationError));
        return finish({ outcome: 'error', errorClass: 'tls', error: TLS_MESSAGES[code] || `certificato non valido (${code})` });
      }
      if (!tlsAtLeast(protocol, m.minTls || 'TLSv1.2')) return finish({ outcome: 'error', errorClass: 'tls', error: `Protocollo ${protocol} sotto il minimo ${m.minTls || 'TLSv1.2'}` });
      finish({ outcome: 'ok' });
    });
    socket.on('error', (e) => {
      if (blockedError(e) || e instanceof BlockedDestinationError) return finish({ outcome: 'error', errorClass: 'destinazione non ammessa', error: 'destinazione non ammessa' });
      const code = String(e.code || '');
      if (/ERR_SSL|PROTOCOL|ALERT|WRONG_VERSION|UNSUPPORTED/.test(code) || /protocol|alert|version/i.test(e.message)) return finish({ outcome: 'error', errorClass: 'tls', error: `Handshake TLS non riuscito (${e.message.split('\n')[0].slice(0, 80)})` });
      const cls = code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'dns' : code === 'ETIMEDOUT' ? 'timeout' : 'connessione';
      finish({ outcome: 'error', errorClass: cls, error: cls === 'dns' ? `Nome non risolto (${m.host})` : `Connessione a ${m.host}:${m.port} non riuscita (${code || e.message})` });
    });
  });
}

// ---------------- domain expiry via RDAP ----------------

export const rdapBase = () => (process.env.SITESCANNER_RDAP_URL || 'https://rdap.org').replace(/\/$/, '');

/** The expiry of a domain from its registry (RF-TYP-04); `{ domain, expiresAt }` or `{ domain, error }`. Never throws. */
export async function rdapLookup(host, { fetcher = fetch } = {}) {
  const domain = registrableDomain(host);
  if (!domain) return { domain: null, error: 'nome non registrabile (indirizzo IP o nome senza dominio)' };
  try {
    const res = await fetcher(`${rdapBase()}/domain/${encodeURIComponent(domain)}`, { headers: { accept: 'application/rdap+json, application/json' }, signal: AbortSignal.timeout(10000) });
    if (res.status === 404) return { domain, error: 'dominio non trovato nel registro' };
    if (!res.ok) return { domain, error: `il registro ha risposto ${res.status}` };
    const expiresAt = rdapExpiry(await res.json());
    return expiresAt ? { domain, expiresAt } : { domain, error: 'il registro non indica la scadenza' };
  } catch (e) {
    return { domain, error: `registro non raggiungibile (${e.name === 'TimeoutError' ? 'timeout' : e.message})` };
  }
}

export const performNetCheck = { dns: dnsCheck, tcp: tcpCheck, ssl: sslCheck };
