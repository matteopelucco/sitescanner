// Rules and notes of a site map (spec §14.4, §14.6). The inventory is immutable: what the user adds — area and
// parent rules, the brand affix, a general note and a note per page — lives in an overlay next to it (RF-MAP-161),
// like the labels of the scans (ADR-0003). Pure and dependency-free: used by the API, the CLI and the web app.

export const NOTE_LIMITS = { general: 20000, page: 2000 };
const HEX = /^#[0-9a-f]{6}$/i;
const MAX_RULES = 200;
const MAX_NOTES = 5000;

export const emptyOverlay = () => ({ version: 1, rules: null, notes: { general: '', pages: {} } });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** What is wrong with a `match` list: prefixes of path or `re:` regexes. */
function matchProblem(match) {
  if (!Array.isArray(match) || !match.length) return 'servono uno o più prefissi di path o espressioni regolari (re:…)';
  for (const m of match) {
    if (typeof m !== 'string' || !m.trim() || m.length > 300) return `criterio non valido: ${JSON.stringify(m)}`;
    if (m.startsWith('re:')) {
      try {
        new RegExp(m.slice(3));
      } catch (e) {
        return `espressione regolare non valida «${m.slice(3)}» (${e.message})`;
      }
    }
  }
  return null;
}

/**
 * Checks the rules of the map (RF-MAP-71, 54, 60, 73) and returns the normalized ones. Unknown keys are dropped.
 * @returns {{rules: object, errors: string[]}}
 */
export function checkRules(raw) {
  const errors = [];
  const rules = {};
  if (raw === null || raw === undefined) return { rules, errors };
  if (!isObj(raw)) return { rules, errors: ['le regole devono essere un oggetto'] };
  if (raw.areas !== undefined) {
    if (!Array.isArray(raw.areas) || raw.areas.length > MAX_RULES) errors.push(`areas: un elenco di al massimo ${MAX_RULES} regole`);
    else {
      rules.areas = [];
      raw.areas.forEach((a, i) => {
        const at = `areas[${i + 1}]`;
        if (!isObj(a)) return errors.push(`${at}: deve essere un oggetto`);
        const name = typeof a.name === 'string' ? a.name.trim() : '';
        if (!name || name.length > 80) return errors.push(`${at}: il nome è obbligatorio (fino a 80 caratteri)`);
        const p = matchProblem(a.match);
        if (p) return errors.push(`${at} «${name}»: ${p}`);
        if (a.color && !HEX.test(a.color)) return errors.push(`${at} «${name}»: il colore deve essere esadecimale (#rrggbb)`);
        rules.areas.push({ name, match: a.match.map((m) => m.trim()), ...(a.host ? { host: String(a.host) } : {}), ...(a.color ? { color: a.color } : {}) });
      });
    }
  }
  if (raw.parents !== undefined) {
    if (!Array.isArray(raw.parents) || raw.parents.length > MAX_RULES) errors.push(`parents: un elenco di al massimo ${MAX_RULES} regole`);
    else {
      rules.parents = [];
      raw.parents.forEach((r, i) => {
        const at = `parents[${i + 1}]`;
        if (!isObj(r)) return errors.push(`${at}: deve essere un oggetto`);
        const p = matchProblem(r.match);
        if (p) return errors.push(`${at}: ${p}`);
        if (typeof r.parent !== 'string' || !r.parent.trim() || r.parent.length > 600) return errors.push(`${at}: indica il genitore (path o id della pagina)`);
        rules.parents.push({ match: r.match.map((m) => m.trim()), parent: r.parent.trim(), ...(r.host ? { host: String(r.host) } : {}) });
      });
    }
  }
  if (raw.titleAffix !== undefined) {
    if (raw.titleAffix === false) rules.titleAffix = false;
    else if (isObj(raw.titleAffix)) {
      rules.titleAffix = {};
      for (const [host, v] of Object.entries(raw.titleAffix)) {
        if (typeof v !== 'string' || v.length > 100) errors.push(`titleAffix.${host}: deve essere un testo (fino a 100 caratteri)`);
        else rules.titleAffix[host] = v;
      }
    } else errors.push('titleAffix: false oppure un oggetto host → testo');
  }
  if (raw.subareaMin !== undefined) {
    if (!Number.isInteger(raw.subareaMin) || raw.subareaMin < 1 || raw.subareaMin > 1000) errors.push('subareaMin: un intero da 1 a 1000');
    else rules.subareaMin = raw.subareaMin;
  }
  return { rules, errors };
}

/** Normalizes an overlay coming from a client: rules checked, notes limited (RF-MAP-160). Throws an Error listing the problems. */
export function normalizeOverlay(input) {
  const out = emptyOverlay();
  if (!isObj(input)) throw new Error('overlay non valido');
  const errors = [];
  if (input.rules !== undefined && input.rules !== null) {
    const r = checkRules(input.rules);
    errors.push(...r.errors);
    out.rules = r.rules;
  }
  const notes = isObj(input.notes) ? input.notes : {};
  const general = typeof notes.general === 'string' ? notes.general : '';
  if (general.length > NOTE_LIMITS.general) errors.push(`nota generale: al massimo ${NOTE_LIMITS.general} caratteri`);
  out.notes.general = general;
  const pages = isObj(notes.pages) ? notes.pages : {};
  if (Object.keys(pages).length > MAX_NOTES) errors.push(`al massimo ${MAX_NOTES} note di pagina`);
  for (const [id, text] of Object.entries(pages)) {
    if (typeof text !== 'string') { errors.push(`nota di ${id}: deve essere un testo`); continue; }
    if (text.length > NOTE_LIMITS.page) { errors.push(`nota di ${id}: al massimo ${NOTE_LIMITS.page} caratteri`); continue; }
    if (text.trim()) out.notes.pages[id.slice(0, 600)] = text;
  }
  if (errors.length) throw new Error(errors.join('; '));
  return out;
}

/** The rules in force: those saved with the inventory, else those of the site's configuration or of the options used. */
export function effectiveRules(overlay, base = {}) {
  if (overlay && overlay.rules) return overlay.rules;
  const { rules } = checkRules({ areas: base.areas, parents: base.parents, titleAffix: base.titleAffix, subareaMin: base.subareaMin });
  return rules;
}

/**
 * Copies the notes of a previous inventory of the same site (RF-MAP-162): the general note and the notes of the
 * pages that exist in the new one. Notes of pages that disappeared are listed, not copied.
 * @param {object} prev overlay of the previous inventory
 * @param {object} next overlay of the new one
 * @param {Set<string>|string[]} ids page ids of the new inventory
 * @returns {{overlay: object, copied: number, dropped: string[]}}
 */
export function importNotes(prev, next, ids) {
  const have = new Set(ids);
  const overlay = { ...emptyOverlay(), ...next, notes: { general: next?.notes?.general || '', pages: { ...(next?.notes?.pages || {}) } } };
  if (!overlay.notes.general && prev?.notes?.general) overlay.notes.general = prev.notes.general;
  let copied = 0;
  const dropped = [];
  for (const [id, text] of Object.entries(prev?.notes?.pages || {})) {
    if (!have.has(id)) dropped.push(id);
    else if (!overlay.notes.pages[id]) { overlay.notes.pages[id] = text; copied++; }
  }
  return { overlay, copied, dropped: dropped.sort() };
}

// a prefix would also catch /a-b when asked for /a: the exact path is a regex
const exactKey = (key) => `re:^${key.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`)}$`;

/** «Sposta in area…» (RF-MAP-152): a rule for the exact path, ahead of the others so that it wins. */
export function withAreaRule(rules, { key, host = null, name, mainHost = null }) {
  const h = host && host !== mainHost ? host : null;
  const m = exactKey(key);
  const areas = (rules.areas || []).filter((a) => !(a.match.length === 1 && a.match[0] === m && (a.host || null) === h));
  areas.unshift({ name, match: [m], ...(h ? { host: h } : {}) });
  return { ...rules, areas };
}

/** «Imposta genitore…» (RF-MAP-152). An empty parent removes the rule. */
export function withParentRule(rules, { key, host = null, parent, mainHost = null }) {
  const h = host && host !== mainHost ? host : null;
  const m = exactKey(key);
  const parents = (rules.parents || []).filter((p) => !(p.match.length === 1 && p.match[0] === m && (p.host || null) === h));
  if (parent) parents.unshift({ match: [m], parent, ...(h ? { host: h } : {}) });
  return { ...rules, parents };
}

/** Ids of the pages of an inventory as the map names them: `key`, or `host + key` for another host. */
export function inventoryIds(inv) {
  let main = null;
  try {
    main = new URL(inv.baseUrl).host;
  } catch { /* no base URL */ }
  return (inv.pages || []).map((p) => (p.host && p.host !== main ? p.host + p.key : p.key));
}
