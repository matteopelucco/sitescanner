import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { reportPeriod, buildReport, reportCsv, reportPrintHtml, isFirstOfMonth, monthKey } from '../src/core/uptimereport.js';
import { FsMonitorStore } from '../src/monitor/store-fs.js';
import { monitorKpis, aggregate } from '../src/monitor/engine.js';
import { sendMonthlyReports } from '../src/monitor/reports.js';
import { chromiumAvailable } from './helpers/ui.js';
import { serve } from '../src/server.js';

// The availability report (spec §13.12, RF-RPT-01..03): the numbers are those of the dashboard, per tag they are weighted,
// the CSV and the PDF carry the same content, the monthly one goes out by email once a month.

const MIN = 60000, DAY = 86400000;

test('periods of the report, in the time zone of the account', () => {
  const now = Date.UTC(2026, 9, 26, 10, 0); // 26 October 2026, Rome
  assert.deepEqual([new Date(reportPeriod('month', now, { tz: 'Europe/Rome' }).from).toISOString(), reportPeriod('month', now, { tz: 'Europe/Rome' }).to], ['2026-09-30T22:00:00.000Z', now], 'midnight of the 1st in Rome is 22:00 of the day before (summer time)');
  const last = reportPeriod('last-month', now, { tz: 'Europe/Rome' });
  assert.deepEqual([new Date(last.from).toISOString(), new Date(last.to).toISOString(), last.label], ['2026-08-31T22:00:00.000Z', '2026-09-30T22:00:00.000Z', 'Settembre 2026']);
  const q = reportPeriod('quarter', now, { tz: 'UTC' });
  assert.deepEqual([new Date(q.from).toISOString(), q.label], ['2026-10-01T00:00:00.000Z', '4° trimestre 2026']);
  assert.equal(reportPeriod('last-month', Date.UTC(2026, 0, 15), { tz: 'UTC' }).label, 'Dicembre 2025', 'across the year');
  const c = reportPeriod('custom', now, { tz: 'UTC', from: '2026-10-01', to: '2026-10-10' });
  assert.deepEqual([new Date(c.from).toISOString(), new Date(c.to).toISOString()], ['2026-10-01T00:00:00.000Z', '2026-10-11T00:00:00.000Z']);
  assert.equal(reportPeriod('custom', now, { tz: 'UTC', from: '2026-10-01', to: '2026-12-31' }).to, now, 'never the future');
  assert.throws(() => reportPeriod('custom', now, { from: '2026-10-10', to: '2026-10-01' }), /Intervallo non valido/);
  assert.throws(() => reportPeriod('custom', now, {}), /Intervallo non valido/);
  assert.throws(() => reportPeriod('boh', now), /Periodo sconosciuto/);
  assert.equal(isFirstOfMonth(Date.UTC(2026, 9, 1, 4), 'Europe/Rome'), true);
  assert.equal(isFirstOfMonth(Date.UTC(2026, 8, 30, 23, 30), 'Europe/Rome'), true, '00:30 of the 1st in Rome is still the 30th in UTC');
  assert.equal(isFirstOfMonth(Date.UTC(2026, 9, 2, 4), 'Europe/Rome'), false);
  assert.equal(monthKey(Date.UTC(2026, 9, 1, 4), 'Europe/Rome'), '2026-10');
});

const kp = (availability, downtimeMs, monitoredMs, extra = {}) => ({ availability, downtimeMs, monitoredMs, incidents: downtimeMs ? 1 : 0, mttrMs: downtimeMs || null, response: availability == null ? null : { avg: 200, p95: 400, p99: 800 }, ...extra });

test('the report: weighted totals per tag, objectives, CSV, printable document', () => {
  const period = { from: Date.UTC(2026, 8, 1), to: Date.UTC(2026, 9, 1), label: 'Settembre 2026' };
  const mons = [
    { id: 'a', name: 'Sito Acme', url: 'https://acme.it/', tags: ['cliente:acme', 'prod'], slaPct: 99.9, kpis: kp(100, 0, 30 * DAY), incidentList: [] },
    { id: 'b', name: 'Shop Acme', url: 'https://shop.acme.it/', tags: ['cliente:acme'], slaPct: 99.9, kpis: kp(99, 0.01 * 10 * DAY, 10 * DAY), incidentList: [{ start: Date.UTC(2026, 8, 3, 10), end: Date.UTC(2026, 8, 3, 12), cause: 'Errore HTTP 503 <script>' }] },
    { id: 'c', name: 'Blog Zeta', url: 'https://zeta.it/', tags: ['cliente:zeta'], slaPct: 99.5, kpis: kp(null, 0, 0, { response: null }), incidentList: [] },
  ];
  const r = buildReport({ monitors: mons, period, maintenance: [{ start: Date.UTC(2026, 8, 10, 2), end: Date.UTC(2026, 8, 10, 3), monitors: ['Sito Acme'] }], tz: 'Europe/Rome', generatedAt: Date.UTC(2026, 9, 1, 5) });
  assert.deepEqual(r.rows.map((x) => [x.name, x.slaMet]), [['Blog Zeta', null], ['Shop Acme', false], ['Sito Acme', true]], 'sorted by name; no data is neither met nor missed');
  // the group is weighted on the time monitored: 0.1 days of downtime in 40 days of monitoring, not (100 + 99) / 2
  const acme = r.tags.find((t) => t.tag === 'cliente:acme');
  assert.deepEqual([acme.monitors, acme.availability, acme.slaMet, acme.slaMissed, acme.incidents], [2, 99.75, 1, 1, 1]);
  assert.equal(r.tags.find((t) => t.tag === 'prod').availability, 100);
  assert.equal(r.tags.find((t) => t.tag === 'cliente:zeta').availability, null);
  assert.deepEqual([r.overall.monitors, r.overall.availability, r.overall.slaMet, r.overall.slaMissed], [3, 99.75, 1, 1]);

  const csv = reportCsv(r);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'monitor,url,tag,da,a,disponibilita,obiettivo,obiettivo_rispettato,downtime_s,incidenti,mttr_s,risposta_media_ms,p95_ms,p99_ms');
  assert.equal(lines[2], 'Shop Acme,https://shop.acme.it/,cliente:acme,2026-09-01,2026-09-30,99.00,99.9,no,8640,1,8640,200,400,800');
  assert.equal(lines[1].split(',')[5], '', 'no data: an empty cell, not 0');
  assert.equal(lines.length, 4);
  assert.equal(reportCsv({ ...r, rows: [{ ...r.rows[0], name: 'Con, virgola "e" virgolette' }] }).split('\r\n')[1].startsWith('"Con, virgola ""e"" virgolette"'), true);

  const html = reportPrintHtml(r, { client: 'Acme <Srl>', version: '9.9' });
  assert.match(html, /@page \{ size: A4/);
  assert.match(html, /<h1>Acme &lt;Srl&gt;<\/h1>/);
  assert.match(html, /Settembre 2026/);
  assert.match(html, /99,75%/);
  assert.equal(html.includes('<script>'), false, 'a cause is text');
  assert.match(html, /Errore HTTP 503 &lt;script&gt;/);
  assert.match(html, /Totali per tag/);
  assert.match(html, /Manutenzioni/);
  assert.match(html, /sitescanner 9\.9/);
  assert.match(reportPrintHtml(buildReport({ monitors: [], period, tz: 'UTC' })), /Nessun incidente nel periodo/);
});

// ---------------- from the data ----------------

let home, server, base, resend, mails = [];
let pdfOk = false;

before(async () => {
  pdfOk = await chromiumAvailable();
  resend = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    mails.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"r1"}');
  });
  await new Promise((r) => resend.listen(0, '127.0.0.1', r));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-rep-'));
  Object.assign(process.env, {
    SITESCANNER_HOME: home, SITESCANNER_ADMIN_USER: 'admin', SITESCANNER_ADMIN_PASSWORD: 'admin-iniziale-123', SITESCANNER_MONITOR_DEV: '1', SITESCANNER_ALLOW_PRIVATE_NETWORKS: '1',
    SITESCANNER_RESEND_URL: `http://127.0.0.1:${resend.address().port}/emails`, RESEND_API_KEY: 're_test', SITESCANNER_EMAIL_FROM: 'report@esempio.it', SITESCANNER_NOTIFY_RETRY_MS: '1,1,1',
  });
  server = await serve({ port: 0, multi: true });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await new Promise((r) => resend.close(r));
  for (const k of ['SITESCANNER_ADMIN_USER', 'SITESCANNER_ADMIN_PASSWORD', 'SITESCANNER_MONITOR_DEV', 'SITESCANNER_ALLOW_PRIVATE_NETWORKS', 'SITESCANNER_RESEND_URL', 'RESEND_API_KEY', 'SITESCANNER_EMAIL_FROM', 'SITESCANNER_NOTIFY_RETRY_MS']) delete process.env[k];
  fs.rmSync(home, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  return async (method, p, body, raw = false) => {
    const res = await fetch(`${base}/api/${p}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    if (raw) return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, data };
  };
}

test('report from the data: the same KPIs as the dashboard, filters, CSV, PDF, monthly email (RF-RPT-01..03)', async () => {
  const admin = client();
  await admin('POST', 'login', { username: 'admin', password: 'admin-iniziale-123' });
  await admin('PUT', 'me/password', { current: 'admin-iniziale-123', password: 'admin-definitiva-12' });
  await admin('POST', 'users', { username: 'rita', password: 'rita-temporanea-1' });
  const rita = client();
  await rita('POST', 'login', { username: 'rita', password: 'rita-temporanea-1' });
  await rita('PUT', 'me/password', { current: 'rita-temporanea-1', password: 'rita-definitiva-12' });

  // two monitors of a client and one of another, with the 2 first days of last month checked every 5 minutes
  const now = Date.now();
  const d = new Date(now);
  const lastMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
  const mk = async (name, tags) => (await rita('POST', 'monitors', { name, url: `https://esempio-${name.toLowerCase().replace(/\W/g, '')}.test/`, tags, slaPct: 99.9 })).data;
  const [sito, shop, blog] = [await mk('Sito', ['cliente:acme']), await mk('Shop', ['cliente:acme']), await mk('Blog', ['cliente:zeta'])];
  const store = new FsMonitorStore(home);
  for (const [mon, outage] of [[sito, 0], [shop, 30], [blog, 0]]) {
    const m = await store.getMonitor('rita', mon.id);
    m.createdAt = lastMonth - DAY;
    for (let t = lastMonth; t < lastMonth + 2 * DAY; t += 5 * MIN) {
      const bad = outage && t >= lastMonth + DAY && t < lastMonth + DAY + outage * MIN;
      await store.addCheck('rita', m.id, bad ? { at: t, outcome: 'error', status: 503, ms: 50, errorClass: 'http', error: 'Errore HTTP 503' } : { at: t, outcome: 'ok', status: 200, ms: 100 + (t / MIN) % 200 });
    }
    if (outage) await store.saveIncident('rita', { id: `inc-${m.id}`, monitorId: m.id, start: lastMonth + DAY, end: lastMonth + DAY + outage * MIN, cause: { message: 'Errore HTTP 503' }, causes: [], notifications: [] });
    m.state.aggregatedUntil = lastMonth - DAY;
    await store.saveMonitor('rita', m);
    await aggregate(store, 'rita', m, { now, windows: [], tz: 'Europe/Rome' });
  }

  // the numbers are those of the KPIs for the same period (RF-KPI-07)
  let r = await rita('GET', 'report?period=last-month');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.rows.length, 3);
  const period = r.data.period;
  const fresh = await store.getMonitor('rita', shop.id);
  const kpis = await monitorKpis(store, 'rita', fresh, { from: period.from, to: period.to, now, windows: [], tz: 'Europe/Rome' });
  const row = r.data.rows.find((x) => x.name === 'Shop');
  assert.deepEqual([row.availability, row.downtimeMs, row.incidents, row.avgMs, row.p95Ms], [kpis.availability, kpis.downtimeMs, kpis.incidents, kpis.response.avg, kpis.response.p95]);
  assert.equal(row.downtimeMs, 30 * MIN);
  assert.equal(row.slaMet, false);
  assert.equal(r.data.rows.find((x) => x.name === 'Sito').availability, 100);
  assert.equal(row.incidentList[0].cause, 'Errore HTTP 503');
  // totals per tag, weighted
  const acme = r.data.tags.find((t) => t.tag === 'cliente:acme');
  assert.deepEqual([acme.monitors, acme.downtimeMs, acme.incidents, acme.availability], [2, 30 * MIN, 1, Math.floor((1 - (30 * MIN) / (acme.monitoredMs)) * 10000) / 100]);
  // filters: a tag (a namespace takes all its tags), a text, a period
  assert.deepEqual((await rita('GET', 'report?period=last-month&tag=cliente:zeta')).data.rows.map((x) => x.name), ['Blog']);
  assert.deepEqual((await rita('GET', 'report?period=last-month&tag=cliente')).data.rows.length, 3);
  assert.deepEqual((await rita('GET', 'report?period=last-month&q=shop')).data.rows.map((x) => x.name), ['Shop']);
  assert.equal((await rita('GET', 'report?period=month')).data.rows.length, 3, 'the current month: the monitors exist, with no data yet');
  assert.equal((await rita('GET', 'report?period=custom&from=2026-02-10&to=2026-01-01')).status, 400);
  assert.equal((await rita('GET', 'report?period=boh')).status, 400);
  assert.equal((await admin('GET', 'report?period=last-month')).data.rows.length, 0, 'another user sees nothing');

  // CSV
  const csv = await rita('GET', 'report.csv?period=last-month&tag=cliente:acme', undefined, true);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const text = csv.buf.toString('utf8');
  assert.equal(text.charCodeAt(0), 0xfeff, 'with the mark that Excel needs to read the accents');
  assert.equal(text.split('\r\n').length, 3);
  assert.match(text, /Shop,https:\/\/esempio-shop\.test\/,cliente:acme,/);

  // PDF for a client: the same engine as the other reports, or a clear error without Chromium
  if (pdfOk) {
    const pdf = await rita('GET', 'report.pdf?period=last-month&tag=cliente:acme&client=Acme', undefined, true);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.buf.subarray(0, 5).toString(), '%PDF-');
    assert.match(pdf.headers.get('content-disposition'), /disponibilita-acme-\d{4}-\d{2}\.pdf/);
  } else {
    const pdf = await rita('GET', 'report.pdf?period=last-month');
    assert.equal(pdf.status, 400);
    assert.match(pdf.data.error, /Playwright|Chromium/);
  }

  // the monthly report by email (RF-RPT-03): to confirmed addresses, once a month, on the first
  await store.saveChannel('rita', { id: 'mail1', type: 'email', name: 'Cliente Acme', status: 'active', config: { address: 'acme@cliente.it' } });
  await store.saveChannel('rita', { id: 'mail2', type: 'email', name: 'Da confermare', status: 'pending', config: { address: 'x@cliente.it' } });
  await store.saveChannel('rita', { id: 'slack1', type: 'slack', name: 'Slack', status: 'active', config: { webhookUrl: 'http://127.0.0.1:1/x' } });
  assert.equal((await rita('POST', 'report-subscriptions', { name: 'Acme', tag: 'cliente:acme', channelIds: [] })).status, 400);
  assert.equal((await rita('POST', 'report-subscriptions', { name: 'Acme', tag: 'cliente:acme', channelIds: ['mail2'] })).status, 400, 'only confirmed addresses');
  assert.equal((await rita('POST', 'report-subscriptions', { name: 'Acme', tag: 'cliente:acme', channelIds: ['slack1'] })).status, 400, 'only email');
  assert.equal((await rita('POST', 'report-subscriptions', { name: '', channelIds: ['mail1'] })).status, 400);
  const sub = (await rita('POST', 'report-subscriptions', { name: 'Acme', tag: 'cliente:acme', channelIds: ['mail1'] })).data;
  assert.equal((await rita('GET', 'report-subscriptions')).data.length, 1);

  const render = async (report, { client }) => Buffer.from(`%PDF-finto ${client} ${report.rows.length}`);
  const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 3, 30);
  mails.length = 0;
  assert.deepEqual(await sendMonthlyReports(store, { now: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 2, 3, 30), render }), [], 'not on the 2nd');
  let sent = await sendMonthlyReports(store, { now: first, render });
  assert.deepEqual([sent.length, sent[0].sent, sent[0].recipients, sent[0].pdf], [1, 1, 1, true]);
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].to, ['acme@cliente.it']);
  assert.match(mails[0].subject, /Report di disponibilità · Acme/);
  assert.equal(mails[0].attachments.length, 1);
  assert.match(mails[0].attachments[0].filename, /^disponibilita-acme-\d{4}-\d{2}\.pdf$/);
  assert.match(Buffer.from(mails[0].attachments[0].content, 'base64').toString(), /^%PDF-finto Acme 2$/, 'the report of the tag, two monitors');
  assert.match(mails[0].text, /Disponibilità di .*: 9\d,\d\d%/);
  assert.deepEqual(await sendMonthlyReports(store, { now: first + 3600000, render }), [], 'once a month');
  assert.equal(mails.length, 1);
  sent = await sendMonthlyReports(store, { now: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 3, 30), render });
  assert.equal(sent.length, 1, 'the next month again');
  // the PDF engine failing does not stop the mail: the summary goes without the attachment
  mails.length = 0;
  sent = await sendMonthlyReports(store, { now: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 1, 3, 30), render: async () => { throw new Error('Chromium assente'); } });
  assert.deepEqual([sent[0].sent, sent[0].pdf, sent[0].pdfError], [1, false, 'Chromium assente']);
  assert.equal(mails[0].attachments, undefined);
  assert.match(mails[0].text, /Il PDF non è disponibile in questo momento \(Chromium assente\)/);
  // «send now» from the page, and it is in the notification log
  const now2 = await rita('POST', `report-subscriptions/${sub.id}/send`, {});
  assert.equal(now2.status, 200, JSON.stringify(now2.data));
  assert.equal((await rita('GET', 'notification-log')).data.entries.some((e) => e.event === 'report' && e.channel === 'Cliente Acme'), true);
  assert.equal((await rita('DELETE', `report-subscriptions/${sub.id}`)).status, 200);
  assert.deepEqual((await rita('GET', 'report-subscriptions')).data, []);
  assert.equal((await rita('POST', 'report-subscriptions/inesistente/send', {})).status, 404);
});
