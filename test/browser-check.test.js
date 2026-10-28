import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromiumAvailable } from './helpers/ui.js';
import { FsMonitorStore } from '../src/monitor/store-fs.js';
import { normalizeMonitor, runRound, monitoringConfig } from '../src/monitor/engine.js';
import { performCheck } from '../src/monitor/check.js';

// The Browser check (spec §13.14, RF-BRW-01). The validation needs no browser; the checks run in Chromium and are
// skipped, with a message, when it is not available.

const MIN = 60000;
let server, base, skip = false;

const page = (body, head = '') => `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Prova</title>${head}</head><body>${body}</body></html>`;

before(async () => {
  process.env.SITESCANNER_ALLOW_PRIVATE_NETWORKS = '1';
  process.env.SITESCANNER_BROWSER_WAIT_MS = '400'; // an element that is not there is not waited for 5 s
  if (!(await chromiumAvailable())) skip = 'Chromium non disponibile (npx playwright install chromium)';
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x').pathname;
    const html = (b, status = 200) => res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(b);
    if (u === '/ok') return html(page('<h1>Benvenuto</h1><div id="app">contenuto</div><p>Prenota ora</p>'));
    if (u === '/no-element') return html(page('<h1>Benvenuto</h1><p>nessun app</p>'));
    if (u === '/no-text') return html(page('<h1>Benvenuto</h1><div id="app"></div>'));
    if (u === '/hidden-text') return html(page('<h1>Benvenuto</h1><p style="display:none">Prenota ora</p>'));
    if (u === '/js-error') return html(page('<h1>Benvenuto</h1><div id="app">x</div><script>null.boom()</script>'));
    if (u === '/console-error') return html(page('<h1>Benvenuto</h1><script>console.error("rotto")</script>'));
    if (u === '/slow-script') return html(page('<h1>Lento</h1><script src="/slow.js"></script>'));
    if (u === '/slow.js') return setTimeout(() => res.writeHead(200, { 'content-type': 'text/javascript' }).end('1'), 700);
    if (u === '/500') return html(page('<h1>Errore</h1>'), 500);
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const browser = (extra = {}) => normalizeMonitor({ type: 'browser', url: `${base}/ok`, intervalMin: 15, timeoutS: 20, ...extra });

test('validation: a Browser check runs at most every 15 minutes and has its own fields (RF-BRW-01)', () => {
  const m = browser({ waitSelector: ' #app ', waitText: 'Prenota ora' });
  assert.equal(m.type, 'browser');
  assert.equal(m.waitSelector, '#app');
  assert.equal(m.failOnJsErrors, true);
  assert.deepEqual(m.assertions, []);
  assert.equal(m.name, new URL(base).host);
  assert.equal(browser({ failOnJsErrors: false }).failOnJsErrors, false);
  for (const intervalMin of [5, 10, 14]) assert.throws(() => browser({ intervalMin }), /15 minuti/, `${intervalMin} min`);
  assert.throws(() => normalizeMonitor({ type: 'browser', url: 'ftp://x', intervalMin: 15 }), /http o https/);
  assert.throws(() => normalizeMonitor({ type: 'browser', url: '', intervalMin: 15 }), /URL non valido/);
  assert.throws(() => browser({ waitText: 'x'.repeat(201) }), /200 caratteri/);
  // a reference to a variable is kept as written, like for the other types
  assert.equal(normalizeMonitor({ type: 'browser', url: 'https://{{HOST}}/', intervalMin: 30 }).url, 'https://{{HOST}}/');
});

test('page that loads, with its element and its text: ok, with the timings (RF-BRW-01)', async (t) => {
  if (skip) return t.skip(skip);
  const r = await performCheck(browser({ waitSelector: '#app', waitText: 'Prenota ora' }), { detail: true });
  assert.equal(r.outcome, 'ok', r.error);
  assert.equal(r.status, 200);
  assert.ok(r.ms > 0 && r.browser.loadMs > 0, 'load time');
  assert.ok(r.browser.lcpMs === null || r.browser.lcpMs >= 0, 'LCP, when the browser reports it');
  assert.equal(r.browser.jsErrorCount, 0);
  assert.deepEqual(r.assertions.map((a) => a.ok), [true, true, true]);
  assert.equal(r.screenshot, undefined, 'no screenshot when everything is fine');
});

test('what fails the check: missing element, missing or hidden text, JavaScript errors, HTTP error (RF-BRW-01)', async (t) => {
  if (skip) return t.skip(skip);
  const run = (path, extra) => performCheck(browser({ url: `${base}${path}`, ...extra }), { detail: true });

  let r = await run('/no-element', { waitSelector: '#app' });
  assert.equal(r.outcome, 'error');
  assert.equal(r.errorClass, 'asserzione');
  assert.match(r.error, /Elemento non trovato: #app/);
  assert.equal(r.screenshot.contentType, 'image/jpeg');
  assert.ok(r.screenshot.bytes > 500 && r.screenshot.bytes <= 300 * 1024);
  assert.ok(Buffer.from(r.screenshot.data, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), 'a JPEG');

  r = await run('/no-text', { waitText: 'Prenota ora' });
  assert.equal(r.errorClass, 'asserzione');
  assert.match(r.error, /Testo non visibile: Prenota ora/);
  r = await run('/hidden-text', { waitText: 'Prenota ora' });
  assert.equal(r.outcome, 'error', 'a text that is in the page but not visible does not count');

  r = await run('/js-error', { waitSelector: '#app' });
  assert.equal(r.errorClass, 'javascript');
  assert.match(r.error, /1 errore JavaScript/);
  assert.match(r.browser.jsErrors[0], /null/);
  assert.equal(r.assertions.find((a) => a.text.includes('elemento') || a.text.includes("L'elemento")).ok, true, 'the element was there: only the errors failed');
  r = await run('/console-error');
  assert.equal(r.errorClass, 'javascript', 'console.error counts too');
  r = await run('/js-error', { failOnJsErrors: false });
  assert.equal(r.outcome, 'ok', 'errors are reported but do not fail when the monitor says so');
  assert.equal(r.browser.jsErrorCount, 1);

  r = await run('/500');
  assert.equal(r.errorClass, 'http');
  assert.match(r.error, /HTTP 500/);
  assert.ok(r.screenshot);

  r = await performCheck(browser({ url: 'http://127.0.0.1:1/', timeoutS: 8 }), { detail: true });
  assert.equal(r.outcome, 'error');
  assert.equal(r.errorClass, 'connessione');
});

test('load time: degraded and failed thresholds, as for the other types (RF-RIS-01)', async (t) => {
  if (skip) return t.skip(skip);
  const m = (extra) => browser({ url: `${base}/slow-script`, ...extra });
  let r = await performCheck(m({ degradedMs: 300 }), { detail: true });
  assert.equal(r.outcome, 'degraded');
  r = await performCheck(m({ degradedMs: 200, failedMs: 400 }), { detail: true });
  assert.equal(r.outcome, 'error');
  assert.equal(r.errorClass, 'soglia');
});

test('a destination that is not allowed is refused, as for every type (RF-SEC-01)', async () => {
  const r = await performCheck(browser({ url: 'http://127.0.0.1:9/' }), { guard: true, detail: true });
  assert.equal(r.outcome, 'error');
  assert.equal(r.errorClass, 'destinazione non ammessa');
});

test('a failed round opens the incident with the screenshot, which stays with it (RF-BRW-01, RF-RIS-25)', async (t) => {
  if (skip) return t.skip(skip);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-browser-'));
  try {
    const store = new FsMonitorStore(dir);
    let clock = Date.UTC(2026, 9, 1, 9, 0);
    const config = { ...monitoringConfig(), retryMs: 0, spread: false, canaries: [], heartbeatUrl: null, tz: 'UTC' };
    const mon = browser({ url: `${base}/no-element`, waitSelector: '#app', name: 'Pagina prenotazioni' });
    await store.saveMonitor('', mon);
    await runRound({ store, now: () => clock, config });
    const m = await store.getMonitor('', mon.id);
    assert.equal(m.state.status, 'down');
    const inc = await store.getIncident('', m.state.openIncident);
    assert.equal(inc.cause.class, 'asserzione');
    assert.ok(inc.firstRun.screenshot.data.length > 500, 'the first failed run, with its screenshot, is in the incident');
    assert.equal(inc.firstRun.browser.jsErrorCount, 0);
    const [run] = await store.listChecks('', mon.id, 0, Date.UTC(2027, 0, 1));
    assert.equal(run.screenshot, undefined, 'the list of runs stays light');
    assert.equal(run.hasDetail, true);
    const detail = await store.loadRunDetail('', mon.id, run.id);
    assert.ok(detail.screenshot, 'the detail of the run has it');
    clock += MIN;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
