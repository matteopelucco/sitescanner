import { availabilityPct, fmtDuration } from './uptime.js';
import { zonedMidnight } from './runs.js';

// The availability report (spec §13.12, RF-RPT-01/02): period, figures per monitor and per tag, CSV and the document to print.
// Pure: the monitors arrive with their KPIs already computed by the same function as the dashboard (RF-KPI-07).

const DAY = 86400000;

/** [from, to) of a period of the report in the time zone of the account. */
export function reportPeriod(kind, now, { tz = 'UTC', from = null, to = null } = {}) {
  const local = (t) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(t)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
  const { year, month } = local(now);
  const monthStart = (y, m) => zonedMidnight(y + Math.floor((m - 1) / 12), ((m - 1) % 12 + 12) % 12, 1, tz);
  if (kind === 'month') return { from: monthStart(year, month), to: now, label: monthLabel(year, month, tz) };
  if (kind === 'last-month') {
    const y = month === 1 ? year - 1 : year, m = month === 1 ? 12 : month - 1;
    return { from: monthStart(y, m), to: monthStart(year, month), label: monthLabel(y, m, tz) };
  }
  if (kind === 'quarter') {
    const qm = Math.floor((month - 1) / 3) * 3 + 1;
    return { from: monthStart(year, qm), to: now, label: `${Math.floor((month - 1) / 3) + 1}° trimestre ${year}` };
  }
  if (kind === 'custom') {
    const f = Date.parse(from), t = Date.parse(to);
    if (!Number.isFinite(f) || !Number.isFinite(t) || t < f) throw new Error('Intervallo non valido: serve una data di inizio non successiva a quella di fine');
    const end = Math.min(t + DAY, now);
    return { from: f, to: end, label: `${fmtDay(f, tz)} – ${fmtDay(end - 1, tz)}` };
  }
  throw new Error(`Periodo sconosciuto: ${kind}`);
}

const monthLabel = (y, m, tz) => new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('it-IT', { month: 'long', year: 'numeric', timeZone: 'UTC' }).replace(/^./, (c) => c.toUpperCase());
const fmtDay = (t, tz) => new Date(t).toLocaleDateString('it-IT', { timeZone: tz, day: 'numeric', month: 'long', year: 'numeric' });

/** The sums of a group of monitors, weighted on the time monitored (RF-KPI-02), not the mean of the percentages. */
function totalOf(list) {
  const monitoredMs = list.reduce((s, m) => s + (m.kpis.monitoredMs || 0), 0), downtimeMs = list.reduce((s, m) => s + (m.kpis.downtimeMs || 0), 0);
  const withData = list.filter((m) => m.kpis.availability != null);
  return {
    monitors: list.length, monitoredMs, downtimeMs, availability: availabilityPct(monitoredMs, downtimeMs), incidents: list.reduce((s, m) => s + (m.kpis.incidents || 0), 0),
    slaMet: withData.filter((m) => m.kpis.availability >= m.slaPct).length, slaMissed: withData.filter((m) => m.kpis.availability < m.slaPct).length,
  };
}

/**
 * The report: per monitor (availability, downtime, incidents, MTTR, response times, SLA met or not), and the totals per tag and overall.
 * `monitors`: [{ id, name, url, tags, slaPct, kpis, incidentList }]; `maintenance`: [{ start, end, monitors: [names] }].
 */
export function buildReport({ monitors, period, maintenance = [], tz = 'UTC', generatedAt = Date.now() }) {
  const rows = monitors.map((m) => ({
    id: m.id, name: m.name, url: m.url, tags: m.tags || [], slaPct: m.slaPct, availability: m.kpis.availability, downtimeMs: m.kpis.downtimeMs, monitoredMs: m.kpis.monitoredMs,
    incidents: m.kpis.incidents, mttrMs: m.kpis.mttrMs, avgMs: m.kpis.response ? m.kpis.response.avg : null, p95Ms: m.kpis.response ? m.kpis.response.p95 : null, p99Ms: m.kpis.response ? m.kpis.response.p99 : null,
    slaMet: m.kpis.availability == null ? null : m.kpis.availability >= m.slaPct, incidentList: m.incidentList || [],
  })).sort((a, b) => a.name.localeCompare(b.name, 'it'));
  const tags = [...new Set(monitors.flatMap((m) => m.tags || []))].sort();
  return {
    period, tz, generatedAt, rows, overall: totalOf(monitors),
    tags: tags.map((tag) => ({ tag, ...totalOf(monitors.filter((m) => (m.tags || []).includes(tag))) })),
    maintenance,
  };
}

const csvCell = (v) => { const s = String(v ?? ''); return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const pctCsv = (p) => (p == null ? '' : p.toFixed(2));

/** The same content as a CSV (RF-RPT-02): one line per monitor. */
export function reportCsv(report) {
  const head = ['monitor', 'url', 'tag', 'da', 'a', 'disponibilita', 'obiettivo', 'obiettivo_rispettato', 'downtime_s', 'incidenti', 'mttr_s', 'risposta_media_ms', 'p95_ms', 'p99_ms'];
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const lines = report.rows.map((r) => [r.name, r.url, r.tags.join(';'), iso(report.period.from), iso(report.period.to - 1), pctCsv(r.availability), r.slaPct, r.slaMet == null ? '' : r.slaMet ? 'sì' : 'no', Math.round((r.downtimeMs || 0) / 1000), r.incidents, r.mttrMs == null ? '' : Math.round(r.mttrMs / 1000), r.avgMs ?? '', r.p95Ms ?? '', r.p99Ms ?? '']);
  return [head, ...lines].map((l) => l.map(csvCell).join(',')).join('\r\n');
}

// ---------------- the document to print ----------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (p) => (p == null ? '—' : `${p.toFixed(2).replace('.', ',')}%`);
const when = (t, tz) => new Date(t).toLocaleString('it-IT', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' });

const CSS = `
@page { size: A4; margin: 16mm 14mm 18mm; @bottom-right { content: counter(page) " / " counter(pages); font-size: 8pt; color: #5d6673; } }
* { box-sizing: border-box; } html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font: 9.2pt/1.45 "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif; color: #1b1f24; }
h1, h2, h3 { line-height: 1.2; break-after: avoid; } h2 { font-size: 14pt; margin: 8mm 0 3mm; padding-bottom: 1.5mm; border-bottom: 1.5pt solid #2f5fd0; color: #13306f; }
.cover { height: 250mm; display: flex; flex-direction: column; break-after: page; } .cover .brand { font-weight: 700; color: #2f5fd0; }
.cover .kind { margin-top: 38mm; font-size: 11pt; text-transform: uppercase; letter-spacing: 1.2pt; color: #5d6673; } .cover h1 { font-size: 28pt; margin: 2mm 0; color: #13306f; }
.cover .period { font-size: 14pt; color: #3a4350; } .big { margin-top: 14mm; display: flex; gap: 6mm; } .box { flex: 1; border: .6pt solid #dfe3e8; border-radius: 2mm; padding: 4mm 5mm; }
.box b { display: block; font-size: 20pt; color: #13306f; } .box span { color: #5d6673; font-size: 8.5pt; } .gen { margin-top: auto; font-size: 8pt; color: #5d6673; }
table { width: 100%; border-collapse: collapse; font-size: 8.5pt; } th, td { padding: 1.6mm 2mm; border-bottom: .4pt solid #dfe3e8; text-align: left; vertical-align: top; } th { background: #f3f5f8; font-weight: 600; }
tr { break-inside: avoid; } .num { text-align: right; white-space: nowrap; } .ok { color: #1f7a45; font-weight: 600; } .ko { color: #b42626; font-weight: 600; } .muted { color: #5d6673; } .small { font-size: 8pt; }
`;

/** The document of the report: cover, summary, table of the monitors, incidents with duration and cause, maintenance (RF-RPT-02). */
export function reportPrintHtml(report, { title = 'Report di disponibilità', client = '', version = '' } = {}) {
  const { period, tz, rows, overall, tags, maintenance } = report;
  const incidents = rows.flatMap((r) => r.incidentList.map((i) => ({ ...i, monitor: r.name }))).sort((a, b) => a.start - b.start);
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>${esc(title)}${client ? ` · ${esc(client)}` : ''}</title><style>${CSS}</style></head><body>
<section class="cover"><div class="brand">sitescanner</div><div class="kind">${esc(title)}</div><h1>${esc(client || 'Tutti i siti monitorati')}</h1><div class="period">${esc(period.label)}</div>
<div class="big"><div class="box"><b>${pct(overall.availability)}</b><span>disponibilità complessiva</span></div><div class="box"><b>${overall.incidents}</b><span>incidenti</span></div><div class="box"><b>${esc(fmtDuration(overall.downtimeMs))}</b><span>downtime totale</span></div><div class="box"><b>${overall.slaMet}/${overall.slaMet + overall.slaMissed}</b><span>obiettivi rispettati</span></div></div>
<p class="gen">${overall.monitors} monitor · generato il ${esc(when(report.generatedAt, tz))}${version ? ` · sitescanner ${esc(version)}` : ''}</p></section>
<h2>Riepilogo per monitor</h2>
<table><thead><tr><th>Monitor</th><th class="num">Disponibilità</th><th class="num">Obiettivo</th><th class="num">Downtime</th><th class="num">Incidenti</th><th class="num">Risposta media / p95</th></tr></thead><tbody>${rows.map((r) => `<tr><td><b>${esc(r.name)}</b><div class="muted small">${esc(r.url)}</div></td><td class="num ${r.slaMet === false ? 'ko' : r.slaMet ? 'ok' : ''}">${pct(r.availability)}</td><td class="num">${pct(r.slaPct)} ${r.slaMet == null ? '' : r.slaMet ? '✓' : '✗'}</td><td class="num">${esc(fmtDuration(r.downtimeMs || 0))}</td><td class="num">${r.incidents}</td><td class="num">${r.avgMs == null ? '—' : `${r.avgMs} / ${r.p95Ms} ms`}</td></tr>`).join('')}</tbody></table>
${tags.length > 1 ? `<h2>Totali per tag</h2><table><thead><tr><th>Tag</th><th class="num">Monitor</th><th class="num">Disponibilità (pesata)</th><th class="num">Downtime</th><th class="num">Incidenti</th><th class="num">Obiettivi</th></tr></thead><tbody>${tags.map((t) => `<tr><td>${esc(t.tag)}</td><td class="num">${t.monitors}</td><td class="num">${pct(t.availability)}</td><td class="num">${esc(fmtDuration(t.downtimeMs))}</td><td class="num">${t.incidents}</td><td class="num">${t.slaMet}/${t.slaMet + t.slaMissed}</td></tr>`).join('')}</tbody></table><p class="muted small">La disponibilità di un gruppo è pesata sul tempo monitorato di ogni monitor, non la media delle percentuali.</p>` : ''}
<h2>Incidenti</h2>${incidents.length ? `<table><thead><tr><th>Monitor</th><th>Inizio</th><th class="num">Durata</th><th>Causa</th></tr></thead><tbody>${incidents.map((i) => `<tr><td>${esc(i.monitor)}</td><td>${esc(when(i.start, tz))}</td><td class="num">${i.end ? esc(fmtDuration(i.end - i.start)) : 'in corso'}</td><td>${esc(i.cause || '')}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Nessun incidente nel periodo.</p>'}
<h2>Manutenzioni</h2>${maintenance.length ? `<table><thead><tr><th>Quando</th><th>Monitor</th></tr></thead><tbody>${maintenance.map((w) => `<tr><td>${esc(when(w.start, tz))} – ${esc(new Date(w.end).toLocaleTimeString('it-IT', { timeZone: tz, hour: '2-digit', minute: '2-digit' }))}</td><td>${w.monitors.map(esc).join(', ')}</td></tr>`).join('')}</tbody></table><p class="muted small">Il tempo in manutenzione non conta nella disponibilità.</p>` : '<p class="muted">Nessuna manutenzione nel periodo.</p>'}
</body></html>`;
}

/** The first day of a month at which the monthly report goes out: is `now` in the first day of the month in `tz`? */
export function isFirstOfMonth(now, tz) {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: tz, day: '2-digit' }).format(new Date(now));
  return Number(d) === 1;
}

/** A key that says «this month» (to send a report once). */
export const monthKey = (now, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).format(new Date(now));
