import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dirs, UserError } from './config.js';

// Layout:
//   data/<site>/scans/<scanId>/scan.json        immutable snapshot (read-only on disk)
//   data/<site>/scans/<scanId>/screenshots/*.png
//   data/<site>/scans/<scanId>/html/*.html      only with --keep-html
//   data/<site>/labels.json                     mutable overlay: label/note edited after the scan

export function siteDataDir(site) {
  return path.join(dirs.data, site);
}

export function scansDir(site) {
  return path.join(siteDataDir(site), 'scans');
}

export function scanDir(site, id) {
  return path.join(scansDir(site), id);
}

export function newScanId(date = new Date()) {
  const ts = date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${ts}-${crypto.randomBytes(2).toString('hex')}`;
}

// Creates a staging directory; commitScan() renames it into place atomically.
export function stageScan(site, id) {
  const dir = path.join(scansDir(site), `.${id}.partial`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeReadOnly(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) makeReadOnly(p);
    else fs.chmodSync(p, 0o444);
  }
}

export function commitScan(site, id, stagingDir, snapshot) {
  fs.writeFileSync(path.join(stagingDir, 'scan.json'), JSON.stringify(snapshot));
  makeReadOnly(stagingDir);
  const final = scanDir(site, id);
  if (fs.existsSync(final)) throw new Error(`La scan ${id} esiste già`);
  fs.renameSync(stagingDir, final);
  return final;
}

export function discardStaging(stagingDir) {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}

export function listDataSites() {
  if (!fs.existsSync(dirs.data)) return [];
  return fs.readdirSync(dirs.data, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(scansDir(d.name)))
    .map((d) => d.name)
    .sort();
}

export function readLabels(site) {
  const f = path.join(siteDataDir(site), 'labels.json');
  if (!fs.existsSync(f)) return {};
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return {};
  }
}

export function writeLabel(site, id, { label, note }) {
  const labels = readLabels(site);
  const cur = labels[id] || {};
  labels[id] = {
    ...cur,
    ...(label !== undefined ? { label } : {}),
    ...(note !== undefined ? { note } : {}),
    updatedAt: new Date().toISOString(),
  };
  const f = path.join(siteDataDir(site), 'labels.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(labels, null, 2));
  fs.renameSync(tmp, f);
  return labels[id];
}

const cache = new Map();

export function loadScan(site, id) {
  const k = `${site}/${id}`;
  if (cache.has(k)) return cache.get(k);
  const f = path.join(scanDir(site, id), 'scan.json');
  if (!fs.existsSync(f)) throw new UserError(`Scan ${id} non trovata per il sito ${site}`);
  const scan = JSON.parse(fs.readFileSync(f, 'utf8'));
  const overlay = readLabels(site)[id];
  if (overlay) {
    if (overlay.label !== undefined) scan.label = overlay.label;
    if (overlay.note !== undefined) scan.note = overlay.note;
  }
  cache.set(k, scan);
  return scan;
}

// Lightweight metadata for every committed scan, oldest first.
export function listScans(site) {
  const dir = scansDir(site);
  if (!fs.existsSync(dir)) return [];
  const labels = readLabels(site);
  const out = [];
  for (const id of fs.readdirSync(dir).sort()) {
    if (id.startsWith('.')) continue;
    const f = path.join(dir, id, 'scan.json');
    if (!fs.existsSync(f)) continue;
    let s;
    try {
      s = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      continue;
    }
    const o = labels[id] || {};
    out.push({
      id,
      site,
      env: s.env,
      baseUrl: s.baseUrl,
      label: o.label !== undefined ? o.label : s.label || null,
      note: o.note !== undefined ? o.note : s.note || null,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      stats: s.stats,
      options: s.options,
    });
  }
  return out.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)) || a.id.localeCompare(b.id));
}

/**
 * Resolves a scan reference: exact id, unique id prefix, label (most recent wins),
 * "latest", "latest~N" (N scans before the latest).
 */
export function resolveScanRef(site, ref) {
  const scans = listScans(site);
  if (!scans.length) throw new UserError(`Nessuna scan per il sito ${site}`);
  const r = String(ref);
  const m = /^latest(?:~(\d+))?$/.exec(r);
  if (m) {
    const n = Number(m[1] || 0);
    const s = scans[scans.length - 1 - n];
    if (!s) throw new UserError(`${r}: ci sono solo ${scans.length} scan per ${site}`);
    return s.id;
  }
  const exact = scans.find((s) => s.id === r);
  if (exact) return exact.id;
  const byLabel = scans.filter((s) => s.label === r);
  if (byLabel.length) return byLabel[byLabel.length - 1].id;
  const byPrefix = scans.filter((s) => s.id.startsWith(r));
  if (byPrefix.length === 1) return byPrefix[0].id;
  if (byPrefix.length > 1) throw new UserError(`Riferimento ambiguo "${r}": ${byPrefix.map((s) => s.id).join(', ')}`);
  throw new UserError(`Scan "${r}" non trovata per ${site} (usa un id, un prefisso, una label, "latest" o "latest~N")`);
}
