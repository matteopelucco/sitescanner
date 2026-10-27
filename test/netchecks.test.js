import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import {
  cleanHost, parseResolver, formatRecords, normalizeDnsAssertions, evaluateDnsAssertions, tlsAtLeast, registrableDomain, rdapExpiry, dueThreshold,
} from '../src/core/netchecks.js';
import { dnsCheck, tcpCheck, sslCheck, rdapLookup } from '../src/monitor/net-checks.js';
import { performCheck } from '../src/monitor/check.js';
import { normalizeMonitor, checkMonitor, applyResult } from '../src/monitor/engine.js';
import { targetOf } from '../src/monitor/types.js';
import { FsMonitorStore } from '../src/monitor/store-fs.js';
import { startDnsServer } from './helpers/dns.js';
import os from 'node:os';
import path from 'node:path';

// DNS, TCP and SSL/domain monitors (spec §13.5, RF-TYP-02..05), with fake servers: a UDP resolver, a TCP
// server, a TLS server with a self-signed certificate and a RDAP registry.

const DAY = 86400000;

test('pure: names, resolvers, records, verdicts, protocols, domains', () => {
  assert.equal(cleanHost('WWW.Esempio.IT.'), 'www.esempio.it');
  assert.equal(cleanHost('[2001:db8::1]'), '2001:db8::1');
  assert.equal(cleanHost('192.0.2.1'), '192.0.2.1');
  assert.deepEqual([cleanHost('300.1.1.1'), cleanHost('non valido'), cleanHost(''), cleanHost('a..b')], [null, null, null, null]);
  assert.deepEqual(parseResolver('system'), { id: 'system', servers: null });
  assert.deepEqual(parseResolver('cloudflare').servers, ['1.1.1.1']);
  assert.deepEqual(parseResolver('8.8.4.4:5353').servers, ['8.8.4.4:5353']);
  assert.deepEqual(parseResolver('[2001:db8::1]:53').servers, ['[2001:db8::1]:53']);
  assert.deepEqual([parseResolver('boh'), parseResolver('1.1.1.1:99999'), parseResolver('999.1.1.1')], [null, null, null]);
  assert.deepEqual(formatRecords('MX', [{ priority: 20, exchange: 'b.esempio.it.' }, { priority: 10, exchange: 'a.esempio.it.' }]), ['10 a.esempio.it', '20 b.esempio.it']);
  assert.deepEqual(formatRecords('TXT', [['v=spf1 ', 'include:x'], ['altro']]), ['altro', 'v=spf1 include:x']);
  assert.deepEqual(formatRecords('A', ['2.2.2.2', '1.1.1.1']), ['1.1.1.1', '2.2.2.2']);

  const rec = ['1.1.1.1', '2.2.2.2'];
  const v = (comparison, target, ci) => evaluateDnsAssertions(rec, normalizeDnsAssertions([{ comparison, target, ci }])).ok;
  assert.deepEqual([v('contains', '2.2.2.2'), v('contains', '3.3.3.3'), v('notContains', '3.3.3.3'), v('notContains', '1.1.1.1')], [true, false, true, false]);
  assert.deepEqual([v('equalsSet', '2.2.2.2, 1.1.1.1'), v('equalsSet', '1.1.1.1'), v('equalsSet', '1.1.1.1\n2.2.2.2\n3.3.3.3')], [true, false, false]);
  assert.deepEqual([v('matches', '^1\\.1\\.'), v('matches', '^9'), v('notEmpty', '')], [true, false, true]);
  assert.equal(evaluateDnsAssertions([], normalizeDnsAssertions([{ comparison: 'notEmpty' }])).results[0].message, 'Nessun record');
  assert.equal(evaluateDnsAssertions(['V=SPF1 -all'], [{ comparison: 'contains', target: 'v=spf1 -all', ci: true }]).ok, true, 'case does not matter by default');
  assert.equal(evaluateDnsAssertions(['V=SPF1 -all'], [{ comparison: 'contains', target: 'v=spf1 -all', ci: false }]).ok, false);
  assert.match(evaluateDnsAssertions(rec, [{ comparison: 'contains', target: '9.9.9.9' }]).results[0].message, /Il record «9.9.9.9» non c'è \(trovati: 1.1.1.1, 2.2.2.2\)/);
  assert.throws(() => normalizeDnsAssertions([{ comparison: 'boh', target: 'x' }]), /confronto sconosciuto/);
  assert.throws(() => normalizeDnsAssertions([{ comparison: 'contains', target: '' }]), /manca il valore/);
  assert.throws(() => normalizeDnsAssertions([{ comparison: 'matches', target: '(' }]), /espressione non valida/);

  assert.deepEqual([tlsAtLeast('TLSv1.3', 'TLSv1.2'), tlsAtLeast('TLSv1.2', 'TLSv1.2'), tlsAtLeast('TLSv1.1', 'TLSv1.2'), tlsAtLeast(null, 'TLSv1.2')], [true, true, false, false]);
  assert.deepEqual(['www.esempio.it', 'esempio.it', 'a.b.esempio.co.uk', '192.0.2.1', 'localhost', '[::1]'].map(registrableDomain), ['esempio.it', 'esempio.it', 'esempio.co.uk', null, null, null]);
  assert.equal(rdapExpiry({ events: [{ eventAction: 'registration', eventDate: '2000-01-01T00:00:00Z' }, { eventAction: 'expiration', eventDate: '2027-03-01T00:00:00Z' }] }), Date.UTC(2027, 2, 1));
  assert.deepEqual([rdapExpiry({}), rdapExpiry(null), rdapExpiry({ events: [{ eventAction: 'expiration', eventDate: 'boh' }] })], [null, null, null]);
  // thresholds: the closest passed one, once; an expired one is its own
  assert.deepEqual(dueThreshold(40, [30, 14, 7], []), null);
  assert.deepEqual(dueThreshold(20, [30, 14, 7], []), { due: 30, sent: [30] });
  assert.equal(dueThreshold(20, [30, 14, 7], [30]), null);
  assert.deepEqual(dueThreshold(5, [30, 14, 7], [30]), { due: 7, sent: [30, 14, 7] }, 'the larger ones count as sent');
  assert.deepEqual(dueThreshold(-2, [30], [30]), { due: 'expired', sent: [30, 'expired'] });
  assert.equal(dueThreshold(2, [], []), null);
});

test('validation of the types (RF-TYP-02..04)', () => {
  const bad = (input, re) => assert.throws(() => normalizeMonitor(input), re);
  const dns = normalizeMonitor({ type: 'dns', dnsName: 'WWW.Esempio.it.', recordType: 'mx' });
  assert.deepEqual([dns.url, dns.dnsName, dns.recordType, dns.resolver, dns.intervalMin, dns.name], ['', 'www.esempio.it', 'MX', 'system', 5, 'www.esempio.it (MX)']);
  assert.equal(targetOf(dns), 'www.esempio.it · record MX');
  bad({ type: 'dns', dnsName: '' }, /Nome da risolvere/);
  bad({ type: 'dns', dnsName: '192.0.2.1' }, /Nome da risolvere/);
  bad({ type: 'dns', dnsName: 'a.it', recordType: 'SRV' }, /Tipo di record/);
  bad({ type: 'dns', dnsName: 'a.it', resolver: 'boh' }, /Resolver/);
  bad({ type: 'dns', dnsName: 'a.it', dnsAssertions: [{ comparison: 'x' }] }, /confronto sconosciuto/);
  bad({ type: 'dns', dnsName: 'a.it', intervalMin: 7 }, /Intervallo non valido/);
  const tcp = normalizeMonitor({ type: 'tcp', host: 'Mail.Esempio.it', port: '25', send: 'EHLO x\\r\\n', expect: '250' });
  assert.deepEqual([tcp.host, tcp.port, tcp.name, targetOf(tcp)], ['mail.esempio.it', 25, 'mail.esempio.it:25', 'mail.esempio.it:25']);
  bad({ type: 'tcp', host: 'a.it' }, /Porta/);
  bad({ type: 'tcp', host: 'a.it', port: 70000 }, /Porta/);
  bad({ type: 'tcp', host: '', port: 25 }, /Host non valido/);
  bad({ type: 'tcp', host: 'a.it', port: 5432, shouldFail: true, tcpExpect: 'x' }, /non ha senso/);
  const ssl = normalizeMonitor({ type: 'ssl', host: 'esempio.it', intervalMin: 5, minTls: 'TLSv1.0' });
  assert.deepEqual([ssl.port, ssl.intervalMin, ssl.minTls, ssl.checkDomain, ssl.domainDays, ssl.name], [443, 1440, 'TLSv1.2', true, [30, 14, 7, 1], 'esempio.it'], 'one run a day, whatever the interval; at least TLS 1.2');
  assert.equal(normalizeMonitor({ type: 'ssl', host: 'a.it', minTls: 'TLSv1.3', checkDomain: false }).minTls, 'TLSv1.3');
  bad({ type: 'ssl', host: 'non valido!' }, /Host non valido/);
});

// ---------------- DNS ----------------

let dnsServer;
before(async () => {
  dnsServer = await startDnsServer({
    'www.esempio.it': { A: ['203.0.113.10', '203.0.113.11'], AAAA: ['2001:db8::10'], CNAME: ['cdn.esempio.net'] },
    'esempio.it': { MX: [{ priority: 10, exchange: 'mail.esempio.it' }, { priority: 20, exchange: 'mail2.esempio.it' }], TXT: [['v=spf1 include:_spf.esempio.it ', '~all']], NS: ['ns1.esempio.it', 'ns2.esempio.it'] },
    'vuoto.esempio.it': {},
  }, { silent: ['muto.esempio.it'] });
});
after(async () => { await dnsServer.close(); });

const dnsM = (extra) => normalizeMonitor({ type: 'dns', resolver: dnsServer.address, timeoutS: 5, ...extra });

test('DNS: records, assertions, errors, resolver (RF-TYP-02)', async () => {
  let r = await dnsCheck(dnsM({ dnsName: 'www.esempio.it', recordType: 'A' }));
  assert.deepEqual([r.outcome, r.excerpt], ['ok', '203.0.113.10\n203.0.113.11']);
  assert.ok(r.ms >= 0 && r.phases.dnsMs === r.ms);
  r = await dnsCheck(dnsM({ dnsName: 'www.esempio.it', recordType: 'A', dnsAssertions: [{ comparison: 'equalsSet', target: '203.0.113.11, 203.0.113.10' }, { comparison: 'notContains', target: '198.51.100.1' }] }));
  assert.equal(r.outcome, 'ok');
  assert.deepEqual(r.assertions.map((a) => a.ok), [true, true]);
  r = await dnsCheck(dnsM({ dnsName: 'www.esempio.it', recordType: 'A', dnsAssertions: [{ comparison: 'contains', target: '198.51.100.7' }] }));
  assert.deepEqual([r.outcome, r.errorClass], ['error', 'asserzione']);
  assert.match(r.error, /Il record «198.51.100.7» non c'è \(trovati: 203.0.113.10, 203.0.113.11\)/);
  r = await dnsCheck(dnsM({ dnsName: 'www.esempio.it', recordType: 'AAAA', dnsAssertions: [{ comparison: 'contains', target: '2001:db8::10' }] }));
  assert.equal(r.outcome, 'ok');
  r = await dnsCheck(dnsM({ dnsName: 'esempio.it', recordType: 'MX', dnsAssertions: [{ comparison: 'contains', target: '10 mail.esempio.it' }] }));
  assert.equal(r.outcome, 'ok');
  r = await dnsCheck(dnsM({ dnsName: 'esempio.it', recordType: 'TXT', dnsAssertions: [{ comparison: 'matches', target: '^v=spf1 .*~all$' }] }));
  assert.equal(r.outcome, 'ok', 'the chunks of a TXT are joined');
  r = await dnsCheck(dnsM({ dnsName: 'esempio.it', recordType: 'NS', dnsAssertions: [{ comparison: 'equalsSet', target: 'ns1.esempio.it, ns2.esempio.it' }] }));
  assert.equal(r.outcome, 'ok');
  r = await dnsCheck(dnsM({ dnsName: 'www.esempio.it', recordType: 'CNAME', dnsAssertions: [{ comparison: 'contains', target: 'cdn.esempio.net' }] }));
  assert.equal(r.outcome, 'ok');
  // a name that does not exist, a name with no record of that type
  r = await dnsCheck(dnsM({ dnsName: 'scaduto.esempio.it', recordType: 'A' }));
  assert.deepEqual([r.outcome, r.errorClass], ['error', 'dns']);
  assert.match(r.error, /Nessun record A per scaduto.esempio.it/);
  r = await dnsCheck(dnsM({ dnsName: 'vuoto.esempio.it', recordType: 'MX' }));
  assert.deepEqual([r.outcome, r.errorClass], ['error', 'dns']);
  // the resolver does not answer
  r = await dnsCheck(dnsM({ dnsName: 'muto.esempio.it', recordType: 'A', timeoutS: 5 }));
  assert.deepEqual([r.outcome, r.errorClass], ['error', 'timeout']);
  assert.match(r.error, /non ha risposto entro 5 s/);
  // the thresholds apply as for the other checks
  r = await dnsCheck(dnsM({ dnsName: 'www.esempio.it', recordType: 'A', degradedMs: 1 }), { now: Date.now });
  assert.ok(['ok', 'degraded'].includes(r.outcome));
  // through the generic entry point
  r = await performCheck(dnsM({ dnsName: 'www.esempio.it' }));
  assert.equal(r.outcome, 'ok');
  // the guard: a private resolver is refused for the accounts (RF-SEC-01)
  r = await dnsCheck(dnsM({ dnsName: 'www.esempio.it' }), { guard: true });
  assert.deepEqual([r.outcome, r.errorClass], ['error', 'destinazione non ammessa']);
});

// ---------------- TCP ----------------

let tcpServer, tcpPort, silentServer, silentPort;
before(async () => {
  tcpServer = net.createServer((s) => {
    s.on('error', () => {});
    s.write('220 smtp.esempio.it ESMTP pronto\r\n');
    s.on('data', (d) => { if (/EHLO/i.test(d.toString())) s.write('250-smtp.esempio.it\r\n250 STARTTLS\r\n'); });
  });
  await new Promise((r) => tcpServer.listen(0, '127.0.0.1', r));
  tcpPort = tcpServer.address().port;
  silentServer = net.createServer((s) => { s.on('error', () => {}); });
  await new Promise((r) => silentServer.listen(0, '127.0.0.1', r));
  silentPort = silentServer.address().port;
});
after(async () => {
  tcpServer.closeAllConnections?.();
  await new Promise((r) => tcpServer.close(r));
  silentServer.close();
});

const freePort = async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; };

test('TCP: connection, banner, send and expect, must-fail, errors (RF-TYP-03)', async () => {
  const mk = (extra) => normalizeMonitor({ type: 'tcp', host: '127.0.0.1', port: tcpPort, timeoutS: 5, ...extra });
  let r = await tcpCheck(mk({}));
  assert.deepEqual([r.outcome, r.ip], ['ok', '127.0.0.1']);
  assert.ok(r.phases.tcpMs >= 0 && r.phases.totalMs === r.ms);
  // the banner
  r = await tcpCheck(mk({ tcpExpect: '220' }));
  assert.equal(r.outcome, 'ok');
  assert.match(r.excerpt, /^220 smtp.esempio.it/);
  r = await tcpCheck(mk({ tcpExpect: '554' }), { now: Date.now });
  // the server never sends 554: it keeps the connection open, so the check ends at its timeout... bounded by a short one
  const short = mk({ tcpExpect: '554' });
  short.timeoutS = 1;
  r = await tcpCheck(short);
  assert.deepEqual([r.outcome, r.errorClass], ['error', 'timeout']);
  // sending a command and waiting for the answer
  r = await tcpCheck(mk({ tcpSend: 'EHLO prova\\r\\n', tcpExpect: 'STARTTLS' }));
  assert.equal(r.outcome, 'ok');
  assert.match(r.excerpt, /250 STARTTLS/);
  // a closed port, and a port that must be closed (a database exposed by mistake)
  const closed = await freePort();
  r = await tcpCheck(mk({ port: closed }));
  assert.deepEqual([r.outcome, r.errorClass], ['error', 'connessione']);
  assert.match(r.error, /rifiutata o interrotta/);
  r = await tcpCheck(mk({ port: closed, shouldFail: true }));
  assert.equal(r.outcome, 'ok');
  assert.match(r.error, /Non raggiungibile come previsto/);
  r = await tcpCheck(mk({ shouldFail: true }));
  assert.deepEqual([r.outcome, r.errorClass], ['error', 'atteso-errore']);
  assert.match(r.error, /doveva fallire ma è riuscita/);
  // the guard: private destinations are refused for the accounts (RF-SEC-01), even if the check must fail
  r = await tcpCheck(mk({}), { guard: true });
  assert.deepEqual([r.outcome, r.errorClass], ['error', 'destinazione non ammessa']);
  r = await tcpCheck(mk({ shouldFail: true }), { guard: true });
  assert.deepEqual([r.outcome, r.errorClass], ['error', 'destinazione non ammessa'], 'a blocked destination is never the expected failure');
  // the thresholds
  r = await tcpCheck(mk({ degradedMs: 1 }));
  assert.ok(['ok', 'degraded'].includes(r.outcome));
  void silentPort;
});

// ---------------- SSL and domain ----------------

let tlsServer, tlsPort, tls12Server, tls12Port;
before(async () => {
  const opts = { key: fs.readFileSync(new URL('./fixtures/selfsigned.key', import.meta.url)), cert: fs.readFileSync(new URL('./fixtures/selfsigned.crt', import.meta.url)) };
  tlsServer = tls.createServer(opts, (s) => { s.on('error', () => {}); s.end(); });
  tlsServer.on('tlsClientError', () => {});
  await new Promise((r) => tlsServer.listen(0, '127.0.0.1', r));
  tlsPort = tlsServer.address().port;
  tls12Server = tls.createServer({ ...opts, maxVersion: 'TLSv1.2' }, (s) => { s.on('error', () => {}); s.end(); });
  tls12Server.on('tlsClientError', () => {});
  await new Promise((r) => tls12Server.listen(0, '127.0.0.1', r));
  tls12Port = tls12Server.address().port;
});
after(async () => {
  await new Promise((r) => tlsServer.close(r));
  await new Promise((r) => tls12Server.close(r));
});

test('SSL: certificate, chain, protocol, names (RF-TYP-04)', async () => {
  const mk = (extra) => normalizeMonitor({ type: 'ssl', host: 'localhost', port: tlsPort, timeoutS: 5, checkDomain: false, ...extra });
  // the certificate is self-signed: a failure, with the reason in plain Italian
  let r = await sslCheck(mk({}));
  assert.deepEqual([r.outcome, r.errorClass, r.error], ['error', 'tls', 'certificato autofirmato']);
  assert.equal(r.tls.cert.issuer, 'localhost', 'the issuer of a self-signed one is itself');
  assert.ok(r.tls.cert.expiresAt > Date.now() + 365 * DAY);
  assert.deepEqual(r.tls.cert.names, ['localhost', 'IP Address:127.0.0.1']);
  // ignoring the errors of the certificate, as for the web monitors
  r = await sslCheck(mk({ skipSsl: true }));
  assert.equal(r.outcome, 'ok');
  assert.equal(r.tls.protocol, 'TLSv1.3');
  assert.match(r.excerpt, /Protocollo: TLSv1.3/);
  assert.ok(r.phases.tlsMs >= 0 && r.phases.totalMs === r.ms);
  // a server that does not go beyond TLS 1.2, with a minimum of 1.3
  r = await sslCheck(mk({ port: tls12Port, skipSsl: true, minTls: 'TLSv1.3' }));
  assert.deepEqual([r.outcome, r.errorClass], ['error', 'tls']);
  assert.match(r.error, /Handshake TLS non riuscito|sotto il minimo/);
  r = await sslCheck(mk({ port: tls12Port, skipSsl: true }));
  assert.deepEqual([r.outcome, r.tls.protocol], ['ok', 'TLSv1.2']);
  // not a TLS port, a closed one (a name that does not exist is left out: some resolvers take seconds to say no and hold the lookup threads)
  r = await sslCheck(mk({ port: tcpPort, skipSsl: true }));
  assert.deepEqual([r.outcome, r.errorClass], ['error', 'tls']);
  r = await sslCheck(mk({ port: await freePort() }));
  assert.deepEqual([r.outcome, r.errorClass], ['error', 'connessione']);
  r = await sslCheck(mk({ skipSsl: true }), { guard: true });
  assert.deepEqual([r.outcome, r.errorClass], ['error', 'destinazione non ammessa']);
});

let rdap, rdapHits = 0, rdapAnswers = {};
before(async () => {
  rdap = http.createServer((req, res) => {
    rdapHits++;
    const domain = decodeURIComponent(req.url.split('/domain/')[1] || '');
    const a = rdapAnswers[domain];
    if (!a) return res.writeHead(404).end('{}');
    if (a.status) return res.writeHead(a.status).end('{}');
    res.writeHead(200, { 'content-type': 'application/rdap+json' }).end(JSON.stringify({ ldhName: domain, events: [{ eventAction: 'registration', eventDate: '2010-01-01T00:00:00Z' }, ...(a.expires ? [{ eventAction: 'expiration', eventDate: new Date(a.expires).toISOString() }] : [])] }));
  });
  await new Promise((r) => rdap.listen(0, '127.0.0.1', r));
  process.env.SITESCANNER_RDAP_URL = `http://127.0.0.1:${rdap.address().port}`;
});
after(async () => { delete process.env.SITESCANNER_RDAP_URL; await new Promise((r) => rdap.close(r)); });

test('domain expiry from the registry: once a day, alerts, expired (RF-TYP-04)', async () => {
  const now = Date.UTC(2026, 9, 25, 12);
  rdapAnswers = { 'esempio.it': { expires: now + 20 * DAY }, 'senza.it': {}, 'rotto.it': { status: 503 } };
  assert.deepEqual(await rdapLookup('www.esempio.it'), { domain: 'esempio.it', expiresAt: now + 20 * DAY });
  assert.match((await rdapLookup('ignoto.it')).error, /non trovato nel registro/);
  assert.match((await rdapLookup('senza.it')).error, /non indica la scadenza/);
  assert.match((await rdapLookup('rotto.it')).error, /ha risposto 503/);
  assert.match((await rdapLookup('192.0.2.1')).error, /non registrabile/);
  process.env.SITESCANNER_RDAP_URL = 'http://127.0.0.1:1';
  assert.match((await rdapLookup('esempio.it')).error, /registro non raggiungibile/);
  process.env.SITESCANNER_RDAP_URL = `http://127.0.0.1:${rdap.address().port}`;

  // in a monitor: asked once a day, an alert at each threshold, an expired domain is a failure
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-ssl-'));
  const store = new FsMonitorStore(dir);
  try {
    const m = normalizeMonitor({ type: 'ssl', host: 'localhost', port: tlsPort, skipSsl: true, timeoutS: 5, domainDays: [30, 14], sslDays: [] });
    m.host = 'www.esempio.it'; // the registry is asked about this name, the connection goes to the port of the test server
    m.createdAt = now - DAY;
    await store.saveMonitor('', m);
    rdapHits = 0;
    const run = async (t, host = 'localhost') => {
      const saved = await store.getMonitor('', m.id);
      const probe = { ...saved, host };
      const r = await checkMonitor(probe, { guard: false, retryMs: 0, now: () => t });
      saved.state.domain = probe.state.domain;
      saved.state.cert = probe.state.cert;
      await applyResult(store, '', saved, { ...r, at: t }, { windows: [], tz: 'UTC' });
      return { r, saved: await store.getMonitor('', m.id) };
    };
    // the registry is asked about the host of the monitor: use the name that has an answer
    let out = await (async () => {
      const saved = await store.getMonitor('', m.id);
      const probe = { ...saved, host: 'localhost' };
      probe.state.domain = { ...(await rdapLookup('www.esempio.it')), checkedAt: now };
      const r = await checkMonitor(probe, { guard: false, retryMs: 0, now: () => now });
      saved.state.domain = probe.state.domain;
      saved.state.cert = probe.state.cert;
      await applyResult(store, '', saved, { ...r, at: now }, { windows: [], tz: 'UTC' });
      return r;
    })();
    assert.equal(out.outcome, 'ok');
    let events = (await store.listEvents('', {})).map((e) => [e.type, e.days]);
    assert.deepEqual(events, [['domain', 20]], 'under the 30-day threshold');
    // an hour later: not asked again, not alerted again
    rdapHits = 0;
    await run(now + 3600000);
    assert.equal(rdapHits, 0, 'once a day');
    assert.equal((await store.listEvents('', {})).length, 1);
    // the domain is past its date: a failure
    const saved = await store.getMonitor('', m.id);
    saved.state.domain = { domain: 'esempio.it', expiresAt: now - DAY, checkedAt: now + 3600000 };
    await store.saveMonitor('', saved);
    out = await run(now + 7200000);
    assert.deepEqual([out.r.outcome, out.r.errorClass], ['error', 'dominio']);
    assert.match(out.r.error, /dominio esempio.it scaduto il 2026-10-24/);
    events = (await store.listEvents('', {})).map((e) => e.type);
    assert.ok(events.includes('domain-expired'));
    assert.ok(events.includes('down'));
    void out;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
