import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserError, validSiteId } from '../../errors.js';
import { BlobExistsError } from './backend.js';

// Storage of an area on Postgres + private Vercel Blob (ADR-0017, spec §11.3). Same behaviour as
// FsStorage: immutable snapshots, label overlay, no partial scan visible.
//   Postgres  sites(area, id, yaml) · scans(area, site, id, meta, overlay) · inventories(area, id, meta)
//   Blob      u/<area>/<site>/scans/<id>/<file>   files of a scan (scan.json, text.json, screenshots/…)
//             u/<area>/inventory/<id>.json         full inventories

const cache = new Map();
const CACHE_SIZE = 8;
const validRel = (rel) => typeof rel === 'string' && rel !== '' && !rel.split(/[\\/]/).some((p) => p === '..' || p === '' || p === '.') && !path.isAbsolute(rel);
const validInventoryId = (id) => /^[\w-]+$/.test(String(id));
const TYPES = { '.json': 'application/json', '.png': 'image/png', '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

/** The lightweight metadata stored next to a scan, as listScans returns it. */
const scanMeta = (s) => ({ id: s.id, site: s.site, env: s.env, baseUrl: s.baseUrl, label: s.label || null, note: s.note || null, startedAt: s.startedAt, finishedAt: s.finishedAt, stats: s.stats, options: s.options });

export class VercelStorage {
  kind = 'vercel';
  isolated = true;

  /** `area` is the id of the account (spec §10.4). */
  constructor(backend, area) {
    if (!area) throw new Error('VercelStorage: area obbligatoria');
    this.b = backend;
    this.area = String(area);
    this.key = `vercel:${this.area}`;
  }

  async db() {
    await this.b.init();
    return this.b.db;
  }

  scanPrefix(site, id) {
    return `u/${this.area}/${site}/scans/${id}/`;
  }

  // ---------------- sites ----------------

  async listSiteIds() {
    return (await (await this.db()).query('SELECT id FROM sites WHERE area = $1 ORDER BY id', [this.area])).map((r) => r.id);
  }

  async readSiteRaw(id) {
    if (!validSiteId(id)) return null;
    const rows = await (await this.db()).query('SELECT yaml FROM sites WHERE area = $1 AND id = $2', [this.area, id]);
    return rows.length ? rows[0].yaml : null;
  }

  siteLocation(id) {
    return `${id}.yml`;
  }

  get sitesLocation() {
    return 'i tuoi siti';
  }

  async writeSiteRaw(id, raw, { create = false } = {}) {
    if (!validSiteId(id)) throw new UserError(`Id sito non valido: ${id} (ammessi lettere, cifre, "_", "-", ".")`);
    const db = await this.db();
    if (create) {
      const rows = await db.query('INSERT INTO sites (area, id, yaml) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id', [this.area, id, raw]);
      if (!rows.length) throw new UserError(`Il sito "${id}" esiste già`);
    } else {
      await db.query('INSERT INTO sites (area, id, yaml) VALUES ($1, $2, $3) ON CONFLICT (area, id) DO UPDATE SET yaml = EXCLUDED.yaml, updated_at = now()', [this.area, id, raw]);
    }
  }

  async deleteSiteConfig(id) {
    if (!validSiteId(id)) return false;
    return (await (await this.db()).query('DELETE FROM sites WHERE area = $1 AND id = $2 RETURNING id', [this.area, id])).length > 0;
  }

  // ---------------- scans ----------------

  localScanDir() {
    return null;
  }

  async listDataSites() {
    return (await (await this.db()).query('SELECT DISTINCT site FROM scans WHERE area = $1 ORDER BY site', [this.area])).map((r) => r.site);
  }

  async readLabels(site) {
    const rows = await (await this.db()).query('SELECT id, overlay FROM scans WHERE area = $1 AND site = $2 AND overlay IS NOT NULL', [this.area, site]);
    return Object.fromEntries(rows.map((r) => [r.id, r.overlay]));
  }

  async writeLabel(site, id, { label, note }) {
    const db = await this.db();
    const rows = await db.query('SELECT overlay FROM scans WHERE area = $1 AND site = $2 AND id = $3', [this.area, site, id]);
    if (!rows.length) throw new UserError(`Scan ${id} non trovata per il sito ${site}`);
    const overlay = {
      ...(rows[0].overlay || {}),
      ...(label !== undefined ? { label } : {}),
      ...(note !== undefined ? { note } : {}),
      updatedAt: new Date().toISOString(),
    };
    await db.query('UPDATE scans SET overlay = $4::jsonb WHERE area = $1 AND site = $2 AND id = $3', [this.area, site, id, JSON.stringify(overlay)]);
    cache.delete(`${this.key}/${site}/${id}`);
    return overlay;
  }

  async listScans(site) {
    if (!validSiteId(site)) return [];
    const rows = await (await this.db()).query('SELECT id, meta, overlay FROM scans WHERE area = $1 AND site = $2 ORDER BY started_at, id', [this.area, site]);
    return rows.map((r) => {
      const o = r.overlay || {};
      return { ...r.meta, label: o.label !== undefined ? o.label : r.meta.label || null, note: o.note !== undefined ? o.note : r.meta.note || null };
    });
  }

  async scanRow(site, id) {
    if (!validSiteId(site) || !validRel(id)) return null;
    const rows = await (await this.db()).query('SELECT overlay FROM scans WHERE area = $1 AND site = $2 AND id = $3', [this.area, site, id]);
    return rows[0] || null;
  }

  async loadScan(site, id) {
    const k = `${this.key}/${site}/${id}`;
    if (cache.has(k)) return cache.get(k);
    const row = await this.scanRow(site, id);
    const buf = row && (await this.b.blob.get(this.scanPrefix(site, id) + 'scan.json'));
    if (!buf) throw new UserError(`Scan ${id} non trovata per il sito ${site}`);
    const scan = JSON.parse(buf.toString('utf8'));
    const o = row.overlay;
    if (o) {
      if (o.label !== undefined) scan.label = o.label;
      if (o.note !== undefined) scan.note = o.note;
    }
    cache.set(k, scan);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    return scan;
  }

  /** Files of uncommitted scans are not visible: the row must exist (RF-STO-02). */
  async readScanFile(site, id, rel) {
    if (!validRel(rel) || !(await this.scanRow(site, id))) return null;
    return this.b.blob.get(this.scanPrefix(site, id) + rel);
  }

  /** Local working folder (the function's /tmp): Playwright and --keep-html write there. */
  async stageScan(site, id) {
    if (!validSiteId(site)) throw new UserError(`Id sito non valido: ${site}`);
    return fs.mkdtempSync(path.join(os.tmpdir(), `sitescanner-${id}-`));
  }

  /** Uploads every file, then inserts the row: the insert is the commit point. */
  async commitScan(site, id, stagingDir, snapshot) {
    if (await this.scanRow(site, id)) throw new Error(`La scan ${id} esiste già`);
    fs.writeFileSync(path.join(stagingDir, 'scan.json'), JSON.stringify(snapshot));
    const prefix = this.scanPrefix(site, id);
    const files = walk(stagingDir);
    // a few at a time: screenshots can be hundreds
    for (let i = 0; i < files.length; i += 8) {
      await Promise.all(files.slice(i, i + 8).map(async (rel) => {
        try {
          await this.b.blob.put(prefix + rel, fs.readFileSync(path.join(stagingDir, rel)), { contentType: TYPES[path.extname(rel)] || 'application/octet-stream' });
        } catch (e) {
          if (e instanceof BlobExistsError) throw new Error(`La scan ${id} esiste già`);
          throw e;
        }
      }));
    }
    const rows = await (await this.db()).query(
      'INSERT INTO scans (area, site, id, started_at, meta) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT DO NOTHING RETURNING id',
      [this.area, site, id, snapshot.startedAt || null, JSON.stringify(scanMeta(snapshot))],
    );
    if (!rows.length) throw new Error(`La scan ${id} esiste già`);
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  async discardStaging(stagingDir) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  // Scans in steps (spec §11.4): each step may run in another function instance, so the files it
  // writes are uploaded at its end, under the final prefix of the scan. They stay invisible until the
  // row is inserted (commit point) and are removed by discardScan or by the orphan cleanup.

  async stepWorkDir(site, id) {
    return this.stageScan(site, id);
  }

  async flushStaging(site, id, dir) {
    const prefix = this.scanPrefix(site, id);
    const files = walk(dir);
    for (let i = 0; i < files.length; i += 8) {
      // overwrite: a step repeated after a crash uploads the same files again
      await Promise.all(files.slice(i, i + 8).map((rel) => this.b.blob.put(prefix + rel, fs.readFileSync(path.join(dir, rel)), { contentType: TYPES[path.extname(rel)] || 'application/octet-stream', overwrite: true })));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  async discardScan(site, id, dir = null) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (!validSiteId(site) || !validRel(id) || (await this.scanRow(site, id))) return;
    await this.deleteBlobs(this.scanPrefix(site, id));
  }

  async deleteBlobs(prefix) {
    const list = await this.b.blob.list(prefix);
    await this.b.blob.del(list.map((b) => b.pathname));
  }

  /** Rows first (the history disappears at once), then the files; leftovers are removed by the cleanup. */
  async deleteSiteData(site) {
    if (!validSiteId(site)) throw new UserError(`Id sito non valido: ${site}`);
    const rows = await (await this.db()).query('DELETE FROM scans WHERE area = $1 AND site = $2 RETURNING id', [this.area, site]);
    for (const k of [...cache.keys()]) if (k.startsWith(`${this.key}/${site}/`)) cache.delete(k);
    await this.deleteBlobs(`u/${this.area}/${site}/`);
    return rows.length;
  }

  // ---------------- inventories ----------------

  invPath(id) {
    if (!validInventoryId(id)) throw new UserError(`Id inventario non valido: ${id}`);
    return `u/${this.area}/inventory/${id}.json`;
  }

  async saveInventory(inv, meta) {
    await this.b.blob.put(this.invPath(inv.id), JSON.stringify(inv), { contentType: 'application/json' });
    await (await this.db()).query('INSERT INTO inventories (area, id, meta) VALUES ($1, $2, $3::jsonb)', [this.area, inv.id, JSON.stringify(meta)]);
  }

  async listInventories() {
    const rows = await (await this.db()).query('SELECT meta FROM inventories WHERE area = $1', [this.area]);
    return rows.map((r) => r.meta).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }

  async loadInventory(id) {
    const p = this.invPath(id);
    const rows = await (await this.db()).query('SELECT 1 FROM inventories WHERE area = $1 AND id = $2', [this.area, id]);
    const buf = rows.length && (await this.b.blob.get(p));
    if (!buf) throw new UserError(`Inventario ${id} non trovato`);
    return JSON.parse(buf.toString('utf8'));
  }

  async readInventoryOverlay(id) {
    this.invPath(id); // validates the id
    const rows = await (await this.db()).query('SELECT overlay FROM inventories WHERE area = $1 AND id = $2', [this.area, id]);
    if (!rows.length) throw new UserError(`Inventario ${id} non trovato`);
    return rows[0].overlay || null;
  }

  async writeInventoryOverlay(id, overlay) {
    this.invPath(id);
    const saved = { ...overlay, updatedAt: new Date().toISOString() };
    const rows = await (await this.db()).query('UPDATE inventories SET overlay = $3::jsonb WHERE area = $1 AND id = $2 RETURNING id', [this.area, id, JSON.stringify(saved)]);
    if (!rows.length) throw new UserError(`Inventario ${id} non trovato`);
    return saved;
  }

  async deleteInventory(id) {
    const p = this.invPath(id);
    const rows = await (await this.db()).query('DELETE FROM inventories WHERE area = $1 AND id = $2 RETURNING id', [this.area, id]);
    if (!rows.length) throw new UserError(`Inventario ${id} non trovato`);
    await this.b.blob.del([p]);
  }

  async deleteArea() {
    const db = await this.db();
    await db.tx(async (t) => {
      for (const table of ['sites', 'scans', 'inventories', 'jobs']) await t.query(`DELETE FROM ${table} WHERE area = $1`, [this.area]);
    });
    for (const k of [...cache.keys()]) if (k.startsWith(`${this.key}/`)) cache.delete(k);
    await this.deleteBlobs(`u/${this.area}/`);
  }

  // ---------------- jobs (shared between function instances) ----------------

  persistsJobs = true;

  async saveJob(view) {
    await (await this.db()).query(
      `INSERT INTO jobs (area, id, view, status, updated_at) VALUES ($1, $2, $3::jsonb, $4, now())
       ON CONFLICT (area, id) DO UPDATE SET view = EXCLUDED.view, status = EXCLUDED.status, updated_at = now()`,
      [this.area, view.id, JSON.stringify(view), view.status],
    );
  }

  /** Jobs of the area, newest first; a running job without updates for 15 minutes is marked failed (RF-RUN-07). */
  async listJobs(limit = 50) {
    const db = await this.db();
    await db.query(
      `UPDATE jobs SET status = 'failed', updated_at = now(),
         view = jsonb_set(jsonb_set(view, '{status}', '"failed"'), '{error}', '"interrotto: nessun avanzamento"')
       WHERE area = $1 AND status = 'running' AND updated_at < now() - interval '15 minutes'`,
      [this.area],
    );
    await db.query(`DELETE FROM jobs WHERE area = $1 AND id NOT IN (SELECT id FROM jobs WHERE area = $1 ORDER BY updated_at DESC LIMIT ${Number(limit)})`, [this.area]);
    return (await db.query('SELECT view FROM jobs WHERE area = $1 ORDER BY updated_at DESC', [this.area])).map((r) => r.view);
  }

  async getJob(id) {
    const rows = await (await this.db()).query('SELECT view FROM jobs WHERE area = $1 AND id = $2', [this.area, String(id)]);
    return rows.length ? rows[0].view : null;
  }

  async requestCancel(id) {
    return (await (await this.db()).query("UPDATE jobs SET cancel_requested = true WHERE area = $1 AND id = $2 AND status = 'running' RETURNING id", [this.area, String(id)])).length > 0;
  }

  /** Takes the lease of step `step`; false if the step is already done, out of order or running elsewhere. */
  async claimStep(id, step, leaseMs) {
    const rows = await (await this.db()).query(
      `UPDATE jobs SET lease_until = now() + ($4 || ' milliseconds')::interval
       WHERE area = $1 AND id = $2 AND step = $3 AND status = 'running' AND (lease_until IS NULL OR lease_until < now()) RETURNING id`,
      [this.area, String(id), step, String(leaseMs)],
    );
    return rows.length > 0;
  }

  /** Marks step `step` as done and releases the lease. */
  async finishStep(id, step) {
    await (await this.db()).query('UPDATE jobs SET step = $3 + 1, lease_until = NULL WHERE area = $1 AND id = $2 AND step = $3', [this.area, String(id), step]);
  }

  jobStatePath(id) {
    return `u/${this.area}/jobs/${String(id).replace(/[^\w-]/g, '')}/state.json`;
  }

  async saveJobState(id, state) {
    await this.b.blob.put(this.jobStatePath(id), JSON.stringify(state), { contentType: 'application/json', overwrite: true });
  }

  async loadJobState(id) {
    const buf = await this.b.blob.get(this.jobStatePath(id));
    return buf ? JSON.parse(buf.toString('utf8')) : null;
  }

  async deleteJobState(id) {
    await this.b.blob.del([this.jobStatePath(id)]);
  }

  async cancelRequested(id) {
    const rows = await (await this.db()).query('SELECT cancel_requested FROM jobs WHERE area = $1 AND id = $2', [this.area, String(id)]);
    return !!(rows[0] && rows[0].cancel_requested);
  }
}

/**
 * Removes blob files that no committed scan or inventory owns and are older than `olderThanMs`
 * (interrupted scans, deletions cut short). Runs from the daily cron (RF-STO-02).
 * @returns {Promise<number>} files deleted
 */
export async function cleanupOrphans(backend, { olderThanMs = 24 * 3600 * 1000, now = Date.now() } = {}) {
  await backend.init();
  const db = backend.db;
  // RF-RUN-07 for every area: running jobs without progress for 15 minutes have failed
  await db.query(
    `UPDATE jobs SET status = 'failed', updated_at = now(),
       view = jsonb_set(jsonb_set(view, '{status}', '"failed"'), '{error}', '"interrotto: nessun avanzamento"')
     WHERE status = 'running' AND updated_at < now() - interval '15 minutes'`,
  );
  const scans = new Set((await db.query('SELECT area, site, id FROM scans')).map((r) => `u/${r.area}/${r.site}/scans/${r.id}/`));
  const invs = new Set((await db.query('SELECT area, id FROM inventories')).map((r) => `u/${r.area}/inventory/${r.id}.json`));
  const running = new Set((await db.query("SELECT area, id FROM jobs WHERE status = 'running'")).map((r) => `u/${r.area}/jobs/${r.id}/`));
  const orphans = [];
  for (const b of await backend.blob.list('u/')) {
    if (now - b.uploadedAt.getTime() < olderThanMs) continue;
    if (/^u\/[^/]+\/runs\//.test(b.pathname)) continue; // run details: removed by the retention of the monitoring
    const m = /^(u\/[^/]+\/[^/]+\/scans\/[^/]+\/)/.exec(b.pathname);
    const j = /^(u\/[^/]+\/jobs\/[^/]+\/)/.exec(b.pathname);
    if (m ? !scans.has(m[1]) : j ? !running.has(j[1]) : !invs.has(b.pathname)) orphans.push(b.pathname);
  }
  await backend.blob.del(orphans);
  return orphans.length;
}

