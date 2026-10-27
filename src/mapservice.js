// Server side of the site map (spec §14.5.6, §14.6, §14.8): the map with the rules in force, the overlay of rules
// and notes next to an inventory, saving rules in a site's file, and importing notes from the previous inventory.
import { UserError, loadSite, applySiteForm, saveSite } from './config.js';
import { buildSitemap } from './core/sitemap.js';
import { TOOL } from './version.js';
import { htmlToPdf } from './pdf.js';
import { mapBundle, loadD3Hierarchy } from './mapbundle.js';
import { exportFileName, mapCsv, mapDataset, mapMarkdown, mapPrintHtml } from './core/mapexport.js';
import { checkRules, effectiveRules, emptyOverlay, importNotes, inventoryIds, normalizeOverlay } from './core/mapoverlay.js';

/** The rules that apply without the overlay: the site's current configuration, else the options the inventory was made with. */
async function baseRules(st, inv) {
  if (inv.site) {
    try {
      return (await loadSite(st, inv.site)).map;
    } catch { /* site removed or invalid: the options used at the time */ }
  }
  return (inv.options && inv.options.map) || {};
}

export async function overlayOf(st, id) {
  return (await st.readInventoryOverlay(id)) || emptyOverlay();
}

/** The map of an inventory with the rules in force and its notes (RF-MAP-171). */
export async function mapOf(st, id) {
  const inv = await st.loadInventory(id);
  const overlay = await overlayOf(st, id);
  const rules = effectiveRules(overlay, await baseRules(st, inv));
  return { ...buildSitemap(inv, rules), rules, rulesFrom: overlay.rules ? 'inventory' : inv.site ? 'site' : 'default', notes: overlay.notes, site: inv.site || null };
}

/** The effect of rules that are not saved yet (RF-MAP-150): areas, warnings and how many pages each area gets. */
export async function previewRules(st, id, rawRules) {
  const { rules, errors } = checkRules(rawRules);
  if (errors.length) throw new UserError(errors.join('; '));
  const map = buildSitemap(await st.loadInventory(id), rules);
  return { areas: map.areas, subareas: map.subareas, warnings: map.warnings, nodes: map.nodes.length, support: map.support };
}

/**
 * Saves rules and notes. `rules` replaces the saved rules (null goes back to the site's), `general` replaces the general
 * note, `pages` merges notes by page id (an empty text removes one). With `toSite` the rules are written in the
 * site's file, keeping its comments, and the inventory goes back to using the site's rules (RF-MAP-151).
 */
export async function saveOverlay(st, id, body) {
  const inv = await st.loadInventory(id);
  const cur = await overlayOf(st, id);
  const next = {
    version: 1,
    rules: body.rules === undefined ? cur.rules : body.rules,
    notes: {
      general: body.general === undefined ? cur.notes.general : body.general,
      pages: { ...cur.notes.pages, ...(body.pages || {}) },
    },
  };
  for (const [k, v] of Object.entries(next.notes.pages)) if (typeof v === 'string' && !v.trim()) delete next.notes.pages[k];
  let overlay;
  try {
    overlay = normalizeOverlay(next);
  } catch (e) {
    throw new UserError(e.message);
  }
  if (body.toSite) {
    if (!inv.site) throw new UserError('L\'inventario non è di un sito configurato: le regole restano con l\'inventario');
    const rules = effectiveRules(overlay, await baseRules(st, inv));
    await writeRulesToSite(st, inv.site, rules);
    overlay.rules = null;
  }
  return st.writeInventoryOverlay(id, overlay);
}

/** «Usa come regole del sito»: copies rules into the YAML of a configured site (RF-MAP-151). */
export async function writeRulesToSite(st, siteId, rules) {
  const raw = await st.readSiteRaw(siteId);
  if (raw === null) throw new UserError(`Sito "${siteId}" non configurato`);
  const map = { areas: rules.areas || [], parents: rules.parents || [], subareaMin: rules.subareaMin ?? 3, titleAffix: rules.titleAffix === undefined ? null : rules.titleAffix };
  await saveSite(st, siteId, applySiteForm(raw, { map }));
}

/**
 * Copies the notes of the previous inventory of the same site (or of `fromId`) into `id` (RF-MAP-162).
 * @returns {Promise<{copied: number, dropped: string[], from: string|null}>}
 */
export async function importPreviousNotes(st, id, fromId = null) {
  const inv = await st.loadInventory(id);
  let from = fromId;
  if (!from) {
    if (!inv.site) throw new UserError('Le note si importano dall\'inventario precedente dello stesso sito: questo non è di un sito configurato');
    const prev = (await st.listInventories())
      .filter((i) => i.site === inv.site && i.id !== id && String(i.startedAt) < String(inv.startedAt))
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
    if (!prev) return { copied: 0, dropped: [], from: null };
    from = prev.id;
  }
  const prevOverlay = await overlayOf(st, from);
  const { overlay, copied, dropped } = importNotes(prevOverlay, await overlayOf(st, id), inventoryIds(inv));
  await st.writeInventoryOverlay(id, normalizeOverlay(overlay));
  return { copied, dropped, from };
}


export const EXPORT_FORMATS = { csv: 'csv', json: 'json', md: 'md', html: 'zip', zip: 'zip', pdf: 'pdf' };

/**
 * An export of the map of an inventory with the rules and notes in force (spec §14.7).
 * @returns {Promise<{body: Buffer|string, contentType: string, fileName: string}>}
 */
export async function exportMap(st, id, format) {
  const ext = EXPORT_FORMATS[format];
  if (!ext) throw new UserError(`Formato non supportato: ${format} (csv, json, md, html, pdf)`);
  const inv = await st.loadInventory(id);
  const map = await mapOf(st, id);
  const fileName = exportFileName(inv, ext);
  if (ext === 'csv') return { body: mapCsv(map), contentType: 'text/csv; charset=utf-8', fileName };
  if (ext === 'json') return { body: JSON.stringify(mapDataset(map, inv, { tool: TOOL }), null, 2), contentType: 'application/json; charset=utf-8', fileName };
  if (ext === 'md') return { body: mapMarkdown(map, inv), contentType: 'text/markdown; charset=utf-8', fileName };
  if (ext === 'zip') {
    const { buffer } = mapBundle(map, inv, { dataset: mapDataset(map, inv, { tool: TOOL }) });
    return { body: buffer, contentType: 'application/zip', fileName };
  }
  const html = mapPrintHtml(map, inv, { d3: loadD3Hierarchy(), version: TOOL.version });
  return { body: await htmlToPdf(html), contentType: 'application/pdf', fileName };
}
