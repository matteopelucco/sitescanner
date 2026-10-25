import path from 'node:path';
import { sha1 } from './analyze.js';
import { hostBlocked } from './net-guard.js';

// On Vercel the browser is playwright-core with the Chromium of @sparticuz/chromium, built for
// serverless functions (spec §11.5); elsewhere Playwright with its own Chromium.
const serverless = () => process.env.VERCEL === '1' || process.env.SITESCANNER_SERVERLESS_CHROMIUM === '1';

export async function loadPlaywright() {
  try {
    if (serverless()) {
      const [core, sparticuz] = await Promise.all([import('playwright-core'), import('@sparticuz/chromium')]);
      return { ...core, serverlessChromium: sparticuz.default || sparticuz };
    }
    return await import('playwright');
  } catch {
    return null;
  }
}

// SITESCANNER_CHROMIUM points to a Chromium/Chrome executable to use instead of Playwright's own.
export async function launchChromium(pw) {
  if (pw.serverlessChromium) {
    const c = pw.serverlessChromium;
    return pw.chromium.launch({ executablePath: await c.executablePath(), args: c.args, headless: true });
  }
  return pw.chromium.launch({ executablePath: process.env.SITESCANNER_CHROMIUM || undefined });
}

/**
 * Captures screenshots of the HTML pages that answered 2xx. Sets page.screenshot to a path relative to the scan dir.
 * Failures are recorded per page (page.screenshotError) and never abort the scan.
 * In blocks (spec §11.5): starts from target `from` and stops starting new pages after `deadline`;
 * returns `next`, the target to resume from, and `done`.
 */
export async function captureScreenshots(pages, env, opts, outDir, log = () => {}, { signal = null, onProgress = () => {}, guardNetwork = false, from = 0, deadline = Infinity } = {}) {
  const pw = await loadPlaywright();
  if (!pw) {
    log('Playwright non installato: screenshot saltati (npm i playwright && npx playwright install chromium)');
    return { skipped: 'playwright-missing' };
  }
  let browser;
  try {
    browser = await launchChromium(pw);
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
  if (guardNetwork) {
    // RF-SEC-01 for the browser too: every request of the page (images, scripts, iframes) is checked.
    // Chromium resolves names on its own, so the check is on a separate lookup of the same name.
    const verdicts = new Map();
    await context.route('**/*', async (route) => {
      let host;
      try {
        const u = new URL(route.request().url());
        if (!/^https?:$/.test(u.protocol)) return route.continue();
        host = u.hostname;
      } catch {
        return route.abort('blockedbyclient');
      }
      if (!verdicts.has(host)) verdicts.set(host, hostBlocked(host));
      return (await verdicts.get(host)) ? route.abort('blockedbyclient') : route.continue();
    });
  }
  const hideCss = [
    '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important}',
    ...(opts.hide || []).map((s) => `${s}{visibility:hidden!important}`),
  ].join('\n');

  const targets = pages.filter((p) => p.isHtml && !p.error && p.status >= 200 && p.status < 300);
  let idx = from, done = from, started = 0;
  onProgress({ phase: 'screenshots', done, limit: targets.length });
  const worker = async () => {
    const tab = await context.newPage();
    while (idx < targets.length && !signal?.aborted && (started === 0 || Date.now() < deadline)) {
      const p = targets[idx++];
      started++;
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
      onProgress({ phase: 'screenshots', done, limit: targets.length, current: p.key });
    }
    await tab.close();
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency || 2) }, worker));
  } finally {
    await browser.close();
  }
  signal?.throwIfAborted();
  return { captured: targets.filter((p) => p.screenshot).length, next: idx, done: idx >= targets.length };
}
