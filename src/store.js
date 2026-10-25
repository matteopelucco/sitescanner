import crypto from 'node:crypto';
import { UserError } from './errors.js';

// Scans are read and written through the storage of an area (src/storage/, ADR-0017);
// this module keeps what does not depend on where they live.

export function newScanId(date = new Date()) {
  const ts = date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${ts}-${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * Resolves a scan reference: exact id, unique id prefix, label (most recent wins),
 * "latest", "latest~N" (N scans before the latest).
 */
export async function resolveScanRef(st, site, ref) {
  const scans = await st.listScans(site);
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

/** Every site of an area: configured or with history only. */
export async function allSiteIds(st) {
  return [...new Set([...(await st.listSiteIds()), ...(await st.listDataSites())])].sort();
}
