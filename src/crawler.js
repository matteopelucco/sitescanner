import fs from 'node:fs';
import path from 'node:path';
import { analyzeHtml, pageIssues, siteIssues, sha1 } from './analyze.js';
import { toKey } from './core/compare.js';

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

function extractLocs(xml) {
  return [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
}

/**
 * Crawls one environment of a site.
 * @returns {Promise<{pages: object[], issues: object[], texts: Map<string,string>, robots: object|null, sitemapUrls: number}>}
 */
export async function crawl(cfg, env, { maxPages, keepHtmlDir = null, log = () => {} } = {}) {
  const base = new URL(env.baseUrl);
  const origin = base.origin;
  const scopePrefix = base.pathname.endsWith('/') ? base.pathname : base.pathname.replace(/[^/]*$/, '');
  const include = compileRegexes(cfg.include, 'include');
  const exclude = compileRegexes(cfg.exclude, 'exclude');
  const limit = maxPages || cfg.maxPages;

  const headers = { 'user-agent': cfg.userAgent, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', ...env.headers };
  if (env.auth && env.auth.username) {
    headers.authorization = 'Basic ' + Buffer.from(`${env.auth.username}:${env.auth.password || ''}`).toString('base64');
  }

  const keyOf = (u) => {
    const url = new URL(u);
    if (cfg.ignoreQuery) url.search = '';
    return toKey(url.pathname + url.search);
  };
  const inScope = (u) => {
    try {
      const url = new URL(u);
      return url.origin === origin && url.pathname.startsWith(scopePrefix);
    } catch {
      return false;
    }
  };
  const wanted = (key) => {
    if (include.length && !include.some((r) => r.test(key))) return false;
    if (exclude.some((r) => r.test(key))) return false;
    return true;
  };

  async function request(url, accept) {
    const h = accept ? { ...headers, accept } : headers;
    return fetch(url, { headers: h, redirect: 'manual', signal: AbortSignal.timeout(cfg.timeoutMs) });
  }

  async function getText(url) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(cfg.timeoutMs) });
      if (!r.ok) return null;
      return await r.text();
    } catch {
      return null;
    }
  }

  // robots.txt
  let robots = null;
  if (cfg.respectRobots || cfg.sitemap === true) {
    const txt = await getText(origin + '/robots.txt');
    if (txt) robots = parseRobots(txt, String(cfg.userAgent).toLowerCase());
  }
  const robotsAllowed = (key) => !cfg.respectRobots || !robots || robots.allowed(key);

  // Seeds
  const seeds = [];
  for (const s of cfg.start) seeds.push(new URL(s, env.baseUrl).toString());
  let sitemapUrls = 0;
  if (cfg.sitemap) {
    const roots = Array.isArray(cfg.sitemap)
      ? cfg.sitemap.map((s) => new URL(s, env.baseUrl).toString())
      : [...new Set([new URL('sitemap.xml', origin + scopePrefix).toString(), ...((robots && robots.sitemaps) || [])])];
    const seen = new Set();
    const queue = [...roots];
    while (queue.length && seen.size < 50) {
      const sm = queue.shift();
      if (seen.has(sm)) continue;
      seen.add(sm);
      const xml = await getText(sm);
      if (!xml) continue;
      const locs = extractLocs(xml);
      if (/<sitemapindex/i.test(xml)) queue.push(...locs);
      else for (const l of locs) {
        // Sitemaps of another environment often list production URLs: rebase them on this env.
        try {
          const u = new URL(l);
          const rebased = new URL(u.pathname + u.search, origin).toString();
          seeds.push(rebased);
          sitemapUrls++;
        } catch { /* ignore */ }
      }
    }
  }

  const pages = new Map(); // key -> page
  const texts = new Map();
  const queued = new Set();
  let level = [];
  const enqueue = (url, depth, from, list) => {
    if (!inScope(url)) return;
    const key = keyOf(url);
    if (queued.has(key) || !wanted(key) || !robotsAllowed(key)) return;
    queued.add(key);
    const u = new URL(url);
    if (cfg.ignoreQuery) u.search = '';
    u.hash = '';
    list.push({ url: u.toString(), key, depth, from });
  };
  seeds.forEach((s, i) => enqueue(s, i < cfg.start.length ? 0 : 1, null, level));

  async function fetchPage(item) {
    const page = { key: item.key, url: item.url, depth: item.depth, foundFrom: item.from, redirects: [] };
    const t0 = performance.now();
    try {
      let url = item.url;
      let res;
      for (let hop = 0; hop <= 10; hop++) {
        res = await request(url);
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          const next = new URL(res.headers.get('location'), url).toString();
          page.redirects.push({ url, status: res.status, location: next });
          await res.body?.cancel();
          url = next;
          if (!inScope(next)) { page.offsite = true; break; }
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
      if (page.offsite) {
        page.isHtml = false;
      } else if (page.redirects.length) {
        await res.body?.cancel();
        const finalKey = keyOf(url);
        if (finalKey !== item.key) enqueue(url, item.depth, item.key, nextLevel);
      } else if (page.isHtml) {
        const buf = Buffer.from(await res.arrayBuffer());
        page.bytes = buf.length;
        const html = buf.subarray(0, MAX_BODY).toString('utf8');
        if (keepHtmlDir) {
          page.html = `html/${sha1(item.key).slice(0, 12)}.html`;
          fs.writeFileSync(path.join(keepHtmlDir, path.basename(page.html)), html);
        }
        if (res.status < 400) {
          const { page: fields, text, links } = analyzeHtml(html, url);
          Object.assign(page, fields);
          if (page.canonical) {
            try { page.canonicalKey = inScope(page.canonical) ? keyOf(page.canonical) : page.canonical; } catch { /* ignore */ }
          }
          const internal = new Set();
          let external = 0;
          for (const l of links) {
            if (inScope(l.url)) {
              const k = keyOf(l.url);
              internal.add(k);
              if (!l.nofollow && item.depth < cfg.maxDepth) enqueue(l.url, item.depth + 1, item.key, nextLevel);
            } else external++;
          }
          page.links = { internal: [...internal].sort(), external };
          if (cfg.storeText) texts.set(item.key, text);
        }
      } else {
        const len = Number(res.headers.get('content-length'));
        await res.body?.cancel();
        if (len) page.bytes = len;
      }
    } catch (e) {
      page.error = e.name === 'TimeoutError' ? `Timeout dopo ${cfg.timeoutMs} ms` : (e.cause && e.cause.code) || e.message;
    }
    page.responseMs = Math.round(performance.now() - t0);
    return page;
  }

  let nextLevel = [];
  while (level.length && pages.size < limit) {
    level.sort((a, b) => a.depth - b.depth || a.key.localeCompare(b.key));
    const batch = level.slice(0, limit - pages.size);
    nextLevel = [];
    let idx = 0;
    const worker = async () => {
      while (idx < batch.length) {
        const item = batch[idx++];
        const p = await fetchPage(item);
        pages.set(p.key, p);
        log(`[${pages.size}/${limit}] ${p.error ? 'ERR' : p.status} ${p.key}${p.redirects.length ? ' → ' + p.finalUrl : ''}`);
        if (cfg.delayMs) await sleep(cfg.delayMs);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, cfg.concurrency) }, worker));
    level = nextLevel;
  }

  const list = [...pages.values()].sort((a, b) => a.key.localeCompare(b.key));
  for (const p of list) {
    if (!p.offsite && p.redirects.length && p.finalStatus >= 400) p.redirectBroken = true;
    p.issues = pageIssues(p);
    if (p.redirectBroken) p.issues.push({ code: 'redirect-broken', severity: 'error', message: `Il redirect termina con status ${p.finalStatus}` });
  }
  const issues = siteIssues(list);
  return { pages: list, issues, texts, sitemapUrls, unvisited: queued.size - pages.size };
}
