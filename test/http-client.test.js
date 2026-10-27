import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { request } from '../src/monitor/http-client.js';
import { performCheck } from '../src/monitor/check.js';
import { normalizeMonitor } from '../src/monitor/engine.js';

// The HTTP client of the monitors and the API checks (spec §13.3/§13.4, RF-RIS-20, RF-AST-04, RNF-43).

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
let srv, base, tls, tlsBase, lastRequest;

before(async () => {
  srv = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    lastRequest = { method: req.method, url: req.url, headers: req.headers, body };
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/slow') {
      // 80 ms before the first byte, then the body in two parts 60 ms apart
      return setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('prima ');
        setTimeout(() => res.end('seconda'), 60);
      }, 80);
    }
    if (u.pathname === '/gzip') return res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' }).end(zlib.gzipSync('testo compresso'));
    if (u.pathname === '/br') return res.writeHead(200, { 'content-encoding': 'br' }).end(zlib.brotliCompressSync('brotli ok'));
    if (u.pathname === '/redirect') return res.writeHead(u.searchParams.get('code') ? Number(u.searchParams.get('code')) : 302, { location: '/echo' }).end();
    if (u.pathname === '/echo') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ method: req.method, body }));
    if (u.pathname === '/big') return res.writeHead(200).end('x'.repeat(3 * 1024 * 1024));
    if (u.pathname === '/cut') {
      // announces 1000 bytes, sends 10 and closes
      res.writeHead(200, { 'content-length': '1000' });
      res.write('0123456789');
      return setTimeout(() => res.socket.destroy(), 20);
    }
    if (u.pathname === '/hang') return; // never answers
    if (u.pathname === '/cookie') return res.writeHead(200, { 'set-cookie': ['a=1', 'b=2'], 'x-multi': 'uno' }).end('ok');
    if (u.pathname === '/api/items' && req.method === 'POST') {
      const data = JSON.parse(body || '{}');
      if (req.headers.authorization !== 'Bearer t0k3n') return res.writeHead(401, { 'content-type': 'application/json' }).end('{"errore":"non autorizzato"}');
      return res.writeHead(201, { 'content-type': 'application/json', location: '/api/items/7' }).end(JSON.stringify({ id: 7, nome: data.nome, tags: ['nuovo', 'api'], ok: true }));
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<p>ok</p>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  tls = https.createServer({ key: fs.readFileSync(path.join(fixtures, 'selfsigned.key')), cert: fs.readFileSync(path.join(fixtures, 'selfsigned.crt')) }, (req, res) => res.writeHead(200).end('sicuro'));
  await new Promise((r) => tls.listen(0, '127.0.0.1', r));
  tlsBase = `https://127.0.0.1:${tls.address().port}`;
  process.env.SITESCANNER_ALLOW_PRIVATE_NETWORKS = '1';
});

after(async () => {
  delete process.env.SITESCANNER_ALLOW_PRIVATE_NETWORKS;
  srv.closeAllConnections?.();
  await new Promise((r) => srv.close(r));
  await new Promise((r) => tls.close(r));
});

const sumPhases = (p) => p.dnsMs + p.tcpMs + p.tlsMs + p.waitMs + p.downloadMs;

test('phases: wait for the first byte and download are measured apart, and add up to the total (RNF-43)', async () => {
  const r = await request(`${base}/slow`, { timeoutMs: 5000 });
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), 'prima seconda');
  const p = r.phases;
  assert.ok(p.waitMs >= 70 && p.waitMs < 250, `wait ${p.waitMs}`);
  assert.ok(p.downloadMs >= 50 && p.downloadMs < 250, `download ${p.downloadMs}`);
  assert.equal(p.tlsMs, 0, 'plain http has no TLS phase');
  assert.ok(Math.abs(sumPhases(p) - p.totalMs) <= 5, `phases ${sumPhases(p)} vs total ${p.totalMs}`);
  assert.ok(r.ttfbMs >= p.waitMs && r.ttfbMs <= p.totalMs);
  assert.equal(r.ip, '127.0.0.1');
});

test('phases with TLS: handshake, protocol, certificate of the connection', async () => {
  const r = await request(`${tlsBase}/`, { timeoutMs: 5000, insecure: true });
  assert.equal(r.status, 200);
  assert.ok(r.phases.tlsMs >= 0);
  assert.match(r.tls.protocol, /^TLSv1\.[23]$/);
  assert.equal(r.tls.authorized, false, 'self-signed');
  assert.ok(r.tls.cert.expiresAt > Date.now());
  assert.ok(r.tls.cert.names.includes('IP Address:127.0.0.1') || r.tls.cert.names.includes('localhost') || r.tls.cert.names.length);
  assert.ok(Math.abs(sumPhases(r.phases) - r.phases.totalMs) <= 5);
  // the same fails without «insecure»: the error carries the certificate code
  await assert.rejects(request(`${tlsBase}/`, { timeoutMs: 5000 }), (e) => /SELF_SIGNED|DEPTH_ZERO|UNABLE_TO_VERIFY/.test(e.code));
});

test('compressed bodies are decompressed; big bodies are cut at 2 MB', async () => {
  assert.equal((await request(`${base}/gzip`, {})).body.toString(), 'testo compresso');
  assert.equal((await request(`${base}/br`, {})).body.toString(), 'brotli ok');
  const big = await request(`${base}/big`, {});
  assert.equal(big.body.length, 2 * 1024 * 1024);
  assert.equal(big.truncated, true);
  assert.equal(big.status, 200);
});

test('errors: timeout, connection cut in the middle, refused, header values', async () => {
  const t0 = Date.now();
  await assert.rejects(request(`${base}/hang`, { timeoutMs: 150 }), (e) => e.name === 'TimeoutError' && e.code === 'ETIMEDOUT' && typeof e.phases.totalMs === 'number');
  assert.ok(Date.now() - t0 < 1500);
  await assert.rejects(request(`${base}/cut`, { timeoutMs: 3000 }), (e) => e.code === 'ECONNRESET');
  await assert.rejects(request('http://127.0.0.1:1/', { timeoutMs: 3000 }), (e) => e.code === 'ECONNREFUSED');
  const r = await request(`${base}/cookie`, {});
  assert.deepEqual(r.headers['set-cookie'], ['a=1', 'b=2']);
  assert.equal(r.headers['x-multi'], 'uno');
});

test('check: redirects are followed with the phases of the last request and the time of the others (RF-RIS-20)', async () => {
  const m = normalizeMonitor({ url: `${base}/redirect`, assertions: [{ source: 'status', comparison: 'in', target: '200' }, { source: 'json', property: '$.method', comparison: 'equals', target: 'GET' }] });
  const r = await performCheck(m, { guard: false, detail: true });
  assert.equal(r.outcome, 'ok', r.error);
  assert.equal(r.finalUrl, `${base}/echo`);
  assert.deepEqual(r.chain, [{ url: `${base}/redirect`, status: 302 }]);
  assert.ok(r.phases.redirectMs >= 0);
  assert.ok(Math.abs(sumPhases(r.phases) + r.phases.redirectMs - r.phases.totalMs) <= 6, JSON.stringify(r.phases));
  assert.equal(r.phases.totalMs, r.ms);
  assert.deepEqual(r.assertions.map((a) => a.ok), [true, true]);
});

test('API check: POST with a JSON body, headers, assertions on status, header and JSON (RF-AST-04)', async () => {
  const m = normalizeMonitor({
    type: 'api', url: `${base}/api/items`, method: 'POST', bodyType: 'json', body: '{"nome":"Prova"}',
    headers: { authorization: 'Bearer t0k3n' },
    assertions: [
      { source: 'status', comparison: 'equals', target: '201' },
      { source: 'header', property: 'Location', comparison: 'matches', target: '^/api/items/\\d+$' },
      { source: 'json', property: '$.nome', comparison: 'equals', target: 'Prova' },
      { source: 'json', property: '$.tags[*]', comparison: 'contains', target: 'api' },
      { source: 'json', property: '$.ok', comparison: 'equals', target: 'true' },
      { source: 'time', comparison: 'lt', target: '3000' },
    ],
  });
  const r = await performCheck(m, { guard: false, detail: true });
  assert.equal(r.outcome, 'ok', r.error);
  assert.equal(lastRequest.method, 'POST');
  assert.equal(lastRequest.headers['content-type'], 'application/json');
  assert.equal(lastRequest.headers['content-length'], '16');
  assert.equal(lastRequest.body, '{"nome":"Prova"}');
  assert.equal(lastRequest.headers.authorization, 'Bearer t0k3n');
  assert.match(lastRequest.headers['user-agent'], /^sitescanner-monitor\//);
  assert.equal(r.assertions.length, 6);

  // wrong credentials: the first assertion fails with the status, and the others are shown too
  const bad = await performCheck({ ...m, headers: {} }, { guard: false, detail: true });
  assert.equal(bad.outcome, 'error');
  assert.equal(bad.errorClass, 'http');
  assert.equal(bad.error, 'Status 401, atteso 201');
  assert.equal(bad.assertions.filter((a) => !a.ok).length, 5, 'every assertion is evaluated');

  // an assertion on the JSON fails with the value found (RF-AST-03)
  const wrong = await performCheck({ ...m, assertions: [{ source: 'json', property: '$.nome', comparison: 'equals', target: 'Altro' }] }, { guard: false });
  assert.deepEqual([wrong.outcome, wrong.errorClass, wrong.error], ['error', 'asserzione', 'JSON $.nome = "Prova", atteso "Altro"']);

  // text body; redirects after a POST turn into a GET without body
  const text = normalizeMonitor({ type: 'api', url: `${base}/redirect?code=303`, method: 'POST', bodyType: 'text', body: 'ciao', assertions: [{ source: 'json', property: '$.method', comparison: 'equals', target: 'GET' }, { source: 'json', property: '$.body', comparison: 'empty' }] });
  assert.equal((await performCheck(text, { guard: false })).outcome, 'ok');
  const kept = normalizeMonitor({ type: 'api', url: `${base}/redirect?code=307`, method: 'POST', bodyType: 'text', body: 'ciao', assertions: [{ source: 'json', property: '$.method', comparison: 'equals', target: 'POST' }, { source: 'json', property: '$.body', comparison: 'equals', target: 'ciao' }] });
  assert.equal((await performCheck(kept, { guard: false })).outcome, 'ok', '307 keeps method and body');
  assert.equal(lastRequest.headers['content-type'], 'text/plain; charset=utf-8');
});

test('the destination guard applies to every request of a check (RF-SEC-01)', async () => {
  delete process.env.SITESCANNER_ALLOW_PRIVATE_NETWORKS;
  try {
    const r = await performCheck(normalizeMonitor({ url: `${base}/` }), { guard: true });
    assert.deepEqual([r.outcome, r.errorClass], ['error', 'destinazione non ammessa']);
    // a redirect to a private address is blocked as well
    const meta = await performCheck(normalizeMonitor({ url: 'http://169.254.169.254/latest/' }), { guard: true });
    assert.equal(meta.errorClass, 'destinazione non ammessa');
  } finally {
    process.env.SITESCANNER_ALLOW_PRIVATE_NETWORKS = '1';
  }
});

test('validation of the request fields of a monitor', () => {
  const ok = { url: `${base}/` };
  assert.throws(() => normalizeMonitor({ ...ok, method: 'POST' }), /Metodo GET o HEAD/);
  assert.equal(normalizeMonitor({ ...ok, type: 'api', method: 'patch' }).method, 'PATCH');
  assert.throws(() => normalizeMonitor({ ...ok, type: 'api', method: 'TRACE' }), /Metodo: GET, POST/);
  assert.throws(() => normalizeMonitor({ ...ok, type: 'ftp' }), /Tipo di monitor/);
  assert.throws(() => normalizeMonitor({ ...ok, method: 'HEAD', assertions: [{ source: 'body', comparison: 'contains', target: 'x' }] }), /richiedono il metodo GET/);
  assert.throws(() => normalizeMonitor({ ...ok, type: 'api', method: 'POST', bodyType: 'json', body: '{non json' }), /corpo JSON non è valido/);
  assert.throws(() => normalizeMonitor({ ...ok, assertions: [{ source: 'json', property: 'x', comparison: 'equals', target: '1' }] }), /percorso JSON non valido/);
  // defaults: a site must answer 200–399, an API 200–299
  assert.deepEqual(normalizeMonitor(ok).assertions, [{ source: 'status', comparison: 'in', target: '200-399' }]);
  assert.deepEqual(normalizeMonitor({ ...ok, type: 'api' }).assertions, [{ source: 'status', comparison: 'in', target: '200-299' }]);
  // the status list and keyword of the first version become assertions, in the stored monitor too
  const legacy = normalizeMonitor({ ...ok, expect: '200,301', keyword: { text: 'Carrello', mode: 'present', caseInsensitive: true } });
  assert.deepEqual(legacy.assertions, [{ source: 'status', comparison: 'in', target: '200,301' }, { source: 'body', comparison: 'contains', target: 'Carrello', ci: true }]);
  assert.equal('expect' in legacy || 'keyword' in legacy, false);
});
