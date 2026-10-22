// Pure comparison logic shared by the CLI and the HTML report (inlined in the browser).
// No imports allowed here: the report build strips `export` and embeds this file verbatim.

export const SEVERITIES = ['error', 'warn', 'info'];
export const SEVERITY_RANK = { error: 3, warn: 2, info: 1 };

export const FINDING_TYPES = {
  'page-removed': 'Pagina rimossa',
  'page-added': 'Pagina aggiunta',
  'page-mapped': 'Pagina rimappata (redirect map)',
  'mapped-target-missing': 'Destinazione redirect map assente',
  'status-changed': 'Status HTTP cambiato',
  'redirect-changed': 'Destinazione redirect cambiata',
  'title-changed': 'Title cambiato',
  'description-changed': 'Meta description cambiata',
  'h1-changed': 'H1 cambiato',
  'canonical-changed': 'Canonical cambiato',
  'robots-changed': 'Meta robots cambiato',
  'lang-changed': 'Lingua cambiata',
  'hreflang-changed': 'Hreflang cambiati',
  'content-changed': 'Contenuto testuale cambiato',
  'links-changed': 'Link interni cambiati',
  'perf-regression': 'Tempo di risposta peggiorato',
  'issue-new': 'Nuova issue',
  'issue-resolved': 'Issue risolta',
  'visual-changed': 'Differenza visiva',
};

function norm(v) {
  if (v == null) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

function arrEq(a, b) {
  const x = (a || []).map(norm);
  const y = (b || []).map(norm);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function statusClass(s) {
  if (!s) return 'fail';
  if (s >= 500) return '5xx';
  if (s >= 400) return '4xx';
  if (s >= 300) return '3xx';
  return '2xx';
}

function isOk(p) {
  return p && p.status >= 200 && p.status < 300 && !p.error;
}

function hasNoindex(p) {
  return /noindex/i.test((p && p.robots) || '');
}

// Accepts a CSV with "from,to" rows (header optional). Values may be absolute URLs or paths.
export function parseRedirectMap(text) {
  const map = {};
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/[,;\t]/).map((s) => s.trim().replace(/^"|"$/g, ''));
    if (parts.length < 2) continue;
    const [from, to] = parts;
    if (/^(from|old|source)$/i.test(from)) continue;
    map[toKey(from)] = toKey(to);
  }
  return map;
}

// Reduces a URL or path to the page key used by scans: path + normalized query, no origin, no hash.
export function toKey(u) {
  let s = String(u || '').trim();
  try {
    const url = new URL(s, 'http://placeholder.invalid');
    const params = [...url.searchParams.entries()]
      .filter(([k]) => !/^utm_/i.test(k))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const q = params.length ? '?' + new URLSearchParams(params).toString() : '';
    return (url.pathname || '/') + q;
  } catch {
    return s;
  }
}

function issueSet(p) {
  const m = new Map();
  for (const i of (p && p.issues) || []) m.set(i.code, i);
  return m;
}

/**
 * Compare two scans.
 * @param {object} base  scan snapshot (scan.json)
 * @param {object} head  scan snapshot (scan.json)
 * @param {object} [opts]
 * @param {object} [opts.redirectMap]  { baseKey: headKey }
 * @param {object} [opts.visual]       { key: { ratio, baseSize, headSize } } precomputed pixel diffs
 * @param {string[]} [opts.ignore]     finding types to drop
 * @param {object} [opts.thresholds]
 */
export function compareScans(base, head, opts = {}) {
  const t = Object.assign(
    { contentWarnRatio: 0.3, perfFactor: 2, perfMinDeltaMs: 500, perfMinMs: 1000, visualWarn: 0.005, visualInfo: 0.0001 },
    opts.thresholds || {},
  );
  const ignore = new Set(opts.ignore || []);
  const redirectMap = opts.redirectMap || {};
  const visual = opts.visual || {};
  const findings = [];
  const add = (f) => {
    if (!ignore.has(f.type)) findings.push(f);
  };

  const bPages = new Map((base.pages || []).map((p) => [p.key, p]));
  const hPages = new Map((head.pages || []).map((p) => [p.key, p]));
  const pairs = []; // { key, baseKey, headKey, b, h, mapped }
  const consumedHead = new Set();

  for (const [key, b] of bPages) {
    const mappedTo = redirectMap[key];
    if (mappedTo && mappedTo !== key) {
      const h = hPages.get(mappedTo);
      if (h) {
        consumedHead.add(mappedTo);
        pairs.push({ key: mappedTo, baseKey: key, headKey: mappedTo, b, h, mapped: true });
        add({
          type: 'page-mapped', severity: 'info', key: mappedTo, baseKey: key,
          message: `${key} → ${mappedTo} (redirect map)`,
        });
      } else {
        add({
          type: 'mapped-target-missing', severity: 'error', key: mappedTo, baseKey: key,
          message: `La redirect map indica ${key} → ${mappedTo}, ma ${mappedTo} non è presente in Head`,
        });
        pairs.push({ key, baseKey: key, headKey: null, b, h: null, mapped: true });
      }
      continue;
    }
    const h = hPages.get(key);
    if (h) consumedHead.add(key);
    pairs.push({ key, baseKey: key, headKey: h ? key : null, b, h: h || null, mapped: false });
  }
  for (const [key, h] of hPages) {
    if (!consumedHead.has(key)) pairs.push({ key, baseKey: null, headKey: key, b: null, h, mapped: false });
  }

  const pageState = {}; // key -> added | removed | changed | unchanged

  for (const pr of pairs) {
    const { b, h, key } = pr;
    const before = findings.length;

    if (b && !h) {
      if (!pr.mapped) {
        const sev = isOk(b) ? 'error' : 'info';
        add({ type: 'page-removed', severity: sev, key, message: `Presente in Base (status ${b.status || 'n/d'}), assente in Head` });
      }
      pageState[key] = 'removed';
      continue;
    }
    if (!b && h) {
      const sev = isOk(h) ? 'info' : 'warn';
      add({ type: 'page-added', severity: sev, key, message: `Nuova in Head (status ${h.status || 'n/d'})` });
      pageState[key] = 'added';
      continue;
    }

    const ctx = { key, baseKey: pr.baseKey };

    // Status
    if ((b.status || 0) !== (h.status || 0) || !!b.error !== !!h.error) {
      const bc = statusClass(b.status), hc = statusClass(h.status);
      let sev = 'warn';
      if (isOk(b) && (hc === '4xx' || hc === '5xx' || hc === 'fail')) sev = 'error';
      else if (!isOk(b) && isOk(h)) sev = 'info';
      else if (bc === hc) sev = 'info';
      add({ ...ctx, type: 'status-changed', severity: sev, message: `${b.status || b.error || 'n/d'} → ${h.status || h.error || 'n/d'}`, base: b.status, head: h.status });
    }

    // Redirect destination
    const bFinal = b.redirects && b.redirects.length ? toKey(b.finalUrl) : null;
    const hFinal = h.redirects && h.redirects.length ? toKey(h.finalUrl) : null;
    if (bFinal !== hFinal) {
      add({ ...ctx, type: 'redirect-changed', severity: 'warn', message: `${bFinal || '(nessun redirect)'} → ${hFinal || '(nessun redirect)'}`, base: bFinal, head: hFinal });
    }

    if (isOk(b) && isOk(h)) {
      const fields = [
        ['title', 'title-changed', 'warn'],
        ['description', 'description-changed', 'warn'],
        ['canonical', 'canonical-changed', 'warn'],
        ['lang', 'lang-changed', 'warn'],
      ];
      for (const [field, type, sev] of fields) {
        let bv = norm(b[field]), hv = norm(h[field]);
        if (field === 'canonical') { bv = bv && toKey(bv); hv = hv && toKey(hv); }
        if (bv !== hv) add({ ...ctx, type, severity: sev, message: `«${bv || '∅'}» → «${hv || '∅'}»`, base: b[field] ?? null, head: h[field] ?? null });
      }
      if (!arrEq(b.h1, h.h1)) {
        add({ ...ctx, type: 'h1-changed', severity: 'warn', message: `«${(b.h1 || []).join(' | ') || '∅'}» → «${(h.h1 || []).join(' | ') || '∅'}»`, base: b.h1, head: h.h1 });
      }
      if (norm(b.robots) !== norm(h.robots)) {
        const sev = !hasNoindex(b) && hasNoindex(h) ? 'error' : 'warn';
        add({ ...ctx, type: 'robots-changed', severity: sev, message: `«${b.robots || '∅'}» → «${h.robots || '∅'}»`, base: b.robots, head: h.robots });
      }
      const hrefl = (p) => (p.hreflang || []).map((x) => `${x.lang}=${toKey(x.href)}`).sort();
      if (!arrEq(hrefl(b), hrefl(h))) {
        add({ ...ctx, type: 'hreflang-changed', severity: 'info', message: `${hrefl(b).length} → ${hrefl(h).length} alternate`, base: b.hreflang, head: h.hreflang });
      }
      if (b.textHash && h.textHash && b.textHash !== h.textHash) {
        const bw = b.wordCount || 0, hw = h.wordCount || 0;
        const ratio = bw ? Math.abs(hw - bw) / bw : hw ? 1 : 0;
        const sev = ratio >= t.contentWarnRatio ? 'warn' : 'info';
        const delta = hw - bw;
        add({ ...ctx, type: 'content-changed', severity: sev, message: `Parole ${bw} → ${hw} (${delta >= 0 ? '+' : ''}${delta}, ${(ratio * 100).toFixed(1)}%)`, base: bw, head: hw });
      }
      const bl = new Set((b.links && b.links.internal) || []);
      const hl = new Set((h.links && h.links.internal) || []);
      const lost = [...bl].filter((x) => !hl.has(x) && !(redirectMap[x] && hl.has(redirectMap[x])));
      const gained = [...hl].filter((x) => !bl.has(x));
      if (lost.length || gained.length) {
        const sev = bl.size && lost.length / bl.size > 0.2 ? 'warn' : 'info';
        add({ ...ctx, type: 'links-changed', severity: sev, message: `−${lost.length} / +${gained.length} link interni`, base: lost.slice(0, 50), head: gained.slice(0, 50) });
      }
      const bm = b.responseMs || 0, hm = h.responseMs || 0;
      if (bm && hm >= t.perfMinMs && hm > bm * t.perfFactor && hm - bm > t.perfMinDeltaMs) {
        add({ ...ctx, type: 'perf-regression', severity: 'warn', message: `${bm} ms → ${hm} ms`, base: bm, head: hm });
      }
    }

    // Page-level issues
    const bi = issueSet(b), hi = issueSet(h);
    for (const [code, i] of hi) {
      if (!bi.has(code)) add({ ...ctx, type: 'issue-new', severity: i.severity, code, message: `${code}: ${i.message}` });
    }
    for (const [code, i] of bi) {
      if (!hi.has(code)) add({ ...ctx, type: 'issue-resolved', severity: 'info', code, message: `${code}: ${i.message}` });
    }

    const v = visual[key];
    if (v && v.ratio != null) {
      const sizeChanged = v.baseSize && v.headSize && (v.baseSize[0] !== v.headSize[0] || v.baseSize[1] !== v.headSize[1]);
      if (v.ratio >= t.visualWarn) add({ ...ctx, type: 'visual-changed', severity: 'warn', message: `${(v.ratio * 100).toFixed(2)}% pixel differenti${sizeChanged ? ` (dimensioni ${v.baseSize.join('×')} → ${v.headSize.join('×')})` : ''}`, base: v.baseSize, head: v.headSize, ratio: v.ratio });
      else if (v.ratio >= t.visualInfo || sizeChanged) add({ ...ctx, type: 'visual-changed', severity: 'info', message: `${(v.ratio * 100).toFixed(3)}% pixel differenti`, base: v.baseSize, head: v.headSize, ratio: v.ratio });
    }

    const changed = findings.slice(before).some((f) => f.type !== 'page-mapped');
    pageState[key] = changed ? 'changed' : 'unchanged';
  }

  // Site-level issues (duplicates etc.)
  const siteIssueId = (i) => i.id || i.code + '|' + (i.key || '');
  const bs = new Map((base.issues || []).map((i) => [siteIssueId(i), i]));
  const hs = new Map((head.issues || []).map((i) => [siteIssueId(i), i]));
  for (const [k, i] of hs) if (!bs.has(k)) add({ type: 'issue-new', severity: i.severity, key: i.key || '(sito)', code: i.code, message: `${i.code}: ${i.message}` });
  for (const [k, i] of bs) if (!hs.has(k)) add({ type: 'issue-resolved', severity: 'info', key: i.key || '(sito)', code: i.code, message: `${i.code}: ${i.message}` });

  findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || String(a.key).localeCompare(String(b.key)) || a.type.localeCompare(b.type));

  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const states = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  for (const s of Object.values(pageState)) states[s]++;

  return {
    base: { id: base.id, env: base.env, label: base.label || null, startedAt: base.startedAt, pages: bPages.size },
    head: { id: head.id, env: head.env, label: head.label || null, startedAt: head.startedAt, pages: hPages.size },
    summary: { ...counts, ...states, findings: findings.length },
    pairs: pairs.map((p) => ({ key: p.key, baseKey: p.baseKey, headKey: p.headKey, state: pageState[p.key] || 'unchanged', mapped: p.mapped })),
    findings,
  };
}

export function exceedsThreshold(result, failOn) {
  if (!failOn) return false;
  const min = SEVERITY_RANK[failOn];
  return result.findings.some((f) => SEVERITY_RANK[f.severity] >= min);
}

// Line-based LCS diff, used by the report to show text changes. Returns [{op:'=', '-', '+', text}].
export function diffLines(a, b, maxLines = 1500) {
  const x = String(a || '').split('\n').slice(0, maxLines);
  const y = String(b || '').split('\n').slice(0, maxLines);
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length, endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) { endX--; endY--; }
  const xs = x.slice(start, endX), ys = y.slice(start, endY);
  const n = xs.length, m = ys.length;
  const out = x.slice(0, start).map((text) => ({ op: '=', text }));
  if (n * m > 4_000_000) {
    xs.forEach((text) => out.push({ op: '-', text }));
    ys.forEach((text) => out.push({ op: '+', text }));
  } else {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = xs[i] === ys[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (xs[i] === ys[j]) { out.push({ op: '=', text: xs[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: '-', text: xs[i++] });
      else out.push({ op: '+', text: ys[j++] });
    }
    while (i < n) out.push({ op: '-', text: xs[i++] });
    while (j < m) out.push({ op: '+', text: ys[j++] });
  }
  x.slice(endX).forEach((text) => out.push({ op: '=', text }));
  return out;
}

