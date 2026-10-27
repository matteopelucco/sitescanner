import fs from 'node:fs';
import path from 'node:path';
import { analyzeHtml, pageIssues, siteIssues, setIndexability, applyQuality, sha1 } from './analyze.js';
import { toKey, TRACKING_PARAMS } from './core/compare.js';
import { crawlFetch, blockedError } from './net-guard.js';

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
    const s = { v: 1, limit, robotsTxt: null, robotsFound: null, sitemapFound: null, sitemapUrls: 0, seeds: [], sitemapSeeds: [], startCount: c.start.length, queued: [], level: [], batch: null, idx: 0, nextLevel: [], pages: [], texts: {} };
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
  }

  // Rebuilds what is derived from the state: robots rules and the set of queued keys.
  hydrate() {
    const s = this.state;
    this.robots = s.robotsTxt ? parseRobots(s.robotsTxt, String(this.cfg.userAgent).toLowerCase()) : null;
    this.queuedSet = new Set(s.queued);
    this.pageCount = s.pages.length;
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

  request(url, accept) {
    const h = accept ? { ...this.headers, accept } : this.headers;
    return this.fetch(url, { headers: h, redirect: 'manual', signal: this.timeout() });
  }

  async getText(url) {
    // a second try: a keep-alive connection that the server closed in the meantime fails once with ECONNRESET, and a
    // robots.txt that «does not exist» for that reason would make the crawl ignore its rules
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await this.fetch(url, { headers: this.headers, signal: this.timeout() });
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
    const t0 = performance.now();
    try {
      let url = item.url;
      let res;
      const chain = new Set([url]);
      for (let hop = 0; hop <= 10; hop++) {
        res = await this.request(url);
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          const next = new URL(res.headers.get('location'), url).toString();
          page.redirects.push({ url, status: res.status, location: next });
          await res.body?.cancel();
          url = next;
          if (!this.inScope(next)) { page.offsite = true; break; }
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
        const finalKey = this.keyOf(url);
        if (finalKey !== item.key) this.enqueue(url, item.depth, item.key, nextLevel);
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
          const { page: fields, text, links } = analyzeHtml(html, url);
          Object.assign(page, fields);
          // fetch decompresses transparently but keeps the header
          page.compressed = !!res.headers.get('content-encoding');
          page.charset = page.charset || (/charset=([\w-]+)/i.exec(ct) || [])[1] || null;
          page.securityHeaders = securityHeaders(res.headers);
          if (page.canonical) {
            try { page.canonicalKey = this.inScope(page.canonical) ? this.keyOf(page.canonical) : page.canonical; } catch { /* ignore */ }
          }
          const internal = new Set();
          let external = 0, nofollow = 0;
          for (const l of links) {
            if (this.inScope(l.url)) {
              const k = this.keyOf(l.url);
              internal.add(k);
              if (l.nofollow) nofollow++;
              if (!l.nofollow && item.depth < cfg.maxDepth) this.enqueue(l.url, item.depth + 1, item.key, nextLevel);
            } else external++;
          }
          page.links = { internal: [...internal].sort(), external, nofollow };
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
  async runBlock({ deadline = Infinity } = {}) {
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
    for (const p of list) {
      if (!p.offsite && p.redirects.length && p.finalStatus >= 400) p.redirectBroken = true;
      setIndexability(p);
      p.issues = pageIssues(p, quality);
      if (p.redirectBroken) p.issues.push({ code: 'redirect-broken', severity: 'error', message: `Il redirect termina con status ${p.finalStatus}` });
    }
    const seedKeys = (urls) => [...new Set(urls.filter((u) => this.inScope(u)).map((u) => this.keyOf(u)))].sort();
    const startKeys = seedKeys(s.seeds.slice(0, s.startCount));
    const sitemapKeys = seedKeys(s.sitemapSeeds);
    const site = siteIssues(list, { startKeys, sitemapKeys, robotsFound: s.robotsFound, sitemapFound: s.sitemapFound, quality });
    const { issues, issueCodes } = applyQuality(list, site, quality);
    return {
      pages: list, issues, issueCodes, texts: new Map(Object.entries(s.texts)), sitemapUrls: s.sitemapUrls, unvisited: this.queuedSet.size - s.pages.length,
      robotsFound: s.robotsFound, sitemapFound: s.sitemapFound, seeds: { start: startKeys, sitemap: sitemapKeys },
    };
  }
}
