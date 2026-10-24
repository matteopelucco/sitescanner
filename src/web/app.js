// Web app: sites, scans with live progress, inventories. Talks to /api (src/api.js); job updates via SSE.

// ---- helpers ----
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '');
const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('it-IT'));
const fmtBytes = (n) => (n == null ? '—' : n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
const fmtDur = (ms) => (ms == null ? '' : ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);
const lines = (v) => String(v || '').split('\n').map((s) => s.trim()).filter(Boolean);
const intOrNull = (v) => (String(v).trim() === '' ? null : Number(v));
const reportUrl = (site, base, head) => `/report/#${new URLSearchParams({ site, ...(base ? { base } : {}), ...(head ? { head } : {}) })}`;

async function api(method, path, body) {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer = null;
function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${error ? ' error' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, error ? 6000 : 3000);
}

// ---- state ----
const state = {
  info: null,      // /api/state
  jobs: [],        // newest first
  view: null,      // { name, refresh?() } of the current page
  inv: null,       // inventory open in #/inventory/<id>
  invPages: { q: '', filter: '', sort: 'clickDepth', dir: 1, limit: 200 },
  openTree: new Set(['/']),
};

const runningJobs = () => state.jobs.filter((j) => j.status === 'running');
const siteJobs = (site) => state.jobs.filter((j) => j.lock === `site:${site}` || (j.params && j.params.site === site));

// ---- jobs ----
const PHASE = { start: 'Avvio', robots: 'robots.txt', sitemap: 'Sitemap', crawl: 'Crawling', screenshots: 'Screenshot', saving: 'Salvataggio', report: 'Aggiornamento report' };
const STATUS = { running: ['In corso', 'info'], done: ['Completato', 'ok'], failed: ['Fallito', 'error'], cancelled: ['Annullato', 'warn'] };

function progressBar(j) {
  const p = j.progress || {};
  if (j.status !== 'running') return '';
  let pct = null;
  if (p.phase === 'crawl' && p.limit) pct = p.done / Math.max(1, Math.min(p.limit, p.discovered || p.limit));
  if (p.phase === 'screenshots' && p.limit) pct = p.done / p.limit;
  const w = pct == null ? '' : ` style="width:${Math.min(100, Math.round(pct * 100))}%"`;
  return `<div class="bar${pct == null ? ' indet' : ''}" role="progressbar"${pct == null ? '' : ` aria-valuenow="${Math.round(pct * 100)}"`}><i${w}></i></div>`;
}

function progressLine(j) {
  const p = j.progress || {};
  if (j.status === 'failed') return `<span class="err">${esc(j.error)}</span>`;
  if (j.status === 'cancelled') return 'Annullato: nessun dato salvato.';
  if (j.status === 'done') {
    const r = j.result || {};
    if (j.type === 'scan') {
      const s = r.stats || {};
      return `${fmtNum(s.pages)} URL · ${fmtNum(s.htmlPages)} pagine HTML · issue ${fmtNum(s.issues?.error)} errori, ${fmtNum(s.issues?.warn)} warning`
        + `${r.truncated ? ' · <span class="sev-w">troncata a maxPages</span>' : ''}${r.screenshotsSkipped ? ` · screenshot saltati: ${esc(r.screenshotsSkipped)}` : ''}`;
    }
    return `${fmtNum(r.urls)} URL · ${fmtNum(r.htmlPages)} pagine HTML · profondità di click max ${fmtNum(r.maxClickDepth)}${r.truncated ? ' · <span class="sev-w">troncato</span>' : ''}`;
  }
  const parts = [PHASE[p.phase] || p.phase];
  if (p.phase === 'crawl') parts.push(`${fmtNum(p.done)} visitati su ${fmtNum(p.discovered)} scoperti (limite ${fmtNum(p.limit)})`);
  if (p.phase === 'screenshots') parts.push(`${fmtNum(p.done)} / ${fmtNum(p.limit)}`);
  if (j.cancelling) parts.push('annullamento…');
  return esc(parts.join(' · ')) + (p.current ? ` <span class="mono">${esc(p.current)}</span>` : '');
}

function jobLinks(j) {
  const r = j.result || {};
  const out = [`<a class="btn small" href="#/jobs/${esc(j.id)}">Dettagli</a>`];
  if (j.status === 'running') out.push(`<button class="btn small danger" data-cancel="${esc(j.id)}" ${j.cancelling ? 'disabled' : ''}>Annulla</button>`);
  if (j.status === 'done' && j.type === 'scan') out.push(`<a class="btn small" href="${esc(reportUrl(r.site, null, r.scanId))}" target="_blank" rel="noopener">Apri nel report ↗</a>`);
  if (j.status === 'done' && j.type === 'inventory') out.push(`<a class="btn small" href="#/inventory/${esc(r.inventoryId)}">Apri inventario</a>`);
  return out.join('');
}

function jobCard(j) {
  const [label, cls] = STATUS[j.status] || [j.status, ''];
  const when = j.finishedAt ? `${fmtDate(j.startedAt)} · ${fmtDur(new Date(j.finishedAt) - new Date(j.startedAt))}` : `avviato ${fmtDate(j.startedAt)}`;
  return `<div class="job" data-job="${esc(j.id)}">
    <div class="top"><span class="what">${esc(j.title)}</span><span class="row"><span class="tag ${cls}">${label}</span><span class="muted small">${esc(when)}</span></span></div>
    ${progressBar(j)}
    <div class="line">${progressLine(j)}</div>
    <div class="row">${jobLinks(j)}</div>
  </div>`;
}

// Containers marked data-jobs="all" | "site:<id>" | "inventory" | "running" are refreshed on every job event.
function jobsFor(filter) {
  if (filter === 'all') return state.jobs;
  if (filter === 'running') return runningJobs();
  if (filter === 'inventory') return state.jobs.filter((j) => j.type === 'inventory');
  if (filter.startsWith('site:')) return siteJobs(filter.slice(5)).slice(0, 3);
  return [];
}
function renderJobBoxes() {
  for (const el of $$('[data-jobs]')) {
    const list = jobsFor(el.dataset.jobs);
    el.innerHTML = list.length ? list.map(jobCard).join('') : (el.dataset.empty ? `<p class="muted small">${esc(el.dataset.empty)}</p>` : '');
  }
  const n = runningJobs().length;
  $('#jobBadge').hidden = !n;
  $('#jobBadge').textContent = n;
  for (const el of $$('[data-site-running]')) el.hidden = !siteJobs(el.dataset.siteRunning).some((j) => j.status === 'running');
}

function onJob(j) {
  const i = state.jobs.findIndex((x) => x.id === j.id);
  const prev = i >= 0 ? state.jobs[i] : null;
  if (prev && prev.seq > j.seq) return;
  if (i >= 0) state.jobs[i] = j;
  else state.jobs.unshift(j);
  renderJobBoxes();
  if (prev && prev.status === 'running' && j.status !== 'running') {
    if (j.status === 'done') toast(`${j.title}: completato`);
    else if (j.status === 'failed') toast(`${j.title}: ${j.error}`, true);
    if (state.view && state.view.refresh) state.view.refresh(j);
  } else if (state.view && state.view.onJob) state.view.onJob(j);
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('jobs', (e) => {
    state.jobs = JSON.parse(e.data);
    renderJobBoxes();
  });
  es.addEventListener('job', (e) => onJob(JSON.parse(e.data)));
  // EventSource reconnects by itself; the "jobs" event on reconnect resyncs the list.
}

async function startJob(params) {
  const j = await api('POST', 'jobs', params);
  onJob(j);
  return j;
}

// ---- views ----
const app = () => $('#app');

function setView(name, extra = {}) {
  state.view = { name, ...extra };
  for (const a of $$('[data-nav]')) a.classList.toggle('on', a.dataset.nav === name);
}

function errorView(e) {
  app().innerHTML = `<div class="notice error">${esc(e.message || e)}</div><p><a href="#/">← Torna ai siti</a></p>`;
}

// Dashboard
async function viewSites() {
  setView('sites', { refresh: () => viewSites() });
  const info = state.info = await api('GET', 'state');
  $('#ver').textContent = info.tool.version;
  $('#root').textContent = info.root;
  const cards = info.sites.map((s) => {
    const last = s.lastScan;
    const envs = Object.entries(s.envs);
    return `<div class="card">
      <div class="row" style="justify-content:space-between"><a class="title" href="#/site/${encodeURIComponent(s.id)}">${esc(s.name)}</a>
        <span class="row"><span class="tag info" data-site-running="${esc(s.id)}" hidden>scan in corso</span>${s.configured ? '' : '<span class="tag">solo storico</span>'}${s.error ? '<span class="tag error">config non valida</span>' : ''}</span></div>
      <div class="meta mono">${esc(s.id)}</div>
      ${envs.map(([k, u]) => `<div class="meta"><b>${esc(k)}</b> · ${esc(u)}</div>`).join('')}
      <div class="meta">${s.scans ? `${fmtNum(s.scans)} scan · ultima ${esc(fmtDate(last.startedAt))} [${esc(last.env)}]${last.label ? ` <span class="tag label">${esc(last.label)}</span>` : ''}` : 'Nessuna scan'}</div>
      ${last && last.stats ? `<div class="meta">${fmtNum(last.stats.pages)} URL · <span class="sev-e">${fmtNum(last.stats.issues?.error)} errori</span> · <span class="sev-w">${fmtNum(last.stats.issues?.warn)} warning</span></div>` : ''}
      <div class="actions">
        ${s.configured && !s.error ? envs.map(([k]) => `<button class="btn small primary" data-scan="${esc(s.id)}" data-env="${esc(k)}">Scan ${esc(k)}</button>`).join('') : ''}
        <a class="btn small" href="#/site/${encodeURIComponent(s.id)}">Apri</a>
        ${s.scans ? `<a class="btn small" href="${esc(reportUrl(s.id))}" target="_blank" rel="noopener">Report ↗</a>` : ''}
      </div>
    </div>`;
  }).join('');
  app().innerHTML = `
    <div class="head"><div><h1>Siti</h1><div class="sub">Configurazioni in <span class="mono">sites/</span>, storico delle scan in <span class="mono">data/</span></div></div>
      <div class="row"><a class="btn" href="#/inventory">Nuovo inventario</a><a class="btn primary" href="#/new">+ Nuovo sito</a></div></div>
    <div data-jobs="running"></div>
    ${info.sites.length ? `<div class="cards">${cards}</div>` : '<div class="panel empty">Nessun sito configurato. <a href="#/new">Crea il primo sito</a> oppure lancia un <a href="#/inventory">inventario</a> su un URL qualsiasi.</div>'}`;
  renderJobBoxes();
}

// Site detail
async function viewSite(id, tab = 'scans') {
  const d = await api('GET', `sites/${encodeURIComponent(id)}`);
  setView('sites', {
    refresh: async (j) => {
      if (j && j.type !== 'scan') return;
      const fresh = await api('GET', `sites/${encodeURIComponent(id)}`);
      const h = $('[data-history]');
      if (h) h.innerHTML = historyTable(fresh);
    },
  });
  const tabs = [['scans', 'Scan e storico'], ...(d.raw !== null ? [['config', 'Configurazione']] : [])];
  app().innerHTML = `
    <div class="head"><div><h1>${esc(d.name)}</h1><div class="sub mono">sites/${esc(d.id)}.yml${d.configured ? '' : ' — non configurato (solo storico)'}</div></div>
      <div class="row">${d.scans ? `<a class="btn" href="${esc(reportUrl(d.id))}" target="_blank" rel="noopener">Report ↗</a>` : ''}
      <a class="btn" href="#/inventory?site=${encodeURIComponent(d.id)}">Inventario</a>
      ${d.configured ? '<button class="btn danger" id="delSite">Elimina sito…</button>' : d.scans ? '<button class="btn danger" id="delSite">Elimina storico…</button>' : ''}</div></div>
    ${d.error ? `<div class="notice error">Configurazione non valida: ${esc(d.error)}</div>` : ''}
    <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="tabBody"></div>`;
  const body = $('#tabBody');
  if (tab === 'config') renderSiteEditor(body, d);
  else renderScansTab(body, d);
  for (const b of $$('[data-tab]')) b.onclick = () => { location.hash = `#/site/${encodeURIComponent(id)}${b.dataset.tab === 'scans' ? '' : `/${b.dataset.tab}`}`; };
  const del = $('#delSite');
  if (del) del.onclick = () => deleteSiteDialog(d);
}

// Deleting a site asks explicitly what to do with its history (RF-WEB-07).
async function deleteSiteDialog(d) {
  const n = d.scans;
  const scans = `${n} scan`;
  let choices;
  if (!d.configured) {
    choices = [{ value: 'delete', label: `Cancella lo storico (${scans})`, desc: 'Scan, screenshot, testo e label vengono eliminati definitivamente e il sito sparisce da web app e report.' }];
  } else if (n) {
    choices = [
      { value: 'keep', label: `Tieni lo storico (${scans})`, desc: 'Viene eliminato solo sites/' + d.id + '.yml; il sito resta consultabile come «solo storico».' },
      { value: 'delete', label: `Cancella anche lo storico (${scans})`, desc: 'Scan, screenshot, testo e label vengono eliminati definitivamente e il sito sparisce da web app e report.' },
    ];
  } else {
    choices = [{ value: 'keep', label: 'Elimina la configurazione', desc: 'Il sito non ha scan salvate.' }];
  }
  const history = await choiceDialog({
    title: d.configured ? `Eliminare il sito «${d.name}»?` : `Eliminare lo storico di «${d.name}»?`,
    choices,
    confirm: 'Elimina',
  });
  if (!history) return;
  try {
    const r = await api('DELETE', `sites/${encodeURIComponent(d.id)}?history=${history}`);
    toast(r.scansDeleted ? `Sito eliminato con ${r.scansDeleted} scan` : r.configDeleted ? 'Configurazione eliminata, storico conservato' : 'Sito eliminato');
    location.hash = '#/';
  } catch (e) { toast(e.message, true); }
}

/**
 * Modal with mutually exclusive choices; resolves with the chosen value or null if cancelled.
 * With more than one choice nothing is preselected: confirming requires an explicit choice.
 */
function choiceDialog({ title, choices, confirm }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dialog';
    const one = choices.length === 1;
    dlg.innerHTML = `<form method="dialog">
      <h2>${esc(title)}</h2>
      ${choices.map((c) => `<label class="choice"><input type="radio" name="c" value="${esc(c.value)}"${one ? ' checked' : ''}><span><b>${esc(c.label)}</b><small>${esc(c.desc)}</small></span></label>`).join('')}
      <div class="row end"><button type="button" class="btn" data-x>Annulla</button><button class="btn danger" value="ok"${one ? '' : ' disabled'}>${esc(confirm)}</button></div>
    </form>`;
    document.body.appendChild(dlg);
    const ok = dlg.querySelector('[value="ok"]');
    dlg.addEventListener('change', () => { ok.disabled = !dlg.querySelector('input:checked'); });
    dlg.querySelector('[data-x]').onclick = () => dlg.close('');
    dlg.addEventListener('close', () => {
      const v = dlg.returnValue === 'ok' ? dlg.querySelector('input:checked')?.value || null : null;
      dlg.remove();
      resolve(v);
    });
    dlg.showModal();
  });
}

function renderScansTab(body, d) {
  const envs = d.config ? Object.keys(d.config.envs) : [];
  body.innerHTML = `
    ${d.config ? `<form class="panel" id="scanForm">
      <h2>Nuova scan</h2>
      <div class="fields">
        <label class="f"><span>Ambiente</span><select name="env">${envs.map((e) => `<option>${esc(e)}</option>`).join('')}</select></label>
        <label class="f"><span>Label</span><input type="text" name="label" placeholder="es. pre-release"></label>
        <label class="f"><span>Max pagine</span><input type="number" min="1" name="maxPages" placeholder="${esc(d.config.maxPages)}"></label>
        <label class="f wide"><span>Nota</span><input type="text" name="note"></label>
      </div>
      <div class="row" style="margin-top:10px">
        <label class="check"><input type="checkbox" name="noScreenshots" ${d.config.screenshots.enabled ? '' : 'checked disabled'}> senza screenshot</label>
        <button class="btn primary" type="submit" style="margin-left:auto">Avvia scan</button>
      </div>
    </form>` : ''}
    <div data-jobs="site:${esc(d.id)}"></div>
    <div class="panel"><h2>Storico</h2><div data-history>${historyTable(d)}</div></div>`;
  renderJobBoxes();
  const f = $('#scanForm');
  if (f) f.onsubmit = async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    try {
      await startJob({ type: 'scan', site: d.id, env: v.env, label: v.label.trim(), note: v.note.trim(), maxPages: v.maxPages || undefined, noScreenshots: !!v.noScreenshots });
      f.label.value = '';
      f.note.value = '';
    } catch (err) { toast(err.message, true); }
  };
}

function historyTable(d) {
  if (!d.history.length) return '<p class="muted">Nessuna scan: avviane una qui sopra o da CLI con <code>sitescanner scan</code>.</p>';
  const rows = d.history.map((s, i) => {
    const prev = d.history.slice(i + 1).find((x) => x.env === s.env);
    const st = s.stats || {};
    return `<tr data-scan="${esc(s.id)}">
      <td>${esc(fmtDate(s.startedAt))}<div class="muted small mono">${esc(s.id)}</div></td>
      <td><span class="tag">${esc(s.env)}</span></td>
      <td class="lbl">${s.label ? `<span class="tag label">${esc(s.label)}</span>` : ''}${s.note ? `<div class="muted small">${esc(s.note)}</div>` : ''}</td>
      <td class="num">${fmtNum(st.pages)}</td>
      <td class="num">${st.healthScore ?? '—'}</td>
      <td class="num sev-e">${fmtNum(st.issues?.error)}</td>
      <td class="num sev-w">${fmtNum(st.issues?.warn)}</td>
      <td class="num">${st.avgResponseMs == null ? '—' : `${fmtNum(st.avgResponseMs)} ms`}</td>
      <td><div class="row">
        <a class="btn small" href="${esc(reportUrl(d.id, s.id))}" target="_blank" rel="noopener" title="Issue e pagine della sola scan">Diagnostica ↗</a>
        <a class="btn small" href="/api/pdf?${esc(new URLSearchParams({ site: d.id, base: s.id }).toString())}" data-pdf title="Report di qualità della scan in PDF (richiede Playwright)">PDF</a>
        ${prev ? `<a class="btn small" href="${esc(reportUrl(d.id, prev.id, s.id))}" target="_blank" rel="noopener" title="Base: ${esc(fmtDate(prev.startedAt))}">Confronta con la precedente ↗</a>` : ''}
        <button class="btn small" data-edit-label>Label</button>
      </div></td>
    </tr>`;
  }).join('');
  return `<div class="tablewrap"><table>
    <thead><tr><th>Data</th><th>Ambiente</th><th>Label / nota</th><th class="num">URL</th><th class="num" title="Quota di pagine senza errori">Health</th><th class="num">Errori</th><th class="num">Warning</th><th class="num">Risposta media</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// PDF links: download through fetch so that a server error is shown as a toast, not saved as a file.
document.addEventListener('click', async (e) => {
  const a = e.target.closest('a[data-pdf]');
  if (!a) return;
  e.preventDefault();
  toast('Generazione del PDF…');
  try {
    const res = await fetch(a.getAttribute('href'));
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(await res.blob());
    link.download = (/filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '') || [])[1] || 'sitescanner.pdf';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    toast('PDF scaricato');
  } catch (err) {
    toast(err.message, true);
  }
});

// Inline label editor in the history table (event delegation: the table is re-rendered after scans).
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-edit-label]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const site = state.view && location.hash.match(/^#\/site\/([^/?]+)/)?.[1];
  if (!site || tr.querySelector('form')) return;
  const cell = tr.querySelector('.lbl');
  const cur = { label: cell.querySelector('.tag')?.textContent || '', note: cell.querySelector('div')?.textContent || '' };
  cell.innerHTML = `<form class="form" style="gap:6px">
    <input class="input" name="label" placeholder="label" value="${esc(cur.label)}">
    <input class="input" name="note" placeholder="nota" value="${esc(cur.note)}">
    <div class="row"><button class="btn small primary">Salva</button><button type="button" class="btn small" data-x>Annulla</button></div></form>`;
  const f = cell.querySelector('form');
  f.label.focus();
  const restore = async () => { const d = await api('GET', `sites/${site}`); $('[data-history]').innerHTML = historyTable(d); };
  f.querySelector('[data-x]').onclick = restore;
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const d = await api('PUT', `sites/${site}/scans/${encodeURIComponent(tr.dataset.scan)}`, { label: f.label.value.trim() || null, note: f.note.value.trim() || null });
      $('[data-history]').innerHTML = historyTable(d);
      toast('Label salvata');
    } catch (err) { toast(err.message, true); }
  };
});

// Site editor: form (writes only the fields it manages, keeping comments) or raw YAML.
function envRow(name = '', e = {}) {
  const auth = e.auth || {};
  return `<div class="env">
    <label class="f"><span>Ambiente</span><input type="text" data-e="name" value="${esc(name)}" placeholder="prod" required pattern="[\\w.\\-]+"></label>
    <label class="f"><span>Base URL</span><input type="url" data-e="baseUrl" value="${esc(e.baseUrl || '')}" placeholder="https://www.example.com/" required></label>
    <label class="f"><span>Utente (basic auth)</span><input type="text" data-e="user" value="${esc(auth.username || '')}" placeholder="\${STAGE_USER}"></label>
    <label class="f"><span>Password</span><input type="password" data-e="pass" value="${esc(auth.password || '')}" placeholder="\${STAGE_PASS}" autocomplete="off"></label>
    <button type="button" class="btn small danger" data-rm-env title="Rimuovi ambiente">✕</button>
  </div>`;
}

function siteForm(c, defs, isNew) {
  const num = (k, label, v = c[k], def = defs[k], name = k) => `<label class="f"><span>${label}</span><input type="number" min="0" name="${name}" value="${v ?? ''}" placeholder="${esc(def)}"></label>`;
  const chk = (k, label, v = c[k], name = k) => `<label class="check"><input type="checkbox" name="${name}" ${v ? 'checked' : ''}> ${label}</label>`;
  const area = (k, label, v, hint = '', name = k) => `<label class="f wide"><span>${label}</span><textarea name="${name}" rows="3">${esc((v || []).join('\n'))}</textarea>${hint ? `<small>${hint}</small>` : ''}</label>`;
  const sh = c.screenshots || defs.screenshots;
  const sitemapList = Array.isArray(c.sitemap) ? c.sitemap : [];
  return `<form class="form" id="siteForm" novalidate>
    <fieldset class="fs"><legend>Sito</legend><div class="fields">
      ${isNew ? '<label class="f"><span>Id (nome del file)</span><input type="text" name="id" required pattern="[\\w.\\-]+" placeholder="www.example.com"></label>' : ''}
      <label class="f"><span>Nome</span><input type="text" name="name" value="${esc(c.name || '')}"></label>
    </div></fieldset>
    <fieldset class="fs"><legend>Ambienti</legend>
      <div class="envs" id="envs">${Object.entries(c.envs || { prod: {} }).map(([k, e]) => envRow(k, e)).join('')}</div>
      <div class="row" style="margin-top:8px"><button type="button" class="btn small" id="addEnv">+ Ambiente</button>
      <small class="muted">Le credenziali possono essere variabili d'ambiente, es. <code>\${STAGE_PASS}</code>. Gli header per ambiente si modificano nel YAML.</small></div>
    </fieldset>
    <fieldset class="fs"><legend>Crawling</legend><div class="fields">
      ${num('maxPages', 'Max pagine')}${num('maxDepth', 'Max profondità')}${num('concurrency', 'Richieste parallele')}${num('delayMs', 'Pausa (ms)')}${num('timeoutMs', 'Timeout (ms)')}
      <label class="f wide"><span>User agent</span><input type="text" name="userAgent" value="${esc(c.userAgent === defs.userAgent ? '' : c.userAgent || '')}" placeholder="${esc(defs.userAgent)}"></label>
      ${area('start', 'URL di partenza (uno per riga)', c.start, 'Relativi a base URL. Vuoto = <code>/</code>.')}
      ${area('include', 'Include (regex sul path, una per riga)', c.include, 'Se presenti, vengono visitati solo i path che ne soddisfano almeno una.')}
      ${area('exclude', 'Exclude (regex sul path, una per riga)', c.exclude)}
      ${area('ignoreParams', 'Parametri di query da ignorare', c.ignoreParams, 'Oltre a quelli di tracciamento noti (utm_*, gclid, …). <code>*</code> finale = qualsiasi suffisso.')}
      ${area('sitemapUrls', 'URL di sitemap specifici (opzionale)', sitemapList, 'Vuoto = <code>/sitemap.xml</code> se la sitemap è attiva.', 'sitemapUrls')}
    </div>
    <div class="row" style="margin-top:10px;gap:16px">${chk('sitemap', 'usa la sitemap', c.sitemap !== false)}${chk('respectRobots', 'rispetta robots.txt')}${chk('ignoreQuery', 'ignora la query string')}${chk('storeText', 'salva il testo (diff testuale)')}</div>
    </fieldset>
    <fieldset class="fs"><legend>Screenshot</legend>
      <div class="row" style="margin-bottom:10px;gap:16px">${chk('enabled', 'abilitati', sh.enabled, 'sh.enabled')}${chk('fullPage', 'pagina intera', sh.fullPage, 'sh.fullPage')}</div>
      <div class="fields">
        ${num('width', 'Larghezza', sh.width, defs.screenshots.width, 'sh.width')}${num('height', 'Altezza', sh.height, defs.screenshots.height, 'sh.height')}
        ${num('maxHeight', 'Altezza massima', sh.maxHeight, defs.screenshots.maxHeight, 'sh.maxHeight')}${num('waitMs', 'Attesa (ms)', sh.waitMs, defs.screenshots.waitMs, 'sh.waitMs')}
        ${num('concurrency', 'Paralleli', sh.concurrency, defs.screenshots.concurrency, 'sh.concurrency')}
        ${area('hide', 'Selettori CSS da nascondere', sh.hide, 'Cookie banner, contenuti dinamici…', 'sh.hide')}
      </div>
    </fieldset>
    <fieldset class="fs"><legend>Confronto</legend><div class="fields">
      ${area('ignore', 'Tipi di differenza da ignorare', c.compare?.ignore, 'es. <code>content-changed</code>, <code>perf-regression</code>. Le soglie si modificano nel YAML.', 'cmp.ignore')}
    </div></fieldset>
    <fieldset class="fs"><legend>Issue di qualità</legend><div class="fields">
      ${area('qdisable', 'Issue da non calcolare', c.quality?.disable, 'Codici, uno per riga, es. <code>anchor-generic</code>, <code>url-underscore</code>. Severità e soglie si modificano nel YAML (<code>quality</code>).', 'q.disable')}
    </div></fieldset>
    <div class="formerr" id="formErr"></div>
    <div class="formbar"><button class="btn primary" type="submit">${isNew ? 'Crea sito' : 'Salva'}</button><span class="muted small">Commenti e chiavi non gestite dal form restano invariati nel file.</span></div>
  </form>`;
}

function collectForm(f) {
  const v = (n) => f.elements[n];
  const val = (n) => v(n).value.trim();
  const form = {
    name: val('name') || undefined,
    maxPages: intOrNull(val('maxPages')), maxDepth: intOrNull(val('maxDepth')), concurrency: intOrNull(val('concurrency')),
    delayMs: intOrNull(val('delayMs')), timeoutMs: intOrNull(val('timeoutMs')),
    userAgent: val('userAgent') || null,
    start: lines(v('start').value).length ? lines(v('start').value) : null,
    include: lines(v('include').value), exclude: lines(v('exclude').value), ignoreParams: lines(v('ignoreParams').value),
    sitemap: v('sitemap').checked ? (lines(v('sitemapUrls').value).length ? lines(v('sitemapUrls').value) : true) : false,
    respectRobots: v('respectRobots').checked, ignoreQuery: v('ignoreQuery').checked, storeText: v('storeText').checked,
    screenshots: {
      enabled: v('sh.enabled').checked, fullPage: v('sh.fullPage').checked,
      width: intOrNull(val('sh.width')), height: intOrNull(val('sh.height')), maxHeight: intOrNull(val('sh.maxHeight')),
      waitMs: intOrNull(val('sh.waitMs')), concurrency: intOrNull(val('sh.concurrency')), hide: lines(v('sh.hide').value),
    },
    compare: { ignore: lines(v('cmp.ignore').value) },
    quality: { disable: lines(v('q.disable').value) },
    envs: {},
  };
  for (const row of $$('.env', f)) {
    const g = (k) => row.querySelector(`[data-e="${k}"]`).value.trim();
    if (!g('name') && !g('baseUrl')) continue;
    if (!g('name') || !g('baseUrl')) throw new Error('Ogni ambiente ha bisogno di nome e base URL');
    if (form.envs[g('name')]) throw new Error(`Ambiente ripetuto: ${g('name')}`);
    form.envs[g('name')] = { baseUrl: g('baseUrl'), auth: g('user') ? { username: g('user'), password: g('pass') } : null };
  }
  if (!Object.keys(form.envs).length) throw new Error('Serve almeno un ambiente');
  return form;
}

function renderSiteEditor(body, d, isNew = false) {
  const defs = state.info?.defaults?.site || {};
  let mode = 'form';
  const draw = () => {
    body.innerHTML = `
      <div class="row" style="margin-bottom:12px"><div class="tabs" style="margin:0;border:0">
        <button data-mode="form" class="${mode === 'form' ? 'on' : ''}">Form</button><button data-mode="yaml" class="${mode === 'yaml' ? 'on' : ''}">YAML</button></div></div>
      <div id="editor"></div>`;
    const ed = $('#editor');
    if (mode === 'yaml') {
      ed.innerHTML = `<form class="form" id="yamlForm">
        ${isNew ? '<label class="f"><span>Id (nome del file)</span><input type="text" name="id" required placeholder="www.example.com" class="input"></label>' : ''}
        <textarea class="input yaml" name="raw" spellcheck="false">${esc(d.raw)}</textarea>
        <div class="formerr" id="formErr"></div>
        <div class="formbar"><button class="btn primary" type="submit">${isNew ? 'Crea sito' : 'Salva YAML'}</button><span class="muted small">Il file viene validato prima di essere scritto.</span></div></form>`;
      $('#yamlForm').onsubmit = (e) => { e.preventDefault(); save({ raw: e.target.raw.value }, e.target.id?.value); };
    } else {
      ed.innerHTML = siteForm(d.config || {}, defs, isNew);
      const f = $('#siteForm');
      $('#addEnv').onclick = () => $('#envs').insertAdjacentHTML('beforeend', envRow());
      f.addEventListener('click', (e) => { if (e.target.closest('[data-rm-env]')) e.target.closest('.env').remove(); });
      f.onsubmit = (e) => {
        e.preventDefault();
        try { save({ form: collectForm(f) }, f.elements.id?.value); } catch (err) { $('#formErr').textContent = err.message; }
      };
    }
    for (const b of $$('[data-mode]', body)) b.onclick = () => { mode = b.dataset.mode; draw(); };
  };
  const save = async (payload, newId) => {
    $('#formErr').textContent = '';
    try {
      if (isNew) {
        const id = String(newId || '').trim();
        if (!id) throw new Error("Indica l'id del sito");
        await api('POST', 'sites', { id, ...payload });
        toast('Sito creato');
        location.hash = `#/site/${encodeURIComponent(id)}`;
      } else {
        const fresh = await api('PUT', `sites/${encodeURIComponent(d.id)}`, payload);
        Object.assign(d, fresh);
        toast('Configurazione salvata');
        draw();
      }
    } catch (err) { $('#formErr').textContent = err.message; }
  };
  draw();
}

async function viewNewSite() {
  setView('sites');
  if (!state.info) state.info = await api('GET', 'state');
  const defs = state.info.defaults.site;
  const d = { raw: state.info.example, config: { ...defs, name: '', envs: { prod: { baseUrl: '' } } } };
  app().innerHTML = `<div class="head"><div><h1>Nuovo sito</h1><div class="sub">Viene creato <span class="mono">sites/&lt;id&gt;.yml</span>. Usa il form o parti dal YAML d'esempio commentato.</div></div></div><div id="tabBody"></div>`;
  renderSiteEditor($('#tabBody'), d, true);
}

// Jobs
function viewJobs() {
  setView('jobs');
  app().innerHTML = `<div class="head"><div><h1>Attività</h1><div class="sub">Scan e inventari avviati dalla web app in questa sessione (non sopravvivono al riavvio del server; i risultati sì).</div></div></div>
    <div data-jobs="all" data-empty="Nessuna attività in questa sessione."></div>`;
  renderJobBoxes();
}

async function viewJob(id) {
  setView('jobs');
  const draw = async () => {
    const j = await api('GET', `jobs/${encodeURIComponent(id)}`);
    const logEl = $('#jobLog');
    const stick = !logEl || logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 4;
    app().innerHTML = `<p><a href="#/jobs">← Attività</a></p>${jobCard(j)}
      <div class="panel"><h2>Parametri</h2><pre class="log">${esc(JSON.stringify(j.params, null, 2))}</pre></div>
      <div class="panel"><h2>Log</h2><pre class="log" id="jobLog">${esc(j.log.join('\n')) || '—'}</pre></div>`;
    const l = $('#jobLog');
    if (stick) l.scrollTop = l.scrollHeight;
  };
  let pending = false;
  const redraw = async (j) => {
    if (j.id !== id || pending) return;
    pending = true;
    try { await draw(); } finally { pending = false; }
  };
  state.view.onJob = redraw;
  state.view.refresh = redraw;
  await draw();
}

// Inventories
async function viewInventories(params) {
  setView('inventory', { refresh: (j) => { if (j.type === 'inventory') drawList(); } });
  if (!state.info) state.info = await api('GET', 'state');
  const sites = state.info.sites.filter((s) => s.configured && !s.error);
  const defs = state.info.defaults.inventory;
  const pre = params.get('site');
  app().innerHTML = `
    <div class="head"><div><h1>Inventari</h1><div class="sub">Un crawl senza screenshot e senza confronto: misura dimensione, struttura e profondità di un sito.</div></div></div>
    <form class="panel" id="invForm">
      <h2>Nuovo inventario</h2>
      <div class="row" style="gap:16px;margin-bottom:10px">
        <label class="check"><input type="radio" name="src" value="url" ${pre ? '' : 'checked'}> URL qualsiasi</label>
        <label class="check"><input type="radio" name="src" value="site" ${pre ? 'checked' : ''} ${sites.length ? '' : 'disabled'}> sito configurato</label>
      </div>
      <div class="fields">
        <label class="f wide" data-src="url"><span>URL</span><input type="url" name="url" placeholder="https://www.example.com/"></label>
        <label class="f" data-src="site"><span>Sito</span><select name="site">${sites.map((s) => `<option value="${esc(s.id)}" ${s.id === pre ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        <label class="f" data-src="site"><span>Ambiente</span><select name="env"></select></label>
        <label class="f"><span>Max URL</span><input type="number" min="1" name="maxPages" placeholder="${esc(defs.maxPages)}"></label>
        <label class="f"><span>Max profondità</span><input type="number" min="1" name="maxDepth" placeholder="${esc(defs.maxDepth)}"></label>
        <label class="f"><span>Richieste parallele</span><input type="number" min="1" name="concurrency" placeholder="4"></label>
      </div>
      <div class="row" style="margin-top:10px"><small class="muted">Con un sito configurato valgono le sue regole (include/exclude, robots, auth, sitemap); i limiti sono quelli indicati qui.</small>
        <button class="btn primary" type="submit" style="margin-left:auto">Avvia inventario</button></div>
    </form>
    <div data-jobs="inventory"></div>
    <div class="panel"><h2>Inventari salvati</h2><div id="invList"><p class="muted">Caricamento…</p></div></div>`;
  const f = $('#invForm');
  const syncSrc = () => {
    const src = f.src.value;
    for (const el of $$('[data-src]', f)) el.hidden = el.dataset.src !== src;
    const s = sites.find((x) => x.id === f.site.value);
    const cur = f.env.value;
    f.env.innerHTML = s ? Object.keys(s.envs).map((e) => `<option ${e === cur ? 'selected' : ''}>${esc(e)}</option>`).join('') : '';
  };
  f.addEventListener('change', syncSrc);
  syncSrc();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    const p = { type: 'inventory', maxPages: v.maxPages || undefined, maxDepth: v.maxDepth || undefined, concurrency: v.concurrency || undefined };
    if (v.src === 'url') p.url = v.url.trim();
    else Object.assign(p, { site: v.site, env: v.env });
    try { await startJob(p); } catch (err) { toast(err.message, true); }
  };
  renderJobBoxes();
  await drawList();
}

async function drawList() {
  const list = await api('GET', 'inventories');
  const el = $('#invList');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<p class="muted">Nessun inventario. Avviane uno qui sopra o da CLI con <code>sitescanner inventory --url …</code>.</p>';
    return;
  }
  el.innerHTML = `<div class="tablewrap"><table>
    <thead><tr><th>Data</th><th>Sito</th><th class="num">URL</th><th class="num">Pagine HTML</th><th class="num">Click max</th><th class="num">Click medio</th><th class="num">Non collegate</th><th></th></tr></thead>
    <tbody>${list.map((i) => `<tr class="click" data-open="${esc(i.id)}">
      <td>${esc(fmtDate(i.startedAt))}</td>
      <td><span class="mono">${esc(i.baseUrl)}</span>${i.site ? `<div class="muted small">${esc(i.site)} [${esc(i.env)}]</div>` : ''}${i.crawl.truncated ? ' <span class="tag warn">troncato</span>' : ''}</td>
      <td class="num">${fmtNum(i.summary.urls)}</td><td class="num">${fmtNum(i.summary.htmlPages)}</td>
      <td class="num">${fmtNum(i.summary.clickDepth.max)}</td><td class="num">${fmtNum(i.summary.clickDepth.avg)}</td><td class="num">${fmtNum(i.summary.clickDepth.notLinked)}</td>
      <td><button class="btn small danger" data-del-inv="${esc(i.id)}">Elimina</button></td></tr>`).join('')}</tbody></table></div>`;
  for (const tr of $$('[data-open]', el)) tr.onclick = (e) => { if (!e.target.closest('button')) location.hash = `#/inventory/${tr.dataset.open}`; };
  for (const b of $$('[data-del-inv]', el)) b.onclick = async () => {
    if (!confirm('Eliminare questo inventario?')) return;
    try { await api('DELETE', `inventories/${b.dataset.delInv}`); drawList(); } catch (err) { toast(err.message, true); }
  };
}

// Charts: one hue, value in the tooltip, axis labels on the edges only.
function barChart(hist, { xLabel, unit = 'pagine', highlight = null } = {}) {
  const keys = Object.keys(hist).map(Number).filter((k) => Number.isFinite(k));
  if (!keys.length) return '<p class="muted small">Nessun dato</p>';
  const xs = [];
  for (let k = Math.min(0, ...keys); k <= Math.max(...keys); k++) xs.push(k);
  const max = Math.max(...xs.map((k) => hist[k] || 0));
  const step = Math.pow(10, Math.floor(Math.log10(max || 1)));
  const top = Math.ceil(max / step) * step || 1;
  const W = 560, H = 190, L = 44, R = 8, T = 10, B = 34;
  const bw = (W - L - R) / xs.length;
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const ticks = [0, top / 2, top];
  const every = Math.ceil(xs.length / 20);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(xLabel)}">
    ${ticks.map((t) => `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${fmtNum(t)}</text>`).join('')}
    ${xs.map((k, i) => {
      const v = hist[k] || 0;
      const x = L + i * bw;
      return `<g class="${highlight === k ? 'on' : ''}"><rect class="hit" x="${x}" y="${T}" width="${bw}" height="${H - T - B}" data-tip="${esc(`${xLabel} <b>${k}</b>: <b>${fmtNum(v)}</b> ${unit}`)}"/>
        <rect class="mark" pointer-events="none" x="${x + bw * 0.12}" y="${y(v)}" width="${Math.max(1, bw * 0.76)}" height="${Math.max(0, H - B - y(v))}" rx="2"/>
        ${i % every === 0 ? `<text class="axis" x="${x + bw / 2}" y="${H - B + 14}" text-anchor="middle">${k}</text>` : ''}</g>`;
    }).join('')}
    <text class="axis" x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle">${esc(xLabel)}</text>
  </svg>`;
}

function statusStack(by) {
  const order = [['2xx', '2xx'], ['3xx', 'redirect'], ['4xx', '4xx'], ['5xx', '5xx'], ['fail', 'errori di rete']];
  const total = order.reduce((s, [k]) => s + (by[k] || 0), 0) || 1;
  const parts = order.filter(([k]) => by[k]);
  return `<div class="stack">${parts.map(([k, l]) => `<i class="s-${k}" style="flex:${by[k]}" data-tip="${esc(`${l}: <b>${fmtNum(by[k])}</b> (${Math.round((by[k] / total) * 100)}%)`)}"></i>`).join('')}</div>
    <div class="legend">${parts.map(([k, l]) => `<span><i class="s-${k}"></i>${l} <b>${fmtNum(by[k])}</b></span>`).join('')}</div>`;
}

function stat(k, v, d = '') {
  return `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div>${d ? `<div class="d">${d}</div>` : ''}</div>`;
}

function findNode(n, path) {
  if (n.path === path) return n;
  for (const c of n.children) if (path === c.path || path.startsWith(c.path + '/')) return findNode(c, path);
  return null;
}

function treeList(nodes, root = false) {
  return `<ul class="tree${root ? ' root' : ''}">${nodes.map((n) => {
    const open = state.openTree.has(n.path);
    return `<li><div class="node"><button class="tw" data-tw="${esc(n.path)}" ${n.children.length ? '' : 'disabled'} aria-label="${open ? 'chiudi' : 'apri'}">${n.children.length ? (open ? '▾' : '▸') : '·'}</button>
      <span class="nm">${esc(root ? n.path : n.name)}</span><span class="ct" title="pagine in questo ramo">${fmtNum(n.total)}${n.pages ? '' : ' · <i>nessuna pagina propria</i>'}</span></div>
      ${open && n.children.length ? treeList(n.children) : ''}</li>`;
  }).join('')}</ul>`;
}

const PAGE_FILTERS = {
  '': ['Tutti gli URL', () => true],
  html: ['Pagine HTML', (p) => p.html],
  orphan: ['Non collegate (solo sitemap)', (p) => p.html && p.clickDepth === null],
  nositemap: ['Collegate ma non in sitemap', (p) => p.html && p.clickDepth !== null && !p.inSitemap],
  errors: ['Errori e 4xx/5xx', (p) => p.error || p.status >= 400],
  redirects: ['Redirect', (p) => !!p.redirectTo],
};
const PAGE_COLS = [['key', 'URL'], ['status', 'Stato'], ['clickDepth', 'Click', true], ['urlDepth', 'Livelli URL', true], ['inlinks', 'Link entranti', true], ['outlinks', 'Link uscenti', true], ['inSitemap', 'Sitemap'], ['bytes', 'Peso', true], ['responseMs', 'ms', true]];

function pagesTable() {
  const inv = state.inv, o = state.invPages;
  const q = o.q.toLowerCase();
  const test = PAGE_FILTERS[o.filter][1];
  const rows = inv.pages.filter((p) => test(p) && (!q || p.key.toLowerCase().includes(q) || (p.title || '').toLowerCase().includes(q)));
  rows.sort((a, b) => {
    const x = a[o.sort], y = b[o.sort];
    if (x == null && y == null) return a.key.localeCompare(b.key);
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * o.dir || a.key.localeCompare(b.key);
  });
  const st = (p) => (p.error ? `<span class="tag error" title="${esc(p.error)}">ERR</span>` : `<span class="tag ${p.status >= 400 ? 'error' : p.redirectTo ? 'info' : 'ok'}">${p.status}</span>`);
  return `<div class="muted small" style="margin-bottom:6px">${fmtNum(rows.length)} risultati${rows.length > o.limit ? `, mostrati i primi ${fmtNum(o.limit)}` : ''}</div>
    <div class="tablewrap"><table>
    <thead><tr>${PAGE_COLS.map(([k, l, n]) => `<th class="sort${n ? ' num' : ''}" data-sort="${k}">${l}${o.sort === k ? (o.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead>
    <tbody>${rows.slice(0, o.limit).map((p) => `<tr>
      <td class="key"><a href="${esc(new URL(p.key, inv.baseUrl).href)}" target="_blank" rel="noopener noreferrer">${esc(p.key)}</a>${p.title ? `<div class="muted small">${esc(p.title)}</div>` : ''}${p.redirectTo ? `<div class="muted small">→ ${esc(p.redirectTo)}</div>` : ''}</td>
      <td>${st(p)}</td><td class="num">${p.clickDepth ?? '<span class="muted" title="non raggiungibile con i link dalla partenza">—</span>'}</td><td class="num">${p.urlDepth}</td>
      <td class="num">${fmtNum(p.inlinks)}</td><td class="num">${fmtNum(p.outlinks)}</td><td>${p.inSitemap ? '✓' : ''}</td>
      <td class="num">${fmtBytes(p.bytes)}</td><td class="num">${fmtNum(p.responseMs)}</td></tr>`).join('')}</tbody></table></div>
    ${rows.length > o.limit ? '<p><button class="btn small" id="morePages">Mostra altri</button></p>' : ''}`;
}

function drawPages() {
  $('#pagesBox').innerHTML = pagesTable();
  for (const th of $$('[data-sort]')) th.onclick = () => {
    const k = th.dataset.sort;
    state.invPages.dir = state.invPages.sort === k ? -state.invPages.dir : ['inlinks', 'outlinks', 'bytes', 'responseMs', 'clickDepth', 'urlDepth'].includes(k) ? -1 : 1;
    state.invPages.sort = k;
    drawPages();
  };
  const more = $('#morePages');
  if (more) more.onclick = () => { state.invPages.limit += 500; drawPages(); };
}

function drawTree() {
  const t = $('#treeBox');
  t.innerHTML = treeList([state.inv.tree], true);
  for (const b of $$('[data-tw]', t)) b.onclick = () => {
    const p = b.dataset.tw;
    if (state.openTree.has(p)) state.openTree.delete(p);
    else state.openTree.add(p);
    drawTree();
  };
}

async function viewInventory(id) {
  setView('inventory');
  const inv = state.inv = await api('GET', `inventories/${encodeURIComponent(id)}`);
  state.invPages = { q: '', filter: '', sort: 'clickDepth', dir: 1, limit: 200 };
  state.openTree = new Set(['/', ...inv.tree.children.slice(0, 1).map((c) => c.path)]);
  const s = inv.summary;
  const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—');
  const smallTable = (rows, field, label) => `<table><thead><tr><th>Pagina</th><th class="num">${label}</th></tr></thead><tbody>${rows.map((r) => `<tr><td class="key">${esc(r.key)}${r.title ? `<div class="muted small">${esc(r.title)}</div>` : ''}</td><td class="num">${fmtNum(r[field])}</td></tr>`).join('')}</tbody></table>`;
  const maxSec = Math.max(1, ...s.sections.map((x) => x.pages));
  app().innerHTML = `
    <p><a href="#/inventory">← Inventari</a></p>
    <div class="head"><div><h1 class="mono" style="font-size:18px">${esc(inv.baseUrl)}</h1>
      <div class="sub">${esc(fmtDate(inv.startedAt))} · ${fmtDur(inv.durationMs)}${inv.site ? ` · sito ${esc(inv.site)} [${esc(inv.env)}]` : ''} · limiti ${fmtNum(inv.options.maxPages)} URL, profondità ${fmtNum(inv.options.maxDepth)} · <span class="mono">${esc(inv.id)}</span></div></div>
      <div class="row"><a class="btn" href="/api/inventories/${esc(inv.id)}.csv">Scarica CSV</a></div></div>
    ${inv.crawl.truncated ? `<div class="notice warn">Inventario troncato al limite di ${fmtNum(inv.options.maxPages)} URL: ${fmtNum(inv.crawl.unvisited)} URL scoperti e non visitati. Dimensioni e profondità sono un minimo: rilancia con un limite più alto.</div>` : ''}
    <div class="stats">
      ${stat('Pagine HTML', fmtNum(s.htmlPages), `${fmtNum(s.urls)} URL visitati`)}
      ${stat('Click max', fmtNum(s.clickDepth.max), `media ${fmtNum(s.clickDepth.avg)} dalla partenza`)}
      ${stat('Livelli URL max', fmtNum(s.urlDepth.max), 'segmenti del path')}
      ${stat('Non collegate', fmtNum(s.clickDepth.notLinked), `${pct(s.clickDepth.notLinked, s.htmlPages)} delle pagine HTML`)}
      ${stat('Sezioni', fmtNum(s.sections.length), 'primo livello del path')}
      ${stat('Risposta media', s.avgResponseMs == null ? '—' : `${fmtNum(s.avgResponseMs)} ms`, `HTML totale ${fmtBytes(s.htmlBytes)}`)}
    </div>
    <div class="panel"><h3>Stato delle risposte</h3>${statusStack(s.byStatus)}</div>
    <div class="grid2">
      <div class="panel"><h2>Profondità di click</h2><p class="muted small">Numero minimo di click dalla pagina di partenza (seguendo link interni e redirect).</p>${barChart(s.clickDepth.histogram, { xLabel: 'Click dalla partenza' })}</div>
      <div class="panel"><h2>Profondità dell'URL</h2><p class="muted small">Numero di segmenti del path (<span class="mono">/a/b/c</span> = 3).</p>${barChart(s.urlDepth.histogram, { xLabel: 'Segmenti del path' })}</div>
    </div>
    <div class="grid2">
      <div class="panel"><h2>Sezioni</h2><div class="tablewrap"><table>
        <thead><tr><th>Sezione</th><th class="num">Pagine</th><th class="num">Click medio</th><th class="num">Click max</th><th class="num">Livelli max</th></tr></thead>
        <tbody>${s.sections.map((x) => `<tr><td class="key">${esc(x.section)}</td><td class="num"><span class="inbar" style="width:${Math.round((x.pages / maxSec) * 60)}px"></span>${fmtNum(x.pages)}</td>
          <td class="num">${fmtNum(x.avgClickDepth)}</td><td class="num">${fmtNum(x.maxClickDepth)}</td><td class="num">${fmtNum(x.maxUrlDepth)}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="panel"><h2>Albero degli URL</h2><div id="treeBox"></div></div>
    </div>
    <div class="grid2">
      <div class="panel"><h2>Sitemap</h2><table><tbody>
        <tr><td>URL elencati nella sitemap</td><td class="num">${fmtNum(s.sitemap.listed)}</td></tr>
        <tr><td>…di cui visitati</td><td class="num">${fmtNum(s.sitemap.crawled)}</td></tr>
        <tr><td>Pagine solo in sitemap (non collegate)</td><td class="num">${fmtNum(s.sitemap.notLinked)}</td></tr>
        <tr><td>Pagine collegate assenti dalla sitemap</td><td class="num">${fmtNum(s.sitemap.missing)}</td></tr>
        <tr><td>Link interni verso URL non visitati</td><td class="num">${fmtNum(s.linkedNotVisited)}</td></tr>
        <tr><td>Tipi di contenuto</td><td class="num small">${Object.entries(s.contentTypes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} ${fmtNum(v)}`).join('<br>')}</td></tr>
      </tbody></table></div>
      <div class="panel"><h2>Più collegate</h2><div class="tablewrap">${smallTable(s.topInlinks.slice(0, 10), 'inlinks', 'Link entranti')}</div></div>
    </div>
    <div class="panel"><h2>Più profonde</h2><div class="tablewrap">${smallTable(s.deepest.slice(0, 10), 'clickDepth', 'Click')}</div></div>
    <div class="panel"><h2>URL</h2>
      <div class="row" style="margin-bottom:10px"><input class="input" id="pq" placeholder="Filtra per URL o titolo" style="max-width:320px">
        <select class="input" id="pf" style="max-width:260px">${Object.entries(PAGE_FILTERS).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
      <div id="pagesBox"></div></div>`;
  drawTree();
  drawPages();
  let t = null;
  $('#pq').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { state.invPages.q = e.target.value.trim(); state.invPages.limit = 200; drawPages(); }, 150); };
  $('#pf').onchange = (e) => { state.invPages.filter = e.target.value; state.invPages.limit = 200; drawPages(); };
}

// ---- tooltip ----
document.addEventListener('mousemove', (e) => {
  const tip = $('#tip');
  const el = e.target.closest && e.target.closest('[data-tip]');
  if (!el) { tip.hidden = true; return; }
  tip.innerHTML = el.dataset.tip; // built with esc() by the charts
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(window.innerWidth - r.width - 8, e.clientX + 12)}px`;
  tip.style.top = `${Math.max(8, e.clientY - r.height - 10)}px`;
});

// Cancel buttons live in job cards everywhere.
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-cancel]');
  if (b) {
    b.disabled = true;
    try { onJob(await api('POST', `jobs/${b.dataset.cancel}/cancel`)); } catch (err) { toast(err.message, true); }
    return;
  }
  const s = e.target.closest('button[data-scan]');
  if (s) {
    s.disabled = true;
    try { await startJob({ type: 'scan', site: s.dataset.scan, env: s.dataset.env }); toast('Scan avviata'); } catch (err) { toast(err.message, true); }
    s.disabled = false;
  }
});

// ---- router ----
async function route() {
  const [path, query = ''] = location.hash.slice(1).split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(query);
  $('#tip').hidden = true;
  try {
    if (!parts.length) await viewSites();
    else if (parts[0] === 'new') await viewNewSite();
    else if (parts[0] === 'site' && parts[1]) {
      if (!state.info) state.info = await api('GET', 'state');
      await viewSite(parts[1], parts[2] || 'scans');
    } else if (parts[0] === 'jobs' && parts[1]) await viewJob(parts[1]);
    else if (parts[0] === 'jobs') viewJobs();
    else if (parts[0] === 'inventory' && parts[1]) await viewInventory(parts[1]);
    else if (parts[0] === 'inventory') await viewInventories(params);
    else location.hash = '#/';
  } catch (e) {
    errorView(e);
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
connectEvents();
api('GET', 'state').then((info) => {
  state.info = info;
  $('#ver').textContent = info.tool.version;
  $('#root').textContent = info.root;
}).catch(() => {});
route();
