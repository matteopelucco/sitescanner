import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSiteIds, loadSite } from '../config.js';
import { listDataSites, listScans, loadScan, scanDir } from '../store.js';
import { TOOL } from '../version.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, f), 'utf8');

const toUrl = (p) => p.split(path.sep).map(encodeURIComponent).join('/');
// JSON safe to embed inside a <script> block.
const js = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function renderIndexHtml() {
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

function writeIfChanged(file, content) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return;
  fs.writeFileSync(file, content);
}

/**
 * Builds the static report.
 * @param {object} o
 * @param {string} o.outDir
 * @param {string[]} [o.sites]       restrict to these sites
 * @param {object}  [o.onlyScans]    { site: [scanIds] } restrict scans (export)
 * @param {boolean} [o.copyAssets]   copy screenshots into the output (self-contained bundle)
 * @param {object}  [o.preselect]    { site, base, head }
 */
export function buildReport({ outDir, sites, onlyScans = null, copyAssets = false, preselect = null }) {
  const out = path.resolve(outDir);
  const dataOut = path.join(out, 'data');
  fs.mkdirSync(dataOut, { recursive: true });

  const ids = sites && sites.length ? sites : [...new Set([...listSiteIds(), ...listDataSites()])].sort();
  const index = { generatedAt: new Date().toISOString(), tool: TOOL, preselect, sites: [] };
  let scanCount = 0;

  for (const site of ids) {
    let cfg = null;
    try { cfg = loadSite(site); } catch { /* site config may be gone: history is still reportable */ }
    let scans = listScans(site);
    if (onlyScans) scans = scans.filter((s) => (onlyScans[site] || []).includes(s.id));
    if (!scans.length && onlyScans) continue;

    const siteOut = path.join(dataOut, site);
    fs.mkdirSync(siteOut, { recursive: true });
    const keep = new Set();
    const entries = [];
    for (const meta of scans) {
      const src = scanDir(site, meta.id);
      let assets;
      if (copyAssets) {
        const dest = path.join(out, 'assets', site, meta.id);
        if (fs.existsSync(path.join(src, 'screenshots'))) {
          fs.mkdirSync(dest, { recursive: true });
          fs.cpSync(path.join(src, 'screenshots'), path.join(dest, 'screenshots'), { recursive: true });
          // copied files inherit 0444; keep the bundle deletable/overwritable
          for (const f of fs.readdirSync(path.join(dest, 'screenshots'))) fs.chmodSync(path.join(dest, 'screenshots', f), 0o644);
        }
        assets = toUrl(path.relative(out, dest)) + '/';
      } else {
        assets = toUrl(path.relative(out, src)) + '/';
      }

      // Scans are immutable: the JSONP wrapper only needs writing once.
      const scanJs = path.join(siteOut, `${meta.id}.js`);
      keep.add(path.basename(scanJs));
      if (!fs.existsSync(scanJs)) {
        const scan = loadScan(site, meta.id);
        fs.writeFileSync(scanJs, `SS_LOAD("scan",${js(site)},${js(meta.id)},${js(scan)});\n`);
      }
      const textSrc = path.join(src, 'text.json');
      let hasText = false;
      if (fs.existsSync(textSrc)) {
        hasText = true;
        const textJs = path.join(siteOut, `${meta.id}.text.js`);
        keep.add(path.basename(textJs));
        if (!fs.existsSync(textJs)) {
          fs.writeFileSync(textJs, `SS_LOAD("text",${js(site)},${js(meta.id)},${fs.readFileSync(textSrc, 'utf8').replace(/</g, '\\u003c')});\n`);
        }
      }
      entries.push({ ...meta, assets, hasText });
      scanCount++;
    }
    for (const f of fs.readdirSync(siteOut)) if (!keep.has(f)) fs.rmSync(path.join(siteOut, f));

    index.sites.push({
      id: site,
      name: (cfg && cfg.name) || (scans[0] && scans[0].siteName) || site,
      envs: cfg ? Object.fromEntries(Object.entries(cfg.envs).map(([k, v]) => [k, v.baseUrl])) : {},
      compare: cfg ? cfg.compare : { ignore: [], thresholds: {} },
      scans: entries,
    });
  }

  // A full build drops the data of sites that no longer exist (e.g. history deleted from the web app).
  if (!sites && !onlyScans) {
    const live = new Set(index.sites.map((s) => s.id));
    for (const e of fs.readdirSync(dataOut, { withFileTypes: true })) if (e.isDirectory() && !live.has(e.name)) fs.rmSync(path.join(dataOut, e.name), { recursive: true, force: true });
  }
  writeIfChanged(path.join(dataOut, 'index.js'), `window.SS_INDEX=${js(index)};\n`);
  fs.writeFileSync(path.join(out, 'index.html'), renderIndexHtml());
  return { outDir: out, sites: index.sites.length, scans: scanCount };
}
