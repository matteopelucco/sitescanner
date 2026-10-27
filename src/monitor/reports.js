import { monitorKpis, monitorStoreFor, monitoringConfig } from './engine.js';
import { maintenanceFor, windowOccurrences } from '../core/uptime.js';
import { buildReport, reportPeriod, reportPrintHtml, reportCsv, isFirstOfMonth, monthKey } from '../core/uptimereport.js';
import { htmlToPdf } from '../pdf.js';
import { sendWithRetries } from './notify.js';
import { publicBaseUrl } from './channels.js';
import { TOOL } from '../version.js';

// The availability report from the data (spec §13.12): the same KPIs as the dashboard, for a period and a group of monitors,
// as JSON, CSV and PDF, and the monthly one by email.

/** The monitors a report talks about: by tag (several, a namespace like `cliente` takes all its tags) and by text. */
export function selectMonitors(monitors, { tags = [], text = '' } = {}) {
  const t = tags.map((x) => String(x).toLowerCase()).filter(Boolean);
  const q = String(text || '').toLowerCase();
  return monitors.filter((m) => (!t.length || (m.tags || []).some((x) => t.some((y) => x === y || x.startsWith(`${y}:`))))
    && (!q || `${m.name} ${m.url}`.toLowerCase().includes(q)));
}

export async function reportData(store, area, { period = 'month', from = null, to = null, tags = [], text = '', now = Date.now(), tz = monitoringConfig().tz } = {}) {
  const p = reportPeriod(period, now, { tz, from, to });
  const windows = await store.listWindows(area);
  const monitors = selectMonitors(await store.listMonitors(area), { tags, text }).filter((m) => m.createdAt < p.to);
  const list = [];
  for (const m of monitors) {
    const kpis = await monitorKpis(store, area, m, { from: p.from, to: p.to, now, windows, tz });
    const incidents = await store.listIncidents(area, { monitorId: m.id, from: p.from, to: p.to });
    list.push({ id: m.id, name: m.name, url: m.url || '', tags: m.tags, slaPct: m.slaPct, kpis, incidentList: incidents.map((i) => ({ start: i.start, end: i.end, cause: i.cause ? i.cause.message : '' })) });
  }
  const maintenance = [];
  for (const w of windows) {
    for (const [s, e] of windowOccurrences(w, p.from, p.to, tz)) {
      const touched = monitors.filter((m) => maintenanceFor([w], m, s, e, tz).length).map((m) => m.name);
      if (touched.length) maintenance.push({ start: s, end: e, monitors: touched });
    }
  }
  maintenance.sort((a, b) => a.start - b.start);
  return buildReport({ monitors: list, period: p, maintenance: maintenance.slice(0, 50), tz, generatedAt: now });
}

export const reportFileName = (report, client) => `disponibilita-${(client || 'tutti').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tutti'}-${new Date(report.period.from).toISOString().slice(0, 7)}.pdf`;

export async function reportPdf(report, { client = '' } = {}) {
  return htmlToPdf(reportPrintHtml(report, { client, version: TOOL.version }));
}

/**
 * The monthly reports (RF-RPT-03): on the first day of the month, the PDF of the previous month for each subscription
 * goes by email to the confirmed addresses it names. Once a month for each subscription. `render` replaces the PDF engine (tests).
 */
export async function sendMonthlyReports(store = monitorStoreFor(), { now = Date.now(), render = reportPdf, force = false } = {}) {
  const out = [];
  for (const area of await store.listAreas()) {
    const prefs = await store.getPrefs(area);
    const tz = prefs.tz || monitoringConfig().tz;
    for (const sub of prefs.monthlyReports || []) {
      if (!force && !isFirstOfMonth(now, tz)) continue;
      const key = `monthly:${area}:${sub.id}`;
      const month = monthKey(now, tz);
      if (!force && (await store.getMeta(key)) === month) continue;
      out.push(await sendOne(store, area, sub, { now, tz, render }));
      if (!force) await store.setMeta(key, month);
    }
  }
  return out;
}

/** One subscription, now (also the «send now» button, to see what the clients will receive). */
export async function sendOne(store, area, sub, { now = Date.now(), tz = monitoringConfig().tz, render = reportPdf } = {}) {
  const report = await reportData(store, area, { period: 'last-month', tags: sub.tag ? [sub.tag] : [], now, tz });
  const channels = (await store.listChannels(area)).filter((c) => c.type === 'email' && c.status === 'active' && (sub.channelIds || []).includes(c.id));
  let pdf = null, pdfError = null;
  try { pdf = await render(report, { client: sub.name }); } catch (e) { pdfError = e.message; }
  const o = report.overall;
  const lines = [
    `Disponibilità di ${report.period.label}${sub.tag ? ` · ${sub.tag}` : ''}: ${o.availability == null ? 'nessun dato' : `${o.availability.toFixed(2).replace('.', ',')}%`}`,
    `${o.monitors} monitor · ${o.incidents} incidenti · obiettivi rispettati ${o.slaMet}/${o.slaMet + o.slaMissed}`,
    pdf ? 'Il report completo è in allegato (PDF).' : `Il PDF non è disponibile in questo momento (${pdfError}): il riepilogo è qui sopra.`,
  ];
  const deliveries = [];
  for (const c of channels) {
    const message = { subject: `Report di disponibilità · ${sub.name} · ${report.period.label}`, lines: [`Report di disponibilità · ${sub.name}`, ...lines], link: `${publicBaseUrl()}/#/report`, ...(pdf ? { attachments: [{ filename: reportFileName(report, sub.name), content: Buffer.from(pdf).toString('base64') }] } : {}) };
    const r = await sendWithRetries(c, message);
    deliveries.push({ channelId: c.id, channel: c.name, type: c.type, ok: r.ok, at: Date.now(), attempts: r.attempts, error: r.error || null, response: r.response || null });
  }
  // it goes in the log of the notifications (RF-ALR-07)
  await store.addEvent(area, { type: 'report', status: 'info', at: now, monitorName: `Report «${sub.name}»`, deliveries });
  return { area, subscription: sub.id, month: report.period.label, sent: deliveries.filter((d) => d.ok).length, failed: deliveries.filter((d) => !d.ok).length, pdf: !!pdf, pdfError, recipients: channels.length };
}

export { reportCsv };
