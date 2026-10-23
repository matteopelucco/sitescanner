import fs from 'node:fs';
import path from 'node:path';
import { loadSite, resolveEnv, redactedConfig, UserError } from './config.js';
import { newScanId, stageScan, commitScan, discardStaging } from './store.js';
import { crawl } from './crawler.js';
import { captureScreenshots } from './screenshots.js';
import { TOOL } from './version.js';

// Staging dirs of scans in progress, removed if the process is interrupted.
export const activeStaging = new Set();

function statusClass(p) {
  if (p.error) return 'fail';
  return `${String(p.status)[0]}xx`;
}

function computeStats(pages, issues) {
  const byStatus = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, fail: 0 };
  const sev = { error: 0, warn: 0, info: 0 };
  let ms = 0, n = 0;
  for (const p of pages) {
    byStatus[statusClass(p)] = (byStatus[statusClass(p)] || 0) + 1;
    for (const i of p.issues) sev[i.severity]++;
    if (!p.error) { ms += p.responseMs; n++; }
  }
  for (const i of issues) sev[i.severity]++;
  return {
    pages: pages.length,
    htmlPages: pages.filter((p) => p.isHtml && p.status < 300).length,
    byStatus,
    issues: sev,
    avgResponseMs: n ? Math.round(ms / n) : null,
    screenshots: pages.filter((p) => p.screenshot).length,
  };
}

/**
 * Runs a scan and stores it as an immutable snapshot.
 * `opts.signal` aborts it (nothing is saved); `opts.onProgress` receives the progress events of
 * crawl and screenshots, then { phase: 'saving' }.
 * @returns {Promise<object>} the snapshot
 */
export async function scanSite(siteId, envName, opts = {}, log = () => {}) {
  const { signal = null, onProgress = () => {} } = opts;
  const cfg = loadSite(siteId);
  const env = resolveEnv(cfg, envName);
  const id = newScanId();
  const staging = stageScan(siteId, id);
  activeStaging.add(staging);
  try {
    const startedAt = new Date();
    const maxPages = opts.maxPages || cfg.maxPages;
    let keepHtmlDir = null;
    if (opts.keepHtml) {
      keepHtmlDir = path.join(staging, 'html');
      fs.mkdirSync(keepHtmlDir);
    }
    log(`Scan ${siteId} [${envName}] ${env.baseUrl} → ${id}`);
    const result = await crawl(cfg, env, { maxPages, keepHtmlDir, log, signal, onProgress });
    if (!result.pages.length) throw new UserError('Nessuna pagina scansionata: controlla baseUrl, start, include/exclude e robots.txt');
    if (result.pages.every((p) => p.error)) {
      throw new UserError(`Nessuna pagina raggiungibile (${result.pages[0].error}): scan non salvata`);
    }

    const wantShots = cfg.screenshots.enabled && !opts.noScreenshots;
    let shots = null;
    if (wantShots) {
      fs.mkdirSync(path.join(staging, 'screenshots'));
      shots = await captureScreenshots(result.pages, env, cfg.screenshots, staging, log, { signal, onProgress });
    }
    if (cfg.storeText && result.texts.size) {
      fs.writeFileSync(path.join(staging, 'text.json'), JSON.stringify(Object.fromEntries(result.texts)));
    }

    onProgress({ phase: 'saving' });
    const finishedAt = new Date();
    const snapshot = {
      schema: 1,
      id,
      site: siteId,
      siteName: cfg.name,
      env: envName,
      baseUrl: env.baseUrl,
      label: opts.label || null,
      note: opts.note || null,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt - startedAt,
      tool: TOOL,
      options: {
        maxPages,
        screenshots: !!(wantShots && shots && !shots.skipped),
        screenshotsSkipped: shots && shots.skipped ? shots.skipped : undefined,
        keepHtml: !!opts.keepHtml,
        text: !!(cfg.storeText && result.texts.size),
      },
      configHash: cfg.configHash,
      config: redactedConfig(cfg),
      crawl: { sitemapUrls: result.sitemapUrls, unvisited: result.unvisited, truncated: result.unvisited > 0 },
      stats: computeStats(result.pages, result.issues),
      pages: result.pages,
      issues: result.issues,
    };
    commitScan(siteId, id, staging, snapshot);
    activeStaging.delete(staging);
    return snapshot;
  } catch (e) {
    discardStaging(staging);
    activeStaging.delete(staging);
    throw e;
  }
}
