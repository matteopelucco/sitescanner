// Pure helpers on hosts and URLs shared by the crawler (collection) and the site map (derivation).
// No dependencies: usable in the browser like src/core/compare.js.

export const DOCUMENT_TYPES = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'csv'];

/** The site's domain: `map.siteDomain`, or the host of the base URL without a leading "www." (spec §14.1). */
export function siteDomain(mainHost, configured = null) {
  if (configured) return String(configured).toLowerCase().replace(/^\.+/, '');
  return String(mainHost).toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
}

/**
 * How a host relates to the site: the main host, a sibling (the site's domain or one of its subdomains)
 * or an external host.
 * @returns {'main'|'sibling'|'external'}
 */
export function hostRelation(host, mainHost, domain) {
  const h = String(host).toLowerCase();
  if (h === String(mainHost).toLowerCase()) return 'main';
  const name = h.replace(/:\d+$/, ''); // the port does not tell a site from its siblings
  const d = String(domain).toLowerCase();
  return name === d || name.endsWith('.' + d) ? 'sibling' : 'external';
}

/** Lower-case extension of the path of an absolute URL ("" when none). */
export function urlExtension(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return '';
  }
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
}

/** The document extension of a URL when it is one of `types`, else null. */
export function documentExtension(url, types) {
  const ext = urlExtension(url);
  return ext && types.includes(ext) ? ext : null;
}

/** Language subtag of an `lang` attribute: "it-CH" → "it" (null when empty). */
export function primaryLang(lang) {
  const m = /^[a-z]{2,3}/i.exec(String(lang || '').trim());
  return m ? m[0].toLowerCase() : null;
}
