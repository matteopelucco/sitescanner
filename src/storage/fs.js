import fs from 'node:fs';
import path from 'node:path';
import { UserError, validSiteId } from '../errors.js';

// Layout of an area (the working folder in single-user mode, users/<username>/ with accounts):
//   sites/<id>.yml                                   site configuration, comments included
//   data/<site>/scans/<scanId>/scan.json             immutable snapshot (read-only on disk)
//   data/<site>/scans/<scanId>/screenshots/*.png
//   data/<site>/scans/<scanId>/text.json             extracted text (optional)
//   data/<site>/scans/<scanId>/html/*.html           only with --keep-html
//   data/<site>/labels.json                          mutable overlay: label/note edited after the scan
//   inventory/<id>.json, inventory/<id>.meta.json    inventories

// Few entries: the web app keeps the process alive and snapshots can be large.
const cache = new Map();
const CACHE_SIZE = 8;

const validInventoryId = (id) => /^[\w-]+$/.test(String(id));
// Paths inside a scan folder, e.g. "screenshots/ab12.png": no traversal, no absolute paths.
const validRel = (rel) => typeof rel === 'string' && rel !== '' && !rel.split(/[\\/]/).some((p) => p === '..' || p === '') && !path.isAbsolute(rel);

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function makeReadOnly(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) makeReadOnly(p);
    else fs.chmodSync(p, 0o444);
  }
}

function makeWritable(p) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return;
  fs.chmodSync(p, st.isDirectory() ? 0o755 : 0o644);
  if (st.isDirectory()) for (const f of fs.readdirSync(p)) makeWritable(path.join(p, f));
}

/** Storage of one area on the local filesystem. Every method is async, as for the other backends. */
export class FsStorage {
  kind = 'fs';

  /** `isolated`: a private area of an account (multi-user rules apply, e.g. RF-SEC-02). */
  constructor(root, { isolated = false } = {}) {
    this.root = path.resolve(root);
    this.isolated = isolated;
    this.key = `fs:${this.root}`;
  }

  get dirs() {
    return { sites: path.join(this.root, 'sites'), data: path.join(this.root, 'data'), inventory: path.join(this.root, 'inventory') };
  }

  // ---------------- sites ----------------

  siteFile(id) {
    if (!validSiteId(id)) return null;
    for (const ext of ['yml', 'yaml']) {
      const f = path.join(this.dirs.sites, `${id}.${ext}`);
      if (fs.existsSync(f)) return f;
    }
    return null;
  }

  async listSiteIds() {
    if (!fs.existsSync(this.dirs.sites)) return [];
    return fs.readdirSync(this.dirs.sites)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => f.replace(/\.ya?ml$/, ''))
      .filter(validSiteId)
      .sort();
  }

  /** YAML source of a site, or null if it is not configured. */
  async readSiteRaw(id) {
    const f = this.siteFile(id);
    return f ? fs.readFileSync(f, 'utf8') : null;
  }

  /** Where a site is configured, for error messages. */
  siteLocation(id) {
    return this.siteFile(id) || path.join(this.dirs.sites, `${id}.yml`);
  }

  get sitesLocation() {
    return this.dirs.sites;
  }

  /** Writes the YAML source atomically. `create` refuses to overwrite an existing site. */
  async writeSiteRaw(id, raw, { create = false } = {}) {
    if (!validSiteId(id)) throw new UserError(`Id sito non valido: ${id} (ammessi lettere, cifre, "_", "-", ".")`);
    const existing = this.siteFile(id);
    if (create && existing) throw new UserError(`Il sito "${id}" esiste già`);
    writeAtomic(existing || path.join(this.dirs.sites, `${id}.yml`), raw);
  }

  /** Removes only the configuration: the history stays. Returns false if the site was not configured. */
  async deleteSiteConfig(id) {
    const f = this.siteFile(id);
    if (!f) return false;
    fs.rmSync(f);
    return true;
  }

  // ---------------- scans ----------------

  siteDataDir(site) {
    return path.join(this.dirs.data, site);
  }

  scansDir(site) {
    return path.join(this.siteDataDir(site), 'scans');
  }

  /** Folder of a committed scan: only this backend has one (static report, CLI). */
  localScanDir(site, id) {
    return path.join(this.scansDir(site), id);
  }

  async listDataSites() {
    if (!fs.existsSync(this.dirs.data)) return [];
    return fs.readdirSync(this.dirs.data, { withFileTypes: true })
      .filter((d) => d.isDirectory() && validSiteId(d.name) && fs.existsSync(this.scansDir(d.name)))
      .map((d) => d.name)
      .sort();
  }

  async readLabels(site) {
    const f = path.join(this.siteDataDir(site), 'labels.json');
    if (!fs.existsSync(f)) return {};
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      return {};
    }
  }

  async writeLabel(site, id, { label, note }) {
    const labels = await this.readLabels(site);
    const cur = labels[id] || {};
    labels[id] = {
      ...cur,
      ...(label !== undefined ? { label } : {}),
      ...(note !== undefined ? { note } : {}),
      updatedAt: new Date().toISOString(),
    };
    writeAtomic(path.join(this.siteDataDir(site), 'labels.json'), JSON.stringify(labels, null, 2));
    cache.delete(`${this.key}/${site}/${id}`);
    return labels[id];
  }

  /** Lightweight metadata for every committed scan, oldest first. */
  async listScans(site) {
    if (!validSiteId(site)) return [];
    const dir = this.scansDir(site);
    if (!fs.existsSync(dir)) return [];
    const labels = await this.readLabels(site);
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

  async loadScan(site, id) {
    const k = `${this.key}/${site}/${id}`;
    if (cache.has(k)) return cache.get(k);
    const f = validSiteId(site) && validRel(id) && path.join(this.localScanDir(site, id), 'scan.json');
    if (!f || !fs.existsSync(f)) throw new UserError(`Scan ${id} non trovata per il sito ${site}`);
    const scan = JSON.parse(fs.readFileSync(f, 'utf8'));
    const overlay = (await this.readLabels(site))[id];
    if (overlay) {
      if (overlay.label !== undefined) scan.label = overlay.label;
      if (overlay.note !== undefined) scan.note = overlay.note;
    }
    cache.set(k, scan);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    return scan;
  }

  /** A file of a committed scan (e.g. "text.json", "screenshots/x.png"), or null. */
  async readScanFile(site, id, rel) {
    if (!validSiteId(site) || !validRel(id) || !validRel(rel)) return null;
    const f = path.join(this.localScanDir(site, id), rel);
    return fs.existsSync(f) && fs.statSync(f).isFile() ? fs.readFileSync(f) : null;
  }

  /** Local working folder for a scan in progress; commitScan() makes it the snapshot. */
  async stageScan(site, id) {
    if (!validSiteId(site)) throw new UserError(`Id sito non valido: ${site}`);
    const dir = path.join(this.scansDir(site), `.${id}.partial`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Writes scan.json, makes the files read-only and renames the folder into place (atomic). */
  async commitScan(site, id, stagingDir, snapshot) {
    fs.writeFileSync(path.join(stagingDir, 'scan.json'), JSON.stringify(snapshot));
    makeReadOnly(stagingDir);
    const final = this.localScanDir(site, id);
    if (fs.existsSync(final)) throw new Error(`La scan ${id} esiste già`);
    fs.renameSync(stagingDir, final);
  }

  async discardStaging(stagingDir) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  // Scans in steps (spec §11.4): locally the staging folder is the same for every step.

  /** Working folder of one step of a scan: here the staging folder itself. */
  async stepWorkDir(site, id) {
    return this.stageScan(site, id);
  }

  /** Files written by a step stay in the staging folder until the commit. */
  async flushStaging() {}

  /** Removes everything an uncommitted scan left behind. */
  async discardScan(site, id) {
    if (validSiteId(site) && validRel(id)) fs.rmSync(path.join(this.scansDir(site), `.${id}.partial`), { recursive: true, force: true });
  }

  /**
   * Deletes the whole history of a site (snapshots, screenshots, text, labels): the only exception to
   * RF-DATA-13, on explicit request. Snapshot files are read-only, so they are made writable first.
   * @returns {Promise<number>} the number of scans deleted
   */
  async deleteSiteData(site) {
    if (!validSiteId(site)) throw new UserError(`Id sito non valido: ${site}`);
    const dir = this.siteDataDir(site);
    if (!fs.existsSync(dir)) return 0;
    const n = (await this.listScans(site)).length;
    makeWritable(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    for (const k of [...cache.keys()]) if (k.startsWith(`${this.key}/${site}/`)) cache.delete(k);
    return n;
  }

  // ---------------- inventories ----------------

  invFile(id, ext = 'json') {
    if (!validInventoryId(id)) throw new UserError(`Id inventario non valido: ${id}`);
    return path.join(this.dirs.inventory, `${id}.${ext}`);
  }

  /** Stores an inventory: `inv` is the full record, `meta` its summary for listings. */
  async saveInventory(inv, meta) {
    writeAtomic(this.invFile(inv.id), JSON.stringify(inv));
    writeAtomic(this.invFile(inv.id, 'meta.json'), JSON.stringify(meta));
  }

  /** Summaries of the stored inventories, newest first. */
  async listInventories() {
    const dir = this.dirs.inventory;
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.meta.json')) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      } catch { /* ignore unreadable files */ }
    }
    return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }

  async loadInventory(id) {
    const f = this.invFile(id);
    if (!fs.existsSync(f)) throw new UserError(`Inventario ${id} non trovato`);
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  }

  async deleteInventory(id) {
    const f = this.invFile(id);
    if (!fs.existsSync(f)) throw new UserError(`Inventario ${id} non trovato`);
    fs.rmSync(f);
    fs.rmSync(this.invFile(id, 'meta.json'), { force: true });
  }

  /** Removes the whole area (all sites, scans, inventories): used when an account is deleted. */
  async deleteArea() {
    if (!fs.existsSync(this.root)) return;
    makeWritable(this.root);
    fs.rmSync(this.root, { recursive: true, force: true });
    for (const k of [...cache.keys()]) if (k.startsWith(`${this.key}/`)) cache.delete(k);
  }
}
