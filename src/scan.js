import fs from 'node:fs';
import path from 'node:path';
import { loadSite, resolveEnv, redactedConfig, UserError } from './config.js';
import { newScanId } from './store.js';
import { storageFor } from './storage/index.js';
import { areaPolicy, applyLimits } from './policy.js';
import { CrawlRun } from './crawler.js';
import { captureScreenshots } from './screenshots.js';
import { runLocal } from './steps.js';
import { TOOL } from './version.js';
import { healthScore } from './core/diagnose.js';

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
    healthScore: healthScore({ pages, issues }),
    screenshots: pages.filter((p) => p.screenshot).length,
  };
}

/**
 * State of a scan to run in steps. `opts`: label, note, maxPages, noScreenshots, keepHtml.
 * The scan id is fixed now, so every step works on the same staging area.
 */
export function scanState(siteId, envName, opts = {}) {
  return {
    kind: 'scan',
    phase: 'start',
    siteId,
    envName,
    id: newScanId(),
    opts: { label: opts.label || null, note: opts.note || null, maxPages: opts.maxPages || null, noScreenshots: !!opts.noScreenshots, keepHtml: !!opts.keepHtml },
  };
}

/**
 * The scan as a job in steps (ADR-0018): start (configuration, robots.txt, sitemaps), crawl in blocks,
 * screenshots in blocks, save. Each step writes its files in a working folder that the storage keeps
 * (filesystem) or uploads (Vercel) at the end of the step; nothing is visible before the commit.
 */
export const scanJob = {
  async step(s, ctx) {
    const { st, log = () => {}, onProgress = () => {}, signal = null, deadline = Infinity } = ctx;
    const work = await st.stepWorkDir(s.siteId, s.id);
    if (st.kind === 'fs') activeStaging.add(work);
    try {
      for (;;) {
        if (s.phase === 'start') {
          const policy = areaPolicy(st);
          const loaded = await loadSite(st, s.siteId);
          const env = resolveEnv(loaded, s.envName);
          const { cfg, maxPages, notes } = applyLimits(loaded, s.opts.maxPages || loaded.maxPages, policy);
          for (const n of notes) log(`Avviso: ${n}`);
          Object.assign(s, { cfg, env, maxPages, notes, guard: !!policy?.guardNetwork, startedAt: new Date().toISOString() });
          log(`Scan ${s.siteId} [${s.envName}] ${env.baseUrl} → ${s.id}`);
          const run = await CrawlRun.begin(cfg, env, { maxPages, log, signal, onProgress, guardNetwork: s.guard });
          s.crawl = run.state;
          s.phase = 'crawl';
        } else if (s.phase === 'crawl') {
          const keepHtmlDir = s.opts.keepHtml ? path.join(work, 'html') : null;
          const run = await CrawlRun.resume(s.crawl, s.cfg, s.env, { keepHtmlDir, log, signal, onProgress, guardNetwork: s.guard });
          if (!(await run.runBlock({ deadline }))) break;
          const r = run.finish();
          if (!r.pages.length) throw new UserError('Nessuna pagina scansionata: controlla baseUrl, start, include/exclude e robots.txt');
          if (r.pages.every((p) => p.error)) throw new UserError(`Nessuna pagina raggiungibile (${r.pages[0].error}): scan non salvata`);
          const { texts, ...rest } = r;
          s.result = rest;
          s.texts = Object.fromEntries(texts);
          delete s.crawl;
          s.wantShots = !!(s.cfg.screenshots.enabled && !s.opts.noScreenshots);
          s.shots = { next: 0 };
          s.phase = s.wantShots ? 'screenshots' : 'save';
        } else if (s.phase === 'screenshots') {
          fs.mkdirSync(path.join(work, 'screenshots'), { recursive: true });
          const r = await captureScreenshots(s.result.pages, s.env, s.cfg.screenshots, work, log, { signal, onProgress, guardNetwork: s.guard, from: s.shots.next, deadline });
          s.shots = r.skipped ? { skipped: r.skipped } : { next: r.next };
          if (!r.skipped && !r.done) break;
          s.phase = 'save';
        } else if (s.phase === 'save') {
          onProgress({ phase: 'saving' });
          const { cfg, env, result } = s;
          const storeText = !!(cfg.storeText && Object.keys(s.texts).length);
          if (storeText) fs.writeFileSync(path.join(work, 'text.json'), JSON.stringify(s.texts));
          const finishedAt = new Date();
          const snapshot = {
            schema: 1,
            id: s.id,
            site: s.siteId,
            siteName: cfg.name,
            env: s.envName,
            baseUrl: env.baseUrl,
            label: s.opts.label,
            note: s.opts.note,
            startedAt: s.startedAt,
            finishedAt: finishedAt.toISOString(),
            durationMs: finishedAt - Date.parse(s.startedAt),
            tool: TOOL,
            options: {
              maxPages: s.maxPages,
              screenshots: !!(s.wantShots && !s.shots.skipped),
              screenshotsSkipped: s.shots.skipped || undefined,
              limits: s.notes.length ? s.notes : undefined,
              keepHtml: s.opts.keepHtml,
              text: storeText,
              issueCodes: result.issueCodes,
            },
            configHash: cfg.configHash,
            config: redactedConfig(cfg),
            crawl: { sitemapUrls: result.sitemapUrls, unvisited: result.unvisited, truncated: result.unvisited > 0, robotsFound: result.robotsFound, sitemapFound: result.sitemapFound, startKeys: result.seeds.start },
            stats: computeStats(result.pages, result.issues),
            pages: result.pages,
            issues: result.issues,
          };
          await st.commitScan(s.siteId, s.id, work, snapshot);
          activeStaging.delete(work);
          return { done: true, value: snapshot };
        }
        if (Date.now() >= deadline) break;
      }
      await st.flushStaging(s.siteId, s.id, work);
      return { done: false };
    } catch (e) {
      await st.discardScan(s.siteId, s.id, work).catch(() => {});
      activeStaging.delete(work);
      throw e;
    }
  },

  async discard(s, { st }) {
    await st.discardScan(s.siteId, s.id);
  },
};

/**
 * Runs a scan and stores it as an immutable snapshot in `opts.storage` (default: the working folder).
 * `opts.signal` aborts it (nothing is saved); `opts.onProgress` receives the progress events of
 * crawl and screenshots, then { phase: 'saving' }.
 * @returns {Promise<object>} the snapshot
 */
export async function scanSite(siteId, envName, opts = {}, log = () => {}) {
  const { signal = null, onProgress = () => {}, storage: st = storageFor(), budgetMs } = opts;
  return runLocal(scanJob, scanState(siteId, envName, opts), { st, log, signal, onProgress }, budgetMs === undefined ? {} : { budgetMs });
}
