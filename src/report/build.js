import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSite } from '../config.js';
import { allSiteIds } from '../store.js';
import { storageFor } from '../storage/index.js';
import { TOOL } from '../version.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, f), 'utf8');

const toUrl = (p) => p.split(path.sep).map(encodeURIComponent).join('/');
// JSON safe to embed inside a <script> block.
const js = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function renderIndexHtml() {
  // Core modules share one script scope in the browser: drop their imports and exports.
  const core = ['../core/compare.js', '../core/diagnose.js', '../core/print.js']
    .map((f) => read(f).replace(/^import .*$/gm, '').replace(/^export /gm, ''))
    .join('\n');
  return read('app.html')
    .replace('/*__CSS__*/', () => read('app.css'))
    .replace('/*__CORE__*/', () => core)
    .replace('/*__APP__*/', () => read('app.js'))
    .replaceAll('__VERSION__', TOOL.version);
}

// The JSONP wrappers the report loads with <script> (ADR-0007).
export const indexJs = (index) => `window.SS_INDEX=${js(index)};\n`;
export const scanJs = (site, id, scan) => `SS_LOAD("scan",${js(site)},${js(id)},${js(scan)});\n`;
export const textJs = (site, id, textJson) => `SS_LOAD("text",${js(site)},${js(id)},${String(textJson).replace(/</g, '\\u003c')});\n`;

/**
 * Index of the report for an area: sites with their scans.
 * `assetsFor(site, id)` gives the URL prefix of the scan's screenshots; `hasText(site, id)` whether it has text.
 */
export async function reportIndex(st, { sites = null, onlyScans = null, preselect = null, assetsFor, hasText }) {
  const ids = sites && sites.length ? sites : await allSiteIds(st);
  const index = { generatedAt: new Date().toISOString(), tool: TOOL, preselect, sites: [] };
  for (const site of ids) {
    let cfg = null;
    try { cfg = await loadSite(st, site); } catch { /* site config may be gone: history is still reportable */ }
    let scans = await st.listScans(site);
    if (onlyScans) scans = scans.filter((s) => (onlyScans[site] || []).includes(s.id));
    if (!scans.length && onlyScans) continue;
    const entries = [];
    for (const meta of scans) entries.push({ ...meta, assets: await assetsFor(site, meta.id), hasText: await hasText(site, meta) });
    index.sites.push({
      id: site,
      name: (cfg && cfg.name) || (scans[0] && scans[0].siteName) || site,
      envs: cfg ? Object.fromEntries(Object.entries(cfg.envs).map(([k, v]) => [k, v.baseUrl])) : {},
      compare: cfg ? cfg.compare : { ignore: [], thresholds: {} },
      scans: entries,
    });
  }
  return index;
}

function writeIfChanged(file, content) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return;
  fs.writeFileSync(file, content);
}

/**
 * Builds the static report from a filesystem storage (the report points at its scan folders).
 * @param {object} o
 * @param {string} o.outDir
 * @param {object}  [o.storage]     storage of the area (default: the working folder)
 * @param {string[]} [o.sites]       restrict to these sites
 * @param {object}  [o.onlyScans]    { site: [scanIds] } restrict scans (export)
 * @param {boolean} [o.copyAssets]   copy screenshots into the output (self-contained bundle)
 * @param {object}  [o.preselect]    { site, base, head }
 */
export async function buildReport({ outDir, sites, onlyScans = null, copyAssets = false, preselect = null, storage: st = storageFor() }) {
  const out = path.resolve(outDir);
  const dataOut = path.join(out, 'data');
  fs.mkdirSync(dataOut, { recursive: true });

  const assetsFor = async (site, id) => {
    const src = st.localScanDir(site, id);
    if (!copyAssets) return toUrl(path.relative(out, src)) + '/';
    const dest = path.join(out, 'assets', site, id);
    if (fs.existsSync(path.join(src, 'screenshots'))) {
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(path.join(src, 'screenshots'), path.join(dest, 'screenshots'), { recursive: true });
      // copied files inherit 0444; keep the bundle deletable/overwritable
      for (const f of fs.readdirSync(path.join(dest, 'screenshots'))) fs.chmodSync(path.join(dest, 'screenshots', f), 0o644);
    }
    return toUrl(path.relative(out, dest)) + '/';
  };
  const hasText = async (site, meta) => fs.existsSync(path.join(st.localScanDir(site, meta.id), 'text.json'));
  const index = await reportIndex(st, { sites, onlyScans, preselect, assetsFor, hasText });

  let scanCount = 0;
  for (const s of index.sites) {
    const siteOut = path.join(dataOut, s.id);
    fs.mkdirSync(siteOut, { recursive: true });
    const keep = new Set();
    for (const meta of s.scans) {
      // Scans are immutable: the JSONP wrapper only needs writing once.
      const file = path.join(siteOut, `${meta.id}.js`);
      keep.add(path.basename(file));
      if (!fs.existsSync(file)) fs.writeFileSync(file, scanJs(s.id, meta.id, await st.loadScan(s.id, meta.id)));
      if (meta.hasText) {
        const tf = path.join(siteOut, `${meta.id}.text.js`);
        keep.add(path.basename(tf));
        if (!fs.existsSync(tf)) fs.writeFileSync(tf, textJs(s.id, meta.id, await st.readScanFile(s.id, meta.id, 'text.json')));
      }
      scanCount++;
    }
    for (const f of fs.readdirSync(siteOut)) if (!keep.has(f)) fs.rmSync(path.join(siteOut, f));
  }

  // A full build drops the data of sites that no longer exist (e.g. history deleted from the web app).
  if (!sites && !onlyScans) {
    const live = new Set(index.sites.map((s) => s.id));
    for (const e of fs.readdirSync(dataOut, { withFileTypes: true })) if (e.isDirectory() && !live.has(e.name)) fs.rmSync(path.join(dataOut, e.name), { recursive: true, force: true });
  }
  writeIfChanged(path.join(dataOut, 'index.js'), indexJs(index));
  fs.writeFileSync(path.join(out, 'index.html'), renderIndexHtml());
  return { outDir: out, sites: index.sites.length, scans: scanCount };
}
