import crypto from 'node:crypto';
import { parse } from 'node-html-parser';
import { toKey, indexabilityOf } from './core/compare.js';
import { ISSUE_TYPES } from './core/diagnose.js';

const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'table', 'blockquote', 'pre', 'form', 'figure', 'figcaption', 'dt', 'dd', 'br', 'hr']);
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'head']);

export const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

/** Thresholds of the quality rules; a site can override them under `quality`. */
export const QUALITY_DEFAULTS = {
  slowMs: 2000,
  titleMin: 30,
  titleMax: 65,
  descriptionMin: 70,
  descriptionMax: 170,
  thinWords: 200,
  maxClickDepth: 3,
  maxDomNodes: 1500,
  maxUrlLength: 115,
};

// Link texts that say nothing about the destination (Lighthouse "link-text", in the languages we meet most).
const GENERIC_ANCHORS = new Set([
  'click here', 'click', 'here', 'read more', 'more', 'learn more', 'see more', 'more info', 'details', 'continue', 'go', 'link', 'this', 'start',
  'clicca qui', 'clicca', 'qui', 'leggi', 'leggi di più', 'leggi tutto', 'scopri', 'scopri di più', 'continua', 'dettagli', 'più info', 'altro', 'vai', 'approfondisci', 'vedi tutto', 'info',
  'mehr', 'weiterlesen', 'hier', 'mehr erfahren', 'en savoir plus', 'lire la suite', 'ici', 'cliquez ici', 'más', 'leer más', 'aquí',
]);
const SOFT404 = /\b404\b|not found|page (?:does not|doesn't) exist|pagina non trovata|pagina non esiste|page introuvable|seite nicht gefunden|página no encontrada/i;
const PLACEHOLDER = /lorem ipsum|dolor sit amet/i;
// BCP 47 subset accepted by search engines for hreflang: language[-Script][-REGION], or x-default.
const HREFLANG = /^(x-default|[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?)$/i;
const SECURITY_HEADERS = { hsts: 'Strict-Transport-Security', csp: 'Content-Security-Policy', xcto: 'X-Content-Type-Options', xfo: 'X-Frame-Options', referrer: 'Referrer-Policy' };

function decode(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

// Visible text, one line per block element, whitespace collapsed.
function extractText(root) {
  const lines = [];
  let cur = '';
  const flush = () => {
    const t = cur.replace(/\s+/g, ' ').trim();
    if (t) lines.push(t);
    cur = '';
  };
  const walk = (node) => {
    if (node.nodeType === 3) {
      cur += decode(node.rawText);
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = (node.rawTagName || '').toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    const block = BLOCK_TAGS.has(tag);
    if (block) flush();
    for (const c of node.childNodes) walk(c);
    if (block) flush();
  };
  const body = root.querySelector('body') || root;
  walk(body);
  flush();
  return lines.join('\n');
}

const clean = (s) => (s == null ? null : decode(String(s)).replace(/\s+/g, ' ').trim());

// @type values of a JSON-LD document, including those inside @graph.
function jsonLdTypes(v, out) {
  if (Array.isArray(v)) v.forEach((x) => jsonLdTypes(x, out));
  else if (v && typeof v === 'object') {
    const t = v['@type'];
    if (t) (Array.isArray(t) ? t : [t]).forEach((x) => out.add(String(x)));
    if (v['@graph']) jsonLdTypes(v['@graph'], out);
  }
  return out;
}

const attr = (el, name) => (el.getAttribute(name) || '').trim();
const hasName = (el) => !!(attr(el, 'aria-label') || attr(el, 'aria-labelledby') || attr(el, 'title'));

/**
 * Parses an HTML document into the page record fields and the list of discovered links.
 * @param {string} html
 * @param {string} pageUrl final URL of the document (used to resolve relative links)
 */
export function analyzeHtml(html, pageUrl) {
  const root = parse(html, { comment: false, blockTextElements: { script: true, style: true, noscript: true, pre: true } });
  const metas = (name) => root.querySelectorAll('meta[name]').filter((e) => attr(e, 'name').toLowerCase() === name);
  const meta = (name) => {
    const el = metas(name)[0];
    return el ? clean(el.getAttribute('content')) : null;
  };
  const prop = (p) => {
    const el = root.querySelector(`meta[property="${p}"]`);
    return el ? clean(el.getAttribute('content')) : null;
  };
  const abs = (href) => {
    try {
      return new URL(href, pageUrl).toString();
    } catch {
      return null;
    }
  };

  const base = root.querySelector('base[href]');
  const baseHref = base ? abs(base.getAttribute('href')) || pageUrl : pageUrl;
  const resolve = (href) => {
    try {
      return new URL(href, baseHref).toString();
    } catch {
      return null;
    }
  };

  // <title> of SVG icons is not the document title
  const titles = root.querySelectorAll('title').filter((e) => !e.closest('svg'));
  const canonicals = root.querySelectorAll('link[rel="canonical"]');
  const canonicalHref = canonicals.length ? canonicals[0].getAttribute('href') || '' : null;
  const htmlEl = root.querySelector('html');

  const headings = {};
  for (let i = 1; i <= 6; i++) headings[`h${i}`] = root.querySelectorAll(`h${i}`).length;
  const h1 = root.querySelectorAll('h1').map((e) => clean(e.textContent)).filter(Boolean);
  // first jump of more than one level going down the outline (e.g. h2 → h4)
  let headingSkip = null;
  let prev = 0;
  for (const el of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const lvl = Number(el.rawTagName.slice(1));
    if (prev && lvl > prev + 1) { headingSkip = `h${prev} → h${lvl}`; break; }
    prev = lvl;
  }

  const hreflang = root.querySelectorAll('link[rel="alternate"][hreflang]').map((e) => ({
    lang: e.getAttribute('hreflang'),
    href: resolve(e.getAttribute('href') || ''),
  }));

  const links = [];
  const anchors = { empty: 0, generic: 0 };
  for (const a of root.querySelectorAll('a[href]')) {
    const href = (a.getAttribute('href') || '').trim();
    if (!href || /^(javascript:|mailto:|tel:|data:|#)/i.test(href)) continue;
    const u = resolve(href);
    if (!u || !/^https?:/i.test(u)) continue;
    links.push({ url: u, nofollow: /nofollow/i.test(a.getAttribute('rel') || '') });
    const imgAlt = a.querySelectorAll('img').map((i) => attr(i, 'alt')).join(' ').trim();
    const text = clean(a.textContent) || imgAlt || attr(a, 'aria-label') || attr(a, 'title');
    if (!text) anchors.empty++;
    else if (GENERIC_ANCHORS.has(text.toLowerCase().replace(/[\s.…:»›→>!]+$/u, '').trim())) anchors.generic++;
  }

  const images = root.querySelectorAll('img');
  const missingAlt = images.filter((i) => i.getAttribute('alt') == null).length;
  const missingSize = images.filter((i) => !i.getAttribute('width') || !i.getAttribute('height')).length;

  let mixed = 0, insecureForms = 0;
  if (/^https:/i.test(pageUrl)) {
    for (const el of root.querySelectorAll('img[src], script[src], link[rel="stylesheet"][href], iframe[src], source[src], video[src], audio[src]')) {
      const v = el.getAttribute('src') || el.getAttribute('href') || '';
      if (/^http:\/\//i.test(v)) mixed++;
    }
    for (const f of root.querySelectorAll('form[action]')) if (/^http:\/\//i.test(resolve(attr(f, 'action')) || '')) insecureForms++;
  }

  const structuredData = { types: new Set(), invalid: 0 };
  for (const s of root.querySelectorAll('script')) {
    if (!/application\/ld\+json/i.test(s.getAttribute('type') || '')) continue;
    try {
      jsonLdTypes(JSON.parse(s.rawText || s.textContent), structuredData.types);
    } catch {
      structuredData.invalid++;
    }
  }

  // Accessible names that can be checked without rendering.
  const labelled = new Set(root.querySelectorAll('label[for]').map((l) => l.getAttribute('for')));
  const unlabeledInputs = root.querySelectorAll('input, select, textarea').filter((el) => {
    if (/^(hidden|submit|button|reset|image)$/i.test(attr(el, 'type'))) return false;
    return !hasName(el) && !(el.id && labelled.has(el.id)) && !el.closest('label');
  }).length;
  const unnamedButtons = root.querySelectorAll('button').filter((b) => !clean(b.textContent) && !hasName(b) && !b.querySelectorAll('img').some((i) => attr(i, 'alt'))).length;
  const untitledIframes = root.querySelectorAll('iframe').filter((f) => !attr(f, 'title')).length;

  const refresh = root.querySelectorAll('meta[http-equiv]').find((e) => attr(e, 'http-equiv').toLowerCase() === 'refresh');
  const charsetMeta = root.querySelector('meta[charset]');
  const ctMeta = root.querySelectorAll('meta[http-equiv]').find((e) => attr(e, 'http-equiv').toLowerCase() === 'content-type');
  const charset = charsetMeta ? attr(charsetMeta, 'charset') : ctMeta ? (/charset=([\w-]+)/i.exec(ctMeta.getAttribute('content') || '') || [])[1] || null : null;

  const text = extractText(root);
  const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;

  return {
    page: {
      title: titles.length ? clean(titles[0].textContent) : null,
      titleCount: titles.length,
      description: meta('description'),
      descriptionCount: metas('description').length,
      robots: meta('robots'),
      canonical: canonicalHref != null ? resolve(canonicalHref) : null,
      canonicalCount: new Set(canonicals.map((e) => resolve(e.getAttribute('href') || ''))).size,
      canonicalRelative: canonicalHref != null && !/^(https?:)?\/\//i.test(canonicalHref.trim()),
      lang: htmlEl ? htmlEl.getAttribute('lang') || null : null,
      viewport: meta('viewport'),
      charset,
      doctype: /^﻿?\s*(<!--[\s\S]*?-->\s*)*<!doctype\s+html/i.test(html),
      metaRefresh: refresh ? clean(refresh.getAttribute('content')) || '' : null,
      h1,
      headings,
      headingSkip,
      hreflang,
      og: { title: prop('og:title'), description: prop('og:description'), image: prop('og:image') },
      structuredData: { types: [...structuredData.types].sort(), invalid: structuredData.invalid },
      wordCount,
      textHash: sha1(text).slice(0, 16),
      placeholderText: PLACEHOLDER.test(text),
      images: { total: images.length, missingAlt, missingSize },
      anchors,
      domNodes: root.querySelectorAll('*').length,
      mixedContent: mixed,
      insecureForms,
      a11y: { unlabeledInputs, unnamedButtons, untitledIframes },
    },
    text,
    links,
  };
}

/** Indexability fields of a page record (see indexabilityOf). */
export function setIndexability(p) {
  const why = indexabilityOf(p);
  p.indexable = !why;
  p.indexability = why;
  return p;
}

/** Per-page lint rules. Each issue: { code, severity, message }. */
export function pageIssues(p, opts = {}) {
  const q = { ...QUALITY_DEFAULTS, ...opts };
  const issues = [];
  const add = (code, message) => issues.push({ code, severity: ISSUE_TYPES[code][0], message });
  if (p.error) {
    add('fetch-failed', p.error);
    return issues;
  }
  if (p.status >= 500) add('http-5xx', `Status ${p.status}`);
  else if (p.status >= 400) add('http-4xx', `Status ${p.status}`);
  if (p.redirectLoop) add('redirect-loop', `Redirect in loop o oltre 10 passaggi: ${p.redirects.map((r) => r.status).join(' → ')}`);
  else if (p.redirects && p.redirects.length > 1) add('redirect-chain', `Catena di ${p.redirects.length} redirect`);
  if (p.redirects && p.redirects.length && [302, 303, 307].includes(p.redirects[0].status)) add('redirect-temporary', `Redirect ${p.redirects[0].status} verso ${p.redirects[0].location}`);
  if (p.responseMs > q.slowMs) add('slow-response', `Risposta in ${p.responseMs} ms`);

  let path = '';
  try { path = decodeURIComponent(new URL(p.url).pathname); } catch { /* keep empty */ }
  if (/[A-Z]/.test(path)) add('url-uppercase', `Path con maiuscole: ${path}`);
  if (path.includes('_')) add('url-underscore', `Path con underscore: ${path}`);
  if (p.url && p.url.length > q.maxUrlLength) add('url-too-long', `URL di ${p.url.length} caratteri`);
  if (/\/\/|\s/.test(path)) add('url-malformed', `Path con doppio slash o spazi: ${path}`);

  if (!p.isHtml || p.status >= 300) return issues;

  const indexable = p.indexable ?? !indexabilityOf(p);
  if (!p.title) add('title-missing', 'Tag <title> assente o vuoto');
  else if (p.title.length > q.titleMax) add('title-too-long', `Title di ${p.title.length} caratteri`);
  else if (p.title.length < q.titleMin) add('title-too-short', `Title di ${p.title.length} caratteri`);
  if (p.titleCount > 1) add('title-multiple', `${p.titleCount} tag <title>`);
  if (!p.description) add('description-missing', 'Meta description assente');
  else if (p.description.length > q.descriptionMax) add('description-too-long', `Description di ${p.description.length} caratteri`);
  else if (p.description.length < q.descriptionMin) add('description-too-short', `Description di ${p.description.length} caratteri`);
  if (p.descriptionCount > 1) add('description-multiple', `${p.descriptionCount} meta description`);
  if (!p.h1 || !p.h1.length) add('h1-missing', 'Nessun H1');
  else if (p.h1.length > 1) add('h1-multiple', `${p.h1.length} H1 nella pagina`);
  if (p.headingSkip) add('heading-skip', `Salto di livello ${p.headingSkip}`);
  if (!p.lang) add('lang-missing', 'Attributo lang assente su <html>');
  if (!p.viewport) add('viewport-missing', 'Meta viewport assente');
  if (p.doctype === false) add('doctype-missing', 'Documento senza <!doctype html>');
  if (p.charset === null) add('charset-missing', 'Charset non dichiarato né nel meta né nell\'header Content-Type');
  if (/noindex/i.test(p.robots || '')) add('noindex', `Meta robots: ${p.robots}`);
  if (/\b(noindex|none)\b/i.test(p.xRobots || '')) add('x-robots-noindex', `X-Robots-Tag: ${p.xRobots}`);
  if (/\b(nofollow|none)\b/i.test(`${p.robots || ''} ${p.xRobots || ''}`)) add('nofollow-page', 'I link della pagina non vengono seguiti dai motori di ricerca');
  if (!p.canonical) add('canonical-missing', 'Link canonical assente');
  else if (p.canonicalKey && p.canonicalKey !== p.key) add('canonical-other', `Canonical verso ${p.canonical}`);
  if (p.canonicalCount > 1) add('canonical-multiple', `${p.canonicalCount} canonical diversi`);
  if (p.canonicalRelative) add('canonical-relative', 'Canonical con URL relativo');
  if (p.metaRefresh != null) add('meta-refresh', `Meta refresh: ${p.metaRefresh}`);
  if (p.status === 200 && (SOFT404.test(p.title || '') || (p.h1 || []).some((h) => SOFT404.test(h)))) add('soft-404', `Status 200 ma la pagina sembra un errore: «${p.title || p.h1[0]}»`);
  if (indexable && p.wordCount < q.thinWords) add('thin-content', `${p.wordCount} parole (soglia ${q.thinWords})`);
  if (p.placeholderText) add('placeholder-text', 'Il testo contiene «lorem ipsum»');
  if (p.structuredData && p.structuredData.invalid) add('structured-data-invalid', `${p.structuredData.invalid} blocchi JSON-LD non leggibili`);
  if (indexable && p.og && (!p.og.title || !p.og.image)) add('og-missing', `Manca ${[!p.og.title && 'og:title', !p.og.image && 'og:image'].filter(Boolean).join(' e ')}`);

  const hl = p.hreflang || [];
  if (hl.length) {
    const bad = hl.filter((x) => !HREFLANG.test(x.lang || ''));
    if (bad.length) add('hreflang-invalid', `Codici non validi: ${bad.map((x) => x.lang || '∅').join(', ')}`);
    if (!hl.some((x) => x.href && sameOrigin(x.href, p.url) && toKey(x.href) === p.key)) add('hreflang-self-missing', 'Gli hreflang non includono la pagina stessa');
    if (!hl.some((x) => /^x-default$/i.test(x.lang || ''))) add('hreflang-x-default-missing', 'Nessun hreflang x-default');
  }

  if (p.images && p.images.missingAlt) add('img-alt-missing', `${p.images.missingAlt} immagini senza alt su ${p.images.total}`);
  if (p.images && p.images.missingSize) add('img-no-dimensions', `${p.images.missingSize} immagini senza width/height su ${p.images.total}`);
  if (p.mixedContent) add('mixed-content', `${p.mixedContent} risorse http:// su pagina https`);
  if (p.insecureForms) add('form-insecure', `${p.insecureForms} form con action http://`);
  if (p.compressed === false && p.bytes > 1400) add('compression-missing', `HTML di ${Math.round(p.bytes / 1024)} KB servito senza compressione`);
  if (p.bytes > 3 * 1024 * 1024) add('page-heavy', `HTML di ${(p.bytes / 1024 / 1024).toFixed(1)} MB`);
  if (p.domNodes > q.maxDomNodes) add('dom-large', `${p.domNodes} elementi nel DOM (soglia ${q.maxDomNodes})`);
  if (p.a11y && p.a11y.unlabeledInputs) add('input-no-label', `${p.a11y.unlabeledInputs} campi senza label o aria-label`);
  if (p.a11y && p.a11y.unnamedButtons) add('button-no-name', `${p.a11y.unnamedButtons} pulsanti senza testo o aria-label`);
  if (p.a11y && p.a11y.untitledIframes) add('iframe-no-title', `${p.a11y.untitledIframes} iframe senza title`);
  if (p.anchors && p.anchors.empty) add('anchor-empty', `${p.anchors.empty} link senza testo`);
  if (p.anchors && p.anchors.generic) add('anchor-generic', `${p.anchors.generic} link con testo generico («clicca qui», «leggi di più»…)`);
  if (p.links && p.links.nofollow) add('nofollow-internal', `${p.links.nofollow} link interni con rel="nofollow"`);
  return issues;
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

const sample = (keys) => `${keys.slice(0, 5).join(', ')}${keys.length > 5 ? '…' : ''}`;

/**
 * Cross-page rules. Adds page issues to the page records (broken links, canonical and hreflang
 * targets, sitemap, click depth) and returns the site-level issues (duplicates, robots/sitemap,
 * security headers).
 * @param {object[]} pages
 * @param {object} [ctx]
 * @param {string[]} [ctx.startKeys]    keys of the start URLs (click depth 0)
 * @param {string[]} [ctx.sitemapKeys]  keys listed in the sitemaps
 * @param {boolean|null} [ctx.robotsFound]   null = not checked
 * @param {boolean|null} [ctx.sitemapFound]  null = not checked
 * @param {object} [ctx.quality]        thresholds (QUALITY_DEFAULTS)
 */
export function siteIssues(pages, ctx = {}) {
  const q = { ...QUALITY_DEFAULTS, ...(ctx.quality || {}) };
  const byKey = new Map(pages.map((p) => [p.key, p]));
  for (const p of pages) if (p.indexable === undefined) setIndexability(p);
  const add = (p, code, message, extra = {}) => p.issues.push({ code, severity: ISSUE_TYPES[code][0], message, ...extra });
  const isBroken = (t) => t.error || t.status >= 400 || t.finalStatus >= 400;

  // Click depth: shortest path in internal links from the start pages.
  const startKeys = new Set(ctx.startKeys && ctx.startKeys.length ? ctx.startKeys : pages.filter((p) => p.depth === 0).map((p) => p.key));
  let frontier = [...startKeys].filter((k) => byKey.has(k));
  for (const k of frontier) byKey.get(k).clickDepth = 0;
  for (let d = 1; frontier.length; d++) {
    const next = [];
    for (const k of frontier) {
      for (const t of byKey.get(k).links?.internal || []) {
        const tp = byKey.get(t);
        if (!tp || tp.clickDepth != null) continue;
        tp.clickDepth = d;
        next.push(t);
      }
    }
    frontier = next;
  }

  const inlinks = new Map();
  for (const p of pages) for (const t of p.links?.internal || []) if (t !== p.key) inlinks.set(t, (inlinks.get(t) || 0) + 1);
  const sitemap = new Set(ctx.sitemapKeys || []);

  for (const p of pages) {
    if (p.clickDepth === undefined) p.clickDepth = null;
    const internal = p.links?.internal || [];
    const broken = internal.filter((k) => byKey.has(k) && isBroken(byKey.get(k)));
    if (broken.length) add(p, 'broken-links', `${broken.length} link interni rotti: ${sample(broken)}`, { targets: broken });
    const redirected = internal.filter((k) => byKey.has(k) && !isBroken(byKey.get(k)) && byKey.get(k).redirects?.length);
    if (redirected.length) add(p, 'links-to-redirect', `${redirected.length} link interni verso redirect: ${sample(redirected)}`, { targets: redirected });
    const ok = p.isHtml && !p.error && p.status >= 200 && p.status < 300;
    if (ok && p.links && !internal.some((k) => k !== p.key)) add(p, 'no-internal-outlinks', 'La pagina non linka nessun\'altra pagina del sito');
    if (p.indexable && p.clickDepth > q.maxClickDepth) add(p, 'deep-page', `${p.clickDepth} clic dalla pagina iniziale (soglia ${q.maxClickDepth})`);

    if (ok && p.canonicalKey && p.canonicalKey !== p.key && byKey.has(p.canonicalKey)) {
      const t = byKey.get(p.canonicalKey);
      if (isBroken(t)) add(p, 'canonical-broken', `Canonical verso ${p.canonicalKey} (${t.error || t.finalStatus || t.status})`);
      else if (t.redirects?.length) add(p, 'canonical-to-redirect', `Canonical verso ${p.canonicalKey}, che redirige a ${t.finalUrl}`);
      else if (/\b(noindex|none)\b/i.test(`${t.robots || ''} ${t.xRobots || ''}`)) add(p, 'canonical-to-noindex', `Canonical verso ${p.canonicalKey}, che è noindex`);
    }

    if (ok && p.hreflang?.length) {
      const hBroken = [], noReturn = [];
      for (const x of p.hreflang) {
        if (!x.href || !sameOrigin(x.href, p.url)) continue;
        const k = toKey(x.href);
        const t = byKey.get(k);
        if (!t || k === p.key) continue;
        if (t.error || t.status >= 300) hBroken.push(k);
        else if (t.isHtml && !(t.hreflang || []).some((y) => y.href && toKey(y.href) === p.key)) noReturn.push(k);
      }
      if (hBroken.length) add(p, 'hreflang-broken', `${hBroken.length} alternate non 2xx: ${sample(hBroken)}`, { targets: hBroken });
      if (noReturn.length) add(p, 'hreflang-return-missing', `${noReturn.length} alternate senza hreflang di ritorno: ${sample(noReturn)}`, { targets: noReturn });
    }

    if (sitemap.has(p.key) && !p.indexable) add(p, 'sitemap-non-indexable', `In sitemap ma non indicizzabile (${p.indexability})`);
    if (sitemap.size && p.indexable && !sitemap.has(p.key)) add(p, 'not-in-sitemap', 'Pagina indicizzabile non elencata nella sitemap');
    if (sitemap.has(p.key) && ok && !inlinks.get(p.key) && !startKeys.has(p.key)) add(p, 'orphan-page', 'Elencata nella sitemap ma nessuna pagina del sito la linka');
  }

  const issues = [];
  const siteIssue = (code, id, key, message, extra = {}) => issues.push({ code, id, severity: ISSUE_TYPES[code][0], key, message, ...extra });
  const dup = (value, code, label, show = (v) => `«${v.slice(0, 80)}»`) => {
    const groups = new Map();
    for (const p of pages) {
      const v = value(p);
      if (!p.indexable || p.status !== 200 || !v) continue;
      if (!groups.has(v)) groups.set(v, []);
      groups.get(v).push(p.key);
    }
    for (const [v, keys] of groups) {
      if (keys.length < 2) continue;
      keys.sort();
      siteIssue(code, `${code}:${sha1(v).slice(0, 10)}`, keys[0], `${label} su ${keys.length} pagine${show(v) ? `: ${show(v)}` : ''}`, { pages: keys });
    }
  };
  dup((p) => p.title && p.title.toLowerCase(), 'title-duplicate', 'Title duplicato');
  dup((p) => p.description && p.description.toLowerCase(), 'description-duplicate', 'Description duplicata');
  dup((p) => p.wordCount && p.textHash, 'content-duplicate', 'Testo identico', () => '');

  if (ctx.robotsFound === false) siteIssue('robots-missing', 'robots-missing', '/robots.txt', 'robots.txt non trovato', { pages: [] });
  if (ctx.sitemapFound === false) siteIssue('sitemap-missing', 'sitemap-missing', '/sitemap.xml', 'Nessuna sitemap trovata (sitemap.xml o dichiarata in robots.txt)', { pages: [] });

  const withHeaders = pages.filter((p) => p.securityHeaders && /^https:/i.test(p.url));
  for (const [h, name] of Object.entries(SECURITY_HEADERS)) {
    const missing = withHeaders.filter((p) => !p.securityHeaders.includes(h)).map((p) => p.key).sort();
    if (missing.length) siteIssue('security-headers-missing', `security-headers-missing:${h}`, missing[0], `Header ${name} assente su ${missing.length} pagine`, { pages: missing });
  }
  return issues;
}

/**
 * Applies the `quality` section of a site to the computed issues: drops disabled codes and
 * overrides severities. Returns the codes that remain active (recorded in the snapshot).
 */
export function applyQuality(pages, issues, quality = {}) {
  const disabled = new Set(quality.disable || []);
  const severity = quality.severity || {};
  const keep = (list) => list.filter((i) => !disabled.has(i.code)).map((i) => (severity[i.code] ? { ...i, severity: severity[i.code] } : i));
  for (const p of pages) p.issues = keep(p.issues || []);
  return { issues: keep(issues), issueCodes: Object.keys(ISSUE_TYPES).filter((c) => !disabled.has(c)) };
}
