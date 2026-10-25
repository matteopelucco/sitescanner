import tls from 'node:tls';
import { crawlFetch, blockedError, guardedLookup } from '../net-guard.js';
import { parseExpect } from '../core/uptime.js';
import { TOOL } from '../version.js';

// One check of a monitor (spec §12.3, RF-MON-10/11/15/16).

const MAX_BODY = 2 * 1024 * 1024;
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
    case 'keyword': return r.error;
    case 'redirect': return r.error || 'Troppi redirect';
    case 'destinazione non ammessa': return 'Destinazione non ammessa (indirizzo privato o locale)';
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

/**
 * Runs one request with the rules of the monitor.
 * @returns {Promise<{at, outcome: 'ok'|'slow'|'error', status, ms, ttfbMs, finalUrl, errorClass, error, excerpt}>}
 */
export async function performCheck(m, { guard = false, now = Date.now } = {}) {
  const at = now();
  const fetch = await crawlFetch(guard);
  const headers = { 'user-agent': `sitescanner-monitor/${TOOL.version}`, 'cache-control': 'no-cache', pragma: 'no-cache', ...(m.headers || {}) };
  if (m.auth && m.auth.username) headers.authorization = 'Basic ' + Buffer.from(`${m.auth.username}:${m.auth.password || ''}`).toString('base64');
  const timeoutMs = (m.timeoutS || 30) * 1000;
  const signal = AbortSignal.timeout(timeoutMs);
  const t0 = performance.now();
  const r = { at, outcome: 'error', status: null, ms: null, ttfbMs: null, finalUrl: m.url, errorClass: null, error: null, excerpt: null };
  try {
    let url = m.url;
    let res;
    const seen = new Set([url]);
    for (let hop = 0; ; hop++) {
      res = await fetch(url, { method: m.method || 'GET', headers, redirect: 'manual', signal });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        await res.body?.cancel();
        const next = new URL(loc, url).toString();
        if (seen.has(next) || hop >= 10) {
          Object.assign(r, { errorClass: 'redirect', error: seen.has(next) ? 'Ciclo di redirect' : 'Troppi redirect (oltre 10)', status: res.status });
          r.ms = Math.round(performance.now() - t0);
          return r;
        }
        seen.add(next);
        url = next;
        continue;
      }
      break;
    }
    r.ttfbMs = Math.round(performance.now() - t0);
    r.status = res.status;
    r.finalUrl = url;
    let body = '';
    if ((m.method || 'GET') !== 'HEAD' && res.body) {
      const chunks = [];
      let size = 0;
      for await (const chunk of res.body) {
        chunks.push(chunk);
        size += chunk.length;
        if (size >= MAX_BODY) break;
      }
      body = Buffer.concat(chunks).subarray(0, MAX_BODY).toString('utf8');
    }
    r.ms = Math.round(performance.now() - t0);
    const expect = parseExpect(m.expect || '200-399');
    if (!expect(res.status)) {
      Object.assign(r, { errorClass: 'http', error: `HTTP ${res.status}`, excerpt: body.slice(0, 2048) || null });
      return r;
    }
    if (m.keyword && m.keyword.text) {
      const hay = m.keyword.caseInsensitive ? body.toLowerCase() : body;
      const needle = m.keyword.caseInsensitive ? m.keyword.text.toLowerCase() : m.keyword.text;
      const found = hay.includes(needle);
      if (m.keyword.mode === 'absent' ? found : !found) {
        Object.assign(r, { errorClass: 'keyword', error: m.keyword.mode === 'absent' ? `Parola «${m.keyword.text}» presente` : `Parola «${m.keyword.text}» non trovata`, excerpt: body.slice(0, 2048) || null });
        return r;
      }
    }
    r.outcome = m.slowMs && r.ms > m.slowMs ? 'slow' : 'ok';
    return r;
  } catch (e) {
    Object.assign(r, classify(e));
    if (r.errorClass === 'timeout') r.error = `timeout dopo ${m.timeoutS || 30} s`;
    r.ms = Math.round(performance.now() - t0);
    return r;
  }
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
