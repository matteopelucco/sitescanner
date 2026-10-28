import tls from 'node:tls';
import { blockedError, guardedLookup } from '../net-guard.js';
import { evaluateAssertions, assertionsFromLegacy, describeAssertion } from '../core/assertions.js';
import { request, headerText, maskHeaders } from './http-client.js';
import { TOOL } from '../version.js';
import { performNetCheck } from './net-checks.js';

// One check of a monitor (spec §12.3, RF-MON-10/11/15/16).

const NET_CODES = { ENOTFOUND: 'dns', EAI_AGAIN: 'dns', ENODATA: 'dns', ECONNREFUSED: 'connessione', ECONNRESET: 'connessione', EPIPE: 'connessione', EHOSTUNREACH: 'connessione', ENETUNREACH: 'connessione', UND_ERR_SOCKET: 'connessione', UND_ERR_CLOSED: 'connessione', ETIMEDOUT: 'timeout', UND_ERR_CONNECT_TIMEOUT: 'timeout', UND_ERR_HEADERS_TIMEOUT: 'timeout', UND_ERR_BODY_TIMEOUT: 'timeout' };

/** Error classes that may come from the monitor's own network (RF-MON-13). */
export const NETWORK_CLASSES = new Set(['dns', 'connessione', 'timeout']);

/** Messages in plain Italian for alerts and pages (RF-NOT-02). */
export function describeError(r, timeoutS = 30) {
  switch (r.errorClass) {
    case 'dns': return 'Nome a dominio non risolto (DNS)';
    case 'connessione': return 'Connessione rifiutata o interrotta';
    case 'timeout': return `Timeout dopo ${timeoutS} s`;
    case 'tls': return `Certificato non valido${r.error ? ` (${r.error})` : ''}`;
    case 'http': return `Errore HTTP ${r.status}`;
    case 'keyword':
    case 'asserzione': return r.error;
    case 'redirect': return r.error || 'Troppi redirect';
    case 'soglia': return r.error || 'Risposta oltre la soglia di guasto';
    case 'atteso-errore': return r.error;
    case 'destinazione non ammessa': return 'Destinazione non ammessa (indirizzo privato o locale)';
    case 'dominio':
    case 'configurazione': return r.error;
    case 'heartbeat':
    case 'heartbeat-fail': return r.error;
    default: return r.error || 'Errore';
  }
}

function classify(e) {
  if (blockedError(e)) return { errorClass: 'destinazione non ammessa', error: 'destinazione non ammessa' };
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return { errorClass: 'timeout', error: 'timeout' };
  let c = e;
  for (let i = 0; i < 4 && c; i++) {
    const code = c.code || '';
    if (NET_CODES[code]) return { errorClass: NET_CODES[code], error: code };
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|TLS|SSL/i.test(code)) return { errorClass: 'tls', error: code };
    c = c.cause;
  }
  return { errorClass: 'connessione', error: (e.cause && (e.cause.code || e.cause.message)) || e.message };
}

// Failures of the response itself (RF-RIS-06): the ones a «this request should fail» monitor expects.
const RESPONSE_CLASSES = new Set(['http', 'keyword', 'asserzione']);

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The request, with the rules of the monitor, without the inversion of «should fail». */
async function runRequest(m, { guard, now, detail, location = null }) {
  const at = now();
  const method = m.method || 'GET';
  const headers = { 'user-agent': `sitescanner-monitor/${TOOL.version}`, accept: '*/*', 'cache-control': 'no-cache', pragma: 'no-cache', ...(m.headers || {}) };
  if (location) headers['x-sitescanner-location'] = location; // the owner of the site can tell where a request comes from (RF-LOC-04)
  if (m.auth && m.auth.username) headers.authorization = 'Basic ' + Buffer.from(`${m.auth.username}:${m.auth.password || ''}`).toString('base64');
  // API checks (RF-AST-04): a body, as text or JSON
  let body = BODY_METHODS.has(method) && m.bodyType && m.bodyType !== 'none' ? String(m.body ?? '') : null;
  if (body != null && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = m.contentType || (m.bodyType === 'json' ? 'application/json' : 'text/plain; charset=utf-8');
  // the failure threshold cannot exceed the timeout (RF-RIS-01); it bounds the whole run, redirects included
  const timeoutMs = (m.timeoutS || 30) * 1000;
  const failedMs = m.failedMs && m.failedMs < timeoutMs ? m.failedMs : null;
  const budget = failedMs || timeoutMs;
  const t0 = performance.now();
  const r = { at, outcome: 'error', status: null, ms: null, ttfbMs: null, finalUrl: m.url, errorClass: null, error: null, excerpt: null, phases: null };
  const follow = m.followRedirects !== false;
  const chain = [];
  try {
    let url = m.url;
    let res;
    let verb = method;
    const seen = new Set([url]);
    for (;;) {
      res = await request(url, { method: verb, headers, body, timeoutMs: Math.max(1, budget - (performance.now() - t0)), insecure: !!m.skipSsl, family: m.ipVersion === '4' ? 4 : m.ipVersion === '6' ? 6 : 0, guard });
      const loc = headerText(res.headers.location);
      if (follow && res.status >= 300 && res.status < 400 && loc) {
        const next = new URL(loc, url).toString();
        chain.push({ url, status: res.status });
        if (seen.has(next) || chain.length > 10) {
          Object.assign(r, { errorClass: 'redirect', error: seen.has(next) ? 'Ciclo di redirect' : 'Troppi redirect (oltre 10)', status: res.status });
          r.ms = Math.round(performance.now() - t0);
          return r;
        }
        seen.add(next);
        // 303, and 301/302 after a POST, continue with a GET without body, like browsers do
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && verb === 'POST')) { verb = 'GET'; body = null; }
        url = next;
        continue;
      }
      break;
    }
    r.ms = Math.round(performance.now() - t0);
    r.status = res.status;
    r.finalUrl = url;
    r.ttfbMs = Math.round(res.ttfbMs + (r.ms - res.ms));
    // phases of the last request; the time of the redirects before it is a phase of its own
    r.phases = { ...res.phases, redirectMs: Math.max(0, r.ms - res.phases.totalMs), totalMs: r.ms };
    if (res.tls) r.tls = { protocol: res.tls.protocol, cert: res.tls.cert, authorized: res.tls.authorized };
    if (res.ip) r.ip = res.ip;
    const text = res.body.toString('utf8');
    if (detail) {
      r.redirects = chain.length;
      r.chain = chain;
      r.headers = maskHeaders(res.headers);
      r.excerpt = text.slice(0, 2048) || null;
    }
    if (failedMs && r.ms > failedMs) {
      Object.assign(r, { errorClass: 'soglia', error: `Risposta in ${r.ms} ms, oltre la soglia di guasto di ${failedMs} ms` });
      return r;
    }
    const assertions = m.assertions && m.assertions.length ? m.assertions : assertionsFromLegacy(m);
    const verdict = evaluateAssertions(assertions, { status: res.status, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, headerText(v)])), body: text, ms: r.ms, url });
    if (detail) r.assertions = verdict.results.map((x) => ({ text: describeAssertion(x.assertion), ok: x.ok, message: x.message }));
    if (!verdict.ok) {
      const first = verdict.results.find((x) => !x.ok);
      Object.assign(r, { errorClass: first.errorClass, error: first.message, excerpt: r.excerpt || text.slice(0, 2048) || null });
      return r;
    }
    if (m.degradedMs && r.ms > m.degradedMs) {
      r.outcome = 'degraded';
      r.error = `Risposta in ${r.ms} ms, oltre la soglia di degrado di ${m.degradedMs} ms`;
    } else r.outcome = 'ok';
    return r;
  } catch (e) {
    Object.assign(r, classify(e));
    r.ms = Math.round(performance.now() - t0);
    if (r.errorClass === 'timeout') {
      if (failedMs) Object.assign(r, { errorClass: 'soglia', error: `Nessuna risposta entro la soglia di guasto di ${failedMs} ms` });
      else r.error = `timeout dopo ${m.timeoutS || 30} s`;
    }
    return r;
  }
}

/**
 * Runs one check with the rules of the monitor (RF-MON-10, RF-RIS-01/06).
 * Outcomes: 'ok', 'degraded' (slower than `degradedMs`) and 'error'. With «the request should fail»
 * a failed response (status or keyword) is the expected result, and a successful one is the error;
 * network errors stay errors, because they prove nothing about the response.
 * `detail`: also return the response headers (sensitive ones masked) and a 2 KB excerpt (test runs).
 * @returns {Promise<{at, outcome, status, ms, ttfbMs, finalUrl, errorClass, error, excerpt}>}
 */
export async function performCheck(m, { guard = false, now = Date.now, detail = false, location = null } = {}) {
  if (m.type === 'browser') return (await import('./browser-check.js')).browserCheck(m, { guard, now, detail }); // RF-BRW-01
  if (performNetCheck[m.type]) return performNetCheck[m.type](m, { guard, now, detail }); // DNS, TCP, SSL (RF-TYP-02..04)
  const r = await runRequest(m, { guard, now, detail, location });
  if (!m.shouldFail) return r;
  if (r.outcome !== 'error') {
    return { ...r, outcome: 'error', errorClass: 'atteso-errore', error: `La richiesta doveva fallire ma ha risposto con HTTP ${r.status}` };
  }
  if (RESPONSE_CLASSES.has(r.errorClass)) return { ...r, outcome: 'ok', errorClass: null, error: `Fallita come previsto (${r.error})` };
  return r;
}

/**
 * Certificate of an https URL (RF-MON-16): expiry, issuer, names, validity.
 * @returns {Promise<{expiresAt, issuer, names, valid, error}|null>}
 */
export function certInfo(url, { guard = false, timeoutMs = 10000 } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'https:') return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = tls.connect({ host: u.hostname, port: Number(u.port) || 443, servername: u.hostname, rejectUnauthorized: false, timeout: timeoutMs, ...(guard ? { lookup: guardedLookup } : {}) }, () => {
      const c = socket.getPeerCertificate();
      const out = c && c.valid_to ? {
        expiresAt: Date.parse(c.valid_to),
        issuer: (c.issuer && (c.issuer.O || c.issuer.CN)) || null,
        names: String(c.subjectaltname || '').split(',').map((s) => s.trim().replace(/^DNS:/, '')).filter(Boolean),
        valid: socket.authorized,
        error: socket.authorized ? null : String(socket.authorizationError || ''),
      } : null;
      socket.end();
      resolve(out);
    });
    socket.on('error', () => resolve(null));
    socket.on('timeout', () => { socket.destroy(); resolve(null); });
  });
}
