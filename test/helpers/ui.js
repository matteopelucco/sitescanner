import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { serve } from '../../src/server.js';

// Helpers for the tests that drive the web app in a real browser (Playwright + Chromium, optional).

export async function chromiumAvailable() {
  try {
    const { chromium } = await import('playwright');
    const b = await chromium.launch();
    await b.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts the web app on a temporary folder in monitoring-dev mode, with a fixture site whose answer
 * can be changed (`site.mode`). Single-user mode unless `multi`.
 */
export async function startApp({ multi = false, env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-ui-'));
  const site = { mode: 'ok', hits: 0 };
  site.server = http.createServer((req, res) => {
    site.hits++;
    if (site.mode === 'down') return res.writeHead(502).end('bad gateway');
    if (site.mode === 'slow') return setTimeout(() => res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>lento</h1>'), 150);
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Prova</title><h1>Sito di prova</h1>');
  });
  await new Promise((r) => site.server.listen(0, '127.0.0.1', r));
  site.url = `http://127.0.0.1:${site.server.address().port}/`;
  const saved = {};
  const vars = { SITESCANNER_HOME: home, SITESCANNER_MONITOR_DEV: '1', SITESCANNER_ALLOW_PRIVATE_NETWORKS: '1', SITESCANNER_MON_RETRY_MS: '10', ...(multi ? { SITESCANNER_ADMIN_USER: 'admin', SITESCANNER_ADMIN_PASSWORD: 'admin-iniziale-123' } : {}), ...env };
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
  const server = await serve({ port: 0, multi });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, site, home,
    async stop() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await new Promise((r) => site.server.close(r));
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

/** A JSON client with a session cookie. */
export function apiClient(base) {
  let cookie = '';
  const req = async (method, p, body) => {
    const res = await fetch(`${base}/api/${p}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, data };
  };
  req.cookie = () => cookie;
  return req;
}

/**
 * Opens a page in a new browser context, failing on JavaScript errors, console errors and failed
 * requests (other than the ones listed in `allow`). `problems` collects them.
 */
export async function openPage(browser, base, { cookie = null, viewport = { width: 1280, height: 900 }, allow = [] } = {}) {
  const context = await browser.newContext({ viewport });
  if (cookie) {
    const [name, ...v] = cookie.split('=');
    await context.addCookies([{ name, value: v.join('='), url: base }]);
  }
  const page = await context.newPage();
  const problems = [];
  const ok = (text) => allow.some((a) => (a instanceof RegExp ? a.test(text) : text.includes(a)));
  page.on('pageerror', (e) => { if (!ok(e.message)) problems.push(`pageerror: ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error' && !ok(m.text())) problems.push(`console: ${m.text()}`); });
  page.on('requestfailed', (r) => { if (!ok(r.url())) problems.push(`requestfailed: ${r.url()}`); });
  page.on('response', (r) => { if (r.status() >= 500 && !ok(r.url())) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
  return { page, context, problems };
}
