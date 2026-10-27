// The offline bundle of the site map (spec §14.7, RF-MAP-173): a ZIP with an index.html that opens from file://,
// the data of the map, the libraries of the graph and the same view code as the web app, in read-only mode.
// Like the report (ADR-0007) it loads its data with a classic script: ES modules do not load from file://, so
// the view modules are joined into one script with their import/export lines taken out.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipFiles } from './core/zip.js';
import { exportFileName } from './core/mapexport.js';

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
export const VENDOR_FILES = ['d3-dispatch', 'd3-quadtree', 'd3-timer', 'd3-force', 'd3-hierarchy'];

/** d3-hierarchy of src/web/vendor/, loaded into Node for the diagram of the PDF. */
export function loadD3Hierarchy() {
  const code = fs.readFileSync(path.join(webDir, 'vendor', 'd3-hierarchy.min.js'), 'utf8');
  const mod = { exports: {} };
  new Function('exports', 'module', code)(mod.exports, mod);
  return mod.exports;
}

const read = (...p) => fs.readFileSync(path.join(webDir, ...p), 'utf8');

/** A module of the web app as a piece of a classic script: no imports, no `export`. */
function plain(src) {
  return src.replace(/^import .*;\s*$/gm, '').replace(/^export (async function|function|const|let|class) /gm, '$1 ');
}

// what the editing code of the web app provides and the read-only bundle does not need
const STUBS = 'const openRulesEditor = () => {}, openMoveDialog = () => {}, withAreaRule = () => ({}), withParentRule = () => ({});';

const APP = `
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('it-IT'));
const DATA = window.__SITEMAP__;
const api = async (method, p) => {
  if (method === 'GET' && /\\/map$/.test(p)) return DATA.map;
  throw new Error('Il bundle è in sola lettura');
};
const TABS = [['overview', 'Panoramica'], ['graph', 'Grafo'], ['tree', 'Albero'], ['catalog', 'Catalogo'], ['redirects', 'Redirect ed ecosistema']];
async function route() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const tab = TABS.some(([k]) => k === q.get('tab')) ? q.get('tab') : 'overview';
  const inv = DATA.inventory;
  const href = (k) => '#/inventory/' + encodeURIComponent(inv.id) + '?tab=' + k;
  document.getElementById('app').innerHTML = '<div class="head"><div><h1 class="mono" style="font-size:18px">' + esc(inv.baseUrl) + '</h1><div class="sub">Mappa del sito · inventario del ' + esc(String(inv.startedAt).slice(0, 10)) + ' · <span class="mono">' + esc(inv.id) + '</span> · sola lettura</div></div></div>'
    + '<nav class="tabs" aria-label="Viste della mappa">' + TABS.map(([k, l]) => '<a class="tab' + (k === tab ? ' on' : '') + '" href="' + href(k) + '">' + l + '</a>').join('') + '</nav><div id="mapRoot"></div>';
  const root = document.getElementById('mapRoot');
  const args = { root, id: inv.id, api, esc, fmtNum, readonly: true };
  if (tab === 'overview') await mountMapStats(args);
  else await mountMapViews({ ...args, tab, params: q });
}
window.addEventListener('hashchange', route);
route();
`;

const INDEX = (title) => `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${String(title).replace(/[<>&"]/g, '')}</title>
<link rel="stylesheet" href="app.css"></head>
<body><header class="topbar"><span class="brand"><span class="logo" aria-hidden="true">◎</span> sitescanner · mappa del sito</span></header>
<main id="app"><p class="empty">Caricamento…</p></main>
<div id="tip" class="tip" hidden></div>
<script src="map-data.js"></script>
${VENDOR_FILES.map((v) => `<script src="vendor/${v}.min.js"></script>`).join('\n')}
<script src="bundle.js"></script>
</body></html>
`;

/** @returns {Buffer} the ZIP */
export function mapBundle(map, inv, { dataset }) {
  // a data script must not be closed by its own content
  const json = JSON.stringify({ inventory: dataset.inventory, map }).replace(/</g, String.fromCharCode(92)+'u003c').split(String.fromCharCode(0x2028)).join(String.fromCharCode(92)+'u2028').split(String.fromCharCode(0x2029)).join(String.fromCharCode(92)+'u2029');
  const bundle = `(function () {\n'use strict';\n${STUBS}\n${plain(read('mapgraph.js'))}\n${plain(read('mapview.js'))}\n${APP}\n})();\n`;
  const files = [
    { name: 'index.html', data: INDEX(`Mappa del sito ${new URL(inv.baseUrl).host}`) },
    { name: 'map-data.js', data: `window.__SITEMAP__ = ${json};\n` },
    { name: 'bundle.js', data: bundle },
    { name: 'app.css', data: read('app.css') },
    ...VENDOR_FILES.flatMap((v) => [
      { name: `vendor/${v}.min.js`, data: fs.readFileSync(path.join(webDir, 'vendor', `${v}.min.js`)) },
      { name: `vendor/${v}.LICENSE`, data: fs.readFileSync(path.join(webDir, 'vendor', `${v}.LICENSE`)) },
    ]),
  ];
  return { buffer: zipFiles(files), files, fileName: exportFileName(inv, 'zip') };
}
