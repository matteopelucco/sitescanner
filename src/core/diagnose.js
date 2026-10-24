// Single-scan diagnostics shared by the CLI and the HTML report (inlined in the browser).
// Only imports from compare.js are allowed: the report build strips import/export lines and
// embeds this file right after compare.js, in the same scope.
import { SEVERITY_RANK, indexabilityOf } from './compare.js';

// Every quality issue code checked by analyze.js: [default severity, category, Italian description].
// It is also the rule set recorded in each scan (options.issueCodes).
export const ISSUE_TYPES = {
  'fetch-failed': ['error', 'Risposte', 'Pagina non raggiungibile'],
  'http-5xx': ['error', 'Risposte', 'Errore del server (5xx)'],
  'http-4xx': ['error', 'Risposte', 'Pagina non trovata o negata (4xx)'],
  'soft-404': ['warn', 'Risposte', 'Probabile soft 404 (pagina di errore con status 200)'],
  'slow-response': ['warn', 'Prestazioni', 'Risposta lenta'],
  'redirect-broken': ['error', 'Redirect', 'Redirect verso pagina in errore'],
  'redirect-loop': ['error', 'Redirect', 'Loop di redirect o troppi redirect'],
  'redirect-chain': ['warn', 'Redirect', 'Catena di redirect'],
  'redirect-temporary': ['info', 'Redirect', 'Redirect temporaneo (302/303/307)'],
  'meta-refresh': ['warn', 'Redirect', 'Redirect con meta refresh'],
  'noindex': ['info', 'Indicizzabilità', 'Pagina noindex'],
  'x-robots-noindex': ['info', 'Indicizzabilità', 'Noindex via header X-Robots-Tag'],
  'nofollow-page': ['info', 'Indicizzabilità', 'Pagina nofollow (meta robots o X-Robots-Tag)'],
  'canonical-missing': ['info', 'Canonical', 'Canonical assente'],
  'canonical-other': ['info', 'Canonical', 'Canonical verso altra pagina'],
  'canonical-multiple': ['error', 'Canonical', 'Canonical multipli in conflitto'],
  'canonical-relative': ['info', 'Canonical', 'Canonical relativo'],
  'canonical-broken': ['error', 'Canonical', 'Canonical verso pagina in errore'],
  'canonical-to-redirect': ['warn', 'Canonical', 'Canonical verso un redirect'],
  'canonical-to-noindex': ['warn', 'Canonical', 'Canonical verso pagina noindex'],
  'title-missing': ['warn', 'Title e description', 'Title assente'],
  'title-too-long': ['info', 'Title e description', 'Title troppo lungo'],
  'title-too-short': ['info', 'Title e description', 'Title troppo corto'],
  'title-multiple': ['warn', 'Title e description', 'Più tag title'],
  'title-duplicate': ['warn', 'Title e description', 'Title duplicato'],
  'description-missing': ['warn', 'Title e description', 'Meta description assente'],
  'description-too-long': ['info', 'Title e description', 'Meta description troppo lunga'],
  'description-too-short': ['info', 'Title e description', 'Meta description troppo corta'],
  'description-multiple': ['warn', 'Title e description', 'Più meta description'],
  'description-duplicate': ['info', 'Title e description', 'Meta description duplicata'],
  'h1-missing': ['warn', 'Heading', 'H1 assente'],
  'h1-multiple': ['info', 'Heading', 'H1 multipli'],
  'heading-skip': ['info', 'Heading', 'Livelli di heading saltati'],
  'thin-content': ['info', 'Contenuti', 'Poco testo (thin content)'],
  'content-duplicate': ['warn', 'Contenuti', 'Contenuto duplicato'],
  'placeholder-text': ['warn', 'Contenuti', 'Testo segnaposto (lorem ipsum)'],
  'broken-links': ['error', 'Link', 'Link interni rotti'],
  'links-to-redirect': ['info', 'Link', 'Link interni verso redirect'],
  'no-internal-outlinks': ['warn', 'Link', 'Nessun link interno in uscita'],
  'deep-page': ['info', 'Link', 'Pagina profonda (troppi clic dalla home)'],
  'nofollow-internal': ['info', 'Link', 'Link interni nofollow'],
  'anchor-empty': ['info', 'Link', 'Link senza testo'],
  'anchor-generic': ['info', 'Link', 'Link con testo generico'],
  'sitemap-non-indexable': ['warn', 'Sitemap e robots', 'URL non indicizzabile in sitemap'],
  'not-in-sitemap': ['info', 'Sitemap e robots', 'Pagina indicizzabile assente dalla sitemap'],
  'orphan-page': ['warn', 'Sitemap e robots', 'Pagina orfana (in sitemap, mai linkata)'],
  'robots-missing': ['info', 'Sitemap e robots', 'robots.txt assente'],
  'sitemap-missing': ['info', 'Sitemap e robots', 'Sitemap assente'],
  'hreflang-invalid': ['warn', 'Hreflang', 'Codici hreflang non validi'],
  'hreflang-broken': ['warn', 'Hreflang', 'Hreflang verso pagine non 2xx'],
  'hreflang-return-missing': ['warn', 'Hreflang', 'Hreflang senza link di ritorno'],
  'hreflang-self-missing': ['info', 'Hreflang', 'Hreflang senza riferimento a sé stessa'],
  'hreflang-x-default-missing': ['info', 'Hreflang', 'Hreflang senza x-default'],
  'structured-data-invalid': ['error', 'Dati strutturati', 'JSON-LD non valido'],
  'og-missing': ['info', 'Dati strutturati', 'Open Graph incompleto'],
  'mixed-content': ['warn', 'Sicurezza', 'Mixed content'],
  'form-insecure': ['warn', 'Sicurezza', 'Form che inviano dati in HTTP'],
  'security-headers-missing': ['info', 'Sicurezza', 'Header di sicurezza assenti'],
  'compression-missing': ['info', 'Prestazioni', 'HTML non compresso'],
  'page-heavy': ['info', 'Prestazioni', 'HTML molto pesante'],
  'dom-large': ['info', 'Prestazioni', 'DOM troppo grande'],
  'img-no-dimensions': ['info', 'Prestazioni', 'Immagini senza width/height'],
  'viewport-missing': ['info', 'HTML e URL', 'Meta viewport assente'],
  'lang-missing': ['info', 'HTML e URL', 'Lingua (lang) assente'],
  'doctype-missing': ['info', 'HTML e URL', 'Doctype assente'],
  'charset-missing': ['info', 'HTML e URL', 'Charset non dichiarato'],
  'url-uppercase': ['info', 'HTML e URL', 'URL con maiuscole'],
  'url-underscore': ['info', 'HTML e URL', 'URL con underscore'],
  'url-too-long': ['info', 'HTML e URL', 'URL troppo lungo'],
  'url-malformed': ['info', 'HTML e URL', 'URL con doppio slash o spazi'],
  'img-alt-missing': ['warn', 'Accessibilità', 'Immagini senza alt'],
  'input-no-label': ['warn', 'Accessibilità', 'Campi di form senza etichetta'],
  'button-no-name': ['warn', 'Accessibilità', 'Pulsanti senza nome accessibile'],
  'iframe-no-title': ['info', 'Accessibilità', 'Iframe senza title'],
};

export const ISSUE_CATEGORIES = [...new Set(Object.values(ISSUE_TYPES).map((t) => t[1]))];
export const issueLabel = (code) => (ISSUE_TYPES[code] ? ISSUE_TYPES[code][2] : code);
export const issueCategory = (code) => (ISSUE_TYPES[code] ? ISSUE_TYPES[code][1] : 'Altro');

/**
 * Health score 0–100: share of crawled URLs without error-level issues (site-level issues count
 * for every page they involve). Null for a scan without pages.
 */
export function healthScore(scan) {
  const pages = scan.pages || [];
  if (!pages.length) return null;
  const bad = new Set();
  for (const p of pages) if ((p.issues || []).some((i) => i.severity === 'error')) bad.add(p.key);
  for (const i of scan.issues || []) if (i.severity === 'error') for (const k of i.pages || (i.key ? [i.key] : [])) bad.add(k);
  const n = pages.filter((p) => bad.has(p.key)).length;
  return Math.round((100 * (pages.length - n)) / pages.length);
}

export function statusClassOf(p) {
  if (!p || p.error || !p.status) return 'fail';
  return `${String(p.status)[0]}xx`;
}

/**
 * Diagnostic view of one scan: issues grouped by code, per-page summary and inbound links.
 * Site-level issues (duplicates) are attributed to every page they involve.
 * @returns {{summary: object, codes: object[], pages: object[], inlinks: object, siteIssuesByPage: object}}
 */
export function diagnoseScan(scan) {
  const pages = scan.pages || [];
  const codes = new Map();
  const group = (i) => {
    if (!codes.has(i.code)) codes.set(i.code, { code: i.code, label: issueLabel(i.code), category: issueCategory(i.code), severity: i.severity, occurrences: 0, keys: new Set(), items: [] });
    return codes.get(i.code);
  };
  for (const p of pages) {
    for (const i of p.issues || []) {
      const g = group(i);
      g.occurrences++;
      g.keys.add(p.key);
      g.items.push({ key: p.key, message: i.message });
    }
  }
  const siteIssuesByPage = {};
  for (const i of scan.issues || []) {
    const g = group(i);
    const keys = i.pages || (i.key ? [i.key] : []);
    g.occurrences++;
    keys.forEach((k) => g.keys.add(k));
    g.items.push({ key: i.key || keys[0] || '', message: i.message, pages: keys });
    for (const k of keys) (siteIssuesByPage[k] = siteIssuesByPage[k] || []).push(i);
  }
  const codeList = [...codes.values()].map(({ keys, ...g }) => ({ ...g, pages: keys.size }));
  codeList.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.occurrences - a.occurrences || a.code.localeCompare(b.code));

  const inlinks = {};
  for (const p of pages) {
    for (const k of new Set(p.links?.internal || [])) if (k !== p.key) (inlinks[k] = inlinks[k] || []).push(p.key);
  }

  const byStatus = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, fail: 0 };
  const sev = { error: 0, warn: 0, info: 0 };
  let ms = 0, timed = 0, withIssues = 0, indexable = 0;
  const pageList = pages.map((p) => {
    const counts = { error: 0, warn: 0, info: 0 };
    const all = [...(p.issues || []), ...(siteIssuesByPage[p.key] || [])];
    for (const i of all) counts[i.severity]++;
    for (const i of p.issues || []) sev[i.severity]++;
    if (all.length) withIssues++;
    const status = statusClassOf(p);
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (!p.error && p.responseMs != null) { ms += p.responseMs; timed++; }
    const indexability = indexabilityOf(p);
    if (!indexability) indexable++;
    const worst = counts.error ? 'error' : counts.warn ? 'warn' : counts.info ? 'info' : null;
    return { key: p.key, status, code: p.error ? null : p.status, error: p.error || null, title: p.title || null, depth: p.depth, clickDepth: p.clickDepth ?? null, indexability, inlinks: (inlinks[p.key] || []).length, counts, worst };
  });
  for (const i of scan.issues || []) sev[i.severity]++;
  const rank = (p) => (p.worst ? SEVERITY_RANK[p.worst] : 0);
  pageList.sort((a, b) => rank(b) - rank(a) || (b.counts.error + b.counts.warn + b.counts.info) - (a.counts.error + a.counts.warn + a.counts.info) || a.key.localeCompare(b.key));

  return {
    summary: {
      pages: pages.length,
      pagesWithIssues: withIssues,
      indexable,
      healthScore: healthScore(scan),
      ...sev,
      byStatus,
      avgResponseMs: timed ? Math.round(ms / timed) : null,
      truncated: !!(scan.crawl && scan.crawl.truncated),
    },
    codes: codeList,
    pages: pageList,
    inlinks,
    siteIssuesByPage,
  };
}
