import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { guardedLookup, assertUrlAllowed } from '../net-guard.js';

// HTTP client of the monitors (spec §13.4, RF-RIS-20): a request on node:http(s) that measures the
// phases of the connection on the socket, with a fresh connection every time (no keep-alive), so that
// DNS, TCP and TLS are really measured. Redirects are followed by the caller, one request per hop.

const MAX_BODY = 2 * 1024 * 1024;

const SENSITIVE = /set-cookie|cookie|authorization|token|key|secret/i;

/**
 * One request.
 * opts: { method, headers, body (Buffer|string|null), timeoutMs, insecure, family (0|4|6), guard, readBody }
 * @returns {Promise<{status, headers, body: Buffer, bytes, truncated, phases, ip, tls, ms}>}
 *   headers: lowercase names, string or array of strings; phases: dnsMs, tcpMs, tlsMs, waitMs, downloadMs, totalMs.
 * Rejects with the error of the request, with `phases` (what was measured so far) attached.
 */
export function request(url, opts = {}) {
  const u = new URL(url);
  const secure = u.protocol === 'https:';
  if (opts.guard) assertUrlAllowed(url); // IP literals never reach the lookup
  const t0 = performance.now();
  const at = {};
  const phasesSoFar = () => {
    const t = (x) => (x == null ? null : x);
    return { dnsMs: t(at.lookup != null ? Math.round(at.lookup - t0) : null), totalMs: Math.round(performance.now() - t0) };
  };
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      e.phases = phasesSoFar();
      reject(e);
    };
    const body = opts.body == null ? null : Buffer.from(opts.body);
    const headers = { 'accept-encoding': 'gzip, deflate, br', connection: 'close', ...(opts.headers || {}) };
    if (body && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-length')) headers['content-length'] = body.length;
    const req = (secure ? https : http).request({
      protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || (secure ? 443 : 80), path: `${u.pathname}${u.search}`,
      method: opts.method || 'GET', headers, agent: false,
      ...(opts.guard ? { lookup: guardedLookup } : {}),
      ...(opts.family ? { family: opts.family } : {}),
      ...(secure && opts.insecure ? { rejectUnauthorized: false } : {}),
      ...(secure ? { servername: /^[\d.]+$|:/.test(u.hostname) ? undefined : u.hostname } : {}),
    });
    const timer = setTimeout(() => fail(Object.assign(new Error('timeout'), { name: 'TimeoutError', code: 'ETIMEDOUT' })), opts.timeoutMs || 30000);
    let ip = null, tlsInfo = null;
    req.on('socket', (socket) => {
      socket.on('lookup', (err, address) => { at.lookup = performance.now(); ip = address || ip; });
      socket.on('connect', () => { at.connect = performance.now(); ip = socket.remoteAddress || ip; });
      socket.on('secureConnect', () => {
        at.secure = performance.now();
        const c = socket.getPeerCertificate();
        tlsInfo = {
          protocol: socket.getProtocol(),
          authorized: socket.authorized,
          authorizationError: socket.authorized ? null : String(socket.authorizationError || ''),
          cert: c && c.valid_to ? { expiresAt: Date.parse(c.valid_to), issuer: (c.issuer && (c.issuer.O || c.issuer.CN)) || null, names: String(c.subjectaltname || '').split(',').map((x) => x.trim().replace(/^DNS:/, '')).filter(Boolean) } : null,
        };
      });
    });
    req.on('error', fail);
    req.on('response', (res) => {
      at.response = performance.now();
      // decompression, bounded: a compression bomb stops at MAX_BODY like any other body
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      if (stream !== res) stream.on('error', (e) => fail(Object.assign(e, { code: e.code || 'EDECOMPRESS' })));
      const chunks = [];
      let size = 0, truncated = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        at.end = performance.now();
        const rel = (x, from) => Math.max(0, Math.round(x - from));
        const lookup = at.lookup ?? t0; // an IP literal has no lookup
        const connect = at.connect ?? at.response;
        const afterConn = at.secure ?? connect;
        const phases = {
          dnsMs: rel(lookup, t0),
          tcpMs: rel(connect, lookup),
          tlsMs: at.secure != null ? rel(at.secure, connect) : 0,
          waitMs: rel(at.response, afterConn),
          downloadMs: rel(at.end, at.response),
          totalMs: Math.round(at.end - t0),
        };
        const buf = Buffer.concat(chunks);
        const headersOut = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), v]));
        resolve({ status: res.statusCode, headers: headersOut, body: buf, bytes: size, truncated, phases, ip, tls: tlsInfo, ms: phases.totalMs, ttfbMs: Math.round(at.response - t0) });
      };
      if (opts.readBody === false || (opts.method || 'GET') === 'HEAD') {
        res.resume();
        res.on('end', finish);
        res.on('error', fail);
        return;
      }
      stream.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          if (!truncated) {
            truncated = true;
            chunks.push(c.subarray(0, c.length - (size - MAX_BODY)));
          }
          // enough: stop downloading, the part read is what the assertions see
          res.destroy();
          stream.destroy?.();
          finish();
          return;
        }
        chunks.push(c);
      });
      stream.on('end', finish);
      // a connection that closes before the end of the body is an error, not a short page
      stream.on('close', () => (res.complete || truncated ? finish() : fail(Object.assign(new Error('connessione interrotta'), { code: 'ECONNRESET' }))));
      res.on('error', (e) => (truncated ? finish() : fail(e)));
    });
    if (body) req.write(body);
    req.end();
  });
}

/** Header values as one string (several values of the same header joined). */
export const headerText = (v) => (Array.isArray(v) ? v.join(', ') : v);

/** Headers of a response, with sensitive values masked (RF-RIS-21). */
export const maskHeaders = (headers) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, SENSITIVE.test(k) ? '••••••' : headerText(v)]));
