import { loadSite, validSiteId, UserError } from './config.js';
import { loadScan, resolveScanRef } from './store.js';
import { renderPrintHtml } from './core/print.js';
import { loadPlaywright, launchChromium } from './screenshots.js';
import { TOOL } from './version.js';

export const pdfFileName = (site, baseId, headId) => `sitescanner-${site}-${baseId}${headId ? `-vs-${headId}` : ''}.pdf`;

/**
 * Renders the print report of a scan (diagnostic) or of two scans (comparison) as a PDF,
 * with headless Chromium. Throws UserError if Playwright or Chromium are not available.
 * @returns {Promise<{buffer: Buffer, baseId: string, headId: string|null, fileName: string}>}
 */
export async function renderPdf({ site, base, head = null, redirectMap = {} }) {
  if (!validSiteId(site)) throw new UserError(`Id sito non valido: ${site}`);
  if (!base) throw new UserError('Serve la scan Base');
  const baseId = resolveScanRef(site, base);
  const headId = head ? resolveScanRef(site, head) : null;
  let cfg = null;
  try { cfg = loadSite(site); } catch { /* config removed: history is still reportable */ }
  const html = renderPrintHtml({
    base: loadScan(site, baseId),
    head: headId ? loadScan(site, headId) : null,
    compare: { redirectMap, ignore: cfg ? cfg.compare.ignore : [], thresholds: cfg ? cfg.compare.thresholds : {} },
    siteName: cfg ? cfg.name : '',
    version: TOOL.version,
  });

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
    const buffer = await page.pdf({ preferCSSPageSize: true, printBackground: true, outline: true, tagged: true });
    return { buffer, baseId, headId, fileName: pdfFileName(site, baseId, headId) };
  } finally {
    await browser.close();
  }
}
