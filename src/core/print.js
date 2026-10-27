// Print document (A4, CSS paged media) of a report: diagnostic of one scan or Base/Head comparison.
// Shared by the PDF export (Playwright, in Node) and the report's "PDF" button (browser print).
// Only imports from the other core modules are allowed: the report build strips import/export
// lines and embeds this file after compare.js and diagnose.js, in the same scope.
import { SEVERITIES, FINDING_TYPES, compareScans } from './compare.js';
import { diagnoseScan, healthScore, issueLabel, ISSUE_CATEGORIES } from './diagnose.js';

const PRINT_LIMITS = { findings: 400, pagesPerIssue: 25, worstPages: 40, nonIndexable: 80, addedRemoved: 100 };

export const pEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Value of a CSS string (content: "…") built from untrusted text.
export const cssStr = (s) => `"${String(s ?? '').replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ')}"`;
export const pNum = (n) => (n == null ? '—' : Number(n).toLocaleString('it-IT'));
export const pDate = (iso) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const pSev = (s) => `<span class="sev ${s}">${s}</span>`;
const more = (n, what) => (n > 0 ? `<p class="more">… e altre ${pNum(n)} ${what}: l'elenco completo è nel report interattivo.</p>` : '');

export const PRINT_CSS = `
@page { size: A4; margin: 17mm 14mm 18mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font: 9.2pt/1.45 "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif; color: #1b1f24; background: #fff; }
h1, h2, h3 { line-height: 1.2; break-after: avoid; }
h2 { font-size: 15pt; margin: 0 0 4mm; padding-bottom: 2mm; border-bottom: 1.5pt solid #2f5fd0; color: #13306f; }
h3 { font-size: 10.5pt; margin: 5mm 0 2mm; }
p { margin: 0 0 2.5mm; }
code { font-family: Consolas, "SFMono-Regular", Menlo, monospace; font-size: 8pt; }
section { margin-bottom: 7mm; }
section.newpage { break-before: page; }
.cover { height: 255mm; display: flex; flex-direction: column; break-after: page; }
.cover .brand { font-size: 10pt; font-weight: 700; letter-spacing: .4pt; color: #2f5fd0; }
.cover .kind { margin-top: 30mm; font-size: 11pt; text-transform: uppercase; letter-spacing: 1.2pt; color: #5d6673; }
.cover h1 { font-size: 28pt; margin: 2mm 0 2mm; color: #13306f; }
.cover .url { font-size: 11pt; color: #5d6673; overflow-wrap: anywhere; }
.cover .verdict { margin: 12mm 0 8mm; display: flex; gap: 6mm; align-items: stretch; }
.cover .scans { display: flex; gap: 6mm; }
.cover .toc { margin-top: auto; border-top: .6pt solid #dfe3e8; padding-top: 4mm; color: #5d6673; }
.cover .toc ol { margin: 1mm 0 0; padding-left: 5mm; columns: 2; }
.cover .gen { margin-top: 4mm; font-size: 8pt; color: #5d6673; }
.box { flex: 1; border: .6pt solid #dfe3e8; border-radius: 2mm; padding: 3.5mm 4mm; break-inside: avoid; }
.box h4 { margin: 0 0 1.5mm; font-size: 7.5pt; text-transform: uppercase; letter-spacing: .6pt; color: #5d6673; }
.box .id { font-family: Consolas, monospace; font-size: 8pt; color: #5d6673; overflow-wrap: anywhere; }
.badge { flex: 0 0 80mm; border-radius: 2mm; padding: 5mm; display: flex; flex-direction: column; justify-content: center; }
.badge b { font-size: 17pt; }
.badge.fail { background: #fbe7e7; color: #a42424; }
.badge.warn { background: #fdf1dc; color: #8a5200; }
.badge.pass { background: #e2f3e8; color: #1b6a3b; }
.score { flex: 0 0 56mm; text-align: center; white-space: nowrap; border: .6pt solid #dfe3e8; border-radius: 2mm; padding: 4mm 2mm; }
.score b { display: block; font-size: 24pt; color: #13306f; }
.score small { color: #5d6673; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; margin-bottom: 5mm; }
.kpi { border: .6pt solid #dfe3e8; border-radius: 1.5mm; padding: 2.5mm 3mm; break-inside: avoid; }
.kpi span { display: block; font-size: 7pt; text-transform: uppercase; letter-spacing: .5pt; color: #5d6673; }
.kpi b { font-size: 14pt; }
.kpi small { display: block; color: #5d6673; }
.bar { display: flex; height: 4mm; border-radius: 1mm; overflow: hidden; margin: 1.5mm 0 1mm; background: #f0f2f5; }
.bar i { display: block; height: 100%; }
.legend { font-size: 7.5pt; color: #5d6673; }
.legend i { display: inline-block; width: 2.5mm; height: 2.5mm; border-radius: .5mm; margin: 0 1mm 0 3mm; vertical-align: -.2mm; }
table { width: 100%; border-collapse: collapse; margin-bottom: 3mm; }
table.fixed { table-layout: fixed; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
th { text-align: left; font-size: 7pt; text-transform: uppercase; letter-spacing: .4pt; color: #5d6673; background: #f0f2f5; padding: 1.6mm 2mm; border-bottom: .6pt solid #c9ced6; }
td { padding: 1.4mm 2mm; border-bottom: .4pt solid #e4e7eb; vertical-align: top; overflow-wrap: anywhere; }
tbody tr:nth-child(even) td { background: #fafbfc; }
td.num, th.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
td.key { font-family: Consolas, monospace; font-size: 8pt; }
td.muted, .muted { color: #5d6673; }
.sev { display: inline-block; min-width: 11mm; text-align: center; font-size: 6.8pt; font-weight: 700; text-transform: uppercase; padding: .3mm 1.2mm; border-radius: .8mm; }
.sev.error { background: #fbe7e7; color: #a42424; }
.sev.warn { background: #fdf1dc; color: #8a5200; }
.sev.info { background: #e6eef8; color: #2d5a8e; }
.delta.up { color: #a42424; font-weight: 700; } .delta.down { color: #1b6a3b; }
.issue { break-inside: avoid-page; margin-bottom: 4mm; }
.issue h3 { margin-top: 0; }
.more { font-size: 8pt; color: #5d6673; font-style: italic; }
.empty { color: #5d6673; font-style: italic; }
`;

const MARGIN_FONT = 'font: 7.5pt "Segoe UI", system-ui, Roboto, Arial, sans-serif; color: #5d6673;';
const cols = (...widths) => `<colgroup>${widths.map((w) => `<col style="width:${w}%">`).join('')}</colgroup>`;

export function pageCss(siteName, kind, when) {
  return `@page { @top-left { content: ${cssStr(`sitescanner · ${siteName}`)}; ${MARGIN_FONT} }
  @top-right { content: ${cssStr(`${kind} · ${when}`)}; ${MARGIN_FONT} }
  @bottom-right { content: "Pagina " counter(page) " di " counter(pages); ${MARGIN_FONT} } }
@page :first { @top-left { content: none; } @top-right { content: none; } }`;
}

const scanBox = (title, s) => `<div class="box"><h4>${pEsc(title)}</h4>
  <div><b>${pEsc(pDate(s.startedAt))}</b> · ${pEsc(s.env)}${s.label ? ` · «${pEsc(s.label)}»` : ''}</div>
  <div class="id">${pEsc(s.id)}</div>
  <div class="muted">${pNum((s.pages || []).length)} pagine${s.crawl && s.crawl.truncated ? ' (troncata a maxPages)' : ''}</div>
  ${s.note ? `<div class="muted">${pEsc(s.note)}</div>` : ''}</div>`;

export const kpi = (label, value, sub = '') => `<div class="kpi"><span>${pEsc(label)}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;

function statusBar(byStatus) {
  const parts = [['2xx', '#3c9a5f'], ['3xx', '#d39b2a'], ['4xx', '#d0533f'], ['5xx', '#9e2a2a'], ['fail', '#6b7280']];
  const total = parts.reduce((n, [k]) => n + (byStatus[k] || 0), 0) || 1;
  return `<div class="bar">${parts.map(([k, c]) => (byStatus[k] ? `<i style="width:${(100 * byStatus[k]) / total}%;background:${c}"></i>` : '')).join('')}</div>
    <div class="legend">${parts.map(([k, c]) => `<i style="background:${c}"></i>${k === 'fail' ? 'non raggiungibili' : k} ${pNum(byStatus[k] || 0)}`).join('')}</div>`;
}

export function printDocument(title, siteName, kind, when, body) {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>${pEsc(title)}</title>
<style>${PRINT_CSS}
${pageCss(siteName, kind, when)}</style></head><body>${body}</body></html>`;
}

function cover({ kind, siteName, baseUrl, badgeCls, badgeTxt, badgeSub, score, scoreSub, boxes, toc, generatedAt, version }) {
  return `<div class="cover">
  <div class="brand">◎ sitescanner</div>
  <div class="kind">${pEsc(kind)}</div>
  <h1>${pEsc(siteName)}</h1>
  <div class="url">${pEsc(baseUrl)}</div>
  <div class="verdict"><div class="badge ${badgeCls}"><b>${pEsc(badgeTxt)}</b><span>${badgeSub}</span></div>
    <div class="score"><small>Health score</small><b>${score}</b><small>${scoreSub}</small></div></div>
  <div class="scans">${boxes}</div>
  <div class="toc"><b>Contenuti</b><ol>${toc.map((t) => `<li>${pEsc(t)}</li>`).join('')}</ol></div>
  <div class="gen">Generato il ${pEsc(pDate(generatedAt))} da sitescanner ${pEsc(version || '')}. Health score: quota di URL senza issue di livello error.</div>
</div>`;
}

/** Diagnostic document of one scan. */
function diagnosticDoc(scan, { siteName, generatedAt, version }) {
  const d = diagnoseScan(scan), s = d.summary;
  const name = siteName || scan.siteName || scan.site;
  const cls = s.error ? 'fail' : s.warn ? 'warn' : 'pass';
  const txt = s.error ? 'Errori da correggere' : s.warn ? 'Da verificare' : 'Nessun problema';
  const toc = ['Sintesi', 'Issue rilevate', 'Dettaglio di errori e warning', 'Pagine con più problemi', 'Pagine non indicizzabili'];

  const byCat = ISSUE_CATEGORIES.map((cat) => {
    const codes = d.codes.filter((c) => c.category === cat);
    const n = (sev) => codes.filter((c) => c.severity === sev).reduce((a, c) => a + c.occurrences, 0);
    return { cat, error: n('error'), warn: n('warn'), info: n('info') };
  }).filter((r) => r.error + r.warn + r.info);

  const important = d.codes.filter((c) => c.severity !== 'info');
  const worst = d.pages.filter((p) => p.worst).slice(0, PRINT_LIMITS.worstPages);
  const nonIdx = d.pages.filter((p) => p.indexability);

  const body = `
${cover({ kind: 'Report di qualità', siteName: name, baseUrl: scan.baseUrl, badgeCls: cls, badgeTxt: txt, badgeSub: `${pNum(s.error)} errori · ${pNum(s.warn)} warning · ${pNum(s.info)} info`, score: s.healthScore ?? '—', scoreSub: 'su 100', boxes: scanBox('Scan', scan), toc, generatedAt, version })}
<section><h2>1. Sintesi</h2>
  <div class="kpis">
    ${kpi('Health score', s.healthScore ?? '—', 'pagine senza errori')}
    ${kpi('Pagine', pNum(s.pages), s.truncated ? 'scan troncata' : '')}
    ${kpi('Indicizzabili', pNum(s.indexable), s.pages ? `${Math.round((100 * s.indexable) / s.pages)}%` : '')}
    ${kpi('Con issue', pNum(s.pagesWithIssues), s.pages ? `${Math.round((100 * s.pagesWithIssues) / s.pages)}%` : '')}
    ${kpi('Errori', pNum(s.error))}${kpi('Warning', pNum(s.warn))}${kpi('Info', pNum(s.info))}
    ${kpi('Risposta media', s.avgResponseMs == null ? '—' : `${pNum(s.avgResponseMs)} ms`)}
  </div>
  <h3>Status HTTP</h3>${statusBar(s.byStatus)}
  <h3>Issue per categoria</h3>
  ${byCat.length ? `<table><thead><tr><th>Categoria</th><th class="num">Error</th><th class="num">Warning</th><th class="num">Info</th></tr></thead><tbody>
    ${byCat.map((r) => `<tr><td>${pEsc(r.cat)}</td><td class="num">${r.error ? pNum(r.error) : ''}</td><td class="num">${r.warn ? pNum(r.warn) : ''}</td><td class="num">${r.info ? pNum(r.info) : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">Nessuna issue rilevata.</p>'}
</section>
<section class="newpage"><h2>2. Issue rilevate</h2>
  ${d.codes.length ? `<table><thead><tr><th>Sev.</th><th>Issue</th><th>Categoria</th><th class="num">Occorrenze</th><th class="num">Pagine</th></tr></thead><tbody>
    ${d.codes.map((c) => `<tr><td>${pSev(c.severity)}</td><td>${pEsc(c.label)}<br><code class="muted">${pEsc(c.code)}</code></td><td class="muted">${pEsc(c.category)}</td><td class="num">${pNum(c.occurrences)}</td><td class="num">${pNum(c.pages)}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">Nessuna issue rilevata.</p>'}
</section>
<section class="newpage"><h2>3. Dettaglio di errori e warning</h2>
  ${important.length ? important.map((c) => `<div class="issue"><h3>${pSev(c.severity)} ${pEsc(c.label)} <code class="muted">${pEsc(c.code)}</code></h3>
    <table class="fixed">${cols(38, 62)}<thead><tr><th>Pagina</th><th>Dettaglio</th></tr></thead><tbody>
    ${c.items.slice(0, PRINT_LIMITS.pagesPerIssue).map((it) => `<tr><td class="key">${pEsc(it.pages ? it.pages.slice(0, 10).join(' · ') + (it.pages.length > 10 ? ` · … (${it.pages.length})` : '') : it.key)}</td><td>${pEsc(it.message)}</td></tr>`).join('')}
    </tbody></table>${more(c.items.length - PRINT_LIMITS.pagesPerIssue, 'occorrenze')}</div>`).join('') : '<p class="empty">Nessun errore o warning.</p>'}
</section>
<section class="newpage"><h2>4. Pagine con più problemi</h2>
  ${worst.length ? `<table class="fixed">${cols(36, 9, 7, 7, 7, 34)}<thead><tr><th>Pagina</th><th>Status</th><th class="num">Error</th><th class="num">Warn</th><th class="num">Info</th><th>Title</th></tr></thead><tbody>
    ${worst.map((p) => `<tr><td class="key">${pEsc(p.key)}</td><td>${pEsc(p.error || p.code)}</td><td class="num">${p.counts.error || ''}</td><td class="num">${p.counts.warn || ''}</td><td class="num">${p.counts.info || ''}</td><td>${pEsc(p.title || '')}</td></tr>`).join('')}</tbody></table>
    ${more(d.pages.filter((p) => p.worst).length - worst.length, 'pagine con issue')}` : '<p class="empty">Nessuna pagina con issue.</p>'}
</section>
<section><h2>5. Pagine non indicizzabili</h2>
  ${nonIdx.length ? `<table class="fixed">${cols(60, 40)}<thead><tr><th>Pagina</th><th>Motivo</th></tr></thead><tbody>
    ${nonIdx.slice(0, PRINT_LIMITS.nonIndexable).map((p) => `<tr><td class="key">${pEsc(p.key)}</td><td>${pEsc(p.indexability)}</td></tr>`).join('')}</tbody></table>${more(nonIdx.length - PRINT_LIMITS.nonIndexable, 'pagine')}` : '<p class="empty">Tutte le pagine sono indicizzabili.</p>'}
</section>`;
  return printDocument(`Report di qualità · ${name} · ${pDate(scan.startedAt)}`, name, 'Report di qualità', pDate(scan.startedAt), body);
}

/** Comparison document of two scans. */
function comparisonDoc(base, head, compareOpts, { siteName, generatedAt, version }) {
  const r = compareScans(base, head, compareOpts);
  const s = r.summary;
  const name = siteName || head.siteName || head.site;
  const same = base.id === head.id;
  const cls = s.error ? 'fail' : s.warn ? 'warn' : 'pass';
  const txt = same ? 'Stessa scan' : s.error ? 'Regressioni' : s.warn ? 'Da verificare' : 'Nessuna regressione';
  const hb = healthScore(base), hh = healthScore(head);
  const toc = ['Sintesi', 'Regressioni (error)', 'Da verificare (warning)', 'Pagine aggiunte e rimosse', 'Issue di qualità Base → Head'];

  const types = {};
  for (const f of r.findings) (types[f.type] = types[f.type] || { error: 0, warn: 0, info: 0 })[f.severity]++;
  const findingsTable = (sev) => {
    const rows = r.findings.filter((f) => f.severity === sev);
    if (!rows.length) return `<p class="empty">Nessuna differenza di livello ${sev}.</p>`;
    return `<table class="fixed">${cols(24, 30, 46)}<thead><tr><th>Tipo</th><th>Pagina</th><th>Dettaglio</th></tr></thead><tbody>
      ${rows.slice(0, PRINT_LIMITS.findings).map((f) => `<tr><td>${pEsc(FINDING_TYPES[f.type] || f.type)}</td><td class="key">${pEsc(f.key)}${f.baseKey && f.baseKey !== f.key ? `<br><span class="muted">da ${pEsc(f.baseKey)}</span>` : ''}</td><td>${pEsc(f.message)}</td></tr>`).join('')}</tbody></table>
      ${more(rows.length - PRINT_LIMITS.findings, 'differenze')}`;
  };
  const added = r.pairs.filter((p) => p.state === 'added'), removed = r.pairs.filter((p) => p.state === 'removed');
  const keyList = (list) => (list.length ? `<table><tbody>${list.slice(0, PRINT_LIMITS.addedRemoved).map((p) => `<tr><td class="key">${pEsc(p.key)}</td></tr>`).join('')}</tbody></table>${more(list.length - PRINT_LIMITS.addedRemoved, 'pagine')}` : '<p class="empty">Nessuna.</p>');

  const db = diagnoseScan(base), dh = diagnoseScan(head);
  const codes = new Map();
  for (const c of db.codes) codes.set(c.code, { c, b: c.occurrences, h: 0 });
  for (const c of dh.codes) codes.set(c.code, { c, b: codes.get(c.code)?.b || 0, h: c.occurrences });
  const issueRows = [...codes.values()].sort((x, y) => (y.h - y.b) - (x.h - x.b) || y.h - x.h);

  const body = `
${cover({ kind: 'Report di regressione', siteName: name, baseUrl: `${base.baseUrl}${base.baseUrl !== head.baseUrl ? ` → ${head.baseUrl}` : ''}`, badgeCls: cls, badgeTxt: txt, badgeSub: `${pNum(s.error)} errori · ${pNum(s.warn)} warning · ${pNum(s.info)} info`, score: `${hb ?? '—'} → ${hh ?? '—'}`, scoreSub: 'Base → Head', boxes: scanBox('Base', base) + scanBox('Head', head), toc, generatedAt, version })}
<section><h2>1. Sintesi</h2>
  <div class="kpis">
    ${kpi('Pagine', `${pNum(r.base.pages)} → ${pNum(r.head.pages)}`)}
    ${kpi('Health score', `${hb ?? '—'} → ${hh ?? '—'}`)}
    ${kpi('Differenze', pNum(s.findings))}
    ${kpi('Error / warn / info', `${pNum(s.error)} / ${pNum(s.warn)} / ${pNum(s.info)}`)}
    ${kpi('Cambiate', pNum(s.changed))}${kpi('Aggiunte', pNum(s.added))}${kpi('Rimosse', pNum(s.removed))}${kpi('Invariate', pNum(s.unchanged))}
  </div>
  ${compareOpts.redirectMap && Object.keys(compareOpts.redirectMap).length ? `<p class="muted">Confronto con redirect map di ${pNum(Object.keys(compareOpts.redirectMap).length)} voci.</p>` : ''}
  <h3>Differenze per tipo</h3>
  ${Object.keys(types).length ? `<table><thead><tr><th>Tipo</th>${SEVERITIES.map((v) => `<th class="num">${v}</th>`).join('')}</tr></thead><tbody>
    ${Object.entries(types).sort((a, b) => b[1].error - a[1].error || b[1].warn - a[1].warn || b[1].info - a[1].info).map(([t, c]) => `<tr><td>${pEsc(FINDING_TYPES[t] || t)}</td>${SEVERITIES.map((v) => `<td class="num">${c[v] || ''}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<p class="empty">Nessuna differenza tra Base e Head.</p>'}
</section>
<section class="newpage"><h2>2. Regressioni (error)</h2>${findingsTable('error')}</section>
<section><h2>3. Da verificare (warning)</h2>${findingsTable('warn')}</section>
<section class="newpage"><h2>4. Pagine aggiunte e rimosse</h2>
  <h3>Aggiunte (${pNum(added.length)})</h3>${keyList(added)}
  <h3>Rimosse (${pNum(removed.length)})</h3>${keyList(removed)}
</section>
<section class="newpage"><h2>5. Issue di qualità Base → Head</h2>
  ${issueRows.length ? `<table><thead><tr><th>Sev.</th><th>Issue</th><th class="num">Base</th><th class="num">Head</th><th class="num">Δ</th></tr></thead><tbody>
    ${issueRows.map(({ c, b, h }) => `<tr><td>${pSev(c.severity)}</td><td>${pEsc(issueLabel(c.code))} <code class="muted">${pEsc(c.code)}</code></td><td class="num">${pNum(b)}</td><td class="num">${pNum(h)}</td><td class="num"><span class="delta ${h > b ? 'up' : h < b ? 'down' : ''}">${h > b ? '+' : ''}${h - b}</span></td></tr>`).join('')}</tbody></table>` : '<p class="empty">Nessuna issue in Base e Head.</p>'}
  <p class="muted">Le differenze di livello info (${pNum(s.info)}) sono riassunte nella sintesi e consultabili nel report interattivo.</p>
</section>`;
  return printDocument(`Report di regressione · ${name} · ${pDate(base.startedAt)} → ${pDate(head.startedAt)}`, name, 'Report di regressione', `${pDate(base.startedAt)} → ${pDate(head.startedAt)}`, body);
}

/**
 * Self-contained HTML of the print report. Without `head` it is the diagnostic of `base`.
 * @param {object} o
 * @param {object} o.base          scan snapshot
 * @param {object} [o.head]        scan snapshot
 * @param {object} [o.compare]     compareScans options (redirectMap, ignore, thresholds)
 * @param {string} [o.siteName]
 * @param {string} [o.generatedAt] ISO date
 * @param {string} [o.version]     tool version
 */
export function renderPrintHtml({ base, head = null, compare = {}, siteName = '', generatedAt = new Date().toISOString(), version = '' }) {
  const meta = { siteName, generatedAt, version };
  return head ? comparisonDoc(base, head, compare, meta) : diagnosticDoc(base, meta);
}
