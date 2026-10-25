import { loadSite, resolveEnv, adhocSite, UserError } from './config.js';
import { storageFor } from './storage/index.js';
import { areaPolicy, applyLimits } from './policy.js';
import { newScanId } from './store.js';
import { CrawlRun } from './crawler.js';
import { runLocal } from './steps.js';
import { TOOL } from './version.js';

// Layout:
//   inventory/<id>.json        full inventory (summary + one record per URL)
//   inventory/<id>.meta.json   summary only, read by listings
// Inventories are independent of scans: they are not compared and do not enter the report.

export const INVENTORY_DEFAULTS = { maxPages: 5000, maxDepth: 50 };

const isOkHtml = (p) => p.isHtml && !p.error && !p.offsite && !p.redirects.length && p.status >= 200 && p.status < 300;

function statusClass(p) {
  if (p.error) return 'fail';
  if (p.redirects.length) return '3xx';
  return `${String(p.status)[0]}xx`;
}

const segments = (key) => key.split('?')[0].split('/').filter(Boolean);

function histogram(values) {
  const h = {};
  for (const v of values) h[v] = (h[v] || 0) + 1;
  return h;
}

/**
 * Derives size and depth of a site from crawled pages.
 * Click depth is the shortest path over internal links (and redirects) from the start pages,
 * so pages reached only through the sitemap count as not linked.
 * @param {object[]} pages crawler page records
 * @param {{start: string[], sitemap: string[]}} seeds page keys of start URLs and sitemap URLs
 */
export function analyzeInventory(pages, seeds = { start: [], sitemap: [] }) {
  const byKey = new Map(pages.map((p) => [p.key, p]));
  const out = new Map(pages.map((p) => [p.key, new Set()]));
  const inlinks = new Map(pages.map((p) => [p.key, new Set()]));
  for (const p of pages) {
    for (const k of (p.links && p.links.internal) || []) {
      if (k === p.key) continue;
      out.get(p.key).add(k);
      if (inlinks.has(k)) inlinks.get(k).add(p.key);
    }
  }
  // A redirecting page has no links: its edge is the redirect target, queued with foundFrom = source.
  for (const p of pages) {
    const src = p.foundFrom && byKey.get(p.foundFrom);
    if (src && src.redirects.length && !src.offsite) out.get(src.key).add(p.key);
  }

  const clickDepth = new Map();
  let frontier = seeds.start.filter((k) => byKey.has(k));
  for (const k of frontier) clickDepth.set(k, 0);
  for (let d = 1; frontier.length; d++) {
    const next = [];
    for (const k of frontier) {
      for (const t of out.get(k) || []) {
        if (!byKey.has(t) || clickDepth.has(t)) continue;
        clickDepth.set(t, d);
        next.push(t);
      }
    }
    frontier = next;
  }

  const inSitemap = new Set(seeds.sitemap);
  const records = pages.map((p) => {
    const segs = segments(p.key);
    return {
      key: p.key,
      status: p.error ? null : p.status,
      finalStatus: p.redirects.length ? p.finalStatus : undefined,
      redirectTo: p.redirects.length ? p.finalUrl : undefined,
      error: p.error || undefined,
      contentType: p.contentType || null,
      html: isOkHtml(p),
      title: p.title || null,
      bytes: p.bytes || null,
      responseMs: p.responseMs,
      clickDepth: clickDepth.has(p.key) ? clickDepth.get(p.key) : null,
      urlDepth: segs.length,
      section: segs.length ? `/${segs[0]}` : '/',
      inlinks: inlinks.get(p.key).size,
      outlinks: out.get(p.key).size,
      inSitemap: inSitemap.has(p.key),
    };
  });

  const html = records.filter((r) => r.html);
  const linked = html.filter((r) => r.clickDepth !== null);
  const depths = linked.map((r) => r.clickDepth);
  const byStatus = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, fail: 0 };
  for (const p of pages) byStatus[statusClass(p)] = (byStatus[statusClass(p)] || 0) + 1;
  const contentTypes = histogram(pages.filter((p) => !p.error && !p.redirects.length).map((p) => p.contentType || 'sconosciuto'));

  const sections = new Map();
  for (const r of html) {
    const s = sections.get(r.section) || { section: r.section, pages: 0, linked: 0, depthSum: 0, maxClickDepth: null, maxUrlDepth: 0 };
    s.pages++;
    s.maxUrlDepth = Math.max(s.maxUrlDepth, r.urlDepth);
    if (r.clickDepth !== null) {
      s.linked++;
      s.depthSum += r.clickDepth;
      s.maxClickDepth = Math.max(s.maxClickDepth ?? 0, r.clickDepth);
    }
    sections.set(r.section, s);
  }

  // Path tree of the HTML pages; a query string folds into its path.
  const tree = { name: '/', path: '/', pages: 0, total: 0, children: {} };
  for (const r of html) {
    let node = tree;
    node.total++;
    for (const seg of segments(r.key)) {
      node.children[seg] ||= { name: seg, path: `${node.path === '/' ? '' : node.path}/${seg}`, pages: 0, total: 0, children: {} };
      node = node.children[seg];
      node.total++;
    }
    node.pages++;
  }
  const finishTree = (n) => ({ name: n.name, path: n.path, pages: n.pages, total: n.total, children: Object.values(n.children).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)).map(finishTree) });

  const linkTargets = new Set(pages.flatMap((p) => (p.links && p.links.internal) || []));
  const top = (list, field, n = 20) => [...list].sort((a, b) => b[field] - a[field] || a.key.localeCompare(b.key)).slice(0, n).map((r) => ({ key: r.key, [field]: r[field], title: r.title }));

  const summary = {
    urls: pages.length,
    htmlPages: html.length,
    byStatus,
    contentTypes,
    htmlBytes: html.reduce((s, r) => s + (r.bytes || 0), 0),
    avgResponseMs: html.length ? Math.round(html.reduce((s, r) => s + (r.responseMs || 0), 0) / html.length) : null,
    clickDepth: {
      max: depths.length ? Math.max(...depths) : null,
      avg: depths.length ? Math.round((depths.reduce((a, b) => a + b, 0) / depths.length) * 10) / 10 : null,
      histogram: histogram(depths),
      notLinked: html.length - linked.length,
    },
    urlDepth: {
      max: html.length ? Math.max(...html.map((r) => r.urlDepth)) : null,
      histogram: histogram(html.map((r) => r.urlDepth)),
    },
    sections: [...sections.values()]
      .map(({ depthSum, ...s }) => ({ ...s, avgClickDepth: s.linked ? Math.round((depthSum / s.linked) * 10) / 10 : null }))
      .sort((a, b) => b.pages - a.pages || a.section.localeCompare(b.section)),
    sitemap: {
      listed: seeds.sitemap.length,
      crawled: seeds.sitemap.filter((k) => byKey.has(k)).length,
      notLinked: html.filter((r) => r.inSitemap && r.clickDepth === null).length,
      missing: linked.filter((r) => !r.inSitemap).length,
    },
    linkedNotVisited: [...linkTargets].filter((k) => !byKey.has(k)).length,
    topInlinks: top(html, 'inlinks'),
    deepest: top(linked, 'clickDepth'),
  };
  return { summary, tree: finishTree(tree), pages: records };
}

/**
 * The inventory as a job in steps (spec §11.4): start (configuration, robots.txt, sitemaps), crawl in
 * blocks, save. `o`: { site, env } or { url }, plus optional maxPages, maxDepth, concurrency.
 */
export const inventoryState = (o) => ({ kind: 'inventory', phase: 'start', o, id: newScanId() });

export const inventoryJob = {
  async step(s, { st, log = () => {}, onProgress = () => {}, signal = null, deadline = Infinity }) {
    const o = s.o;
    for (;;) {
      if (s.phase === 'start') {
        let cfg, env;
        if (o.url) {
          cfg = adhocSite(o.url);
          env = resolveEnv(cfg, 'web');
        } else {
          if (!o.site || !o.env) throw new UserError('Indica un URL oppure sito e ambiente');
          cfg = await loadSite(st, o.site);
          env = resolveEnv(cfg, o.env);
        }
        cfg = {
          ...cfg,
          maxPages: o.maxPages || INVENTORY_DEFAULTS.maxPages,
          maxDepth: o.maxDepth || INVENTORY_DEFAULTS.maxDepth,
          concurrency: o.concurrency || cfg.concurrency,
          storeText: false,
        };
        const policy = areaPolicy(st);
        const limited = applyLimits(cfg, cfg.maxPages, policy);
        cfg = { ...limited.cfg, maxPages: limited.maxPages };
        for (const n of limited.notes) log(`Avviso: ${n}`);
        Object.assign(s, { cfg, env, guard: !!policy?.guardNetwork, startedAt: new Date().toISOString() });
        log(`Inventario ${env.baseUrl} → ${s.id}`);
        s.crawl = (await CrawlRun.begin(cfg, env, { maxPages: cfg.maxPages, log, signal, onProgress, guardNetwork: s.guard })).state;
        s.phase = 'crawl';
      } else if (s.phase === 'crawl') {
        const run = await CrawlRun.resume(s.crawl, s.cfg, s.env, { log, signal, onProgress, guardNetwork: s.guard });
        if (!(await run.runBlock({ deadline }))) return { done: false };
        const result = run.finish();
        if (!result.pages.length) throw new UserError('Nessuna pagina trovata: controlla URL, include/exclude e robots.txt');
        if (result.pages.every((p) => p.error)) throw new UserError(`Sito non raggiungibile (${result.pages[0].error}): inventario non salvato`);
        onProgress({ phase: 'saving' });
        const { summary, tree, pages } = analyzeInventory(result.pages, result.seeds);
        const { cfg, env } = s;
        const finishedAt = new Date();
        const meta = {
          schema: 1,
          id: s.id,
          site: o.url ? null : o.site,
          env: o.url ? null : o.env,
          baseUrl: env.baseUrl,
          startedAt: s.startedAt,
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt - Date.parse(s.startedAt),
          tool: TOOL,
          options: { maxPages: cfg.maxPages, maxDepth: cfg.maxDepth, concurrency: cfg.concurrency, respectRobots: cfg.respectRobots, sitemap: !!cfg.sitemap },
          crawl: { truncated: result.unvisited > 0, unvisited: result.unvisited, start: result.seeds.start },
          summary,
        };
        await st.saveInventory({ ...meta, tree, pages }, meta);
        return { done: true, value: { ...meta, tree, pages } };
      }
      if (Date.now() >= deadline) return { done: false };
    }
  },

  // Nothing is stored before the end.
  async discard() {},
};

/**
 * Crawls a configured site (site + env) or any URL and stores the inventory.
 * @param {object} o { site, env } or { url }, plus optional maxPages, maxDepth, concurrency
 * @param {object} [hooks] { signal, onProgress, log, storage, budgetMs }
 */
export async function runInventory(o, { signal = null, onProgress = () => {}, log = () => {}, storage: st = storageFor(), budgetMs } = {}) {
  return runLocal(inventoryJob, inventoryState(o), { st, log, signal, onProgress }, budgetMs === undefined ? {} : { budgetMs });
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function inventoryCsv(inv) {
  const cols = ['key', 'status', 'redirectTo', 'error', 'contentType', 'html', 'title', 'bytes', 'responseMs', 'clickDepth', 'urlDepth', 'section', 'inlinks', 'outlinks', 'inSitemap'];
  return [cols.join(','), ...inv.pages.map((p) => cols.map((c) => csvCell(p[c])).join(','))].join('\n') + '\n';
}
