import fs from 'node:fs';
import path from 'node:path';
import { analyzeHtml, pageIssues, siteIssues, setIndexability, applyQuality, sha1 } from './analyze.js';
import { toKey, TRACKING_PARAMS } from './core/compare.js';
import { documentExtension, hostRelation, primaryLang, siteDomain } from './core/hosts.js';
import { crawlFetch, blockedError, hostBlocked } from './net-guard.js';
import { loadPlaywright, launchChromium } from './screenshots.js';

const MAX_BODY = 10 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function compileRegexes(list, field) {
  return (list || []).map((s) => {
    try {
      return new RegExp(s);
    } catch (e) {
      throw new Error(`Regex non valida in "${field}": ${s} (${e.message})`);
    }
  });
}

// Minimal robots.txt support: groups for "*" and our UA token, Disallow/Allow prefixes with * and $.
function parseRobots(txt, uaToken) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  const sitemaps = [];
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'sitemap') { sitemaps.push(v); continue; }
    if (k === 'user-agent') {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (k === 'disallow' || k === 'allow') cur.rules.push({ allow: k === 'allow', path: v });
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && uaToken.includes(a)));
  const rules = (mine.length ? mine : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules).filter((r) => r.path);
  const toRe = (p) => new RegExp('^' + p.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
  const compiled = rules.map((r) => ({ ...r, re: toRe(r.path), len: r.path.length }));
  return {
    sitemaps,
    allowed(pathAndQuery) {
      let best = null;
      for (const r of compiled) if (r.re.test(pathAndQuery) && (!best || r.len > best.len || (r.len === best.len && r.allow))) best = r;
      return !best || best.allow;
    },
  };
}

const SECURITY_HEADERS = { hsts: 'strict-transport-security', csp: 'content-security-policy', xcto: 'x-content-type-options', xfo: 'x-frame-options', referrer: 'referrer-policy' };

// Short names of the security headers present in a response (frame-ancestors in CSP counts as X-Frame-Options).
function securityHeaders(h) {
  const present = Object.keys(SECURITY_HEADERS).filter((k) => h.get(SECURITY_HEADERS[k]));
  if (!present.includes('xfo') && /frame-ancestors/i.test(h.get('content-security-policy') || '')) present.push('xfo');
  return present;
}

function extractLocs(xml) {
  return [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
}

/**
 * Crawls one environment of a site.
 * `signal` aborts the crawl (the promise rejects with an AbortError); `onProgress` receives
 * { phase: 'robots'|'sitemap'|'crawl', done, limit, discovered, current } as the crawl advances.
 * `guardNetwork`: refuse private destinations (RF-SEC-01, multi-user mode).
 * @returns {Promise<{pages: object[], issues: object[], texts: Map<string,string>, sitemapUrls: number, unvisited: number, seeds: {start: string[], sitemap: string[]}}>}
 */
export async function crawl(cfg, env, opts = {}) {
  const run = await CrawlRun.begin(cfg, env, opts);
  await run.runBlock();
  return run.finish();
}

/**
 * A crawl that can stop at a deadline and resume later, possibly in another process (spec §11.4,
 * ADR-0018). Its whole state is plain JSON (`run.state`). The visited pages are the same as in a
 * single run (RF-RUN-03): levels are processed in the same order and a block stops only between pages.
 */
export class CrawlRun {
  constructor(cfg, env, state, { maxPages, keepHtmlDir = null, log = () => {}, signal = null, onProgress = () => {}, guardNetwork = false } = {}) {
    this.cfg = cfg;
    this.env = env;
    this.state = state;
    this.keepHtmlDir = keepHtmlDir;
    this.log = log;
    this.signal = signal;
    this.onProgress = onProgress;
    this.guardNetwork = guardNetwork;
    this.limit = state ? state.limit : maxPages || cfg.maxPages;
  }

  /** robots.txt, sitemaps and seeds: the first part of a crawl. */
  static async begin(cfg, env, opts = {}) {
    const run = new CrawlRun(cfg, env, null, opts);
    await run.setup();
    const { cfg: c, limit, onProgress } = run;
    const s = { v: 1, limit, robotsTxt: null, robotsFound: null, sitemapFound: null, sitemapUrls: 0, seeds: [], sitemapSeeds: [], startCount: c.start.length, queued: [], level: [], batch: null, idx: 0, nextLevel: [], pages: [], texts: {}, boundaryCount: 0, boundarySkipped: [], siblingRobots: {}, rendered: 0 };
    run.state = s;
    run.hydrate();

    onProgress({ phase: 'robots', done: 0, limit, discovered: 0 });
    if (c.respectRobots || c.sitemap === true) {
      const txt = await run.getText(run.origin + '/robots.txt');
      s.robotsFound = txt != null;
      s.robotsTxt = txt || null;
      run.hydrate();
    }

    for (const st of c.start) s.seeds.push(new URL(st, env.baseUrl).toString());
    if (c.sitemap) {
      onProgress({ phase: 'sitemap', done: 0, limit, discovered: 0 });
      const roots = Array.isArray(c.sitemap)
        ? c.sitemap.map((x) => new URL(x, env.baseUrl).toString())
        : [...new Set([new URL('sitemap.xml', run.origin + run.scopePrefix).toString(), ...((run.robots && run.robots.sitemaps) || [])])];
      const seen = new Set();
      const queue = [...roots];
      s.sitemapFound = false;
      while (queue.length && seen.size < 50) {
        const sm = queue.shift();
        if (seen.has(sm)) continue;
        seen.add(sm);
        const xml = await run.getText(sm);
        if (!xml) continue;
        s.sitemapFound = true;
        const locs = extractLocs(xml);
        if (/<sitemapindex/i.test(xml)) queue.push(...locs);
        else for (const l of locs) {
          // Sitemaps of another environment often list production URLs: rebase them on this env.
          try {
            const u = new URL(l);
            const rebased = new URL(u.pathname + u.search, run.origin).toString();
            s.seeds.push(rebased);
            s.sitemapSeeds.push(rebased);
            s.sitemapUrls++;
          } catch { /* ignore */ }
        }
      }
    }
    s.seeds.forEach((x, i) => run.enqueue(x, i < c.start.length ? 0 : 1, null, s.level));
    return run;
  }

  /** Continues a crawl from its saved state. */
  static async resume(state, cfg, env, opts = {}) {
    const run = new CrawlRun(cfg, env, state, opts);
    await run.setup();
    run.hydrate();
    return run;
  }

  async setup() {
    const cfg = this.cfg;
    this.fetch = await crawlFetch(this.guardNetwork);
    const base = new URL(this.env.baseUrl);
    this.origin = base.origin;
    this.scopePrefix = base.pathname.endsWith('/') ? base.pathname : base.pathname.replace(/[^/]*$/, '');
    this.include = compileRegexes(cfg.include, 'include');
    this.exclude = compileRegexes(cfg.exclude, 'exclude');
    this.headers = { 'user-agent': cfg.userAgent, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', ...this.env.headers };
    if (this.env.auth && this.env.auth.username) {
      this.headers.authorization = 'Basic ' + Buffer.from(`${this.env.auth.username}:${this.env.auth.password || ''}`).toString('base64');
    }
    this.ignoreParams = [...TRACKING_PARAMS, ...(cfg.ignoreParams || [])];
    // Sibling hosts (RF-MAP-10): their pages are visited one level only, with no credentials of the environment
    this.plainHeaders = { 'user-agent': cfg.userAgent, accept: this.headers.accept };
    this.sibling = null;
    if (cfg.collectMap && cfg.map?.siblings !== false) {
      const lower = (l) => (l || []).map((h) => String(h).toLowerCase());
      this.sibling = { domain: siteDomain(base.host, cfg.map?.siteDomain), only: lower(cfg.map?.siblingHosts), exclude: lower(cfg.map?.siblingExclude), max: cfg.map?.maxSiblingPages ?? 200 };
    }
    this.mainHost = base.host;
  }

  // Rebuilds what is derived from the state: robots rules and the set of queued keys.
  hydrate() {
    const s = this.state;
    this.robots = s.robotsTxt ? parseRobots(s.robotsTxt, String(this.cfg.userAgent).toLowerCase()) : null;
    this.queuedSet = new Set(s.queued);
    this.pageCount = s.pages.length;
    this.skippedSet = new Set(s.boundarySkipped || []);
    this.robotsCache = new Map();
  }

  /** Id of a URL in the site map: the key for the main host, host + key for a sibling host, null otherwise. */
  idOfUrl(u) {
    try {
      if (this.inScope(u)) return this.keyOf(u);
      const url = new URL(u);
      if (this.sibling && /^https?:$/.test(url.protocol) && url.host !== this.mainHost && hostRelation(url.host, this.mainHost, this.sibling.domain) === 'sibling') return url.host + this.keyOf(u);
    } catch { /* not a URL */ }
    return null;
  }

  /** Is a URL one that is visited as a boundary page (include/exclude of the sibling hosts apply)? */
  siblingOk(u) {
    if (!this.sibling) return false;
    try {
      const url = new URL(u);
      if (!/^https?:$/.test(url.protocol) || url.host === this.mainHost || hostRelation(url.host, this.mainHost, this.sibling.domain) !== 'sibling') return false;
      const h = url.host.toLowerCase();
      const name = h.replace(/:\d+$/, '');
      if (this.sibling.exclude.includes(h) || this.sibling.exclude.includes(name)) return false;
      return !this.sibling.only.length || this.sibling.only.includes(h) || this.sibling.only.includes(name);
    } catch {
      return false;
    }
  }

  /** Queues a page of a sibling host (RF-MAP-10, RF-MAP-12): its links will not be followed. */
  enqueueBoundary(u, depth, from) {
    if (!this.siblingOk(u)) return;
    const url = new URL(u);
    const pathKey = this.keyOf(u);
    const id = url.host + pathKey;
    if (this.queuedSet.has(id) || this.skippedSet.has(id) || !this.wanted(pathKey)) return;
    const s = this.state;
    if ((s.boundaryCount || 0) >= this.sibling.max) {
      this.skippedSet.add(id);
      (s.boundarySkipped ||= []).push(id);
      return;
    }
    this.queuedSet.add(id);
    s.queued.push(id);
    s.boundaryCount = (s.boundaryCount || 0) + 1;
    if (this.cfg.ignoreQuery) url.search = '';
    url.hash = '';
    s.nextLevel.push({ url: url.toString(), key: id, pathKey, depth, from, boundary: true });
  }

  /** robots.txt of a sibling host, fetched once and kept in the state. */
  async boundaryAllowed(item) {
    if (!this.cfg.respectRobots) return true;
    const origin = new URL(item.url).origin;
    const s = this.state;
    s.siblingRobots ||= {};
    if (!(origin in s.siblingRobots)) s.siblingRobots[origin] = await this.getText(origin + '/robots.txt', this.plainHeaders);
    const txt = s.siblingRobots[origin];
    if (!txt) return true;
    if (!this.robotsCache.has(origin)) this.robotsCache.set(origin, parseRobots(txt, String(this.cfg.userAgent).toLowerCase()));
    return this.robotsCache.get(origin).allowed(item.pathKey);
  }

  /** May one more page be opened in the browser (RF-MAP-21)? */
  canRender() {
    const m = this.cfg.map || {};
    return !!this.cfg.collectMap && (m.render ?? 'auto') === 'auto' && (this.state.rendered || 0) < (m.maxRendered ?? 50) && !this.browserFailure;
  }

  // The browser starts on the first page that needs it and closes at the end of the block, so a block
  // of a stepped run (spec §11.4) never leaves a process behind. One context with the credentials of the
  // environment for the main host, one without for boundary pages (RF-MAP-13).
  async browserContext(boundary) {
    if (!this.browserPromise) {
      this.browserPromise = (async () => {
        const pw = await loadPlaywright();
        if (!pw) throw new Error('Playwright non installato');
        return launchChromium(pw);
      })();
    }
    const browser = await this.browserPromise;
    this.contexts ||= {};
    const which = boundary ? 'plain' : 'own';
    if (!this.contexts[which]) {
      const { env } = this;
      this.contexts[which] = (async () => {
        const context = await browser.newContext({
          viewport: { width: 1280, height: 800 },
          userAgent: this.cfg.userAgent,
          httpCredentials: !boundary && env.auth && env.auth.username ? { username: env.auth.username, password: env.auth.password || '' } : undefined,
          extraHTTPHeaders: boundary ? undefined : Object.fromEntries(Object.entries(env.headers || {}).filter(([k]) => k.toLowerCase() !== 'user-agent')),
        });
        if (this.guardNetwork) {
          // RF-SEC-01 for the browser too, as for the screenshots
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
        return context;
      })();
    }
    return this.contexts[which];
  }

  async closeBrowser() {
    const p = this.browserPromise;
    this.browserPromise = null;
    this.contexts = null;
    if (p) await p.then((b) => b.close()).catch(() => {});
  }

  /** The DOM of a page after the scripts ran: up to 5 s of idle network (RF-MAP-21). */
  async render(url, boundary) {
    this.state.rendered = (this.state.rendered || 0) + 1;
    this.onProgress({ phase: 'render', done: this.state.rendered, limit: this.cfg.map?.maxRendered ?? 50, current: url });
    let page;
    try {
      const context = await this.browserContext(boundary);
      page = await context.newPage();
      await page.goto(url, { waitUntil: 'load', timeout: this.cfg.timeoutMs });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      return { html: await page.content(), url: page.url() };
    } catch (e) {
      this.signal?.throwIfAborted();
      const msg = String(e.message || e).split('\n')[0];
      if (/Playwright non installato|Executable doesn't exist|Failed to launch|browserType\.launch/i.test(msg)) this.browserFailure = msg;
      return { error: msg };
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  keyOf(u) {
    const url = new URL(u);
    if (this.cfg.ignoreQuery) url.search = '';
    return toKey(url.pathname + url.search, this.ignoreParams);
  }

  inScope(u) {
    try {
      const url = new URL(u);
      return url.origin === this.origin && url.pathname.startsWith(this.scopePrefix);
    } catch {
      return false;
    }
  }

  wanted(key) {
    if (this.include.length && !this.include.some((r) => r.test(key))) return false;
    if (this.exclude.some((r) => r.test(key))) return false;
    return true;
  }

  robotsAllowed(key) {
    return !this.cfg.respectRobots || !this.robots || this.robots.allowed(key);
  }

  timeout() {
    return this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(this.cfg.timeoutMs)]) : AbortSignal.timeout(this.cfg.timeoutMs);
  }

  request(url, accept, plain = false) {
    const base = plain ? this.plainHeaders : this.headers;
    const h = accept ? { ...base, accept } : base;
    return this.fetch(url, { headers: h, redirect: 'manual', signal: this.timeout() });
  }

  async getText(url, headers = this.headers) {
    // a second try: a keep-alive connection that the server closed in the meantime fails once with ECONNRESET, and a
    // robots.txt that «does not exist» for that reason would make the crawl ignore its rules
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await this.fetch(url, { headers, signal: this.timeout() });
        if (!r.ok) return null;
        return await r.text();
      } catch {
        this.signal?.throwIfAborted();
      }
    }
    return null;
  }

  enqueue(url, depth, from, list) {
    if (!this.inScope(url)) return;
    const key = this.keyOf(url);
    if (this.queuedSet.has(key) || !this.wanted(key) || !this.robotsAllowed(key)) return;
    this.queuedSet.add(key);
    this.state.queued.push(key);
    const u = new URL(url);
    if (this.cfg.ignoreQuery) u.search = '';
    u.hash = '';
    list.push({ url: u.toString(), key, depth, from });
  }

  async fetchPage(item) {
    const { cfg, keepHtmlDir } = this;
    const nextLevel = this.state.nextLevel;
    const page = { key: item.key, url: item.url, depth: item.depth, foundFrom: item.from, redirects: [] };
    const boundary = !!item.boundary;
    if (boundary) Object.assign(page, { boundary: true, pathKey: item.pathKey, host: new URL(item.url).host });
    const originOf = boundary ? new URL(item.url).origin : null;
    const inScope = (u) => (boundary ? new URL(u).origin === originOf : this.inScope(u));
    const t0 = performance.now();
    try {
      if (boundary && !(await this.boundaryAllowed(item))) {
        page.error = 'bloccata da robots.txt';
        page.robotsBlocked = true;
        page.responseMs = 0;
        return page;
      }
      let url = item.url;
      let res;
      const chain = new Set([url]);
      for (let hop = 0; hop <= 10; hop++) {
        res = await this.request(url, undefined, boundary);
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          const next = new URL(res.headers.get('location'), url).toString();
          page.redirects.push({ url, status: res.status, location: next });
          await res.body?.cancel();
          url = next;
          if (!inScope(next)) {
            page.offsite = true;
            if (!boundary) this.enqueueBoundary(next, item.depth + 1, item.key);
            break;
          }
          if (chain.has(next) || hop === 10) { page.redirectLoop = true; break; }
          chain.add(next);
          continue;
        }
        break;
      }
      page.finalUrl = url;
      page.status = page.redirects.length ? page.redirects[0].status : res.status;
      page.finalStatus = page.offsite ? null : res.status;
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      page.contentType = ct.split(';')[0] || null;
      page.isHtml = /html/.test(ct);
      const etag = res.headers.get('etag');
      if (etag) page.etag = etag;
      const xRobots = res.headers.get('x-robots-tag');
      if (xRobots) page.xRobots = xRobots;
      if (page.offsite) {
        page.isHtml = false;
      } else if (page.redirects.length) {
        await res.body?.cancel();
        if (boundary) this.enqueueBoundary(url, item.depth, item.key);
        else {
          const finalKey = this.keyOf(url);
          if (finalKey !== item.key) this.enqueue(url, item.depth, item.key, nextLevel);
        }
      } else if (page.isHtml) {
        const buf = Buffer.from(await res.arrayBuffer());
        page.bytes = buf.length;
        const html = buf.subarray(0, MAX_BODY).toString('utf8');
        if (keepHtmlDir) {
          page.html = `html/${sha1(item.key).slice(0, 12)}.html`;
          fs.mkdirSync(keepHtmlDir, { recursive: true });
          fs.writeFileSync(path.join(keepHtmlDir, path.basename(page.html)), html);
        }
        if (res.status < 400) {
          const collect = !!cfg.collectMap;
          const aOpts = { navSelectors: collect ? cfg.map?.navSelectors : [] };
          let analysis = analyzeHtml(html, url, aOpts);
          if (collect) {
            page.spaShell = analysis.spaShell;
            if (analysis.spaShell && this.canRender()) {
              const r = await this.render(url, boundary);
              if (r.html) {
                analysis = analyzeHtml(r.html, url, aOpts);
                page.rendered = true;
              } else page.renderError = r.error;
            }
          }
          const { page: fields, text, links, landmarks } = analysis;
          Object.assign(page, fields);
          // fetch decompresses transparently but keeps the header
          page.compressed = !!res.headers.get('content-encoding');
          page.charset = page.charset || (/charset=([\w-]+)/i.exec(ct) || [])[1] || null;
          page.securityHeaders = securityHeaders(res.headers);
          if (page.canonical) {
            try { page.canonicalKey = (boundary ? this.idOfUrl(page.canonical) : this.inScope(page.canonical) && this.keyOf(page.canonical)) || page.canonical; } catch { /* ignore */ }
          }
          const internal = new Set();
          const mapData = collect ? { content: new Set(), nav: new Set(), documents: new Map(), hosts: new Set() } : null;
          const docTypes = collect ? cfg.map?.documentTypes || [] : [];
          let external = 0, nofollow = 0;
          for (const l of links) {
            const ext = collect && documentExtension(l.url, docTypes);
            if (ext) {
              // a document is recorded, not visited as a page (RF-MAP-04)
              const region = l.nav ? 'nav' : 'content';
              const u = new URL(l.url);
              u.hash = '';
              mapData.documents.set(`${u}|${region}`, { url: u.toString(), host: u.host, ext, region });
            } else if (!boundary && this.inScope(l.url)) {
              const k = this.keyOf(l.url);
              internal.add(k);
              if (collect) (l.nav ? mapData.nav : mapData.content).add(k);
              if (l.nofollow) nofollow++;
              if (!l.nofollow && item.depth < cfg.maxDepth) this.enqueue(l.url, item.depth + 1, item.key, nextLevel);
            } else {
              // out of the main host, or any link of a boundary page: a sibling host is an edge of the map
              // (and, from the main host, a boundary page to visit), anything else is external
              const id = collect ? this.idOfUrl(l.url) : null;
              if (id) {
                internal.add(id);
                (l.nav ? mapData.nav : mapData.content).add(id);
                if (!boundary && !l.nofollow && item.depth < cfg.maxDepth) this.enqueueBoundary(l.url, item.depth + 1, item.key);
              }
              const host = new URL(l.url).host;
              if (!(id && boundary && (this.inScope(l.url) || host === page.host))) {
                external++;
                if (collect) mapData.hosts.add(host);
              }
            }
          }
          page.links = { internal: [...internal].sort(), external, nofollow };
          if (collect) {
            page.host = new URL(url).host;
            page.regions = landmarks ? 'landmark' : 'none';
            page.contentLinks = [...mapData.content].sort();
            page.navLinks = [...mapData.nav].sort();
            page.documents = [...mapData.documents.values()].sort((a, b) => a.url.localeCompare(b.url) || a.region.localeCompare(b.region));
            page.externalHosts = [...mapData.hosts].sort();
            page.langPrimary = primaryLang(fields.lang);
            page.hreflang = (fields.hreflang || []).map((h) => ({ ...h, key: (h.href && this.idOfUrl(h.href)) || null }));
          }
          if (cfg.storeText) this.state.texts[item.key] = text;
        }
      } else {
        const len = Number(res.headers.get('content-length'));
        await res.body?.cancel();
        if (len) page.bytes = len;
      }
    } catch (e) {
      this.signal?.throwIfAborted();
      page.error = e.name === 'TimeoutError' ? `Timeout dopo ${cfg.timeoutMs} ms` : blockedError(e) ? 'destinazione non ammessa' : (e.cause && e.cause.code) || e.message;
    }
    if (cfg.collectMap && page.redirects.length && page.finalUrl) {
      // where the redirect ends (RF-MAP-06)
      const main = new URL(this.env.baseUrl).host;
      const rel = hostRelation(new URL(page.finalUrl).host, main, siteDomain(main, cfg.map?.siteDomain));
      page.redirectKind = rel === 'main' ? 'same-host' : rel;
    }
    page.responseMs = Math.round(performance.now() - t0);
    return page;
  }

  get done() {
    const s = this.state;
    return !s.batch && (!s.level.length || this.pageCount >= this.limit);
  }

  /**
   * Visits pages until the crawl ends or `deadline` (ms since epoch) passes. Pages already started
   * are always completed, and at least one page is visited per block, so every block makes progress.
   * @returns {Promise<boolean>} true when the crawl is complete
   */
  async runBlock(opts = {}) {
    try {
      return await this.runPages(opts);
    } finally {
      await this.closeBrowser();
    }
  }

  async runPages({ deadline = Infinity } = {}) {
    const s = this.state;
    const { cfg, limit } = this;
    let started = 0;
    for (;;) {
      if (!s.batch) {
        if (!s.level.length || this.pageCount >= limit) return true;
        s.level.sort((a, b) => a.depth - b.depth || a.key.localeCompare(b.key));
        s.batch = s.level.slice(0, limit - this.pageCount);
        s.idx = 0;
        s.nextLevel = [];
      }
      const batch = s.batch;
      const worker = async () => {
        while (s.idx < batch.length && !this.signal?.aborted && (started === 0 || Date.now() < deadline)) {
          const item = batch[s.idx++];
          started++;
          const p = await this.fetchPage(item);
          s.pages.push(p);
          this.pageCount++;
          this.log(`[${this.pageCount}/${limit}] ${p.error ? 'ERR' : p.status} ${p.key}${p.redirects.length ? ' → ' + p.finalUrl : ''}`);
          this.onProgress({ phase: 'crawl', done: this.pageCount, limit, discovered: this.queuedSet.size, current: p.key });
          if (cfg.delayMs) await sleep(cfg.delayMs);
        }
      };
      this.onProgress({ phase: 'crawl', done: this.pageCount, limit, discovered: this.queuedSet.size });
      await Promise.all(Array.from({ length: Math.max(1, cfg.concurrency) }, worker));
      this.signal?.throwIfAborted();
      if (s.idx < batch.length) return false; // deadline: resume from s.idx
      s.level = s.nextLevel;
      s.nextLevel = [];
      s.batch = null;
      s.idx = 0;
    }
  }

  /** Issues and the final result, once the crawl is complete. */
  finish() {
    const s = this.state;
    const list = [...s.pages].sort((a, b) => a.key.localeCompare(b.key));
    const quality = this.cfg.quality || {};
    // boundary pages of sibling hosts (RF-MAP-11) are data for the site map, not part of the site's checks
    const own = list.filter((p) => !p.boundary);
    for (const p of list.filter((p) => p.boundary)) { setIndexability(p); p.issues = []; }
    for (const p of own) {
      if (!p.offsite && p.redirects.length && p.finalStatus >= 400) p.redirectBroken = true;
      setIndexability(p);
      p.issues = pageIssues(p, quality);
      if (p.redirectBroken) p.issues.push({ code: 'redirect-broken', severity: 'error', message: `Il redirect termina con status ${p.finalStatus}` });
    }
    const seedKeys = (urls) => [...new Set(urls.filter((u) => this.inScope(u)).map((u) => this.keyOf(u)))].sort();
    const startKeys = seedKeys(s.seeds.slice(0, s.startCount));
    const sitemapKeys = seedKeys(s.sitemapSeeds);
    const site = siteIssues(own, { startKeys, sitemapKeys, robotsFound: s.robotsFound, sitemapFound: s.sitemapFound, quality });
    const { issues, issueCodes } = applyQuality(own, site, quality);
    return {
      pages: list, issues, issueCodes, texts: new Map(Object.entries(s.texts)), sitemapUrls: s.sitemapUrls, unvisited: this.queuedSet.size - s.pages.length,
      robotsFound: s.robotsFound, sitemapFound: s.sitemapFound, seeds: { start: startKeys, sitemap: sitemapKeys }, boundarySkipped: s.boundarySkipped || [],
    };
  }
}
