import path from 'node:path';
import { sha1 } from './analyze.js';

export async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    return null;
  }
}

/**
 * Captures screenshots of the HTML pages that answered 2xx. Sets page.screenshot to a path relative to the scan dir.
 * Failures are recorded per page (page.screenshotError) and never abort the scan.
 */
export async function captureScreenshots(pages, env, opts, outDir, log = () => {}) {
  const pw = await loadPlaywright();
  if (!pw) {
    log('Playwright non installato: screenshot saltati (npm i playwright && npx playwright install chromium)');
    return { skipped: 'playwright-missing' };
  }
  let browser;
  try {
    browser = await pw.chromium.launch();
  } catch (e) {
    log(`Impossibile avviare Chromium (${e.message.split('\n')[0]}): screenshot saltati. Prova: npx playwright install chromium`);
    return { skipped: 'browser-launch-failed' };
  }
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: 1,
    httpCredentials: env.auth && env.auth.username ? { username: env.auth.username, password: env.auth.password || '' } : undefined,
    extraHTTPHeaders: Object.fromEntries(Object.entries(env.headers || {}).filter(([k]) => k.toLowerCase() !== 'user-agent')),
    reducedMotion: 'reduce',
  });
  const hideCss = [
    '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important}',
    ...(opts.hide || []).map((s) => `${s}{visibility:hidden!important}`),
  ].join('\n');

  const targets = pages.filter((p) => p.isHtml && !p.error && p.status >= 200 && p.status < 300);
  let idx = 0, done = 0;
  const worker = async () => {
    const tab = await context.newPage();
    while (idx < targets.length) {
      const p = targets[idx++];
      const file = `screenshots/${sha1(p.key).slice(0, 12)}.png`;
      try {
        await tab.goto(p.url, { waitUntil: 'load', timeout: 30000 });
        await tab.addStyleTag({ content: hideCss });
        await tab.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        if (opts.waitMs) await tab.waitForTimeout(opts.waitMs);
        let clip;
        if (opts.fullPage) {
          const h = await tab.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0));
          clip = { x: 0, y: 0, width: opts.width, height: Math.max(1, Math.min(h, opts.maxHeight)) };
        }
        await tab.screenshot({ path: path.join(outDir, file), fullPage: !!opts.fullPage, clip, animations: 'disabled' });
        p.screenshot = file;
      } catch (e) {
        p.screenshotError = e.message.split('\n')[0];
      }
      done++;
      log(`[screenshot ${done}/${targets.length}] ${p.screenshotError ? 'ERR ' : ''}${p.key}`);
    }
    await tab.close();
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency || 2) }, worker));
  } finally {
    await browser.close();
  }
  return { captured: targets.filter((p) => p.screenshot).length };
}
