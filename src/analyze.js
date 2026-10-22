import crypto from 'node:crypto';
import { parse } from 'node-html-parser';

const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'table', 'blockquote', 'pre', 'form', 'figure', 'figcaption', 'dt', 'dd', 'br', 'hr']);
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'head']);

export const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

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

/**
 * Parses an HTML document into the page record fields and the list of discovered links.
 * @param {string} html
 * @param {string} pageUrl final URL of the document (used to resolve relative links)
 */
export function analyzeHtml(html, pageUrl) {
  const root = parse(html, { comment: false, blockTextElements: { script: true, style: true, noscript: true, pre: true } });
  const meta = (name) => {
    const el = root.querySelector(`meta[name="${name}"]`) || root.querySelector(`meta[name="${name.toUpperCase()}"]`);
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

  const titleEl = root.querySelector('title');
  const canonicalEl = root.querySelector('link[rel="canonical"]');
  const htmlEl = root.querySelector('html');

  const headings = {};
  for (let i = 1; i <= 6; i++) headings[`h${i}`] = root.querySelectorAll(`h${i}`).length;
  const h1 = root.querySelectorAll('h1').map((e) => clean(e.textContent)).filter(Boolean);

  const hreflang = root.querySelectorAll('link[rel="alternate"][hreflang]').map((e) => ({
    lang: e.getAttribute('hreflang'),
    href: resolve(e.getAttribute('href') || ''),
  }));

  const links = [];
  for (const a of root.querySelectorAll('a[href]')) {
    const href = (a.getAttribute('href') || '').trim();
    if (!href || /^(javascript:|mailto:|tel:|data:|#)/i.test(href)) continue;
    const u = resolve(href);
    if (u && /^https?:/i.test(u)) links.push({ url: u, nofollow: /nofollow/i.test(a.getAttribute('rel') || '') });
  }

  const images = root.querySelectorAll('img');
  const missingAlt = images.filter((i) => i.getAttribute('alt') == null).length;

  let mixed = 0;
  if (/^https:/i.test(pageUrl)) {
    for (const el of root.querySelectorAll('img[src], script[src], link[rel="stylesheet"][href], iframe[src], source[src], video[src], audio[src]')) {
      const v = el.getAttribute('src') || el.getAttribute('href') || '';
      if (/^http:\/\//i.test(v)) mixed++;
    }
  }

  const text = extractText(root);
  const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;

  return {
    page: {
      title: titleEl ? clean(titleEl.textContent) : null,
      description: meta('description'),
      robots: meta('robots'),
      canonical: canonicalEl ? resolve(canonicalEl.getAttribute('href') || '') : null,
      lang: htmlEl ? htmlEl.getAttribute('lang') || null : null,
      viewport: meta('viewport'),
      h1,
      headings,
      hreflang,
      og: { title: prop('og:title'), description: prop('og:description'), image: prop('og:image') },
      wordCount,
      textHash: sha1(text).slice(0, 16),
      images: { total: images.length, missingAlt },
      mixedContent: mixed,
    },
    text,
    links,
  };
}

/** Per-page lint rules. Each issue: { code, severity, message }. */
export function pageIssues(p, { slowMs = 2000 } = {}) {
  const issues = [];
  const add = (code, severity, message) => issues.push({ code, severity, message });
  if (p.error) {
    add('fetch-failed', 'error', p.error);
    return issues;
  }
  if (p.status >= 500) add('http-5xx', 'error', `Status ${p.status}`);
  else if (p.status >= 400) add('http-4xx', 'error', `Status ${p.status}`);
  if (p.redirects && p.redirects.length > 1) add('redirect-chain', 'warn', `Catena di ${p.redirects.length} redirect`);
  if (p.responseMs > slowMs) add('slow-response', 'warn', `Risposta in ${p.responseMs} ms`);
  if (!p.isHtml || p.status >= 300) return issues;

  if (!p.title) add('title-missing', 'warn', 'Tag <title> assente o vuoto');
  else if (p.title.length > 65) add('title-too-long', 'info', `Title di ${p.title.length} caratteri`);
  if (!p.description) add('description-missing', 'warn', 'Meta description assente');
  else if (p.description.length > 170) add('description-too-long', 'info', `Description di ${p.description.length} caratteri`);
  if (!p.h1 || !p.h1.length) add('h1-missing', 'warn', 'Nessun H1');
  else if (p.h1.length > 1) add('h1-multiple', 'info', `${p.h1.length} H1 nella pagina`);
  if (!p.lang) add('lang-missing', 'info', 'Attributo lang assente su <html>');
  if (!p.viewport) add('viewport-missing', 'info', 'Meta viewport assente');
  if (/noindex/i.test(p.robots || '')) add('noindex', 'info', `Meta robots: ${p.robots}`);
  if (!p.canonical) add('canonical-missing', 'info', 'Link canonical assente');
  else if (p.canonicalKey && p.canonicalKey !== p.key) add('canonical-other', 'info', `Canonical verso ${p.canonical}`);
  if (p.images && p.images.missingAlt) add('img-alt-missing', 'warn', `${p.images.missingAlt} immagini senza alt su ${p.images.total}`);
  if (p.mixedContent) add('mixed-content', 'warn', `${p.mixedContent} risorse http:// su pagina https`);
  if (p.bytes > 3 * 1024 * 1024) add('page-heavy', 'info', `HTML di ${(p.bytes / 1024 / 1024).toFixed(1)} MB`);
  return issues;
}

/** Cross-page rules: broken internal links, duplicate titles/descriptions. Mutates page issues. */
export function siteIssues(pages) {
  const byKey = new Map(pages.map((p) => [p.key, p]));
  for (const p of pages) {
    const broken = (p.links?.internal || []).filter((k) => {
      const t = byKey.get(k);
      return t && (t.error || t.status >= 400 || t.finalStatus >= 400);
    });
    if (broken.length) {
      p.issues.push({ code: 'broken-links', severity: 'error', message: `${broken.length} link interni rotti: ${broken.slice(0, 5).join(', ')}${broken.length > 5 ? '…' : ''}`, targets: broken });
    }
  }
  const issues = [];
  const dup = (field, code, severity, label) => {
    const groups = new Map();
    for (const p of pages) {
      if (!p.isHtml || p.status !== 200 || !p[field]) continue;
      if (/noindex/i.test(p.robots || '')) continue;
      if (p.canonicalKey && p.canonicalKey !== p.key) continue;
      const k = p[field].toLowerCase();
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p.key);
    }
    for (const [value, keys] of groups) {
      if (keys.length < 2) continue;
      keys.sort();
      issues.push({ code, id: `${code}:${sha1(value).slice(0, 10)}`, severity, key: keys[0], message: `${label} duplicato su ${keys.length} pagine: «${value.slice(0, 80)}»`, pages: keys });
    }
  };
  dup('title', 'title-duplicate', 'warn', 'Title');
  dup('description', 'description-duplicate', 'info', 'Description');
  return issues;
}
