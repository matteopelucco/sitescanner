import { loadPlaywright, launchChromium, guardRequests } from '../screenshots.js';
import { judge } from './net-checks.js';
import { hostBlocked } from '../net-guard.js';

// The check of a «Browser check» monitor (spec §13.14, RF-BRW-01): the page is opened in Chromium (§11.5), and the check
// says whether it loaded, whether the element or the text the monitor waits for is there, and whether the page raised
// JavaScript errors. The result has the shape of an HTTP check, plus `browser` (load, LCP, errors) and, when the check
// fails, `screenshot` (a JPEG, as base64) that stays with the incident.

const VIEWPORT = { width: 1280, height: 800 };
const SHOT_MAX_BYTES = 300 * 1024; // a screenshot is kept in the row of the run and of the incident: it stays small
const ERRORS_MAX = 5;
const SETTLE_MS = 300; // after the load event, for the largest paint to be reported
// how long the element and the text are waited for once the page has loaded (a page that builds itself in the browser needs a moment)
const WAIT_MS = () => Number(process.env.SITESCANNER_BROWSER_WAIT_MS) || 5000;

// One Chromium at a time in this process: it is heavy, and the rounds of checks run many monitors in parallel.
let chain = Promise.resolve();
const alone = (fn) => {
  const result = chain.then(fn, fn);
  chain = result.catch(() => {});
  return result;
};

const fail = (r, errorClass, error) => Object.assign(r, { outcome: 'error', errorClass, error });
const clip = (s, n = 300) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

async function screenshot(page) {
  for (const quality of [60, 35]) {
    try {
      const data = await page.screenshot({ type: 'jpeg', quality, timeout: 5000, animations: 'disabled' });
      if (data.length <= SHOT_MAX_BYTES || quality === 35) return { contentType: 'image/jpeg', bytes: data.length, width: VIEWPORT.width, height: VIEWPORT.height, data: data.toString('base64') };
    } catch {
      return null;
    }
  }
  return null;
}

/** The result of the page, with the checks of the monitor: `m.waitSelector`, `m.waitText`, `m.failOnJsErrors`. */
async function run(m, { guard, now }) {
  const r = { at: now(), outcome: 'ok', status: null, ms: null, ttfbMs: null, finalUrl: null, errorClass: null, error: null, excerpt: null, phases: null, assertions: [] };
  const timeoutMs = (m.timeoutS || 30) * 1000;
  const deadline = performance.now() + timeoutMs;
  const left = () => Math.max(500, deadline - performance.now());

  let host;
  try { host = new URL(m.url).hostname; } catch { return fail(r, 'configurazione', 'URL non valido'); }
  if (guard && (await hostBlocked(host))) return fail(r, 'destinazione non ammessa', 'destinazione non ammessa');

  const pw = await loadPlaywright();
  if (!pw) return fail(r, 'browser', 'Playwright non è installato: il Browser check non può girare qui');
  let browser;
  try {
    browser = await launchChromium(pw);
  } catch (e) {
    return fail(r, 'browser', `Impossibile avviare Chromium (${String(e.message).split('\n')[0]})`);
  }
  const errors = [];
  let page;
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      ignoreHTTPSErrors: !!m.skipSsl,
      httpCredentials: m.auth && m.auth.username ? { username: m.auth.username, password: m.auth.password || '' } : undefined,
      extraHTTPHeaders: Object.fromEntries(Object.entries(m.headers || {}).filter(([k]) => k.toLowerCase() !== 'user-agent')),
      reducedMotion: 'reduce',
    });
    if (guard) await guardRequests(context);
    page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    page.on('pageerror', (e) => errors.push(`${e.name || 'Error'}: ${e.message}`));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.addInitScript(() => {
      window.__lcp = null;
      try {
        new PerformanceObserver((list) => { const e = list.getEntries(); if (e.length) window.__lcp = e[e.length - 1].startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch { /* a browser without the entry type: no LCP */ }
    });

    const t0 = performance.now();
    let response;
    try {
      response = await page.goto(m.url, { waitUntil: 'load', timeout: timeoutMs });
    } catch (e) {
      r.ms = Math.round(performance.now() - t0);
      const timeout = /timeout/i.test(e.message);
      fail(r, timeout ? 'timeout' : /ERR_NAME_NOT_RESOLVED/.test(e.message) ? 'dns' : /ERR_CERT|SSL/.test(e.message) ? 'tls' : /blockedbyclient/.test(e.message) ? 'destinazione non ammessa' : 'connessione',
        timeout ? `La pagina non si è caricata entro ${m.timeoutS || 30} s` : clip(String(e.message).split('\n')[0].replace(/^page\.goto: /, '')));
      r.screenshot = await screenshot(page);
      return r;
    }
    r.ms = Math.round(performance.now() - t0);
    r.status = response ? response.status() : null;
    r.finalUrl = page.url();
    await page.waitForTimeout(Math.min(SETTLE_MS, left()));
    const timing = await page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0];
      return { ttfb: n ? Math.round(n.responseStart) : null, dom: n ? Math.round(n.domContentLoadedEventEnd) : null, load: n ? Math.round(n.loadEventEnd) : null, lcp: window.__lcp == null ? null : Math.round(window.__lcp) };
    }).catch(() => ({}));
    r.ttfbMs = timing.ttfb ?? null;
    r.browser = { loadMs: timing.load ?? r.ms, domMs: timing.dom ?? null, lcpMs: timing.lcp ?? null };

    // the checks, in this order; the first that fails is the cause, the others are still reported
    let cause = null;
    const check = (text, ok, errorClass, message) => {
      r.assertions.push({ text, ok, message: ok ? '' : message });
      if (!ok && !cause) cause = { errorClass, message };
    };
    if (r.status >= 400) check('La pagina risponde con uno status inferiore a 400', false, 'http', `La pagina ha risposto con HTTP ${r.status}`);
    if (m.waitSelector) {
      const ok = await page.waitForSelector(m.waitSelector, { state: 'attached', timeout: Math.min(left(), WAIT_MS()) }).then(() => true, () => false);
      check(`L'elemento ${m.waitSelector} è presente`, ok, 'asserzione', `Elemento non trovato: ${m.waitSelector}`);
    }
    if (m.waitText) {
      const ok = await page.getByText(m.waitText).first().waitFor({ state: 'visible', timeout: Math.min(left(), WAIT_MS()) }).then(() => true, () => false);
      check(`Il testo «${m.waitText}» è visibile`, ok, 'asserzione', `Testo non visibile: ${m.waitText}`);
    }
    // errors raised while the page was running up to now
    r.browser.jsErrors = errors.slice(0, ERRORS_MAX).map((e) => clip(e));
    r.browser.jsErrorCount = errors.length;
    if (m.failOnJsErrors !== false) check('Nessun errore JavaScript nella console', errors.length === 0, 'javascript', `${errors.length} ${errors.length === 1 ? 'errore' : 'errori'} JavaScript: ${clip(errors[0], 200)}`);
    if (cause) {
      fail(r, cause.errorClass, cause.message);
      r.screenshot = await screenshot(page);
      return r;
    }
    return judge(r, { ...m, failedMs: m.failedMs && m.failedMs < timeoutMs ? m.failedMs : null });
  } catch (e) {
    fail(r, 'browser', `Errore del browser: ${clip(String(e.message).split('\n')[0])}`);
    if (page) r.screenshot = await screenshot(page);
    return r;
  } finally {
    await browser.close().catch(() => {});
  }
}

export const browserCheck = (m, opts) => alone(() => run(m, opts));
