(() => {
  'use strict';
  const INDEX = window.SS_INDEX || { sites: [] };

  // ---- data loading (JSONP-style script tags: works from file:// as well as over http) ----
  const cache = new Map();
  const waiting = new Map();
  window.SS_LOAD = (kind, site, id, data) => {
    const k = `${kind}:${site}/${id}`;
    cache.set(k, data);
    (waiting.get(k) || []).forEach((w) => w.resolve(data));
    waiting.delete(k);
  };
  function load(kind, site, id) {
    const k = `${kind}:${site}/${id}`;
    if (cache.has(k)) return Promise.resolve(cache.get(k));
    return new Promise((resolve, reject) => {
      const first = !waiting.has(k);
      if (first) waiting.set(k, []);
      waiting.get(k).push({ resolve, reject });
      if (!first) return;
      const s = document.createElement('script');
      s.src = `data/${encodeURIComponent(site)}/${encodeURIComponent(id)}${kind === 'text' ? '.text' : ''}.js`;
      s.onerror = () => {
        (waiting.get(k) || []).forEach((w) => w.reject(new Error(`Impossibile caricare ${s.src}`)));
        waiting.delete(k);
      };
      document.head.appendChild(s);
    });
  }

  // ---- helpers ----
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '');
  const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('it-IT'));
  const fmtBytes = (n) => (n == null ? '—' : n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
  const sevBadge = (s) => `<span class="sev ${s}">${s}</span>`;
  const stBadge = (p) => {
    if (!p) return '<span class="hint">—</span>';
    if (p.error) return `<span class="st sx" title="${esc(p.error)}">ERR</span>`;
    return `<span class="st s${String(p.status)[0]}">${p.status}</span>`;
  };
  const STATE_LABEL = { added: 'aggiunta', removed: 'rimossa', changed: 'cambiata', unchanged: 'invariata' };
  const typeLabel = (t) => FINDING_TYPES[t] || t;

  // ---- state ----
  const state = {
    site: null, base: null, head: null, tab: 'diff', page: null,
    sev: new Set(['error', 'warn', 'info']), type: '', q: '', pstate: '', pq: '', openIssue: null,
    pstatus: '', pissue: '', icat: '',
    redirectMap: null, rmapName: '', shot: 'side', limit: 200,
    result: null, diag: null, baseScan: null, headScan: null, error: null,
  };
  // Head empty: diagnostic view of the Base scan alone instead of the comparison.
  const single = () => !state.head;

  function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    // base without head (or with an empty head) is the single-scan diagnostic view
    const head = h.get('base') && !h.get('head') ? '' : h.get('head');
    return { site: h.get('site'), base: h.get('base'), head, tab: h.get('tab'), page: h.get('page') };
  }
  function writeHash() {
    const h = new URLSearchParams();
    if (state.site) h.set('site', state.site);
    if (state.base) h.set('base', state.base);
    if (state.head) h.set('head', state.head);
    if (state.tab && state.tab !== 'diff') h.set('tab', state.tab);
    if (state.page) h.set('page', state.page);
    const s = '#' + h.toString();
    if (location.hash !== s) history.replaceState(null, '', s);
  }

  const siteOf = (id) => INDEX.sites.find((s) => s.id === id);
  const metaOf = (id) => (siteOf(state.site)?.scans || []).find((s) => s.id === id);

  function defaultPair(site) {
    const scans = site.scans;
    if (!scans.length) return [null, null];
    const head = scans[scans.length - 1];
    if (scans.length === 1) return [head.id, null];
    const prevSameEnv = [...scans].reverse().find((s) => s.id !== head.id && s.env === head.env);
    const base = prevSameEnv || scans[scans.length - 2] || head;
    return [base.id, head.id];
  }

  // ---- pickers ----
  function scanOption(s) {
    const lbl = s.label ? ` · ${s.label}` : '';
    return `<option value="${esc(s.id)}">${esc(fmtDate(s.startedAt))} · ${esc(s.env)}${esc(lbl)} · ${esc(s.id.slice(-4))}</option>`;
  }
  function fillPickers() {
    $('#site').innerHTML = INDEX.sites.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} (${s.scans.length})</option>`).join('');
    $('#site').value = state.site || '';
    const site = siteOf(state.site);
    const opts = site ? [...site.scans].reverse().map(scanOption).join('') : '';
    $('#base').innerHTML = opts;
    $('#head').innerHTML = (site && site.scans.length ? '<option value="">— nessuna: diagnostica di Base —</option>' : '') + opts;
    $('#base').value = state.base || '';
    $('#head').value = state.head || '';
    $('#swap').disabled = single();
    $('#rmapLabel').textContent = state.redirectMap ? `Redirect map: ${state.rmapName} (${Object.keys(state.redirectMap).length}) ✕` : 'Redirect map…';
    $('#rmapLabel').parentElement.classList.toggle('on', !!state.redirectMap);
  }

  // head: undefined → default, '' → none (diagnostic view)
  function selectSite(id, base, head) {
    const site = siteOf(id) || INDEX.sites[0];
    state.site = site ? site.id : null;
    if (!site) return;
    const ids = new Set(site.scans.map((s) => s.id));
    const [db, dh] = defaultPair(site);
    state.base = base && ids.has(base) ? base : db;
    state.head = head === '' ? null : head && ids.has(head) ? head : dh;
    fillPickers();
  }

  async function compute() {
    state.result = null;
    state.diag = null;
    state.error = null;
    const site = siteOf(state.site);
    if (!site || !state.base) return render();
    $('#app').innerHTML = '<p class="empty">Caricamento scan…</p>';
    if (single()) {
      try {
        const b = await load('scan', site.id, state.base);
        const bm = metaOf(state.base);
        state.baseScan = { ...b, label: bm?.label ?? b.label, note: bm?.note ?? b.note };
        state.headScan = null;
        state.diag = diagnoseScan(state.baseScan);
      } catch (e) {
        state.error = e.message;
      }
      render();
      if (state.page) openDetail(state.page, true);
      return;
    }
    try {
      const [b, h] = await Promise.all([load('scan', site.id, state.base), load('scan', site.id, state.head)]);
      const bm = metaOf(state.base), hm = metaOf(state.head);
      state.baseScan = { ...b, label: bm?.label ?? b.label, note: bm?.note ?? b.note };
      state.headScan = { ...h, label: hm?.label ?? h.label, note: hm?.note ?? h.note };
      state.result = compareScans(state.baseScan, state.headScan, {
        redirectMap: state.redirectMap || {},
        ignore: (site.compare && site.compare.ignore) || [],
        thresholds: (site.compare && site.compare.thresholds) || {},
      });
    } catch (e) {
      state.error = e.message;
    }
    render();
    if (state.page) openDetail(state.page, true);
  }

  // ---- main render ----
  function render() {
    writeHash();
    const app = $('#app');
    if (!INDEX.sites.length) {
      app.innerHTML = '<p class="empty">Nessuna scan disponibile. Esegui <code>sitescanner scan --site &lt;id&gt; --env &lt;env&gt;</code> e poi <code>sitescanner report</code>.</p>';
      return;
    }
    if (state.error) {
      app.innerHTML = `<p class="empty">Errore: ${esc(state.error)}</p>`;
      return;
    }
    const site = siteOf(state.site);
    if (!site.scans.length) {
      app.innerHTML = '<p class="empty">Nessuna scan per questo sito.</p>';
      return;
    }
    if (single()) return renderSingle(site);
    const r = state.result;
    if (!r) return;
    const s = r.summary;
    const same = state.base === state.head;
    const verdictCls = s.error ? 'fail' : s.warn ? 'warn' : 'pass';
    const verdictTxt = same ? 'Stessa scan' : s.error ? 'Regressioni' : s.warn ? 'Da verificare' : 'Nessuna regressione';
    const headIssueCount = countIssues(state.headScan);

    app.innerHTML = `
      <div class="verdict">
        <div class="badge-big ${verdictCls}"><span class="n">${verdictTxt}</span><small>${s.error} errori · ${s.warn} warning · ${s.info} info</small></div>
        ${card('Base', state.baseScan)}
        ${card('Head', state.headScan)}
      </div>
      ${same ? '<p class="hint">Base e Head coincidono: scegli due scan diverse per il confronto, oppure lascia Head vuota per la diagnostica della scan.</p>' : ''}
      <div class="stats">
        ${stat('Pagine', `${fmtNum(r.base.pages)} → ${fmtNum(r.head.pages)}`, '', '')}
        ${stat('Health score', `${healthScore(state.baseScan) ?? '—'} → ${healthScore(state.headScan) ?? '—'}`, '', '')}
        ${stat('Errori', s.error, '', 'sev:error')}
        ${stat('Warning', s.warn, '', 'sev:warn')}
        ${stat('Info', s.info, '', 'sev:info')}
        ${stat('Cambiate', s.changed, '', 'state:changed')}
        ${stat('Aggiunte', s.added, '', 'state:added')}
        ${stat('Rimosse', s.removed, '', 'state:removed')}
        ${stat('Invariate', s.unchanged, '', 'state:unchanged')}
      </div>
      <nav class="tabs" role="tablist">
        ${tabBtn('diff', 'Differenze', r.findings.length)}
        ${tabBtn('pages', 'Pagine', r.pairs.length)}
        ${tabBtn('issues', 'Issue', headIssueCount)}
        ${tabBtn('history', 'Storico', site.scans.length)}
      </nav>
      <div id="tab"></div>`;
    renderTab();
  }

  const card = (title, scan) => `
      <div class="scanCard">
        <h3>${title}</h3>
        <div><strong>${esc(fmtDate(scan.startedAt))}</strong> <span class="tag">${esc(scan.env)}</span> ${scan.label ? `<span class="tag label">${esc(scan.label)}</span>` : ''}</div>
        <div class="id">${esc(scan.id)}</div>
        <div class="meta">${esc(scan.baseUrl)} · ${fmtNum(scan.stats.pages)} pagine${scan.crawl && scan.crawl.truncated ? ' (troncata a maxPages)' : ''}${scan.options.screenshots ? ' · screenshot' : ''}</div>
        ${scan.note ? `<div class="meta">📝 ${esc(scan.note)}</div>` : ''}
      </div>`;

  const stat = (k, v, d, action) => `<div class="stat${action ? ' click' : ''}" ${action ? `data-act="${action}"` : ''}><div class="k">${k}</div><div class="v">${v}</div>${d ? `<div class="d">${d}</div>` : ''}</div>`;

  const fmtMs = (v) => (v == null ? '—' : `${fmtNum(v)} ms`);
  const fmtDuration = (ms) => (ms == null ? '—' : ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);
  const STATUS_LABEL = { '2xx': '2xx', '3xx': '3xx redirect', '4xx': '4xx', '5xx': '5xx', fail: 'non raggiungibili' };
  const STATUS_FILTERS = { ...STATUS_LABEL, http: '4xx + 5xx' };
  const ISSUE_FILTERS = { noindex: 'non indicizzabili', any: 'con issue', error: 'con error', warn: 'con warning', info: 'con info', none: 'senza issue' };

  // ---- single-scan diagnostic view ----
  function renderSingle(site) {
    if (!state.diag) return;
    if (state.tab === 'diff') state.tab = 'issues';
    writeHash();
    const scan = state.baseScan, d = state.diag, s = d.summary, st = s.byStatus;
    const verdictCls = s.error ? 'fail' : s.warn ? 'warn' : 'pass';
    const verdictTxt = s.error ? 'Errori da correggere' : s.warn ? 'Da verificare' : 'Nessun problema';
    const crawlCard = `
      <div class="scanCard">
        <h3>Crawl</h3>
        <div class="meta">Durata ${esc(fmtDuration(scan.durationMs))} · risposta media ${esc(fmtMs(s.avgResponseMs))}</div>
        <div class="meta">${Object.keys(STATUS_LABEL).filter((k) => st[k]).map((k) => `${fmtNum(st[k])} ${STATUS_LABEL[k]}`).join(' · ') || '—'}</div>
        <div class="meta">${fmtNum(scan.crawl?.sitemapUrls || 0)} URL da sitemap${s.truncated ? ` · ${fmtNum(scan.crawl.unvisited)} URL non visitati (maxPages)` : ''}</div>
      </div>`;
    $('#app').innerHTML = `
      <div class="verdict">
        <div class="badge-big ${verdictCls}"><span class="n">${verdictTxt}</span><small>Health score ${s.healthScore ?? '—'}/100 · ${s.error} errori · ${s.warn} warning · ${s.info} info</small></div>
        ${card('Scan · diagnostica', scan)}
        ${crawlCard}
      </div>
      <p class="hint">Diagnostica della sola scan Base. Scegli una scan in «Head» per vedere le regressioni rispetto a Base.</p>
      <div class="stats">
        ${stat('Pagine', fmtNum(s.pages), '', 'status:')}
        ${stat('Health score', s.healthScore ?? '—', 'pagine senza errori', 'pissue:error')}
        ${stat('Indicizzabili', fmtNum(s.indexable), s.pages ? `${Math.round((100 * s.indexable) / s.pages)}%` : '', 'pissue:noindex')}
        ${stat('Con issue', fmtNum(s.pagesWithIssues), s.pages ? `${Math.round((100 * s.pagesWithIssues) / s.pages)}%` : '', 'pissue:any')}
        ${stat('Errori', fmtNum(s.error), '', 'sev:error')}
        ${stat('Warning', fmtNum(s.warn), '', 'sev:warn')}
        ${stat('Info', fmtNum(s.info), '', 'sev:info')}
        ${stat('2xx', fmtNum(st['2xx']), '', 'status:2xx')}
        ${stat('3xx', fmtNum(st['3xx']), '', 'status:3xx')}
        ${stat('4xx / 5xx', fmtNum(st['4xx'] + st['5xx']), '', 'status:http')}
        ${stat('Non raggiungibili', fmtNum(st.fail), '', 'status:fail')}
      </div>
      <nav class="tabs" role="tablist">
        ${tabBtn('issues', 'Issue', d.codes.length)}
        ${tabBtn('pages', 'Pagine', d.pages.length)}
        ${tabBtn('history', 'Storico', site.scans.length)}
      </nav>
      <div id="tab"></div>`;
    renderTab();
  }

  function renderSingleIssues() {
    const d = state.diag;
    const q = state.q.trim().toLowerCase();
    const matchCode = (c) => `${c.code} ${c.label}`.toLowerCase().includes(q);
    const matchItem = (it) => `${it.key} ${it.message} ${(it.pages || []).join(' ')}`.toLowerCase().includes(q);
    const rows = d.codes.filter((c) => state.sev.has(c.severity) && (!state.icat || c.category === state.icat) && (!q || matchCode(c) || c.items.some(matchItem)));
    const cats = [...new Set(d.codes.map((c) => c.category))].sort();
    const sevCount = (s) => d.codes.filter((c) => c.severity === s).reduce((n, c) => n + c.occurrences, 0);
    const pageLink = (k) => `<span class="plink" data-page="${esc(k)}">${esc(k)}</span>`;
    // a page that does not load: who links to it is what tells where to fix it
    const REF_CODES = new Set(['http-4xx', 'http-5xx', 'fetch-failed', 'redirect-loop']);
    const referrers = (code, key) => {
      if (!REF_CODES.has(code)) return '';
      const from = d.inlinks[key] || [];
      return `<div class="plinks"><span class="hint">Linkata da:</span> ${from.length ? `${from.slice(0, 10).map(pageLink).join(' ')}${from.length > 10 ? ` <span class="hint">… altre ${from.length - 10}</span>` : ''}` : '<span class="hint">nessuna pagina (trovata da sitemap o URL di partenza)</span>'}</div>`;
    };
    const item = (it, code) => (it.pages
      ? `<tr><td></td><td colspan="4" class="msg">${esc(it.message)}<div class="plinks">${it.pages.slice(0, 50).map(pageLink).join(' ')}${it.pages.length > 50 ? ` <span class="hint">… altre ${it.pages.length - 50}</span>` : ''}</div></td></tr>`
      : `<tr class="click" data-page="${esc(it.key)}"><td></td><td class="key" colspan="4">${esc(it.key)} <span class="hint">— ${esc(it.message)}</span>${referrers(code, it.key)}</td></tr>`);
    return `
      <div class="toolbar">
        ${SEVERITIES.map((s) => `<button class="chip${state.sev.has(s) ? ' on' : ''}" data-sev="${s}"><span class="dot ${s}"></span>${s} ${sevCount(s)}</button>`).join('')}
        <select id="icat" aria-label="Categoria"><option value="">Tutte le categorie</option>${cats.map((c) => `<option${state.icat === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <input type="search" id="fq" placeholder="Cerca issue, pagina o messaggio…" value="${esc(state.q)}">
      </div>
      ${rows.length ? `<p class="hint">Issue di qualità della scan per codice. Clicca una riga per vedere le pagine coinvolte.</p>
      <div class="tablewrap"><table>
        <thead><tr><th>Sev.</th><th>Issue</th><th>Categoria</th><th class="num">Occorrenze</th><th class="num">Pagine</th></tr></thead>
        <tbody>${rows.map((c) => {
          const open = state.openIssue === c.code;
          const items = !open ? [] : q && !matchCode(c) ? c.items.filter(matchItem) : c.items;
          return `<tr class="click" data-issue="${esc(c.code)}"><td>${sevBadge(c.severity)}</td><td>${esc(c.label)} <code class="hint">${esc(c.code)}</code> ${open ? '▾' : '▸'}</td><td class="hint">${esc(c.category)}</td><td class="num">${fmtNum(c.occurrences)}</td><td class="num">${fmtNum(c.pages)}</td></tr>
            ${items.slice(0, 300).map((it) => item(it, c.code)).join('')}
            ${items.length > 300 ? `<tr><td></td><td colspan="4" class="hint">… altre ${items.length - 300} occorrenze: restringi con la ricerca.</td></tr>` : ''}`;
        }).join('')}</tbody>
      </table></div>`
      : `<p class="empty">${d.codes.length ? 'Nessuna issue con i filtri correnti.' : 'Nessuna issue rilevata nella scan.'}</p>`}`;
  }

  function renderSinglePages() {
    const d = state.diag;
    const q = state.pq.trim().toLowerCase();
    const byStatus = (p, f) => !f || p.status === f || (f === 'http' && (p.status === '4xx' || p.status === '5xx'));
    const byIssue = (p) => !state.pissue || (state.pissue === 'noindex' ? !!p.indexability : state.pissue === 'none' ? !p.worst : state.pissue === 'any' ? !!p.worst : p.counts[state.pissue] > 0);
    const rows = d.pages.filter((p) => byStatus(p, state.pstatus) && byIssue(p) && (!q || `${p.key} ${p.title || ''}`.toLowerCase().includes(q)));
    const shown = rows.slice(0, state.limit);
    const counts = (c) => SEVERITIES.filter((s) => c[s]).map((s) => `<span class="sev ${s}">${c[s]}</span>`).join(' ');
    const status = (p) => (p.error ? `<span class="st sx" title="${esc(p.error)}">ERR</span>` : `<span class="st s${String(p.code)[0]}">${p.code}</span>`);
    return `
      <div class="toolbar">
        <select id="pstatus" aria-label="Status"><option value="">Tutti gli status</option>${Object.entries(STATUS_FILTERS).map(([k, l]) => `<option value="${k}"${state.pstatus === k ? ' selected' : ''}>${l} (${d.pages.filter((p) => byStatus(p, k)).length})</option>`).join('')}</select>
        <select id="pissue" aria-label="Issue"><option value="">Tutte le pagine</option>${Object.entries(ISSUE_FILTERS).map(([k, l]) => `<option value="${k}"${state.pissue === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <input type="search" id="pq" placeholder="Filtra per path o title…" value="${esc(state.pq)}">
      </div>
      ${rows.length ? `<div class="tablewrap"><table>
        <thead><tr><th>Pagina</th><th>Status</th><th>Title</th><th class="num">Clic</th><th class="num">Link entranti</th><th>Issue</th></tr></thead>
        <tbody>${shown.map((p) => `<tr class="click" data-page="${esc(p.key)}"><td class="key">${esc(p.key)}${p.indexability ? `<div class="hint">non indicizzabile: ${esc(p.indexability)}</div>` : ''}</td><td>${status(p)}</td><td class="msg">${esc(p.title || '')}</td><td class="num">${esc(p.clickDepth ?? '—')}</td><td class="num">${fmtNum(p.inlinks)}</td><td>${counts(p.counts)}</td></tr>`).join('')}</tbody>
      </table></div>
      ${rows.length > shown.length ? `<button class="btn more" data-act="more">Mostra altri (${rows.length - shown.length})</button>` : ''}`
      : '<p class="empty">Nessuna pagina con i filtri correnti.</p>'}`;
  }

  const tabBtn = (id, label, n) => `<button class="tab${state.tab === id ? ' on' : ''}" data-tab="${id}" role="tab">${label}<span class="count">${fmtNum(n)}</span></button>`;

  function countIssues(scan) {
    return (scan.pages || []).reduce((n, p) => n + (p.issues || []).length, 0) + (scan.issues || []).length;
  }

  function renderTab() {
    const el = $('#tab');
    if (!el) return;
    if (single()) {
      if (state.tab === 'pages') el.innerHTML = renderSinglePages();
      else if (state.tab === 'history') el.innerHTML = renderHistory();
      else el.innerHTML = renderSingleIssues();
      return;
    }
    if (state.tab === 'pages') el.innerHTML = renderPages();
    else if (state.tab === 'issues') el.innerHTML = renderIssues();
    else if (state.tab === 'history') el.innerHTML = renderHistory();
    else el.innerHTML = renderDiff();
  }

  function filteredFindings() {
    const q = state.q.trim().toLowerCase();
    return state.result.findings.filter((f) =>
      state.sev.has(f.severity) &&
      (!state.type || f.type === state.type) &&
      (!q || `${f.key} ${f.baseKey || ''} ${f.message} ${f.type}`.toLowerCase().includes(q)));
  }

  function renderDiff() {
    const r = state.result;
    const counts = {};
    for (const f of r.findings) counts[f.type] = (counts[f.type] || 0) + 1;
    const sevCount = (s) => r.findings.filter((f) => f.severity === s).length;
    const rows = filteredFindings();
    const shown = rows.slice(0, state.limit);
    return `
      <div class="toolbar">
        ${SEVERITIES.map((s) => `<button class="chip${state.sev.has(s) ? ' on' : ''}" data-sev="${s}"><span class="dot ${s}"></span>${s} ${sevCount(s)}</button>`).join('')}
        <select id="ftype" aria-label="Tipo"><option value="">Tutti i tipi</option>${Object.keys(counts).sort().map((t) => `<option value="${t}"${state.type === t ? ' selected' : ''}>${esc(typeLabel(t))} (${counts[t]})</option>`).join('')}</select>
        <input type="search" id="fq" placeholder="Cerca pagina o messaggio…" value="${esc(state.q)}">
      </div>
      ${rows.length ? `<div class="tablewrap"><table>
        <thead><tr><th>Sev.</th><th>Tipo</th><th>Pagina</th><th>Dettaglio</th></tr></thead>
        <tbody>${shown.map((f) => `<tr class="click" data-page="${esc(f.key)}"><td>${sevBadge(f.severity)}</td><td>${esc(typeLabel(f.type))}</td><td class="key">${esc(f.key)}${f.baseKey && f.baseKey !== f.key ? `<div class="hint">da ${esc(f.baseKey)}</div>` : ''}</td><td class="msg">${esc(f.message)}</td></tr>`).join('')}</tbody>
      </table></div>
      ${rows.length > shown.length ? `<button class="btn more" data-act="more">Mostra altri (${rows.length - shown.length})</button>` : ''}`
      : `<p class="empty">${r.findings.length ? 'Nessuna differenza con i filtri correnti.' : 'Nessuna differenza tra Base e Head.'}</p>`}`;
  }

  function renderPages() {
    const r = state.result;
    const bp = new Map(state.baseScan.pages.map((p) => [p.key, p]));
    const hp = new Map(state.headScan.pages.map((p) => [p.key, p]));
    const per = {};
    for (const f of r.findings) {
      const c = (per[f.key] = per[f.key] || { error: 0, warn: 0, info: 0 });
      c[f.severity]++;
    }
    const q = state.pq.trim().toLowerCase();
    const rows = r.pairs.filter((p) => (!state.pstate || p.state === state.pstate) && (!q || `${p.key} ${p.baseKey || ''}`.toLowerCase().includes(q)));
    const shown = rows.slice(0, state.limit);
    const counts = (k) => {
      const c = per[k];
      if (!c) return '';
      return SEVERITIES.filter((s) => c[s]).map((s) => `<span class="sev ${s}">${c[s]}</span>`).join(' ');
    };
    return `
      <div class="toolbar">
        <select id="pstate" aria-label="Stato"><option value="">Tutti gli stati</option>${['changed', 'added', 'removed', 'unchanged'].map((s) => `<option value="${s}"${state.pstate === s ? ' selected' : ''}>${STATE_LABEL[s]} (${r.summary[s]})</option>`).join('')}</select>
        <input type="search" id="pq" placeholder="Filtra per path…" value="${esc(state.pq)}">
      </div>
      <div class="tablewrap"><table>
        <thead><tr><th>Pagina</th><th>Stato</th><th>Base</th><th>Head</th><th>Title</th><th>Differenze</th></tr></thead>
        <tbody>${shown.map((p) => {
          const b = p.baseKey && bp.get(p.baseKey), h = p.headKey && hp.get(p.headKey);
          return `<tr class="click" data-page="${esc(p.key)}"><td class="key">${esc(p.key)}${p.mapped && p.baseKey !== p.key ? `<div class="hint">da ${esc(p.baseKey)}</div>` : ''}</td><td><span class="state ${p.state}">${STATE_LABEL[p.state]}</span></td><td>${stBadge(b)}</td><td>${stBadge(h)}</td><td class="msg">${esc((h || b || {}).title || '')}</td><td>${counts(p.key)}</td></tr>`;
        }).join('')}</tbody>
      </table></div>
      ${rows.length > shown.length ? `<button class="btn more" data-act="more">Mostra altri (${rows.length - shown.length})</button>` : ''}`;
  }

  function issueIndex(scan) {
    const m = new Map();
    const push = (i, key) => {
      if (!m.has(i.code)) m.set(i.code, { code: i.code, severity: i.severity, items: [] });
      m.get(i.code).items.push({ key, message: i.message });
    };
    for (const p of scan.pages || []) for (const i of p.issues || []) push(i, p.key);
    for (const i of scan.issues || []) push(i, i.key || '(sito)');
    return m;
  }

  function renderIssues() {
    const bi = issueIndex(state.baseScan), hi = issueIndex(state.headScan);
    const codes = [...new Set([...bi.keys(), ...hi.keys()])];
    const rank = (c) => SEVERITY_RANK[(hi.get(c) || bi.get(c)).severity];
    codes.sort((a, b) => rank(b) - rank(a) || (hi.get(b)?.items.length || 0) - (hi.get(a)?.items.length || 0) || a.localeCompare(b));
    if (!codes.length) return '<p class="empty">Nessuna issue rilevata in Base e Head.</p>';
    return `
      <p class="hint">Issue di qualità rilevate in ciascuna scan (vista as-is). Clicca un codice per vedere le pagine coinvolte in Head.</p>
      <div class="tablewrap"><table>
        <thead><tr><th>Sev.</th><th>Codice</th><th class="num">Base</th><th class="num">Head</th><th class="num">Δ</th></tr></thead>
        <tbody>${codes.map((c) => {
          const b = bi.get(c)?.items.length || 0, h = hi.get(c)?.items.length || 0, d = h - b;
          const open = state.openIssue === c;
          const items = open ? (hi.get(c)?.items || []) : [];
          return `<tr class="click" data-issue="${esc(c)}"><td>${sevBadge((hi.get(c) || bi.get(c)).severity)}</td><td><code>${esc(c)}</code> ${open ? '▾' : '▸'}</td><td class="num">${b}</td><td class="num">${h}</td><td class="num"><span class="delta ${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d > 0 ? '+' : ''}${d}</span></td></tr>
            ${items.slice(0, 300).map((it) => `<tr class="click" data-page="${esc(it.key)}"><td></td><td class="key" colspan="4">${esc(it.key)} <span class="hint">— ${esc(it.message)}</span></td></tr>`).join('')}
            ${open && !items.length ? '<tr><td></td><td colspan="4" class="hint">Nessuna occorrenza in Head (risolta).</td></tr>' : ''}`;
        }).join('')}</tbody>
      </table></div>`;
  }

  function renderHistory() {
    const site = siteOf(state.site);
    const scans = site.scans;
    const W = 1000, H = 120, P = 8;
    const series = [
      { k: 'error', color: 'var(--error)', label: 'errori', v: (s) => s.stats.issues.error },
      { k: 'warn', color: 'var(--warn)', label: 'warning', v: (s) => s.stats.issues.warn },
      { k: 'pages', color: 'var(--accent)', label: 'pagine (scala a parte)', v: (s) => s.stats.pages },
    ];
    // errors and warnings share one scale so they stay comparable; pages get their own
    const issueMax = Math.max(1, ...scans.map((s) => Math.max(s.stats.issues.error, s.stats.issues.warn)));
    let chart = '';
    if (scans.length > 1) {
      const lines = series.map((se) => {
        const vals = scans.map(se.v);
        const max = se.k === 'pages' ? Math.max(1, ...vals) : issueMax;
        const pts = vals.map((v, i) => `${(P + (i * (W - 2 * P)) / (scans.length - 1)).toFixed(1)},${(H - P - (v / max) * (H - 2 * P)).toFixed(1)}`).join(' ');
        return `<polyline fill="none" stroke="${se.color}" stroke-width="2" vector-effect="non-scaling-stroke" points="${pts}"/>`;
      }).join('');
      const marks = scans.map((s, i) => (s.id === state.base || s.id === state.head) ? `<line x1="${P + (i * (W - 2 * P)) / (scans.length - 1)}" x2="${P + (i * (W - 2 * P)) / (scans.length - 1)}" y1="0" y2="${H}" stroke="var(--muted)" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>` : '').join('');
      chart = `<div class="trend"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Andamento issue e pagine">${marks}${lines}</svg>
        <div class="legend">${series.map((se) => `<span><i style="background:${se.color}"></i>${se.label}</span>`).join('')}<span>linee tratteggiate: Base/Head</span></div></div>`;
    }
    return `${chart}
      <div class="tablewrap"><table>
        <thead><tr><th>Data</th><th>Scan</th><th>Env</th><th>Label</th><th class="num">Pagine</th><th class="num" title="Health score">Health</th><th class="num">E</th><th class="num">W</th><th class="num">I</th><th></th></tr></thead>
        <tbody>${[...scans].reverse().map((s) => `<tr>
          <td>${esc(fmtDate(s.startedAt))}</td>
          <td class="key">${esc(s.id)}${s.note ? `<div class="hint">${esc(s.note)}</div>` : ''}</td>
          <td><span class="tag">${esc(s.env)}</span></td>
          <td>${s.label ? `<span class="tag label">${esc(s.label)}</span>` : ''}</td>
          <td class="num">${fmtNum(s.stats.pages)}</td>
          <td class="num">${s.stats.healthScore ?? '—'}</td>
          <td class="num">${s.stats.issues.error}</td><td class="num">${s.stats.issues.warn}</td><td class="num">${s.stats.issues.info}</td>
          <td style="white-space:nowrap"><button class="btn small${s.id === state.base ? ' on' : ''}" data-setbase="${esc(s.id)}">Base</button> <button class="btn small${s.id === state.head ? ' on' : ''}" data-sethead="${esc(s.id)}">Head</button> <button class="btn small${s.id === state.base && single() ? ' on' : ''}" data-single="${esc(s.id)}" title="Diagnostica della sola scan">Solo</button></td>
        </tr>`).join('')}</tbody>
      </table></div>`;
  }

  // ---- page detail ----
  function pageRow(label, bv, hv, fmt = (v) => esc(v ?? '—'), cmp = null) {
    const same = cmp ? cmp(bv, hv) : JSON.stringify(bv ?? null) === JSON.stringify(hv ?? null);
    return `<tr class="${same ? '' : 'diff'}"><td>${label}</td><td class="b">${fmt(bv)}</td><td class="h">${fmt(hv)}</td></tr>`;
  }

  const list = (a) => (a && a.length ? a.map(esc).join('<br>') : '—');
  const pageLink = (p) => (p ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a>` : '—');
  const issueList = (a) => (a && a.length ? [...a].sort((x, y) => SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity]).map((i) => `<div>${sevBadge(i.severity)} <code>${esc(i.code)}</code> <span class="hint">${esc(i.message)}</span></div>`).join('') : '<span class="hint">nessuna</span>');
  const plain = (v) => esc(v ?? '—');
  // [label, value getter, formatter, excluded from the Base/Head highlight]
  const FIELDS = [
    ['Status', (p) => p.error || p.status],
    ['Redirect', (p) => (p.redirects || []).map((x) => `${x.status} → ${x.location}`), list],
    ['Content-Type', (p) => p.contentType],
    ['Title', (p) => p.title],
    ['Description', (p) => p.description],
    ['H1', (p) => p.h1, list],
    ['Canonical', (p) => p.canonical],
    ['Meta robots', (p) => p.robots],
    ['Lang', (p) => p.lang],
    ['Heading', (p) => p.headings, (v) => (v ? Object.entries(v).filter(([, n]) => n).map(([k, n]) => `${k}:${n}`).join(' ') || '—' : '—')],
    ['Parole', (p) => p.wordCount, fmtNum],
    ['Hash testo', (p) => p.textHash, (v) => `<code>${esc(v || '—')}</code>`],
    ['Link interni', (p) => p.links?.internal?.length, fmtNum],
    ['Link esterni', (p) => p.links?.external, fmtNum],
    ['Immagini (senza alt)', (p) => (p.images ? `${p.images.total} (${p.images.missingAlt})` : null)],
    ['Hreflang', (p) => (p.hreflang || []).map((x) => `${x.lang}: ${x.href}`), list],
    ['OG title', (p) => p.og?.title],
    ['OG image', (p) => p.og?.image],
    ['Tempo risposta', (p) => p.responseMs, fmtMs, true],
    ['Dimensione HTML', (p) => p.bytes, fmtBytes, true],
    ['Profondità crawl', (p) => p.depth, plain, true],
    ['Profondità di click', (p) => p.clickDepth, plain, true],
    ['Indicizzabilità', (p) => (p.url ? indexabilityOf(p) || 'indicizzabile' : null)],
    ['X-Robots-Tag', (p) => p.xRobots],
    ['Dati strutturati', (p) => (p.structuredData ? (p.structuredData.types.join(', ') || 'nessuno') + (p.structuredData.invalid ? ` · ${p.structuredData.invalid} JSON-LD non validi` : '') : null)],
  ];

  function openDetail(key, fromHash = false) {
    if (single()) return openSingleDetail(key, fromHash);
    const r = state.result;
    if (!r) return;
    const pair = r.pairs.find((p) => p.key === key);
    if (!pair) { state.page = null; writeHash(); return; }
    state.page = key;
    if (!fromHash) state.shot = 'side';
    writeHash();
    const b = pair.baseKey ? state.baseScan.pages.find((p) => p.key === pair.baseKey) : null;
    const h = pair.headKey ? state.headScan.pages.find((p) => p.key === pair.headKey) : null;
    const bm = metaOf(state.base), hm = metaOf(state.head);
    const findings = r.findings.filter((f) => f.key === key);
    const B = b || {}, Hh = h || {};

    const el = $('#detail');
    el.innerHTML = `
      <header><h2>${esc(key)} <span class="state ${pair.state}">${STATE_LABEL[pair.state]}</span></h2><button class="btn" data-act="close" aria-label="Chiudi">✕</button></header>
      <div class="body">
        ${findings.length ? `<section><h3>Differenze (${findings.length})</h3><div class="tablewrap"><table><tbody>${findings.map((f) => `<tr><td>${sevBadge(f.severity)}</td><td>${esc(typeLabel(f.type))}</td><td class="msg">${esc(f.message)}</td></tr>`).join('')}</tbody></table></div></section>` : '<section><p class="hint">Nessuna differenza rilevata per questa pagina.</p></section>'}
        <section><h3>Confronto</h3><div class="tablewrap"><table class="cmp">
          <thead><tr><th></th><th>Base · ${esc(fmtDate(state.baseScan.startedAt))}</th><th>Head · ${esc(fmtDate(state.headScan.startedAt))}</th></tr></thead>
          <tbody>
            <tr><td>URL</td><td class="b">${pageLink(b)}</td><td class="h">${pageLink(h)}</td></tr>
            ${FIELDS.map(([label, get, fmt = plain, noCmp]) => pageRow(label, get(B), get(Hh), fmt, noCmp ? () => true : null)).join('')}
          </tbody></table></div></section>
        <section><h3>Issue</h3><div class="tablewrap"><table class="cmp"><tbody><tr><td>Issue</td><td class="b">${issueList(b && b.issues)}</td><td class="h">${issueList(h && h.issues)}</td></tr></tbody></table></div></section>
        <section id="shotSec"></section>
        <section id="textSec"></section>
      </div>`;
    el.hidden = false;
    $('#scrim').hidden = false;
    document.body.style.overflow = 'hidden';
    renderShots(b, h, bm, hm);
    renderText(pair, bm, hm);
  }

  function openSingleDetail(key, fromHash = false) {
    const d = state.diag;
    if (!d) return;
    const p = state.baseScan.pages.find((x) => x.key === key);
    if (!p) { state.page = null; writeHash(); return; }
    state.page = key;
    if (!fromHash) state.shot = 'side';
    writeHash();
    const bm = metaOf(state.base);
    const siteIssues = d.siteIssuesByPage[key] || [];
    const inl = d.inlinks[key] || [];
    const out = [...new Set(p.links?.internal || [])];
    const keyList = (keys) => (keys.length ? `<div class="plinks">${keys.slice(0, 200).map((k) => `<span class="plink" data-page="${esc(k)}">${esc(k)}</span>`).join(' ')}${keys.length > 200 ? ` <span class="hint">… altri ${keys.length - 200}</span>` : ''}</div>` : '<span class="hint">nessuno</span>');
    const el = $('#detail');
    el.innerHTML = `
      <header><h2>${esc(key)} ${stBadge(p)}</h2><button class="btn" data-act="close" aria-label="Chiudi">✕</button></header>
      <div class="body">
        <section><h3>Issue (${(p.issues || []).length + siteIssues.length})</h3><div class="tablewrap"><table class="cmp"><tbody>
          <tr><td>Pagina</td><td>${issueList(p.issues)}</td></tr>
          ${siteIssues.length ? `<tr><td>Sito</td><td>${issueList(siteIssues)}</td></tr>` : ''}
        </tbody></table></div></section>
        <section><h3>Dati · ${esc(fmtDate(state.baseScan.startedAt))}</h3><div class="tablewrap"><table class="cmp">
          <tbody>
            <tr><td>URL</td><td>${pageLink(p)}</td></tr>
            ${FIELDS.map(([label, get, fmt = plain]) => `<tr><td>${label}</td><td>${fmt(get(p))}</td></tr>`).join('')}
          </tbody></table></div></section>
        <section><h3>Link entranti (${inl.length})</h3>${keyList(inl)}</section>
        <section><h3>Link interni in uscita (${out.length})</h3>${keyList(out)}</section>
        <section id="shotSec"></section>
        <section id="textSec"></section>
      </div>`;
    el.hidden = false;
    $('#scrim').hidden = false;
    document.body.style.overflow = 'hidden';
    renderShots(p, null, bm, null);
    renderSingleText(p, bm);
  }

  async function renderSingleText(p, bm) {
    const sec = $('#textSec');
    if (!bm.hasText) { sec.innerHTML = ''; return; }
    try {
      const t = (await load('text', state.site, state.base))[p.key];
      if (state.page !== p.key) return;
      sec.innerHTML = t == null ? '' : `<h3>Testo visibile <span class="hint">(${fmtNum(t.split('\n').length)} righe)</span></h3><div class="textdiff">${t.split('\n').map((l) => `<div>${esc(l)}</div>`).join('')}</div>`;
    } catch (e) {
      sec.innerHTML = `<h3>Testo</h3><p class="hint">${esc(e.message)}</p>`;
    }
  }

  function closeDetail() {
    $('#detail').hidden = true;
    $('#scrim').hidden = true;
    document.body.style.overflow = '';
    state.page = null;
    writeHash();
  }

  function renderShots(b, h, bm, hm) {
    const sec = $('#shotSec');
    const bs = b && b.screenshot ? bm.assets + b.screenshot : null;
    const hs = h && h.screenshot ? hm.assets + h.screenshot : null;
    if (!bs && !hs) {
      const why = [b && b.screenshotError, h && h.screenshotError].filter(Boolean).join(' / ');
      sec.innerHTML = `<h3>Screenshot</h3><p class="hint">Nessuno screenshot disponibile${why ? ': ' + esc(why) : ''}.</p>`;
      return;
    }
    const modes = [['side', 'Affiancati'], ['slider', 'Slider'], ['blend', 'Differenza'], ['pixel', 'Pixel diff'], ['base', 'Solo Base'], ['head', 'Solo Head']];
    const both = bs && hs;
    const mode = both ? state.shot : (bs ? 'base' : 'head');
    const img = (src, alt) => (src ? `<img src="${esc(src)}" alt="${alt}" loading="lazy">` : '<div class="noshot">non disponibile</div>');
    let body = '';
    if (mode === 'side') body = `<div class="shots"><figure><figcaption>Base</figcaption>${img(bs, 'Base')}</figure><figure><figcaption>Head</figcaption>${img(hs, 'Head')}</figure></div>`;
    else if (mode === 'slider') body = `<div class="slider" id="sl"><img src="${esc(bs)}" alt="Base"><div class="top" style="width:50%"><img src="${esc(hs)}" alt="Head"></div><input type="range" min="0" max="100" value="50" id="slr" aria-label="Posizione slider"></div><p class="hint">A sinistra Head, a destra Base.</p>`;
    else if (mode === 'blend') body = `<div class="blend"><img src="${esc(bs)}" alt="Base"><img src="${esc(hs)}" alt="Head"></div><p class="hint">Fusione «difference»: le aree nere sono identiche, quelle chiare differiscono.</p>`;
    else if (mode === 'pixel') body = `<div id="pd"><p class="hint">Calcolo in corso…</p></div>`;
    else body = `<div class="single">${img(mode === 'base' ? bs : hs, mode)}</div>`;
    sec.innerHTML = `<h3>Screenshot</h3>
      <div class="toolbar">${modes.filter(([m]) => both || m === mode).map(([m, l]) => `<button class="btn small${m === mode ? ' on' : ''}" data-shot="${m}">${l}</button>`).join('')}
      ${bs ? `<a class="hint" href="${esc(bs)}" target="_blank">apri Base</a>` : ''} ${hs ? `<a class="hint" href="${esc(hs)}" target="_blank">apri Head</a>` : ''}</div>${body}`;
    if (mode === 'slider') {
      const sl = $('#sl'), top = sl.querySelector('.top'), topImg = top.querySelector('img');
      const fit = () => { topImg.style.width = sl.clientWidth + 'px'; };
      fit();
      new ResizeObserver(fit).observe(sl);
      $('#slr').addEventListener('input', (e) => { top.style.width = e.target.value + '%'; });
    }
    if (mode === 'pixel') pixelDiff(bs, hs, $('#pd'));
  }

  function loadImg(src) {
    return new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('immagine non caricabile'));
      i.src = src;
    });
  }

  async function pixelDiff(a, b, out) {
    try {
      const [ia, ib] = await Promise.all([loadImg(a), loadImg(b)]);
      const w = Math.max(ia.naturalWidth, ib.naturalWidth), h = Math.max(ia.naturalHeight, ib.naturalHeight);
      const get = (img) => {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const x = c.getContext('2d');
        x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
        x.drawImage(img, 0, 0);
        return x.getImageData(0, 0, w, h);
      };
      const da = get(ia), db = get(ib);
      const c = document.createElement('canvas');
      c.width = w; c.height = h; c.className = 'pdiff';
      const ctx = c.getContext('2d');
      const o = ctx.createImageData(w, h);
      let n = 0;
      for (let i = 0; i < da.data.length; i += 4) {
        const d = Math.abs(da.data[i] - db.data[i]) + Math.abs(da.data[i + 1] - db.data[i + 1]) + Math.abs(da.data[i + 2] - db.data[i + 2]);
        if (d > 40) {
          n++;
          o.data[i] = 230; o.data[i + 1] = 30; o.data[i + 2] = 60; o.data[i + 3] = 255;
        } else {
          const g = 255 - (255 - (da.data[i] * 0.3 + da.data[i + 1] * 0.59 + da.data[i + 2] * 0.11)) * 0.25;
          o.data[i] = o.data[i + 1] = o.data[i + 2] = g; o.data[i + 3] = 255;
        }
      }
      ctx.putImageData(o, 0, 0);
      out.innerHTML = `<p class="hint">${(100 * n / (w * h)).toFixed(3)}% pixel differenti (${fmtNum(n)}) · ${ia.naturalWidth}×${ia.naturalHeight} → ${ib.naturalWidth}×${ib.naturalHeight}</p>`;
      const wrap = document.createElement('div');
      wrap.className = 'single';
      wrap.appendChild(c);
      out.appendChild(wrap);
    } catch (e) {
      out.innerHTML = `<p class="hint">Pixel diff non disponibile${location.protocol === 'file:' ? ' aprendo il report da file: usa <code>sitescanner serve</code> oppure la modalità «Differenza»' : ''} (${esc(e.message)}).</p>`;
    }
  }

  async function renderText(pair, bm, hm) {
    const sec = $('#textSec');
    if (!pair.baseKey || !pair.headKey || !bm.hasText || !hm.hasText) {
      sec.innerHTML = '';
      return;
    }
    sec.innerHTML = '<h3>Testo</h3><p class="hint">Caricamento…</p>';
    try {
      const [tb, th] = await Promise.all([load('text', state.site, state.base), load('text', state.site, state.head)]);
      if (state.page !== pair.key) return;
      const a = tb[pair.baseKey], b = th[pair.headKey];
      if (a == null && b == null) { sec.innerHTML = ''; return; }
      if (a === b) { sec.innerHTML = '<h3>Testo</h3><p class="hint">Testo identico.</p>'; return; }
      const ops = diffLines(a, b);
      const ctx = 2;
      const keep = ops.map((o, i) => o.op !== '=' || ops.slice(Math.max(0, i - ctx), i + ctx + 1).some((x) => x.op !== '='));
      let html = '', skipped = 0;
      ops.forEach((o, i) => {
        if (!keep[i]) { skipped++; return; }
        if (skipped) { html += `<div class="s">… ${skipped} righe invariate</div>`; skipped = 0; }
        html += `<div class="${o.op === '+' ? 'a' : o.op === '-' ? 'r' : ''}">${esc(o.text)}</div>`;
      });
      if (skipped) html += `<div class="s">… ${skipped} righe invariate</div>`;
      const add = ops.filter((o) => o.op === '+').length, del = ops.filter((o) => o.op === '-').length;
      sec.innerHTML = `<h3>Testo <span class="hint">(+${add} / −${del} righe)</span></h3><div class="textdiff">${html}</div>`;
    } catch (e) {
      sec.innerHTML = `<h3>Testo</h3><p class="hint">${esc(e.message)}</p>`;
    }
  }

  // ---- events ----
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab],[data-sev],[data-page],[data-act],[data-issue],[data-setbase],[data-sethead],[data-single],[data-shot]');
    if (!t) return;
    const d = t.dataset;
    if (d.tab) { state.tab = d.tab; state.limit = 200; render(); return; }
    if (d.sev) { state.sev.has(d.sev) ? state.sev.delete(d.sev) : state.sev.add(d.sev); state.limit = 200; renderTab(); return; }
    if (d.issue) { state.openIssue = state.openIssue === d.issue ? null : d.issue; renderTab(); return; }
    if (d.setbase) { state.base = d.setbase; fillPickers(); compute(); return; }
    if (d.sethead) { state.head = d.sethead; fillPickers(); compute(); return; }
    if (d.single) { state.base = d.single; state.head = null; fillPickers(); compute(); return; }
    if (d.shot) {
      state.shot = d.shot;
      if (single()) return;
      const pair = state.result.pairs.find((p) => p.key === state.page);
      const b = pair.baseKey ? state.baseScan.pages.find((p) => p.key === pair.baseKey) : null;
      const h = pair.headKey ? state.headScan.pages.find((p) => p.key === pair.headKey) : null;
      renderShots(b, h, metaOf(state.base), metaOf(state.head));
      return;
    }
    if (d.page) { openDetail(d.page); return; }
    if (d.act === 'close') { closeDetail(); return; }
    if (d.act === 'more') { state.limit += 500; renderTab(); return; }
    if (d.act && d.act.startsWith('sev:')) {
      state.tab = single() ? 'issues' : 'diff'; state.sev = new Set([d.act.slice(4)]); state.type = ''; state.q = ''; render(); return;
    }
    if (d.act && d.act.startsWith('status:')) {
      state.tab = 'pages'; state.pstatus = d.act.slice(7); state.pissue = ''; render(); return;
    }
    if (d.act && d.act.startsWith('pissue:')) {
      state.tab = 'pages'; state.pissue = d.act.slice(7); state.pstatus = ''; render(); return;
    }
    if (d.act && d.act.startsWith('state:')) {
      state.tab = 'pages'; state.pstate = d.act.slice(6); render(); return;
    }
  });
  $('#scrim').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#detail').hidden) closeDetail(); });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'fq') { state.q = e.target.value; state.limit = 200; rerenderKeepingFocus('fq'); }
    if (e.target.id === 'pq') { state.pq = e.target.value; state.limit = 200; rerenderKeepingFocus('pq'); }
  });
  document.addEventListener('change', (e) => {
    const id = e.target.id;
    if (id === 'ftype') { state.type = e.target.value; renderTab(); }
    if (id === 'pstate') { state.pstate = e.target.value; renderTab(); }
    if (id === 'pstatus') { state.pstatus = e.target.value; state.limit = 200; renderTab(); }
    if (id === 'icat') { state.icat = e.target.value; renderTab(); }
    if (id === 'pissue') { state.pissue = e.target.value; state.limit = 200; renderTab(); }
    if (id === 'site') { state.page = null; selectSite(e.target.value); compute(); }
    if (id === 'base') { state.base = e.target.value; compute(); }
    if (id === 'head') { state.head = e.target.value || null; fillPickers(); compute(); }
    if (id === 'rmap' && e.target.files[0]) {
      const f = e.target.files[0];
      f.text().then((txt) => {
        state.redirectMap = parseRedirectMap(txt);
        state.rmapName = f.name;
        e.target.value = '';
        fillPickers();
        compute();
      });
    }
  });
  $('#rmapLabel').parentElement.addEventListener('click', (e) => {
    if (state.redirectMap) {
      e.preventDefault();
      state.redirectMap = null;
      state.rmapName = '';
      fillPickers();
      compute();
    }
  });
  $('#pdf').addEventListener('click', exportPdf);
  $('#swap').addEventListener('click', () => {
    if (single()) return;
    [state.base, state.head] = [state.head, state.base];
    fillPickers();
    compute();
  });

  // ---- PDF ----
  // Served by `sitescanner ui` the server renders the PDF with Chromium; from file://, from a bundle,
  // without Playwright or with a redirect map loaded, the same print document goes to the browser's print.
  async function exportPdf() {
    if (!state.baseScan) return;
    const btn = $('#pdf');
    if (/^https?:$/.test(location.protocol) && !state.redirectMap) {
      btn.disabled = true;
      btn.textContent = 'PDF…';
      try {
        const q = new URLSearchParams({ site: state.site, base: state.base, ...(state.head ? { head: state.head } : {}) });
        const r = await fetch('/api/pdf?' + q);
        if (r.ok && /pdf/.test(r.headers.get('content-type') || '')) {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(await r.blob());
          a.download = (/filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '') || [])[1] || 'sitescanner.pdf';
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 10000);
          return;
        }
      } catch { /* no server API: print from the browser */ } finally {
        btn.disabled = false;
        btn.textContent = 'PDF';
      }
    }
    printInBrowser();
  }

  function printInBrowser() {
    const site = siteOf(state.site);
    const html = renderPrintHtml({
      base: state.baseScan, head: single() ? null : state.headScan,
      compare: { redirectMap: state.redirectMap || {}, ignore: site.compare?.ignore || [], thresholds: site.compare?.thresholds || {} },
      siteName: site.name, version: INDEX.tool?.version || '',
    });
    const w = window.open('', '_blank');
    if (!w) { alert('Il browser ha bloccato la finestra di stampa: consenti i popup per questa pagina.'); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  }

  function rerenderKeepingFocus(id) {
    const el = document.getElementById(id);
    const pos = el ? el.selectionStart : null;
    renderTab();
    const n = document.getElementById(id);
    if (n) { n.focus(); if (pos != null) n.setSelectionRange(pos, pos); }
  }

  // ---- boot ----
  $('#gen').textContent = INDEX.generatedAt ? fmtDate(INDEX.generatedAt) : '';
  const h = readHash();
  const pre = INDEX.preselect || {};
  if (h.tab) state.tab = h.tab;
  state.page = h.page || null;
  const preHead = pre.base && !pre.head ? '' : pre.head;
  selectSite(h.site || pre.site || (INDEX.sites[0] && INDEX.sites[0].id), h.base || pre.base, h.base ? h.head : preHead);
  compute();
})();
