// Site map derivation (spec §14.3): from the records of an inventory and the rules of the site to nodes,
// edges, tree, areas and statistics. Pure and dependency-free (only ./hosts.js, which is too), so it can run
// in the browser, on the server and in the exports, like ./compare.js. Everything shown by the map comes from here.
//
// Ids: a page of the main host is identified by its key (`/it/crediti/`); a page of another host by
// `host + key` (`kid.corner.ch/it/`). Link lists in the records (`contentLinks`, `navLinks`) hold ids.

import { hostRelation, siteDomain } from './hosts.js';

/** Categorical colors of the areas (light and dark surface), validated with the dataviz palette script (RF-MAP-72). */
export const AREA_PALETTE = [
  { light: '#2a78d6', dark: '#3987e5' },
  { light: '#eb6834', dark: '#d95926' },
  { light: '#1baf7a', dark: '#199e70' },
  { light: '#eda100', dark: '#c98500' },
  { light: '#e87ba4', dark: '#d55181' },
  { light: '#008300', dark: '#008300' },
  { light: '#6250d6', dark: '#9085e9' },
  { light: '#e34948', dark: '#e66767' },
];
export const NEUTRAL_AREA_COLOR = { light: '#6b7280', dark: '#9ca3af' };

const SEPARATORS = [' | ', ' - ', ' – ', ' — ', ' · ', ' :: '];
const ISO_639_1 = new Set('aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'.split(' '));
const HEX = /^#[0-9a-f]{6}$/i;
const MIN_TEMPLATE_PAGES = 5;

/** What an inventory has for the map (RF-MAP-33): inventories made before the map lack some data. */
export function mapSupport(inv) {
  const html = (inv.pages || []).filter((p) => p.html);
  const some = (f) => html.some((p) => p[f] !== undefined);
  return { links: some('contentLinks'), regions: some('regions'), documents: (inv.documents || []).length > 0 || some('documents'), description: some('description'), h1: some('h1') };
}

const splitKey = (key) => {
  const i = key.indexOf('?');
  return i < 0 ? [key, ''] : [key.slice(0, i), key.slice(i)];
};

// Ids a page can be a child of, from the closest: `/a/b/c/` → `/a/b/`, `/a/b`, `/a/`, `/a`, `/` (RF-MAP-51).
function pathAncestors(key) {
  const [path, query] = splitKey(key);
  const segs = path.split('/').filter(Boolean);
  const out = [];
  if (query) out.push(path);
  for (let i = segs.length - 1; i >= 1; i--) {
    const p = '/' + segs.slice(0, i).join('/');
    out.push(p + '/', p);
  }
  out.push('/');
  return out.filter((c) => c !== key);
}

const matchesRule = (patterns, key) => (patterns || []).some((m) => (String(m).startsWith('re:') ? safeRegex(String(m).slice(3)).test(key) : key.startsWith(String(m))));
const regexCache = new Map();
function safeRegex(src) {
  if (!regexCache.has(src)) {
    try {
      regexCache.set(src, new RegExp(src));
    } catch {
      regexCache.set(src, /$^/);
    }
  }
  return regexCache.get(src);
}

// Brand prefix/suffix of the titles of a host (RF-MAP-60): the piece after the last (before the first)
// separator that repeats in at least half of the titles.
function detectAffix(titles) {
  const count = (pick) => {
    const m = new Map();
    for (const t of titles) {
      let best = null;
      for (const sep of SEPARATORS) {
        const i = pick === 'suffix' ? t.lastIndexOf(sep) : t.indexOf(sep);
        if (i > 0 && (best === null || (pick === 'suffix' ? i > best.i : i < best.i))) best = { i, sep };
      }
      if (!best) continue;
      const piece = pick === 'suffix' ? t.slice(best.i) : t.slice(0, best.i + best.sep.length);
      m.set(piece, (m.get(piece) || 0) + 1);
    }
    const top = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return top && top[1] >= 2 && top[1] >= titles.length / 2 ? top[0] : null;
  };
  return { suffix: count('suffix'), prefix: count('prefix') };
}

function shortName(rec, affix, mainHost) {
  let t = (rec.title || '').trim();
  if (affix) {
    if (affix.suffix && t.endsWith(affix.suffix) && t.length > affix.suffix.length) t = t.slice(0, -affix.suffix.length);
    else if (affix.prefix && t.startsWith(affix.prefix) && t.length > affix.prefix.length) t = t.slice(affix.prefix.length);
  }
  t = t.trim();
  if (t) return t;
  if (rec.h1) return rec.h1;
  const [path] = splitKey(rec.key);
  const last = path.split('/').filter(Boolean).pop();
  if (!last) return rec.host || mainHost;
  try {
    return decodeURIComponent(last).replace(/-/g, ' ');
  } catch {
    return last.replace(/-/g, ' ');
  }
}

function languageOf(rec) {
  if (rec.lang) return rec.lang;
  const seg = splitKey(rec.key)[0].split('/').filter(Boolean)[0];
  return seg && seg.length === 2 && ISO_639_1.has(seg.toLowerCase()) ? seg.toLowerCase() : null;
}

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const round1 = (n) => Math.round(n * 10) / 10;
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

/**
 * Derives the map of an inventory.
 * @param {object} inv inventory (baseUrl, pages, documents, crawl.start, options.map)
 * @param {{areas?: object[], parents?: object[], titleAffix?: object|false, subareaMin?: number, thinWords?: number}} [rules]
 */
export function buildSitemap(inv, rules = {}) {
  const warnings = [];
  const recs = inv.pages || [];
  const support = mapSupport(inv);
  if (!support.links) warnings.push('Inventario fatto prima della mappa: non contiene gli elenchi dei link, quindi la mappa mostra la gerarchia e i dati disponibili. Rilancia l\'inventario per avere link, documenti e domini.');
  const base = new URL(inv.baseUrl);
  const mainHost = base.host;
  const domain = siteDomain(mainHost, inv.options?.map?.siteDomain);
  const ratio = inv.options?.map?.templateRatio ?? 0.8;
  const subareaMin = rules.subareaMin ?? 3;
  const thinWords = rules.thinWords ?? 200;
  const idOf = (host, key) => (!host || host === mainHost ? key : host + key);

  // ---- nodes (RF-MAP-40) ----
  // records are taken in id order, so the result does not depend on the order of the inventory
  const entries = recs.map((r) => [idOf(r.host, r.key), r]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const nodes = new Map();
  const recById = new Map();
  for (const [id, r] of entries) {
    recById.set(id, r);
    if (r.html) nodes.set(id, { id, rec: r });
  }
  const empty = { version: 1, support, warnings, root: null, nodes: [], edges: { hierarchy: [], content: [], navigation: [] }, areas: [], subareas: [], stats: null };
  if (!nodes.size) return empty;

  // ---- redirects: a link to a redirecting page is a link to its destination (RF-MAP-41) ----
  const idFromUrl = (u) => {
    try {
      const x = new URL(u, inv.baseUrl);
      const k = x.pathname + x.search;
      return x.host === mainHost ? k : x.host + k;
    } catch {
      return null;
    }
  };
  const lookup = (id) => {
    if (nodes.has(id)) return id;
    const bare = id.split('?')[0];
    return bare !== id && nodes.has(bare) ? bare : null;
  };
  const resolve = (id) => {
    let cur = id;
    for (let i = 0; i < 10; i++) {
      const hit = lookup(cur);
      if (hit) return hit;
      const r = recById.get(cur);
      if (!r || !r.redirectTo) return null;
      const next = idFromUrl(r.redirectTo);
      if (!next || next === cur) return null;
      cur = next;
    }
    return null;
  };
  const resolved = new Map();
  const resolveCached = (id) => {
    if (!resolved.has(id)) resolved.set(id, resolve(id));
    return resolved.get(id);
  };

  // ---- edges (RF-MAP-41..44) ----
  const contentOut = new Map(), contentIn = new Map(), navOut = new Map(), navInCount = new Map();
  const rawLinks = new Map(); // raw link target → { nav, content } pages linking it
  for (const id of nodes.keys()) {
    contentOut.set(id, new Set());
    contentIn.set(id, new Set());
    navOut.set(id, new Set());
    navInCount.set(id, 0);
  }
  const contentEdges = [], navEdges = [];
  const hostLinkers = new Map(); // host → ids of the pages linking one of its pages
  for (const [id, n] of nodes) {
    const r = n.rec;
    for (const [list, out, edges, field] of [[r.contentLinks, contentOut.get(id), contentEdges, 'content'], [r.navLinks, navOut.get(id), navEdges, 'nav']]) {
      for (const raw of list || []) {
        if (!rawLinks.has(raw)) rawLinks.set(raw, { nav: 0, content: 0 });
        rawLinks.get(raw)[field]++;
        const t = resolveCached(raw);
        if (!t || t === id || out.has(t)) continue;
        out.add(t);
        edges.push({ source: id, target: t });
        const th = nodes.get(t).rec.host || mainHost;
        if (th !== (r.host || mainHost)) {
          if (!hostLinkers.has(th)) hostLinkers.set(th, new Set());
          hostLinkers.get(th).add(id);
        }
        if (field === 'content') contentIn.get(t).add(id);
        else navInCount.set(t, navInCount.get(t) + 1);
      }
    }
  }
  const mainNodes = [...nodes.values()].filter((n) => (n.rec.host || mainHost) === mainHost);
  const htmlMain = mainNodes.length;
  const globalNav = new Set();
  if (support.links && htmlMain >= MIN_TEMPLATE_PAGES) {
    for (const [id, c] of navInCount) if (c >= ratio * htmlMain) globalNav.add(id);
  }

  // ---- root (RF-MAP-50) ----
  const segCount = (k) => splitKey(k)[0].split('/').filter(Boolean).length;
  let rootId = (inv.crawl?.start || []).map((k) => lookup(k)).find(Boolean);
  if (!rootId) {
    rootId = mainNodes.map((n) => n.id).sort((a, b) => segCount(a) - segCount(b) || a.length - b.length || a.localeCompare(b))[0] || [...nodes.keys()][0];
  }

  // ---- tree (RF-MAP-51..55) ----
  const parent = new Map(), parentKind = new Map(), reachedFrom = new Map();
  const mainParentOfKey = (key) => pathAncestors(key).find((c) => nodes.has(c) && (nodes.get(c).rec.host || mainHost) === mainHost) || rootId;
  // pages of other hosts reached by a redirect from a page of the main host (RF-MAP-52)
  const redirectOrigin = new Map();
  for (const [, r] of entries) {
    if (r.html || !r.redirectTo || (r.host || mainHost) !== mainHost) continue;
    const t = resolveCached(r.key);
    if (t && (nodes.get(t).rec.host || mainHost) !== mainHost && !redirectOrigin.has(t)) redirectOrigin.set(t, r.key);
  }
  const clickOf = (id) => (nodes.get(id).rec.clickDepth ?? Infinity);
  const bestOf = (set) => [...set].sort((a, b) => clickOf(a) - clickOf(b) || a.localeCompare(b))[0];
  const navLinkers = new Map(); // only needed for pages of other hosts linked from menus alone
  for (const e of navEdges) {
    if ((nodes.get(e.target).rec.host || mainHost) === mainHost) continue;
    if (!navLinkers.has(e.target)) navLinkers.set(e.target, new Set());
    navLinkers.get(e.target).add(e.source);
  }
  for (const [id, n] of nodes) {
    if (id === rootId) continue;
    const host = n.rec.host || mainHost;
    if (host === mainHost) {
      parent.set(id, mainParentOfKey(id));
      parentKind.set(id, 'path');
      continue;
    }
    if (redirectOrigin.has(id)) {
      parent.set(id, mainParentOfKey(redirectOrigin.get(id)));
      parentKind.set(id, 'redirect');
      reachedFrom.set(id, redirectOrigin.get(id));
      continue;
    }
    const mainLinkers = (set) => new Set([...set].filter((s) => (nodes.get(s).rec.host || mainHost) === mainHost));
    const fromContent = mainLinkers(contentIn.get(id));
    const fromNav = mainLinkers(navLinkers.get(id) || []);
    const pool = fromContent.size ? fromContent : fromNav.size ? fromNav : new Set([...contentIn.get(id), ...(navLinkers.get(id) || [])]);
    pool.delete(id);
    parent.set(id, pool.size ? bestOf(pool) : rootId);
    parentKind.set(id, 'link');
  }
  const defaultParent = new Map(parent);
  const defaultKind = new Map(parentKind);
  const ruleParents = rules.parents || [];
  const ruleApplied = new Set();
  for (const [id, n] of nodes) {
    if (id === rootId) continue;
    for (const rule of ruleParents) {
      if (!matchesRule(rule.match, n.rec.key) || (rule.host || mainHost) !== (n.rec.host || mainHost)) continue;
      const p = lookup(rule.parent);
      if (p && p !== id) {
        parent.set(id, p);
        parentKind.set(id, 'rule');
        ruleApplied.add(id);
      }
      break;
    }
  }
  // a cycle is never allowed: the rule that makes it is ignored (RF-MAP-54), anything else falls back to the root
  for (const id of nodes.keys()) {
    const seen = new Set([id]);
    let cur = id;
    while (cur !== rootId && parent.has(cur)) {
      cur = parent.get(cur);
      if (seen.has(cur)) {
        if (ruleApplied.has(id)) {
          warnings.push(`Regola del genitore ignorata: creerebbe un ciclo (${id})`);
          parent.set(id, defaultParent.get(id));
          parentKind.set(id, defaultKind.get(id));
        } else {
          parent.set(id, rootId);
          parentKind.set(id, 'link');
        }
        break;
      }
      seen.add(cur);
    }
  }
  const childrenOf = new Map();
  for (const [id, p] of parent) {
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p).push(id);
  }
  const level = new Map([[rootId, 0]]);
  const levelOf = (id) => {
    if (level.has(id)) return level.get(id);
    const chain = [];
    let cur = id;
    while (!level.has(cur) && parent.has(cur) && chain.length <= nodes.size) {
      chain.push(cur);
      cur = parent.get(cur);
    }
    let l = level.get(cur) ?? 0;
    for (let i = chain.length - 1; i >= 0; i--) level.set(chain[i], ++l);
    return level.get(id);
  };
  const subtree = new Map();
  const sizeOf = (id) => {
    if (subtree.has(id)) return subtree.get(id);
    let n = 1;
    for (const c of childrenOf.get(id) || []) n += sizeOf(c);
    subtree.set(id, n);
    return n;
  };

  // ---- short names (RF-MAP-60/61) ----
  const titlesByHost = new Map();
  for (const n of nodes.values()) {
    const h = n.rec.host || mainHost;
    if (!titlesByHost.has(h)) titlesByHost.set(h, []);
    if (n.rec.title) titlesByHost.get(h).push(n.rec.title.trim());
  }
  const affixOf = new Map();
  for (const [h, titles] of titlesByHost) {
    const configured = rules.titleAffix === false ? false : rules.titleAffix && rules.titleAffix[h] !== undefined ? rules.titleAffix[h] : undefined;
    if (configured === false) affixOf.set(h, null);
    else if (typeof configured === 'string') affixOf.set(h, { suffix: configured, prefix: configured });
    else affixOf.set(h, detectAffix(titles));
  }
  const names = new Map();
  for (const [id, n] of nodes) names.set(id, shortName(n.rec, affixOf.get(n.rec.host || mainHost), mainHost));

  // ---- areas (RF-MAP-70..73) ----
  const areaOf = new Map();
  const topOf = (id) => {
    let cur = id;
    for (let i = 0; i <= nodes.size; i++) {
      const p = parent.get(cur);
      if (p === undefined || p === rootId) return cur;
      cur = p;
    }
    return cur;
  };
  for (const [id, n] of nodes) {
    const host = n.rec.host || mainHost;
    if (id === rootId) areaOf.set(id, 'Home');
    else if (host !== mainHost) areaOf.set(id, host);
    else {
      const top = topOf(id);
      areaOf.set(id, (childrenOf.get(top) || []).length ? names.get(top) : 'Pagine di primo livello');
    }
  }
  const areaColorOverride = new Map();
  for (const rule of rules.areas || []) {
    if (rule.color && HEX.test(rule.color)) areaColorOverride.set(rule.name, { light: rule.color, dark: rule.color });
    else if (rule.color) warnings.push(`Colore dell'area «${rule.name}» non valido: ${rule.color}`);
  }
  for (const [id, n] of nodes) {
    for (const rule of rules.areas || []) {
      if ((rule.host || mainHost) !== (n.rec.host || mainHost) || !matchesRule(rule.match, n.rec.key)) continue;
      areaOf.set(id, rule.name);
      break;
    }
  }
  const areaCount = new Map();
  for (const a of areaOf.values()) areaCount.set(a, (areaCount.get(a) || 0) + 1);
  const ordered = [...areaCount.entries()].filter(([name]) => name !== 'Home').sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const colorOf = new Map();
  if (areaCount.has('Home')) colorOf.set('Home', areaColorOverride.get('Home') || AREA_PALETTE[0]);
  let slot = areaCount.has('Home') ? 1 : 0;
  for (const [name] of ordered) colorOf.set(name, areaColorOverride.get(name) || (slot < AREA_PALETTE.length ? AREA_PALETTE[slot++] : NEUTRAL_AREA_COLOR));
  const areas = [
    ...(areaCount.has('Home') ? [['Home', areaCount.get('Home')]] : []),
    ...ordered,
  ].map(([name, pages]) => ({ id: name, name, pages, color: colorOf.get(name), neutral: colorOf.get(name) === NEUTRAL_AREA_COLOR }));

  // order of children: by area, then path (RF-MAP-55)
  for (const list of childrenOf.values()) list.sort((a, b) => areaOf.get(a).localeCompare(areaOf.get(b)) || a.localeCompare(b));

  // sub-areas: children of the top pages of an area with enough pages below them (RF-MAP-73)
  const subareas = [];
  for (const [id] of nodes) {
    if (id === rootId) continue;
    const a = areaOf.get(id);
    const p = parent.get(id);
    const pa = areaOf.get(p);
    if (a === pa && parent.get(p) !== undefined && areaOf.get(parent.get(p)) !== a && sizeOf(id) >= subareaMin) subareas.push({ id, area: a, name: names.get(id), pages: sizeOf(id) });
  }
  subareas.sort((x, y) => x.area.localeCompare(y.area) || y.pages - x.pages || x.id.localeCompare(y.id));

  // ---- output nodes ----
  const outNodes = [];
  const onlyFromMenus = new Set();
  for (const [id, n] of nodes) {
    const r = n.rec;
    const cIn = contentIn.get(id), cOut = contentOut.get(id);
    const navIn = navInCount.get(id);
    const isOnlyMenus = id !== rootId && support.links && cIn.size === 0 && navIn > 0;
    if (isOnlyMenus) onlyFromMenus.add(id);
    const totalOut = support.links ? new Set([...cOut, ...navOut.get(id)]).size : r.outlinks || 0;
    outNodes.push({
      id, key: r.key, host: r.host || mainHost, url: r.url || new URL(r.key, inv.baseUrl).href,
      title: r.title || null, shortName: names.get(id), h1: r.h1 || null, description: r.description || null,
      wordCount: r.wordCount ?? null, lang: languageOf(r), hreflang: r.hreflang || [], status: r.status, clickDepth: r.clickDepth ?? null,
      inSitemap: !!r.inSitemap, bytes: r.bytes ?? null, regions: r.regions || null,
      parent: id === rootId ? null : parent.get(id), parentKind: id === rootId ? null : parentKind.get(id), reachedFrom: reachedFrom.get(id) || null,
      level: levelOf(id), children: childrenOf.get(id) || [], subtree: sizeOf(id), area: areaOf.get(id),
      documents: r.documents || [], externalHosts: r.externalHosts || [],
      contentOut: [...cOut].sort(), contentIn: [...cIn].sort(), navOutCount: navOut.get(id).size, navInCount: navIn,
      totalOut, totalIn: support.links ? cIn.size + navIn : r.inlinks || 0,
      globalNav: globalNav.has(id), onlyFromMenus: isOnlyMenus,
    });
  }
  outNodes.sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));
  const nodeOf = new Map(outNodes.map((n) => [n.id, n]));

  // ---- statistics (RF-MAP-80..86) ----
  const total = outNodes.length;
  const byHost = new Map();
  for (const n of outNodes) byHost.set(n.host, (byHost.get(n.host) || 0) + 1);
  const byLevel = {};
  for (const n of outNodes) byLevel[n.level] = (byLevel[n.level] || 0) + 1;
  const langs = new Map();
  for (const n of outNodes) {
    const l = n.lang ? n.lang.split('-')[0].toLowerCase() : null;
    if (!l) continue;
    if (!langs.has(l)) langs.set(l, { lang: l, pages: 0, withAlternate: new Map() });
    const e = langs.get(l);
    e.pages++;
    for (const l2 of new Set((n.hreflang || []).map((h) => String(h.lang).split('-')[0].toLowerCase()))) if (l2 !== l) e.withAlternate.set(l2, (e.withAlternate.get(l2) || 0) + 1);
  }
  const languages = [...langs.values()].sort((a, b) => b.pages - a.pages || a.lang.localeCompare(b.lang)).map((e) => ({
    lang: e.lang, pages: e.pages, alternates: Object.fromEntries([...e.withAlternate.entries()].sort().map(([k, v]) => [k, pct(v, e.pages)])),
  }));

  const words = outNodes.map((n) => n.wordCount).filter((w) => w != null);
  const byWords = outNodes.filter((n) => n.wordCount != null);
  const minN = byWords.reduce((m, n) => (!m || n.wordCount < m.wordCount ? n : m), null);
  const maxN = byWords.reduce((m, n) => (!m || n.wordCount > m.wordCount ? n : m), null);

  // documents: once per URL (RF-MAP-83)
  const docs = inv.documents && inv.documents.length ? inv.documents : null;
  const docsByExt = {}, docsByHost = {};
  let broken = 0, docBytes = 0, checked = 0;
  for (const d of docs || []) {
    docsByExt[d.ext] = (docsByExt[d.ext] || 0) + 1;
    docsByHost[d.host] = (docsByHost[d.host] || 0) + 1;
    if (d.check) {
      checked++;
      if (d.check.error || d.check.status >= 400) broken++;
      else docBytes += d.check.bytes || 0;
    }
  }
  const topDocs = outNodes.filter((n) => n.documents.length).map((n) => ({ id: n.id, documents: new Set(n.documents.map((d) => d.url)).size })).sort((a, b) => b.documents - a.documents || a.id.localeCompare(b.id)).slice(0, 10);

  // ecosystem: hosts linked by the pages (RF-MAP-84)
  const eco = new Map();
  const touch = (host, pageId) => {
    if (!eco.has(host)) eco.set(host, { host, pages: new Set(), visited: byHost.get(host) || 0 });
    if (pageId) eco.get(host).pages.add(pageId);
  };
  for (const [h, set] of hostLinkers) for (const id of set) touch(h, id);
  for (const n of outNodes) {
    for (const h of n.externalHosts) touch(h, n.id);
    for (const d of n.documents) if (d.host !== n.host) touch(d.host, n.id);
  }
  for (const h of byHost.keys()) if (h !== mainHost) touch(h, null);
  const ecosystem = [...eco.values()].map((e) => {
    const rel = hostRelation(e.host, mainHost, domain);
    return { host: e.host, relation: rel === 'sibling' ? (e.visited ? 'sibling-visited' : 'sibling-not-visited') : rel, pages: e.pages.size, visited: e.visited };
  }).sort((a, b) => b.pages - a.pages || a.host.localeCompare(b.host));

  // redirects (RF-MAP-85)
  const areaOfId = (id) => {
    if (nodeOf.has(id)) return nodeOf.get(id).area;
    const key = id;
    for (const rule of rules.areas || []) if (!rule.host && matchesRule(rule.match, key)) return rule.name;
    const anc = pathAncestors(key).find((c) => nodeOf.has(c));
    return anc ? nodeOf.get(anc).area : 'Home';
  };
  const redirects = [];
  for (const [id, r] of entries) {
    if (r.html || !r.redirectTo) continue;
    let hops = 1, cur = r;
    const seen = new Set([id]);
    while (cur.redirectTo && hops < 10) {
      const next = idFromUrl(cur.redirectTo);
      const nr = next && recById.get(next);
      if (!nr || !nr.redirectTo || seen.has(next)) break;
      seen.add(next);
      cur = nr;
      hops++;
    }
    const to = resolveCached(id);
    const links = rawLinks.get(id) || { nav: 0, content: 0 };
    redirects.push({
      id, status: r.status, finalUrl: r.redirectTo, hops, target: to,
      crossHost: !!r.redirectKind && r.redirectKind !== 'same-host', kind: r.redirectKind || null,
      crossArea: !!to && areaOfId(id) !== nodeOf.get(to).area, linkedFromNav: links.nav, linkedFromContent: links.content,
    });
  }
  redirects.sort((a, b) => b.linkedFromNav - a.linkedFromNav || a.id.localeCompare(b.id));

  const withTemplate = support.links ? mainNodes.filter((n) => [...navOut.get(n.id)].some((t) => globalNav.has(t))).length : 0;
  const stats = {
    composition: {
      nodes: total,
      byHost: [...byHost.entries()].map(([host, pages]) => ({ host, relation: hostRelation(host, mainHost, domain), pages })).sort((a, b) => b.pages - a.pages || a.host.localeCompare(b.host)),
      byArea: areas.map((a) => ({ area: a.name, pages: a.pages, pct: pct(a.pages, total) })),
      byLevel,
      byLang: languages.map((l) => ({ lang: l.lang, pages: l.pages })),
    },
    links: {
      contentEdges: contentEdges.length,
      avgContentOut: total ? round1(contentEdges.length / total) : 0,
      globalNavPages: globalNav.size,
      pagesWithTemplate: withTemplate,
      onlyFromMenus: onlyFromMenus.size,
      noContentOut: support.links ? outNodes.filter((n) => n.contentOut.length === 0).length : null,
      notLinked: outNodes.filter((n) => n.clickDepth === null).length,
    },
    content: {
      avgWords: words.length ? Math.round(words.reduce((a, b) => a + b, 0) / words.length) : null,
      medianWords: median(words),
      min: minN ? { id: minN.id, words: minN.wordCount } : null,
      max: maxN ? { id: maxN.id, words: maxN.wordCount } : null,
      thin: byWords.filter((n) => n.wordCount < thinWords).length,
    },
    documents: { unique: (docs || []).length, byExt: docsByExt, byHost: docsByHost, pagesWithDocuments: outNodes.filter((n) => n.documents.length).length, top: topDocs, checked, broken, bytes: docBytes },
    ecosystem,
    redirects,
    languages,
  };

  return {
    version: 1,
    support,
    warnings,
    root: rootId,
    mainHost,
    siteDomain: domain,
    nodes: outNodes,
    edges: {
      hierarchy: outNodes.filter((n) => n.parent !== null).map((n) => ({ source: n.parent, target: n.id, type: n.parentKind })),
      content: contentEdges,
      navigation: navEdges,
    },
    areas,
    subareas,
    stats,
  };
}
