// Exports of the site map (spec §14.7): CSV for Excel, the JSON dataset, Markdown with a Mermaid diagram and the
// print document of the PDF. Pure: the map comes from src/core/sitemap.js (with `notes` and `rules` added by the
// server), the inventory from storage; d3-hierarchy is passed in by the caller for the radial diagram.
import { printDocument, pEsc, pNum, pDate, kpi } from './print.js';

export const SCHEMA_VERSION = 1;

/** File name of an export: host and date of the inventory (RF-MAP-175). */
export function exportFileName(inv, ext) {
  let host = 'sito';
  try {
    host = new URL(inv.baseUrl).host.replace(/[^\w.-]+/g, '-');
  } catch { /* keep the default */ }
  const day = String(inv.startedAt || '').slice(0, 10).replace(/-/g, '') || 'senza-data';
  return `mappa-${host}-${day}.${ext}`;
}

const urlOf = (map, id) => map._byId.get(id)?.url || id;
function indexed(map) {
  if (!map._byId) Object.defineProperty(map, '_byId', { value: new Map(map.nodes.map((n) => [n.id, n])), enumerable: false });
  return map;
}
const siteLabel = (map) => map.mainHost;
const dateOf = (inv) => String(inv.startedAt || '').slice(0, 10);

// ---------------------------------------------------------------- CSV (RF-MAP-170)

const CSV_COLUMNS = [
  ['URL', (n) => n.url], ['Host', (n) => n.host], ['Percorso', (n) => n.key], ['Area', (n) => n.area], ['Livello', (n) => n.level],
  ['Genitore', (n, m) => (n.parent ? urlOf(m, n.parent) : '')], ['Nome breve', (n) => n.shortName], ['Title', (n) => n.title], ['H1', (n) => n.h1],
  ['Description', (n) => n.description], ['Parole', (n) => n.wordCount],
  ['Documenti', (n) => n.documents.length], ['URL dei documenti', (n) => [...new Set(n.documents.map((d) => d.url))].join(' | ')],
  ['Navigazione globale', (n) => (n.globalNav ? 'Sì' : 'No')],
  ['Link di contenuto in entrata', (n) => n.contentIn.length], ['URL dei link di contenuto in entrata', (n, m) => n.contentIn.map((x) => urlOf(m, x)).join(' | ')],
  ['Link di contenuto in uscita', (n) => n.contentOut.length], ['URL dei link di contenuto in uscita', (n, m) => n.contentOut.map((x) => urlOf(m, x)).join(' | ')],
  ['Link totali in entrata', (n) => n.totalIn], ['Link totali in uscita', (n) => n.totalOut],
  ['Profondità di click', (n) => n.clickDepth], ['Lingua', (n) => n.lang], ['Raggiunta da', (n) => n.reachedFrom || ''],
  ['Nota', (n, m) => m.notes?.pages?.[n.id] || ''],
];

/** A cell for Excel: a text that starts like a formula is neutralized, separators and quotes are escaped. */
export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function mapCsv(map) {
  indexed(map);
  const rows = [CSV_COLUMNS.map(([h]) => csvCell(h)).join(';')];
  for (const n of map.nodes) rows.push(CSV_COLUMNS.map(([, f]) => csvCell(f(n, map))).join(';'));
  return `﻿${rows.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------- JSON (RF-MAP-171)

/** The dataset of the map with the version of its schema (docs/specs/sitemap.schema.json). */
export function mapDataset(map, inv, { tool = null } = {}) {
  const { redirects, ecosystem, ...stats } = map.stats || {};
  return {
    schemaVersion: SCHEMA_VERSION,
    tool,
    inventory: { id: inv.id, site: inv.site || null, env: inv.env || null, baseUrl: inv.baseUrl, startedAt: inv.startedAt, finishedAt: inv.finishedAt || null },
    options: inv.options || {},
    rules: map.rules || {},
    support: map.support,
    warnings: map.warnings,
    summary: { root: map.root, mainHost: map.mainHost, siteDomain: map.siteDomain, nodes: map.nodes.length, ...stats },
    areas: map.areas,
    subareas: map.subareas,
    nodes: map.nodes,
    edges: map.edges,
    redirects: redirects || [],
    ecosystem: ecosystem || [],
    documents: inv.documents || [],
    notes: map.notes || { general: '', pages: {} },
  };
}

// ---------------------------------------------------------------- Markdown (RF-MAP-172, 163)

/** Text for a Markdown paragraph or table cell: special characters escaped, no line breaks. */
export function mdEsc(s) {
  return String(s ?? '').replace(/\r?\n+/g, ' ').replace(/([\\`*_{}[\]<>()#+!|~])/g, '\\$1').trim();
}
const mdUrl = (u) => String(u).replace(/[()\s]/g, (c) => encodeURIComponent(c));
const mmEsc = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;').replace(/[[\]{}()|]/g, ' ').slice(0, 60);
const MAX_BOXES = 40;

function mermaid(map) {
  const lines = ['flowchart LR'];
  const root = map._byId.get(map.root);
  const boxes = [];
  const edges = [];
  let n = 0;
  const id = () => `n${n++}`;
  const rootId = id();
  boxes.push(`${rootId}["${mmEsc(root?.shortName || 'Home')} — ${map.nodes.length} pagine"]`);
  const areaIds = new Map();
  const queue = [];
  for (const a of map.areas) if (a.name !== 'Home') queue.push({ kind: 'area', a });
  for (const s of map.subareas) queue.push({ kind: 'sub', s });
  let shown = 1;
  let left = 0;
  for (const q of queue.sort((x, y) => (y.a?.pages ?? y.s.pages) - (x.a?.pages ?? x.s.pages) || (x.kind === 'area' ? -1 : 1))) {
    // sub-areas only below an area that is drawn
    if (q.kind === 'sub' && !areaIds.has(q.s.area)) { left++; continue; }
    if (shown >= MAX_BOXES - 1) { left++; continue; }
    const nid = id();
    shown++;
    if (q.kind === 'area') {
      areaIds.set(q.a.name, nid);
      boxes.push(`${nid}["${mmEsc(q.a.name)} (${q.a.pages})"]`);
      edges.push(`${rootId} --> ${nid}`);
    } else {
      boxes.push(`${nid}["${mmEsc(q.s.name)} (${q.s.pages})"]`);
      edges.push(`${areaIds.get(q.s.area)} --> ${nid}`);
    }
  }
  if (left) {
    const nid = id();
    boxes.push(`${nid}["… altre ${left}"]`);
    edges.push(`${rootId} --> ${nid}`);
  }
  return [...lines, ...boxes.map((b) => `  ${b}`), ...edges.map((e) => `  ${e}`)].join('\n');
}

const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const REL = { main: 'principale', 'sibling-visited': 'fratello visitato', 'sibling-not-visited': 'fratello non visitato', external: 'esterno', sibling: 'fratello' };

export function mapMarkdown(map, inv) {
  indexed(map);
  const out = [];
  const s = map.stats;
  out.push(`# Mappa del sito ${mdEsc(siteLabel(map))} (${dateOf(inv)})`, '');
  if (map.notes?.general?.trim()) out.push(...map.notes.general.split(/\r?\n/).map((l) => `> ${mdEsc(l)}`), '');
  for (const w of map.warnings) out.push(`> **Avviso:** ${mdEsc(w)}`, '');
  out.push('## Struttura', '', '```mermaid', mermaid(map), '```', '');
  out.push('## Composizione', '', table(['Area', 'Pagine', 'Quota'], s.composition.byArea.map((a) => [mdEsc(a.area), a.pages, `${a.pct}%`])), '');
  out.push(table(['Livello', 'Pagine'], Object.entries(s.composition.byLevel).map(([l, c]) => [l, c])), '');
  out.push(table(['Host', 'Relazione', 'Pagine'], s.composition.byHost.map((h) => [mdEsc(h.host), REL[h.relation] || h.relation, h.pages])), '');
  out.push('## Collegamenti e contenuto', '', table(['Misura', 'Valore'], [
    ['Archi di contenuto', s.links.contentEdges], ['Voci della navigazione globale', s.links.globalNavPages], ['Raggiungibili solo dai menu', s.links.onlyFromMenus],
    ['Parole: media', s.content.avgWords ?? ''], ['Documenti unici', s.documents.unique],
  ]), '');
  out.push('## Ecosistema', '', s.ecosystem.length ? table(['Host', 'Relazione', 'Pagine che lo linkano'], s.ecosystem.map((e) => [mdEsc(e.host), REL[e.relation] || e.relation, e.pages])) : 'Nessun host.', '');
  out.push('## Redirect', '', s.redirects.length ? table(['Da', 'A', 'Status', 'Tipo'], s.redirects.map((r) => [mdEsc(r.id), mdEsc(r.target || r.finalUrl), r.status, r.crossHost ? 'tra host' : 'stesso host'])) : 'Nessun redirect.', '');
  out.push('## Catalogo per area', '');
  const names = (ids) => {
    const list = ids.slice(0, 4).map((x) => mdEsc(map._byId.get(x)?.shortName || x));
    return list.length ? `${list.join(', ')}${ids.length > 4 ? ` (+${ids.length - 4})` : ''}` : '';
  };
  for (const a of map.areas) {
    const nodes = map.nodes.filter((n) => n.area === a.name);
    out.push(`### ${mdEsc(a.name)} (${nodes.length})`, '');
    out.push(table(['Pagina', 'Title', 'Description', 'Link in uscita', 'Link in entrata', 'Documenti', 'Nota'], nodes.map((n) => [
      `[${mdEsc(n.shortName)}](${mdUrl(n.url)})`, mdEsc(n.title), mdEsc(n.description), names(n.contentOut), names(n.contentIn), n.documents.length || '', mdEsc(map.notes?.pages?.[n.id]),
    ])), '');
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------- PDF (RF-MAP-174)

const colorLight = (a) => a?.color?.light || '#8a8f98';

/** The radial diagram of areas and sub-areas as SVG, positions by d3-hierarchy (ADR-0021). */
export function radialSvg(map, d3) {
  const tree = { name: map.nodes.find((n) => n.id === map.root)?.shortName || 'Home', pages: map.nodes.length, color: '#13306f', children: [] };
  const areaOf = new Map();
  for (const a of map.areas) {
    if (a.name === 'Home') continue;
    const node = { name: a.name, pages: a.pages, color: colorLight(a), children: [] };
    areaOf.set(a.name, node);
    tree.children.push(node);
  }
  for (const s of map.subareas) areaOf.get(s.area)?.children.push({ name: s.name, pages: s.pages, color: colorLight(map.areas.find((a) => a.name === s.area)), children: [] });
  const R = 260;
  const root = d3.hierarchy(tree);
  d3.tree().size([2 * Math.PI, R]).separation((a, b) => (a.parent === b.parent ? 1 : 1.5))(root);
  const pt = (d) => [d.y * Math.cos(d.x - Math.PI / 2), d.y * Math.sin(d.x - Math.PI / 2)];
  const f = (v) => Math.round(v * 10) / 10;
  const parts = [];
  root.links().forEach((l) => {
    const [x1, y1] = pt(l.source), [x2, y2] = pt(l.target);
    parts.push(`<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="#c9ced6" stroke-width="1"/>`);
  });
  root.descendants().forEach((d) => {
    const [x, y] = pt(d);
    const r = d.depth === 0 ? 14 : d.depth === 1 ? 7 + Math.min(8, Math.sqrt(d.data.pages) / 3) : 4;
    parts.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${pEsc(d.data.color)}"/>`);
    if (d.depth === 0) return;
    const left = d.x > Math.PI;
    const deg = (d.x * 180) / Math.PI - 90;
    const label = `${d.data.name.length > 26 ? `${d.data.name.slice(0, 25)}…` : d.data.name} (${d.data.pages})`;
    parts.push(`<text transform="translate(${f(x)},${f(y)}) rotate(${f(deg)}) translate(${f(r + 4)},0)${left ? ' rotate(180)' : ''}" text-anchor="${left ? 'end' : 'start'}" dominant-baseline="middle" font-size="${d.depth === 1 ? 14 : 11}" fill="#1b1f24">${pEsc(label)}</text>`);
  });
  return `<svg viewBox="-570 -480 1140 960" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Diagramma radiale delle aree">${parts.join('')}</svg>`;
}

const MAX_TREE_LINES = 1500;
const MAX_AREA_ROWS = 250;

export function mapPrintHtml(map, inv, { d3 = null, version = '', generatedAt = new Date().toISOString() } = {}) {
  indexed(map);
  const s = map.stats;
  const site = siteLabel(map);
  const when = dateOf(inv);
  const esc = pEsc;
  const bodyParts = [];
  bodyParts.push(`<div class="cover"><div class="brand">◎ sitescanner</div><div class="kind">Mappa del sito</div><h1>${esc(site)}</h1><div class="url">${esc(inv.baseUrl)}</div>
    <div class="scans" style="margin-top:12mm"><div class="box"><h4>Inventario</h4><div><b>${esc(pDate(inv.startedAt))}</b>${inv.env ? ` · ${esc(inv.env)}` : ''}</div><div class="id">${esc(inv.id)}</div><div class="muted">${pNum(map.nodes.length)} pagine in ${pNum(map.areas.length)} aree</div></div></div>
    ${map.notes?.general?.trim() ? `<div class="box" style="margin-top:6mm"><h4>Nota</h4><div style="white-space:pre-wrap">${esc(map.notes.general)}</div></div>` : ''}
    <div class="toc"><b>Contenuti</b><ol><li>Sintesi</li><li>Struttura</li><li>Ecosistema e redirect</li><li>Albero</li><li>Catalogo per area</li></ol></div>
    <div class="gen">Generato il ${esc(pDate(generatedAt))} da sitescanner ${esc(version)}.</div></div>`);
  bodyParts.push(`<section><h2>Sintesi</h2>${map.warnings.map((w) => `<p class="more">${esc(w)}</p>`).join('')}
    <div class="kpis">${kpi('Pagine', pNum(map.nodes.length))}${kpi('Aree', pNum(map.areas.length))}${kpi('Documenti unici', pNum(s.documents.unique))}${kpi('Navigazione globale', pNum(s.links.globalNavPages), 'voci')}
    ${kpi('Solo dai menu', pNum(s.links.onlyFromMenus), 'pagine')}${kpi('Parole (media)', pNum(s.content.avgWords))}${kpi('Pagine con poco testo', pNum(s.content.thin))}${kpi('Redirect', pNum(s.redirects.length))}</div>
    <h3>Composizione per area</h3><table><thead><tr><th>Area</th><th class="num">Pagine</th><th class="num">Quota</th></tr></thead><tbody>${s.composition.byArea.map((a) => `<tr><td>${esc(a.area)}</td><td class="num">${pNum(a.pages)}</td><td class="num">${a.pct}%</td></tr>`).join('')}</tbody></table>
    <h3>Per livello e per host</h3><table><thead><tr><th>Livello</th><th class="num">Pagine</th></tr></thead><tbody>${Object.entries(s.composition.byLevel).map(([l, c]) => `<tr><td>${esc(l)}</td><td class="num">${pNum(c)}</td></tr>`).join('')}</tbody></table>
    <table><thead><tr><th>Host</th><th>Relazione</th><th class="num">Pagine</th></tr></thead><tbody>${s.composition.byHost.map((h) => `<tr><td class="key">${esc(h.host)}</td><td>${esc(REL[h.relation] || h.relation)}</td><td class="num">${pNum(h.pages)}</td></tr>`).join('')}</tbody></table></section>`);
  bodyParts.push(`<section class="newpage"><h2>Struttura</h2>${d3 ? radialSvg(map, d3) : '<p class="empty">Diagramma non disponibile.</p>'}</section>`);
  bodyParts.push(`<section class="newpage"><h2>Ecosistema e redirect</h2>
    <h3>Host linkati</h3><table><thead><tr><th>Host</th><th>Relazione</th><th class="num">Pagine che lo linkano</th></tr></thead><tbody>${s.ecosystem.map((e) => `<tr><td class="key">${esc(e.host)}</td><td>${esc(REL[e.relation] || e.relation)}</td><td class="num">${pNum(e.pages)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">Nessuno.</td></tr>'}</tbody></table>
    <h3>Redirect</h3><table><thead><tr><th>Da</th><th>A</th><th class="num">Status</th><th>Tipo</th></tr></thead><tbody>${s.redirects.slice(0, 200).map((r) => `<tr><td class="key">${esc(r.id)}</td><td class="key">${esc(r.target || r.finalUrl)}</td><td class="num">${esc(r.status)}</td><td>${r.crossHost ? 'tra host' : 'stesso host'}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nessuno.</td></tr>'}</tbody></table></section>`);
  // the tree as an indented list
  const lines = [];
  const walk = (id, depth) => {
    if (lines.length >= MAX_TREE_LINES) return;
    const n = map._byId.get(id);
    if (!n) return;
    lines.push(`<div style="padding-left:${depth * 4}mm"><b>${esc(n.shortName)}</b> <span class="muted key">${esc((n.host === map.mainHost ? '' : n.host) + n.key)}</span></div>`);
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(map.root, 0);
  bodyParts.push(`<section class="newpage"><h2>Albero</h2><div style="font-size:8pt">${lines.join('')}</div>${map.nodes.length > lines.length ? `<p class="more">… e altre ${pNum(map.nodes.length - lines.length)} pagine: l'elenco completo è nel Catalogo e negli export.</p>` : ''}</section>`);
  bodyParts.push(`<section class="newpage"><h2>Catalogo per area</h2>${map.areas.map((a) => {
    const nodes = map.nodes.filter((n) => n.area === a.name);
    return `<h3>${esc(a.name)} <span class="muted">(${pNum(nodes.length)})</span></h3><table><thead><tr><th style="width:26%">Pagina</th><th>Title e description</th><th class="num">Parole</th><th class="num">Link in/out</th><th class="num">Doc.</th></tr></thead><tbody>${nodes.slice(0, MAX_AREA_ROWS).map((n) => `<tr><td><b>${esc(n.shortName)}</b><div class="key muted">${esc((n.host === map.mainHost ? '' : n.host) + n.key)}</div></td><td>${esc(n.title || '')}${n.description ? `<div class="muted">${esc(n.description)}</div>` : ''}${map.notes?.pages?.[n.id] ? `<div style="white-space:pre-wrap"><i>Nota:</i> ${esc(map.notes.pages[n.id])}</div>` : ''}</td><td class="num">${pNum(n.wordCount)}</td><td class="num">${pNum(n.contentIn.length)} / ${pNum(n.contentOut.length)}</td><td class="num">${n.documents.length || ''}</td></tr>`).join('')}</tbody></table>${nodes.length > MAX_AREA_ROWS ? `<p class="more">… e altre ${pNum(nodes.length - MAX_AREA_ROWS)} pagine.</p>` : ''}`;
  }).join('')}</section>`);
  return printDocument(`Mappa del sito ${site}`, site, 'Mappa del sito', when, bodyParts.join('\n'));
}

