import { loadSite, validSiteId, UserError } from './config.js';
import { resolveScanRef } from './store.js';
import { storageFor } from './storage/index.js';
import { renderPrintHtml } from './core/print.js';
import { loadPlaywright, launchChromium } from './screenshots.js';
import { TOOL } from './version.js';

export const pdfFileName = (site, baseId, headId) => `sitescanner-${site}-${baseId}${headId ? `-vs-${headId}` : ''}.pdf`;

/**
 * Renders the print report of a scan (diagnostic) or of two scans (comparison) as a PDF,
 * with headless Chromium. Throws UserError if Playwright or Chromium are not available.
 * @returns {Promise<{buffer: Buffer, baseId: string, headId: string|null, fileName: string}>}
 */
export async function renderPdf({ site, base, head = null, redirectMap = {}, storage: st = storageFor() }) {
  if (!validSiteId(site)) throw new UserError(`Id sito non valido: ${site}`);
  if (!base) throw new UserError('Serve la scan Base');
  const baseId = await resolveScanRef(st, site, base);
  const headId = head ? await resolveScanRef(st, site, head) : null;
  let cfg = null;
  try { cfg = await loadSite(st, site); } catch { /* config removed: history is still reportable */ }
  const html = renderPrintHtml({
    base: await st.loadScan(site, baseId),
    head: headId ? await st.loadScan(site, headId) : null,
    compare: { redirectMap, ignore: cfg ? cfg.compare.ignore : [], thresholds: cfg ? cfg.compare.thresholds : {} },
    siteName: cfg ? cfg.name : '',
    version: TOOL.version,
  });

  return { buffer: await htmlToPdf(html), baseId, headId, fileName: pdfFileName(site, baseId, headId) };
}

/**
 * Renders a print document (HTML with @page rules) as a PDF with headless Chromium: the same engine for the reports of the
 * scans and of the availability. Throws UserError with the way out if Playwright or Chromium are missing.
 */
export async function htmlToPdf(html) {
  const pw = await loadPlaywright();
  if (!pw) throw new UserError('Il PDF richiede Playwright: npm i playwright && npx playwright install chromium (in alternativa usa «PDF» nel report e stampa dal browser)');
  let browser;
  try {
    browser = await launchChromium(pw);
  } catch (e) {
    throw new UserError(`Impossibile avviare Chromium (${e.message.split('\n')[0]}). Prova: npx playwright install chromium, oppure imposta SITESCANNER_CHROMIUM`);
  }
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    // @page rules give size, margins, running header and page numbers; outline = PDF bookmarks from headings
    return await page.pdf({ preferCSSPageSize: true, printBackground: true, outline: true, tagged: true });
  } finally {
    await browser.close();
  }
}
