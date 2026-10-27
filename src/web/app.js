import { comparisonsFor, COMPARISON_LABELS, NEEDS_TARGET } from '/app/assertions.js';
import { mountMapStats, mountMapViews } from '/app/mapview.js';

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
  // Multi-user mode: an expired session goes back to the login page
  if (res.status === 401 && path !== 'login') {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.hash)}`;
    return new Promise(() => {});
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, mustChangePassword: !!data.mustChangePassword });
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
  invPages: { q: '', filter: '', sort: 'clickDepth', dir: 1, limit: 200, open: new Set() },
  openTree: new Set(['/']),
};

const runningJobs = () => state.jobs.filter((j) => j.status === 'running');
const siteJobs = (site) => state.jobs.filter((j) => j.lock === `site:${site}` || (j.params && j.params.site === site));

// ---- jobs ----
const PHASE = { start: 'Avvio', robots: 'robots.txt', sitemap: 'Sitemap', crawl: 'Crawling', render: 'Rendering SPA', documents: 'Controllo documenti', screenshots: 'Screenshot', saving: 'Salvataggio', report: 'Aggiornamento report' };
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
  if (p.phase === 'screenshots' || p.phase === 'render') parts.push(`${fmtNum(p.done)} / ${fmtNum(p.limit)}`);
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
  // On Vercel jobs run in other function instances: their progress is read from the API (RF-RUN-05).
  if (state.info && state.info.polling) {
    const poll = async () => {
      try {
        const list = await api('GET', 'jobs');
        const first = !state.jobsLoaded;
        state.jobsLoaded = true;
        if (first) {
          state.jobs = list;
          renderJobBoxes();
        } else for (const j of [...list].reverse()) onJob(j);
      } catch { /* retried at the next tick */ }
      clearTimeout(state.pollTimer);
      state.pollTimer = setTimeout(poll, runningJobs().length ? 2000 : 10000);
    };
    state.pollNow = () => {
      clearTimeout(state.pollTimer);
      state.pollTimer = setTimeout(poll, 1000);
    };
    poll();
    return;
  }
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
  if (state.pollNow) state.pollNow();
  return j;
}

// ---- views ----
const app = () => $('#app');

function setView(name, extra = {}) {
  if (state.view && state.view.stop) state.view.stop();
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
  $('#root').textContent = info.root || '';
  $('#rootwrap').hidden = !info.root;
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
    <div class="head"><div><h1>Siti</h1><div class="sub">${multi() ? 'I tuoi siti: visibili solo a te' : 'Configurazioni in <span class="mono">sites/</span>, storico delle scan in <span class="mono">data/</span>'}</div></div>
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
  siteMonitors(d);
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
    <fieldset class="fs"><legend>Mappa del sito</legend><div class="fields">
      ${area('docTypes', 'Tipi di documento da elencare', c.map?.documentTypes ?? defs.map?.documentTypes, 'Estensioni, una per riga: <code>pdf</code>, <code>docx</code>, <code>xlsx</code>, <code>zip</code>… I documenti si elencano, non si visitano come pagine.', 'map.documentTypes')}
      ${area('navSel', 'Selettori CSS dei menu', c.map?.navSelectors, 'Oltre a <code>header</code>, <code>nav</code>, <code>footer</code>, <code>aside</code> e ai ruoli ARIA: le aree che contano come navigazione, es. <code>.mega-menu</code>.', 'map.navSelectors')}
      ${num('maxDocuments', 'Documenti controllati al massimo', c.map?.maxDocuments, defs.map?.maxDocuments, 'map.maxDocuments')}
      <label class="f"><span>Soglia del modello</span><input type="number" min="0.05" max="1" step="0.05" name="map.templateRatio" value="${c.map?.templateRatio ?? ''}" placeholder="${esc(defs.map?.templateRatio)}"><small>Quota di pagine oltre la quale un link è del menu quando la pagina non ha <code>nav</code>.</small></label>
    </div>
    <div class="fields" style="margin-top:10px">
      ${area('sibHosts', 'Host fratelli: solo questi', c.map?.siblingHosts, 'Vuoto = tutti i sottodomini del sito. Una pagina di confine per ogni link, i suoi link non si seguono.', 'map.siblingHosts')}
      ${area('sibExcl', 'Host fratelli da escludere', c.map?.siblingExclude, 'es. una CDN o un dominio di servizio.', 'map.siblingExclude')}
      ${num('maxSibling', 'Pagine di confine al massimo', c.map?.maxSiblingPages, defs.map?.maxSiblingPages, 'map.maxSiblingPages')}
      ${num('maxRendered', 'Pagine renderizzate al massimo', c.map?.maxRendered, defs.map?.maxRendered, 'map.maxRendered')}
    </div>
    <div class="row" style="margin-top:10px;gap:16px">${chk('checkDocuments', 'controlla i documenti (richiesta HEAD: stato, tipo e peso)', c.map?.checkDocuments, 'map.checkDocuments')}${chk('siblings', 'visita le pagine di confine degli host fratelli', c.map?.siblings ?? true, 'map.siblings')}${chk('renderSpa', 'apri col browser le pagine che si generano nel browser (SPA)', (c.map?.render ?? 'auto') === 'auto', 'map.render')}</div>
    </fieldset>
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
    map: {
      documentTypes: lines(v('map.documentTypes').value).map((x) => x.toLowerCase()), navSelectors: lines(v('map.navSelectors').value),
      maxDocuments: intOrNull(val('map.maxDocuments')), templateRatio: val('map.templateRatio') === '' ? null : Number(val('map.templateRatio')),
      checkDocuments: v('map.checkDocuments').checked,
      siblings: v('map.siblings').checked, render: v('map.render').checked ? 'auto' : 'never',
      siblingHosts: lines(v('map.siblingHosts').value), siblingExclude: lines(v('map.siblingExclude').value),
      maxSiblingPages: intOrNull(val('map.maxSiblingPages')), maxRendered: intOrNull(val('map.maxRendered')),
    },
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
        <label class="check" data-src="site"><input type="checkbox" name="importNotes"> importa le note dell'inventario precedente dello stesso sito</label>
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
    else Object.assign(p, { site: v.site, env: v.env, importNotes: v.importNotes ? true : undefined });
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
  siblings: ['Host fratelli (altri sottodomini)', (p) => !!p.boundary],
  redirects: ['Redirect', (p) => !!p.redirectTo],
};
const PAGE_COLS = [['key', 'URL'], ['status', 'Stato'], ['clickDepth', 'Click', true], ['urlDepth', 'Livelli URL', true], ['inlinks', 'Link entranti', true], ['outlinks', 'Link uscenti', true], ['inSitemap', 'Sitemap'], ['bytes', 'Peso', true], ['responseMs', 'ms', true]];

// Who links to a page (RF-INV-17): always shown, a few at a time, for pages that do not load; for the others on demand.
// a page of a sibling host is stored with the path only: its address is on its own host
const pageUrl = (p) => (p.boundary && p.host ? `${new URL(state.inv.baseUrl).protocol}//${p.host}${p.key}` : new URL(p.key, state.inv.baseUrl).href);
const isBroken = (p) => !!p.error || p.status >= 400;
function referrersOf(p, o) {
  const from = p.linkedFrom || [];
  const open = o.open.has(p.key);
  if (!from.length) return isBroken(p) ? '<div class="muted small">Linkata da: nessuna pagina (solo sitemap o URL di partenza)</div>' : '';
  if (!open && !isBroken(p)) return '';
  const shown = open ? from : from.slice(0, 3);
  const more = p.inlinks - shown.length;
  return `<div class="muted small refs">Linkata da: ${shown.map((k) => `<a href="${esc(new URL(k, state.inv.baseUrl).href)}" target="_blank" rel="noopener noreferrer">${esc(k)}</a>`).join(', ')}${more > 0 ? ` <button class="linkbtn" data-refs="${esc(p.key)}">${open ? 'altre ' : '… altre '}${fmtNum(more)}</button>` : ''}</div>`;
}

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
      <td class="key"><a href="${esc(pageUrl(p))}" target="_blank" rel="noopener noreferrer">${esc(p.key)}</a>${p.boundary ? ` <span class="tag info" title="Pagina di un altro host del sito, trovata da un link: non se ne seguono i link">host fratello</span><div class="muted small">Su <strong>${esc(p.host)}</strong>, non sull'host principale: trovata da un link del sito</div>` : ''}${p.title ? `<div class="muted small">${esc(p.title)}</div>` : ''}${p.redirectTo ? `<div class="muted small">→ ${esc(p.redirectTo)}</div>` : ''}${referrersOf(p, o)}</td>
      <td>${st(p)}</td><td class="num">${p.clickDepth ?? '<span class="muted" title="non raggiungibile con i link dalla partenza">—</span>'}</td><td class="num">${p.urlDepth}</td>
      <td class="num">${p.linkedFrom && p.linkedFrom.length ? `<button class="linkbtn" data-refs="${esc(p.key)}" aria-expanded="${o.open.has(p.key)}" title="Mostra chi linka questa pagina">${fmtNum(p.inlinks)}</button>` : fmtNum(p.inlinks)}</td><td class="num">${fmtNum(p.outlinks)}</td><td>${p.inSitemap ? '✓' : ''}</td>
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
  for (const b of $$('[data-refs]')) b.onclick = () => {
    const open = state.invPages.open;
    if (!open.delete(b.dataset.refs)) open.add(b.dataset.refs);
    drawPages();
  };
  const more = $('#morePages');
  if (more) more.onclick = () => { state.invPages.limit += 500; drawPages(); };
}

// the exports of the map (RF-MAP-175): files served by the API
function exportLinks(id) {
  const f = [['csv', 'CSV (Excel)'], ['json', 'JSON'], ['md', 'Markdown'], ['zip', 'Bundle offline'], ['pdf', 'PDF']];
  return `<span class="row" aria-label="Esporta la mappa"><span class="muted small">Esporta la mappa</span>${f.map(([e, l]) => `<a class="btn small" href="/api/inventories/${encodeURIComponent(id)}/map.${e}" download>${l}</a>`).join('')}</span>`;
}

function mapTabs(id, tab) {
  return `<nav class="tabs" aria-label="Viste dell'inventario">${MAP_TABS.map(([k, l]) => `<a class="tab${k === tab ? ' on' : ''}" href="#/inventory/${encodeURIComponent(id)}?tab=${k}" ${k === tab ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>`;
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

const configuredSites = () => ((state.info && state.info.sites) || []).filter((x) => x.configured).map((x) => x.id);
const MAP_TABS = [['overview', 'Panoramica'], ['graph', 'Grafo'], ['tree', 'Albero'], ['catalog', 'Catalogo'], ['redirects', 'Redirect ed ecosistema']];

async function viewInventory(id, params = new URLSearchParams()) {
  setView('inventory');
  const inv = state.inv = await api('GET', `inventories/${encodeURIComponent(id)}`);
  const tab = MAP_TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'overview';
  if (tab !== 'overview') {
    app().innerHTML = `
      <p><a href="#/inventory">← Inventari</a></p>
      <div class="head"><div><h1 class="mono" style="font-size:18px">${esc(inv.baseUrl)}</h1>
        <div class="sub">${esc(fmtDate(inv.startedAt))} · <span class="mono">${esc(inv.id)}</span></div></div></div>
      <div class="row" style="margin-bottom:10px">${exportLinks(inv.id)}</div>
      ${mapTabs(inv.id, tab)}<div id="mapRoot"><p class="muted">Caricamento della mappa…</p></div>`;
    await mountMapViews({ root: $('#mapRoot'), id: inv.id, tab, params, api, esc, fmtNum, site: inv.site, sites: configuredSites() });
    return;
  }
  state.invPages = { q: '', filter: '', sort: 'clickDepth', dir: 1, limit: 200, open: new Set() };
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
    <div class="row" style="margin-bottom:10px">${exportLinks(inv.id)}</div>
    ${mapTabs(inv.id, 'overview')}
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
      <div id="pagesBox"></div></div>
    <div id="mapStats"></div>`;
  mountMapStats({ root: $('#mapStats'), id: inv.id, api, esc, fmtNum, sites: configuredSites() });
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


// ---- accounts (multi-user mode, spec §10) ----
const multi = () => !!(state.info && state.info.mode === 'multi');
const me = () => (state.info && state.info.user) || null;
const ROLE = { admin: 'Admin', user: 'Utente' };

// ---- Workspaces, members and API tokens (spec §13.10) ----
const ROLE_LABEL = { owner: 'Proprietario', editor: 'Editor', viewer: 'Lettore' };

async function viewWorkspaces() {
  const d = await api('GET', 'workspaces');
  state.workspaces = d;
  setView('workspaces');
  const rows = [];
  for (const w of d.workspaces) {
    const members = w.kind === 'shared' ? await api('GET', `workspaces/${w.id}/members`) : [];
    const tokens = w.role === 'owner' ? await api('GET', `workspaces/${w.id}/tokens`).catch(() => []) : [];
    rows.push({ w, members, tokens });
  }
  app().innerHTML = `
    <div class="head"><div><h1>Spazi di lavoro</h1><div class="sub">Uno spazio contiene siti, scan, inventari, monitor, canali e variabili. Il tuo spazio personale è tuo; in uno condiviso si lavora in più persone, con un ruolo: <b>proprietario</b> (gestisce membri e token), <b>editor</b> (crea e modifica tutto), <b>lettore</b> (guarda e annota gli incidenti).</div></div>
      <div class="row"><button class="btn primary" id="wsNew">+ Nuovo spazio condiviso</button></div></div>
    ${rows.map(({ w, members, tokens }) => `<div class="panel" data-ws="${esc(w.id)}">
      <div class="row between"><div><h2>${esc(w.name)} ${w.id === d.current ? '<span class="tag ok">in uso</span>' : ''}</h2><div class="small muted">${w.kind === 'personal' ? 'Spazio personale' : `Spazio condiviso · tu sei ${ROLE_LABEL[w.role].toLowerCase()}`}</div></div>
        <div class="row">${w.id === d.current ? '' : `<button class="btn small" data-wsopen="${esc(w.id)}">Usa questo spazio</button>`}
        ${w.kind === 'shared' && w.role === 'owner' ? `<button class="btn small" data-wsrename="${esc(w.id)}">Rinomina</button><button class="btn small danger" data-wsdel="${esc(w.id)}">Elimina…</button>` : ''}
        ${w.kind === 'shared' && w.role !== 'owner' ? `<button class="btn small" data-wsleave="${esc(w.id)}">Esci dallo spazio</button>` : ''}</div></div>
      ${w.kind === 'shared' ? `<h3>Membri</h3><div class="tablewrap"><table><thead><tr><th>Account</th><th>Ruolo</th><th></th></tr></thead><tbody>${members.map((m) => `<tr><td><b>${esc(m.username)}</b>${m.name ? ` <span class="muted">${esc(m.name)}</span>` : ''}${m.you ? ' <span class="tag">tu</span>' : ''}${m.active ? '' : ' <span class="tag warn">disattivato</span>'}</td>
        <td>${w.role === 'owner' ? `<select data-mrole="${esc(m.userId)}" aria-label="Ruolo">${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}"${m.role === k ? ' selected' : ''}>${l}</option>`).join('')}</select>` : esc(ROLE_LABEL[m.role])}</td>
        <td>${w.role === 'owner' && !m.you ? `<button class="btn small danger" data-mdel="${esc(m.userId)}">Togli</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
        ${w.role === 'owner' ? `<form class="row inviteform" data-invite="${esc(w.id)}"><input class="input" name="username" placeholder="username dell'account" required aria-label="Username"><select name="role" aria-label="Ruolo">${Object.entries(ROLE_LABEL).filter(([k]) => k !== 'owner').map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}<option value="owner">Proprietario</option></select><button class="btn">Invita</button><span class="small muted">Gli account li crea l'admin: qui si invitano quelli che esistono già.</span></form>` : ''}` : ''}
      ${w.role === 'owner' ? `<h3>Token API</h3><p class="small muted">Per la CI e il «monitoring as code»: si mostrano una volta sola e si salvano come impronta. Un token di <b>lettura</b> legge, uno di <b>scrittura</b> legge e scrive; nessuno gestisce membri o token.</p>
        ${tokens.length ? `<div class="tablewrap"><table><thead><tr><th>Nome</th><th>Permesso</th><th>Inizio</th><th>Scade</th><th>Ultimo uso</th><th></th></tr></thead><tbody>${tokens.map((t) => `<tr><td><b>${esc(t.name)}</b><div class="small muted">creato da ${esc(t.createdBy || '—')} il ${esc(fmtDate(t.createdAt))}</div></td><td>${t.scope === 'write' ? 'lettura e scrittura' : 'sola lettura'}</td><td class="mono small">${esc(t.prefix)}…</td><td class="small">${t.expiresAt ? esc(fmtDate(t.expiresAt)) : 'mai'}</td><td class="small">${t.lastUsedAt ? esc(fmtDate(t.lastUsedAt)) : 'mai'}</td><td><button class="btn small danger" data-tdel="${esc(t.id)}">Revoca</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted small">Nessun token.</p>'}
        <div class="row"><button class="btn small" data-tnew="${esc(w.id)}">+ Nuovo token</button></div>` : ''}</div>`).join('')}`;

  const reload = () => viewWorkspaces();
  const wsOf = (el) => el.closest('[data-ws]').dataset.ws;
  $('#wsNew').onclick = async () => {
    const fd = await formDialog({
      title: 'Nuovo spazio condiviso', confirm: 'Crea', body: '<label class="f"><span>Nome</span><input type="text" name="name" required minlength="2" maxlength="60" placeholder="Agenzia Rossi"></label><p class="small muted">Ne diventi il proprietario; poi inviti i colleghi.</p>',
      submit: async (f) => { await api('POST', 'workspaces', { name: f.get('name') }); },
    });
    if (fd) { toast('Spazio creato'); reload(); }
  };
  for (const b of $$('[data-wsopen]')) b.onclick = () => selectWorkspace(b.dataset.wsopen);
  for (const b of $$('[data-wsrename]')) b.onclick = async () => {
    const w = d.workspaces.find((x) => x.id === b.dataset.wsrename);
    const fd = await formDialog({ title: 'Rinomina lo spazio', body: `<label class="f"><span>Nome</span><input type="text" name="name" required minlength="2" maxlength="60" value="${esc(w.name)}"></label>`, submit: async (f) => { await api('PUT', `workspaces/${w.id}`, { name: f.get('name') }); } });
    if (fd) reload();
  };
  for (const b of $$('[data-wsdel]')) b.onclick = async () => {
    const w = d.workspaces.find((x) => x.id === b.dataset.wsdel);
    const ok = await formDialog({ title: `Eliminare «${w.name}»?`, body: '<p>Si cancellano per tutti i membri i siti, le scansioni, gli inventari, i monitor, i canali e le variabili dello spazio. Non si può annullare.</p>', confirm: 'Elimina tutto', danger: true, submit: async () => { await api('DELETE', `workspaces/${w.id}`); } });
    if (ok) { toast('Spazio eliminato'); if (w.id === d.current) { await api('POST', 'workspaces/select', { id: d.workspaces[0].id }); location.reload(); } else reload(); }
  };
  for (const b of $$('[data-wsleave]')) b.onclick = async () => {
    const w = d.workspaces.find((x) => x.id === b.dataset.wsleave);
    const ok = await formDialog({ title: `Uscire da «${w.name}»?`, body: '<p>Non lo vedrai più, finché un proprietario non ti invita di nuovo.</p>', confirm: 'Esci', danger: true, submit: async () => { await api('DELETE', `workspaces/${w.id}/members/${me().id}`); } });
    if (ok) { if (w.id === d.current) location.reload(); else reload(); }
  };
  for (const f of $$('[data-invite]')) f.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    try { await api('POST', `workspaces/${f.dataset.invite}/members`, { username: fd.get('username'), role: fd.get('role') }); toast('Membro aggiunto'); reload(); } catch (x) { toast(x.message, true); }
  };
  for (const s of $$('[data-mrole]')) s.onchange = async () => {
    try { await api('PUT', `workspaces/${wsOf(s)}/members/${s.dataset.mrole}`, { role: s.value }); toast('Ruolo cambiato'); } catch (x) { toast(x.message, true); reload(); }
  };
  for (const b of $$('[data-mdel]')) b.onclick = async () => { try { await api('DELETE', `workspaces/${wsOf(b)}/members/${b.dataset.mdel}`); reload(); } catch (x) { toast(x.message, true); } };
  for (const b of $$('[data-tnew]')) b.onclick = async () => {
    let made = null;
    const fd = await formDialog({
      title: 'Nuovo token API', confirm: 'Crea il token',
      body: `<label class="f"><span>Nome</span><input type="text" name="name" required minlength="2" maxlength="60" placeholder="GitHub Actions"></label>
        <label class="f"><span>Permesso</span><select name="scope"><option value="read">Sola lettura</option><option value="write">Lettura e scrittura</option></select></label>
        <label class="f"><span>Scade dopo (giorni, vuoto = mai)</span><input type="number" name="days" min="1" max="3650" value="90"></label>`,
      submit: async (f) => { made = await api('POST', `workspaces/${b.dataset.tnew}/tokens`, { name: f.get('name'), scope: f.get('scope'), expiresInDays: f.get('days') || null }); },
    });
    if (fd && made) { showSecret('Token creato', 'Copialo ora e mettilo nei segreti della tua CI.', made.token, 'Non verrà più mostrato: se lo perdi, revocalo e creane un altro.'); reload(); }
  };
  for (const b of $$('[data-tdel]')) b.onclick = async () => {
    const ok = await formDialog({ title: 'Revocare il token?', body: '<p>Chi lo usa (la CI) smette di funzionare subito.</p>', confirm: 'Revoca', danger: true, submit: async () => { await api('DELETE', `workspaces/${wsOf(b)}/tokens/${b.dataset.tdel}`); } });
    if (ok) reload();
  };
}

async function selectWorkspace(id) {
  try {
    await api('POST', 'workspaces/select', { id });
    location.hash = '#/';
    location.reload();
  } catch (e) { toast(e.message, true); }
}

function renderAccount() {
  const u = me();
  $('#account').hidden = !u;
  $('[data-nav="users"]').hidden = !(u && u.role === 'admin');
  if (!u) return;
  const ws = state.info && state.info.workspace;
  // RF-TEAM-01: the selector of the workspace, with the role when it is not the personal one
  $('#account').innerHTML = `${ws ? `<select id="wsSel" class="wssel" aria-label="Spazio di lavoro"><option value="${esc(ws.id)}" selected>${esc(ws.name)}</option>${(state.workspaces ? state.workspaces.workspaces : []).filter((w) => w.id !== ws.id).map((w) => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('')}<option value="__manage">Gestisci gli spazi…</option></select>${ws.kind === 'shared' ? `<span class="tag ${ws.role === 'viewer' ? 'warn' : ''}">${esc(ROLE_LABEL[ws.role])}</span>` : ''}` : ''}<a href="#/profile" data-nav="profile">${esc(u.name || u.username)}</a><button class="btn small" id="logout">Esci</button>`;
  document.body.classList.toggle('readonly', !!ws && ws.role === 'viewer');
  const sel = $('#wsSel');
  if (sel) {
    // the others are loaded when the selector is opened, so that opening the app costs nothing more
    const load = async () => {
      if (state.workspaces) return;
      state.workspaces = await api('GET', 'workspaces').catch(() => null);
      if (state.workspaces) renderAccount();
    };
    sel.addEventListener('focus', load);
    sel.addEventListener('mousedown', load);
    sel.onchange = () => (sel.value === '__manage' ? (location.hash = '#/workspaces', renderAccount()) : selectWorkspace(sel.value));
  }
  $('#logout').onclick = async () => {
    await api('POST', 'logout', {}).catch(() => {});
    location.href = '/login';
  };
}

/** Modal form; resolves with the FormData on submit, null if cancelled. `check(fd)` returns an error or null. */
function formDialog({ title, body, confirm = 'Salva', danger = false, cancel = true, check = null, submit = null, setup = null }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dialog';
    dlg.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>${body}<p class="formerr" data-err hidden></p>
      <div class="row end">${cancel ? '<button type="button" class="btn" data-x>Annulla</button>' : ''}<button class="btn ${danger ? 'danger' : 'primary'}" value="ok">${esc(confirm)}</button></div></form>`;
    document.body.appendChild(dlg);
    const form = dlg.querySelector('form');
    const err = dlg.querySelector('[data-err]');
    if (setup) setup(dlg, form);
    if (cancel) dlg.querySelector('[data-x]').onclick = () => dlg.close('');
    else dlg.addEventListener('cancel', (e) => e.preventDefault());
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const problem = check ? check(fd) : null;
      if (problem) {
        err.textContent = problem;
        err.hidden = false;
        return;
      }
      if (submit) {
        try {
          await submit(fd);
        } catch (x) {
          err.textContent = x.message;
          err.hidden = false;
          return;
        }
      }
      dlg.remove();
      resolve(fd);
    });
    dlg.addEventListener('close', () => {
      if (dlg.isConnected) {
        dlg.remove();
        resolve(null);
      }
    });
    dlg.showModal();
  });
}

const passwordFields = (current) => `
  ${current ? '<label class="f"><span>Password attuale</span><input type="password" name="current" autocomplete="current-password" required></label>' : ''}
  <label class="f"><span>Nuova password</span><input type="password" name="password" autocomplete="new-password" minlength="12" maxlength="128" required><small>Da 12 a 128 caratteri. Una frase lunga è più sicura di una parola complicata.</small></label>
  <label class="f"><span>Ripeti la nuova password</span><input type="password" name="password2" autocomplete="new-password" required></label>`;
const samePasswords = (fd) => (fd.get('password') !== fd.get('password2') ? 'Le due password non coincidono' : null);

/** RF-USR-05: a temporary password must be changed before using the app. */
async function forcePasswordChange() {
  await formDialog({
    title: 'Scegli una nuova password',
    body: '<p>La password che stai usando è temporanea: prima di continuare scegline una tua.</p>' + passwordFields(true),
    confirm: 'Cambia password',
    cancel: false,
    check: samePasswords,
    submit: (fd) => api('PUT', 'me/password', { current: fd.get('current'), password: fd.get('password') }),
  });
  location.reload();
}

/** Shows a generated password once (RF-ADM-01). */
function showSecret(title, text, password, note = "Non verrà più mostrata: comunicala all'utente in modo sicuro. Al primo accesso dovrà cambiarla.") {
  return formDialog({
    title,
    body: `<p>${esc(text)}</p><div class="secret">${esc(password)}</div><p class="small muted">${esc(note)}</p>
      <div class="row"><button type="button" class="btn small" data-copy>Copia</button></div>`,
    confirm: 'Fatto',
    cancel: false,
  }).then(() => {});
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const s = b.closest('form').querySelector('.secret');
  navigator.clipboard.writeText(s.textContent).then(() => { b.textContent = 'Copiata'; }, () => {});
});

async function viewProfile() {
  setView('profile', { refresh: () => viewProfile() });
  const { user, sessions } = await api('GET', 'me');
  app().innerHTML = `
    <div class="head"><div><h1>Profilo</h1><div class="sub mono">${esc(user.username)} · ${esc(ROLE[user.role])}</div></div></div>
    <div class="grid2">
      <form class="card form" id="pname"><h2>Nome visualizzato</h2>
        <label class="f"><span>Nome</span><input type="text" name="name" maxlength="80" value="${esc(user.name)}"></label>
        <div class="row"><button class="btn primary">Salva</button></div></form>
      <form class="card form" id="ppass"><h2>Password</h2>${passwordFields(true)}<p class="formerr" data-err hidden></p>
        <div class="row"><button class="btn primary">Cambia password</button></div></form>
      <div class="card"><h2>Sessioni</h2><p>Sessioni attive: <b>${fmtNum(sessions)}</b> (questo browser compreso).</p>
        <div class="row"><button class="btn danger" id="pall">Esci da tutti i dispositivi</button></div></div>
    </div>`;
  $('#pname').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('PUT', 'me', { name: e.target.name.value });
      state.info.user = r.user;
      renderAccount();
      toast('Nome salvato');
    } catch (x) { toast(x.message, true); }
  };
  $('#ppass').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const err = $('[data-err]', e.target);
    const problem = samePasswords(fd);
    err.hidden = !problem;
    err.textContent = problem || '';
    if (problem) return;
    try {
      await api('PUT', 'me/password', { current: fd.get('current'), password: fd.get('password') });
      e.target.reset();
      toast('Password cambiata: le altre sessioni sono state chiuse');
      viewProfile();
    } catch (x) {
      err.textContent = x.message;
      err.hidden = false;
    }
  };
  $('#pall').onclick = async () => {
    const ok = await formDialog({ title: 'Uscire da tutti i dispositivi?', body: '<p>Tutte le sessioni, compresa questa, vengono chiuse: dovrai accedere di nuovo.</p>', confirm: 'Esci ovunque', danger: true });
    if (!ok) return;
    await api('POST', 'logout-all', {});
    location.href = '/login';
  };
}

const AUDIT = {
  login: 'Accesso', 'login-failed': 'Accesso fallito', 'login-blocked': 'Accesso bloccato (troppi tentativi)', 'logout-all': 'Uscita da tutti i dispositivi',
  'password-changed': 'Password cambiata', 'password-reset': 'Password reimpostata', 'user-created': 'Utente creato', 'user-deleted': 'Utente eliminato',
  'user-disabled': 'Utente disattivato', 'user-enabled': 'Utente riattivato', 'role-changed': 'Ruolo cambiato',
};

async function viewUsers() {
  setView('users', { refresh: () => viewUsers() });
  const [users, audit] = await Promise.all([api('GET', 'users'), api('GET', 'audit')]);
  const self = me();
  const rows = users.map((u) => `<tr>
      <td><b class="mono">${esc(u.username)}</b>${u.name ? `<div class="small muted">${esc(u.name)}</div>` : ''}</td>
      <td>${esc(ROLE[u.role])}</td>
      <td>${u.active ? '<span class="tag ok">attivo</span>' : '<span class="tag">disattivato</span>'}${u.mustChangePassword ? ' <span class="tag warn">password temporanea</span>' : ''}</td>
      <td class="num">${fmtNum(u.sites)}</td><td class="num">${fmtNum(u.scans)}</td>
      <td>${u.lastLoginAt ? esc(fmtDate(u.lastLoginAt)) : '<span class="muted">mai</span>'}</td>
      <td><div class="row">
        <button class="btn small" data-reset="${esc(u.username)}">Reimposta password</button>
        <button class="btn small" data-role="${esc(u.username)}" data-to="${u.role === 'admin' ? 'user' : 'admin'}">${u.role === 'admin' ? 'Rendi utente' : 'Rendi admin'}</button>
        <button class="btn small" data-active="${esc(u.username)}" data-to="${u.active ? 'false' : 'true'}">${u.active ? 'Disattiva' : 'Riattiva'}</button>
        ${u.username === self.username ? '' : `<button class="btn small danger" data-del="${esc(u.username)}" data-sites="${u.sites}" data-scans="${u.scans}">Elimina…</button>`}
      </div></td></tr>`).join('');
  app().innerHTML = `
    ${(state.info.warnings || []).map((w) => `<div class="notice warn">${esc(w)}</div>`).join('')}
    <div class="head"><div><h1>Utenti</h1><div class="sub">Gli admin gestiscono gli account; i siti di ogni utente restano privati.</div></div>
      <div class="row"><button class="btn primary" id="unew">+ Nuovo utente</button></div></div>
    <div class="panel tablewrap"><table><thead><tr><th>Utente</th><th>Ruolo</th><th>Stato</th><th class="num">Siti</th><th class="num">Scan</th><th>Ultimo accesso</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <h2 style="margin-top:24px">Registro di accesso</h2>
    <div class="panel tablewrap"><table><thead><tr><th>Data</th><th>Azione</th><th>Autore</th><th>Utente</th><th>IP</th></tr></thead><tbody>
      ${audit.map((a) => `<tr><td>${esc(fmtDate(a.at))}</td><td>${esc(AUDIT[a.action] || a.action)}${a.detail ? ` <span class="muted small">${esc(a.detail)}</span>` : ''}</td><td class="mono">${esc(a.actor || '—')}</td><td class="mono">${esc(a.target || '')}</td><td class="mono small">${esc(a.ip || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nessuna voce</td></tr>'}
    </tbody></table></div>`;

  $('#unew').onclick = async () => {
    let created = null;
    const fd = await formDialog({
      title: 'Nuovo utente',
      body: `<label class="f"><span>Username</span><input type="text" name="username" required pattern="[a-z0-9][a-z0-9._\\-]{2,31}" autocapitalize="none" spellcheck="false"><small>3–32 caratteri: a-z, 0-9, ".", "_", "-". Non si può cambiare.</small></label>
        <label class="f"><span>Nome visualizzato</span><input type="text" name="name" maxlength="80"></label>
        <label class="f"><span>Ruolo</span><select name="role"><option value="user">Utente</option><option value="admin">Admin</option></select></label>
        <label class="f"><span>Password iniziale</span><input type="password" name="password" autocomplete="new-password"><small>Vuota: ne viene generata una. In ogni caso è temporanea.</small></label>`,
      confirm: 'Crea',
      submit: async (f) => { created = await api('POST', 'users', { username: f.get('username').trim().toLowerCase(), name: f.get('name'), role: f.get('role'), password: f.get('password') || null }); },
    });
    if (!fd) return;
    if (created.password) await showSecret('Utente creato', `Password temporanea di ${created.user.username}:`, created.password);
    else toast('Utente creato');
    viewUsers();
  };
  for (const b of $$('[data-reset]')) b.onclick = async () => {
    const name = b.dataset.reset;
    const ok = await formDialog({ title: `Reimpostare la password di ${name}?`, body: '<p>Viene generata una password temporanea e tutte le sessioni dell\'utente vengono chiuse.</p>', confirm: 'Reimposta' });
    if (!ok) return;
    try {
      const r = await api('POST', `users/${encodeURIComponent(name)}/reset-password`, {});
      await showSecret('Password reimpostata', `Nuova password temporanea di ${name}:`, r.password);
      viewUsers();
    } catch (x) { toast(x.message, true); }
  };
  for (const b of $$('[data-role]')) b.onclick = async () => {
    try {
      await api('PUT', `users/${encodeURIComponent(b.dataset.role)}`, { role: b.dataset.to });
      toast('Ruolo cambiato');
      viewUsers();
    } catch (x) { toast(x.message, true); }
  };
  for (const b of $$('[data-active]')) b.onclick = async () => {
    const enable = b.dataset.to === 'true';
    if (!enable) {
      const ok = await formDialog({ title: `Disattivare ${b.dataset.active}?`, body: '<p>L\'utente non potrà più accedere e le sue sessioni vengono chiuse; i job in corso vengono annullati. I suoi dati restano.</p>', confirm: 'Disattiva', danger: true });
      if (!ok) return;
    }
    try {
      await api('PUT', `users/${encodeURIComponent(b.dataset.active)}`, { active: enable });
      toast(enable ? 'Utente riattivato' : 'Utente disattivato');
      viewUsers();
    } catch (x) { toast(x.message, true); }
  };
  for (const b of $$('[data-del]')) b.onclick = async () => {
    const name = b.dataset.del;
    const fd = await formDialog({
      title: `Eliminare l'utente ${name}?`,
      body: `<p>Vengono cancellati definitivamente l'account e <b>tutta la sua area</b>: ${fmtNum(b.dataset.sites)} siti e ${fmtNum(b.dataset.scans)} scan, con screenshot, label e inventari.</p>
        <label class="f"><span>Per confermare scrivi lo username</span><input type="text" name="confirm" autocomplete="off" required></label>`,
      confirm: 'Elimina definitivamente',
      danger: true,
      check: (f) => (f.get('confirm').trim() !== name ? 'Lo username non coincide' : null),
      submit: () => api('DELETE', `users/${encodeURIComponent(name)}`),
    });
    if (!fd) return;
    toast(`Utente ${name} eliminato`);
    viewUsers();
  };
}

// ---- monitoring (spec §12) ----
const MSTATUS = { unconfigured: ['non configurato', 'warn'], up: ['su', 'ok'], degraded: ['degradato', 'warn'], down: ['giù', 'error'], paused: ['in pausa', ''], maintenance: ['in manutenzione', 'info'], pending: ['in attesa', ''] };
const HEALTH = { buona: 'ok', attenzione: 'warn', critica: 'error' };
const monitoringOn = () => !!(state.info && state.info.monitoring);
const pct = (p) => (p == null ? '—' : `${p.toFixed(2).replace('.', ',')}%`);
const dur = (ms) => {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `${Math.floor(h / 24)} g${h % 24 ? ` ${h % 24} h` : ''}`;
};
const mstatusTag = (s, muted = false) => `<span class="tag ${(MSTATUS[s] || MSTATUS.pending)[1]}">${(MSTATUS[s] || MSTATUS.pending)[0]}</span>${muted ? ' <span class="tag" data-tip="Gli avvisi di questo monitor sono silenziati: i controlli e gli incidenti continuano">🔕 silenziato</span>' : ''}`;
const healthTag = (h) => `<span class="tag ${HEALTH[h.level]}" data-tip="${esc(h.reasons.length ? h.reasons.join('<br>') : 'Nessun problema negli ultimi 30 giorni')}">${h.level}</span>`;
const pctClass = (p) => (p == null ? 'none' : p >= 99.9 ? 'good' : p >= 99 ? 'mid' : 'bad');

// 90 days as bars, one per day (RF-KPI-02)
function bars90(days, now) {
  const map = new Map(days.map((d) => [d.t, d.pct]));
  const start = Math.floor(now / 864e5) * 864e5 - 89 * 864e5;
  const cells = [];
  for (let i = 0; i < 90; i++) {
    const t = start + i * 864e5;
    const p = map.get(t);
    cells.push(`<rect x="${i * 3}" y="0" width="2" height="18" class="u-${pctClass(p ?? null)}"><title>${new Date(t).toLocaleDateString('it-IT')}: ${p == null ? 'nessun dato' : pct(p)}</title></rect>`);
  }
  return `<svg class="bars90" viewBox="0 0 270 18" preserveAspectRatio="none" role="img" aria-label="Disponibilità degli ultimi 90 giorni">${cells.join('')}</svg>`;
}

// last 24 hours: one cell per hour
function spark24(hours) {
  if (!hours.length) return '<span class="muted small">—</span>';
  return `<svg class="spark24" viewBox="0 0 ${hours.length * 4} 12" preserveAspectRatio="none">${hours.map((h, i) => `<rect x="${i * 4}" y="0" width="3" height="12" class="u-${pctClass(h.pct)}"><title>${new Date(h.t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}: ${pct(h.pct)}${h.avgMs ? ` · ${h.avgMs} ms` : ''}</title></rect>`).join('')}</svg>`;
}

// response time line with the downtime hours in red (RF-KPI-05)
function responseChart(points) {
  const pts = points.filter((p) => p.avgMs != null);
  if (pts.length < 2) return '<p class="muted">Dati insufficienti: il grafico compare dopo qualche ora di controlli.</p>';
  const w = 700, h = 140, t0 = points[0].t, t1 = points[points.length - 1].t || t0 + 1;
  const max = Math.max(...pts.map((p) => p.p95Ms || p.avgMs)) * 1.1;
  const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * w;
  const y = (v) => h - (v / max) * h;
  const down = points.filter((p) => p.downtimeMs > 0).map((p) => `<rect x="${x(p.t)}" y="0" width="${Math.max(2, w / points.length)}" height="${h}" class="downband"><title>${new Date(p.t).toLocaleString('it-IT')}: giù ${dur(p.downtimeMs)}</title></rect>`).join('');
  return `<svg class="rchart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${down}
    <polyline class="p95" points="${pts.filter((p) => p.p95Ms).map((p) => `${x(p.t)},${y(p.p95Ms)}`).join(' ')}"/>
    <polyline class="avg" points="${pts.map((p) => `${x(p.t)},${y(p.avgMs)}`).join(' ')}"/></svg>
    <div class="legend"><span><i class="l-avg"></i>media</span><span><i class="l-p95"></i>p95</span><span><i class="l-down"></i>ore con downtime</span><span class="muted">max ${Math.round(max)} ms</span></div>`;
}


// ---- assertions and request fields of the monitor form (spec §13.3) ----
const SOURCE_LABEL = { status: 'Status', header: 'Header', body: 'Corpo', json: 'JSON', time: 'Tempo (ms)', url: 'URL finale' };
const DEFAULT_ASSERTION = { http: [{ source: 'status', comparison: 'in', target: '200-399' }], api: [{ source: 'status', comparison: 'in', target: '200-299' }] };
const sameAssertions = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function assertionRow(a) {
  const row = document.createElement('div');
  row.className = 'arow';
  row.innerHTML = `<select name="as_source" aria-label="Sorgente">${Object.entries(SOURCE_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
    <input type="text" name="as_property" aria-label="Proprietà" placeholder="">
    <select name="as_comparison" aria-label="Confronto"></select>
    <input type="text" name="as_target" aria-label="Valore atteso" placeholder="valore atteso">
    <select name="as_ci" aria-label="Maiuscole"><option value="">maiuscole contano</option><option value="1">ignora maiuscole</option></select>
    <button type="button" class="btn small" data-rm aria-label="Rimuovi asserzione">×</button>`;
  const q = (n) => row.querySelector(`[name=${n}]`);
  const refresh = (keep = true) => {
    const src = q('as_source').value;
    const was = q('as_comparison').value;
    q('as_comparison').innerHTML = comparisonsFor(src).map((c) => `<option value="${c}">${COMPARISON_LABELS[c]}</option>`).join('');
    if (keep && comparisonsFor(src).includes(was)) q('as_comparison').value = was;
    q('as_property').hidden = !(src === 'header' || src === 'json');
    q('as_property').placeholder = src === 'header' ? 'nome (es. content-type)' : '$.percorso (es. $.stato)';
    const cmp = q('as_comparison').value;
    q('as_target').hidden = !NEEDS_TARGET(cmp);
    q('as_target').placeholder = cmp === 'in' ? '200-399' : src === 'time' ? 'millisecondi' : 'valore atteso';
    q('as_ci').hidden = !(['body', 'header', 'json', 'url'].includes(src) && ['equals', 'notEquals', 'contains', 'notContains'].includes(cmp));
  };
  q('as_source').value = a.source || 'status';
  refresh(false);
  q('as_comparison').value = a.comparison || comparisonsFor(q('as_source').value)[0];
  q('as_property').value = a.property || '';
  q('as_target').value = a.target || '';
  q('as_ci').value = a.ci ? '1' : '';
  refresh(true);
  q('as_source').onchange = () => refresh(false);
  q('as_comparison').onchange = () => refresh(true);
  row.querySelector('[data-rm]').onclick = () => row.remove();
  return row;
}

function wireMonitorForm(dlg, form, m) {
  const box = dlg.querySelector('[data-assertions]');
  const add = (a) => box.appendChild(assertionRow(a));
  for (const a of JSON.parse(box.dataset.initial)) add(a);
  dlg.querySelector('[data-add-assertion]').onclick = () => add({ source: 'body', comparison: 'contains', target: '' });
  const typeOf = () => (form.querySelector('[name=type]:checked') || form.querySelector('[name=type]')).value;
  const syncType = (changed) => {
    const t = typeOf();
    const method = form.querySelector('[name=method]');
    const current = method.value;
    const methods = t === 'api' ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] : ['GET', 'HEAD'];
    method.innerHTML = methods.map((x) => `<option>${x}</option>`).join('');
    method.value = methods.includes(current) ? current : 'GET';
    for (const el of dlg.querySelectorAll('[data-api]')) el.hidden = t !== 'api';
    for (const el of dlg.querySelectorAll('[data-types]')) el.hidden = !el.dataset.types.split(' ').includes(t);
    form.querySelector('[name=url]').required = t === 'http' || t === 'api';
    if (changed) {
      // the default status assertion follows the type, if the user has not changed it
      const rows = [...box.children];
      const read = rows.map((r) => ({ source: r.querySelector('[name=as_source]').value, comparison: r.querySelector('[name=as_comparison]').value, target: r.querySelector('[name=as_target]').value }));
      const other = t === 'api' ? 'http' : 'api';
      if (sameAssertions(read, DEFAULT_ASSERTION[other])) {
        box.innerHTML = '';
        for (const a of DEFAULT_ASSERTION[t]) add(a);
      }
    }
  };
  // DNS: checks on the records, and a resolver given as an address
  const dnsBox = dlg.querySelector('[data-dns-assertions]');
  if (dnsBox) {
    const addDns = (a) => {
      const row = document.createElement('div');
      row.className = 'row dnsrow';
      row.innerHTML = `<select name="dns_comparison">${Object.entries(DNS_COMPARISONS).map(([k, l]) => `<option value="${k}"${a.comparison === k ? ' selected' : ''}>${l}</option>`).join('')}</select><input type="text" name="dns_target" value="${esc(a.target || '')}" placeholder="valore"><button type="button" class="btn small danger" aria-label="Togli">×</button>`;
      row.querySelector('button').onclick = () => row.remove();
      dnsBox.appendChild(row);
    };
    for (const a of JSON.parse(dnsBox.dataset.initial)) addDns(a);
    dlg.querySelector('[data-add-dns]').onclick = () => addDns({ comparison: 'contains', target: '' });
    const res = form.querySelector('[name=resolver]');
    const showRes = () => { dlg.querySelector('[data-custom-resolver]').hidden = res.value !== 'custom' || !dlg.querySelector('[name=resolver]').closest('[data-types]') || typeOf() !== 'dns'; };
    res.addEventListener('change', showRes);
    form.addEventListener('change', showRes);
    showRes();
  }
  const strat = form.querySelector('[name=retryStrategy]');
  const syncRetry = () => { for (const el of dlg.querySelectorAll('[data-retry-more]')) el.hidden = ['none', 'single'].includes(strat.value) && !el.querySelector('[name=retryNetwork]'); };
  if (strat) { strat.addEventListener('change', syncRetry); syncRetry(); }
  const own = form.querySelector('[name=ownPolicy]');
  if (own) own.onchange = () => { form.querySelector('[data-policy]').hidden = !own.checked; };
  for (const r of form.querySelectorAll('[name=type]')) r.onchange = () => syncType(true);
  syncType(false);
}

function monitorForm(m = {}) {
  const headers = Object.entries(m.headers || {}).map(([a, b]) => `${a}: ${b}`).join('\n');
  return `
    ${m.id ? `<input type="hidden" name="type" value="${esc(m.type || 'http')}">` : `<div class="typechoice">${Object.entries(state.typeInfo || {}).map(([k, t], i) => `<label class="typecard"><input type="radio" name="type" value="${k}"${i === 0 ? ' checked' : ''}> <b>${esc(t.label)}</b><span class="muted small">${esc(t.hint)}</span></label>`).join('')}</div>`}
    <label class="f" data-types="http api"><span>URL</span><input type="url" name="url" required value="${esc(m.url || '')}" placeholder="https://www.esempio.it/"></label>
    <label class="f"><span>Nome</span><input type="text" name="name" maxlength="80" value="${esc(m.name || '')}" placeholder="dal dominio, se vuoto; per un heartbeat, es. Backup notturno"></label>
    <div class="fields" data-types="heartbeat" hidden>
      <label class="f"><span>Il job gira ogni (minuti)</span><input type="number" name="expectedMin" min="1" max="43200" value="${m.expectedMin || 60}"><small>Da 1 minuto a 30 giorni (1440 = ogni giorno).</small></label>
      <label class="f"><span>Tolleranza (minuti)</span><input type="number" name="toleranceMin" min="0" max="1440" value="${m.toleranceMin ?? ''}" placeholder="un decimo del periodo"><small>Quanto può ritardare prima che sia un guasto.</small></label>
      <p class="small muted wide">Dopo aver salvato vedi l'indirizzo segreto da chiamare e un esempio di cron.</p>
    </div>
    <div class="fields" data-types="dns" hidden>
      <label class="f"><span>Nome da risolvere</span><input type="text" name="dnsName" value="${esc(m.dnsName || '')}" placeholder="www.esempio.it"></label>
      <label class="f"><span>Tipo di record</span><select name="recordType">${['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'].map((x) => `<option${(m.recordType || 'A') === x ? ' selected' : ''}>${x}</option>`).join('')}</select></label>
      <label class="f"><span>Resolver</span><select name="resolver"><option value="system">Del sistema</option><option value="cloudflare"${m.resolver === 'cloudflare' ? ' selected' : ''}>Cloudflare (1.1.1.1)</option><option value="google"${m.resolver === 'google' ? ' selected' : ''}>Google (8.8.8.8)</option><option value="custom"${m.resolver && !['system', 'cloudflare', 'google'].includes(m.resolver) ? ' selected' : ''}>Un indirizzo IP…</option></select></label>
      <label class="f" data-custom-resolver hidden><span>Indirizzo del resolver</span><input type="text" name="resolverIp" value="${esc(m.resolver && !['system', 'cloudflare', 'google'].includes(m.resolver) ? m.resolver : '')}" placeholder="192.0.2.53 o 192.0.2.53:5353"></label>
      <fieldset class="f wide"><span>Controlli sui record (tutti veri; senza, basta che esista almeno un record)</span>
        <div data-dns-assertions data-initial="${esc(JSON.stringify(m.dnsAssertions || []))}"></div>
        <div><button type="button" class="btn small" data-add-dns>+ Aggiungi controllo</button></div></fieldset>
    </div>
    <div class="fields" data-types="tcp" hidden>
      <label class="f"><span>Host</span><input type="text" name="tcpHost" value="${esc(m.type === 'tcp' ? m.host || '' : '')}" placeholder="mail.esempio.it"></label>
      <label class="f"><span>Porta</span><input type="number" name="tcpPort" min="1" max="65535" value="${m.type === 'tcp' ? m.port || '' : ''}" placeholder="25"></label>
      <label class="f"><span>Testo da inviare (facoltativo)</span><input type="text" name="tcpSend" value="${esc(m.tcpSend || '')}" placeholder="EHLO prova\\r\\n"></label>
      <label class="f"><span>La risposta deve contenere (facoltativo)</span><input type="text" name="tcpExpect" value="${esc(m.tcpExpect || '')}" placeholder="250"></label>
    </div>
    <div class="fields" data-types="ssl" hidden>
      <label class="f"><span>Host</span><input type="text" name="sslHost" value="${esc(m.type === 'ssl' ? m.host || '' : '')}" placeholder="www.esempio.it"></label>
      <label class="f"><span>Porta</span><input type="number" name="sslPort" min="1" max="65535" value="${m.type === 'ssl' ? m.port || 443 : 443}"></label>
      <label class="f"><span>Protocollo minimo</span><select name="minTls">${['TLSv1.2', 'TLSv1.3'].map((x) => `<option${(m.minTls || 'TLSv1.2') === x ? ' selected' : ''}>${x}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" name="checkDomain"${m.checkDomain !== false ? ' checked' : ''}> controlla anche la scadenza del dominio</label>
      <label class="f"><span>Avvisi di scadenza del dominio (giorni)</span><input type="text" name="domainDays" value="${esc((m.domainDays || [30, 14, 7, 1]).join(', '))}"></label>
      <p class="small muted wide">Un controllo al giorno, qualunque sia l'intervallo degli altri monitor.</p>
    </div>
    <details class="adv"><summary>Avanzate</summary><div class="fields">
      <fieldset class="f wide retryfs" data-types="http api dns tcp ssl"><span>Nuovi tentativi prima di dichiarare un guasto</span>
        <div class="fields">
          <label class="f"><span>Strategia</span><select name="retryStrategy">${Object.entries(state.locInfo ? state.locInfo.retryStrategies : { single: 'Un nuovo tentativo' }).map(([k, l]) => `<option value="${k}"${((m.retry && m.retry.strategy) || 'single') === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <label class="f" data-retry-more><span>Tentativi in più (1–3)</span><input type="number" name="retryAttempts" min="1" max="3" value="${(m.retry && m.retry.attempts) || 2}"></label>
          <label class="f" data-retry-more><span>Attesa base (5–60 s)</span><input type="number" name="retryBase" min="5" max="60" value="${(m.retry && m.retry.baseSec) || 10}"></label>
          <label class="check" data-retry-more><input type="checkbox" name="retryNetwork"${m.retry && m.retry.onlyNetwork ? ' checked' : ''}> solo per errori di rete</label>
        </div><small>Un guasto si dichiara solo se anche i nuovi tentativi falliscono; in tutto non si aspetta più di ${state.locInfo ? state.locInfo.maxRetryWaitSec : 120} secondi.</small></fieldset>
      ${state.locInfo && state.locInfo.locations.length > 1 ? `<fieldset class="f wide" data-types="http api"><span>Località da cui controllare (nessuna = ${esc(state.locInfo.locations[0].name)})</span>
        <div class="row">${state.locInfo.locations.map((l) => `<label class="check"><input type="checkbox" name="loc" value="${esc(l.id)}"${(m.locations || []).includes(l.id) ? ' checked' : ''}> ${esc(l.name)}</label>`).join('')}</div>
        <div class="row" data-loc-more><label class="check"><input type="radio" name="locStrategy" value="rotate"${(m.locStrategy || 'rotate') === 'rotate' ? ' checked' : ''}> ${esc(state.locInfo.strategies.rotate)}</label><label class="check"><input type="radio" name="locStrategy" value="parallel"${m.locStrategy === 'parallel' ? ' checked' : ''}> ${esc(state.locInfo.strategies.parallel)}</label></div>
        <label class="check" data-loc-more><input type="checkbox" name="retrySame"${!m.retry || m.retry.sameLocation !== false ? ' checked' : ''}> i nuovi tentativi partono dalla stessa località</label></fieldset>` : ''}
      <label class="f" data-types="http api dns tcp"><span>Intervallo</span><select name="intervalMin">${[5, 10, 15, 30, 60].map((v) => `<option value="${v}"${(m.intervalMin || 5) === v ? ' selected' : ''}>ogni ${v} min</option>`).join('')}</select></label>
      <label class="f" data-types="http api dns tcp ssl"><span>Timeout (s)</span><input type="number" name="timeoutS" min="5" max="60" value="${m.timeoutS || 30}"></label>
      <label class="f" data-types="http api"><span>Metodo</span><select name="method"><option selected>${esc(m.method || 'GET')}</option></select></label>
      <label class="f" data-api hidden><span>Corpo della richiesta</span><select name="bodyType">${[['none', 'nessuno'], ['json', 'JSON'], ['text', 'testo']].map(([v, l]) => `<option value="${v}"${(m.bodyType || 'none') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="f" data-api hidden><span>Content-Type (se diverso dal solito)</span><input type="text" name="contentType" value="${esc(m.contentType || '')}" placeholder="application/json"></label>
      <label class="f wide" data-api hidden><span>Corpo</span><textarea name="body" rows="4" placeholder='{"nome": "prova"}'>${esc(m.body || '')}</textarea></label>
      <fieldset class="f wide assertions" data-types="http api"><span>Asserzioni sulla risposta: devono essere tutte vere</span>
        <div data-assertions data-initial="${esc(JSON.stringify(m.assertions && m.assertions.length ? m.assertions : DEFAULT_ASSERTION[m.type === 'api' ? 'api' : 'http']))}"></div>
        <div><button type="button" class="btn small" data-add-assertion>+ Aggiungi asserzione</button> <small class="muted">Stato, header, testo o JSON della risposta, tempo, indirizzo finale.</small></div></fieldset>
      <label class="f"><span>Degradato dopo (ms)</span><input type="number" name="degradedMs" min="1" value="${m.degradedMs === undefined ? 3000 : m.degradedMs || ''}" placeholder="disattivato"><small>Oltre questa soglia il controllo riesce ma il sito è «degradato».</small></label>
      <label class="f"><span>Fallito dopo (ms)</span><input type="number" name="failedMs" min="1" max="60000" value="${m.failedMs || ''}" placeholder="come il timeout"><small>Oltre questa soglia il controllo è un guasto.</small></label>
      <label class="check"><input type="checkbox" name="notifyDegraded"${m.notifyDegraded ? ' checked' : ''}> avvisa quando diventa degradato</label>
      <label class="check" data-types="http api"><input type="checkbox" name="followRedirects"${m.followRedirects !== false ? ' checked' : ''}> segui i redirect</label>
      <label class="check" data-types="http api ssl"><input type="checkbox" name="skipSsl"${m.skipSsl ? ' checked' : ''}> ignora gli errori del certificato</label>
      <label class="check" data-types="http api tcp" style="grid-column:1/-1"><input type="checkbox" name="shouldFail"${m.shouldFail ? ' checked' : ''}> la richiesta deve fallire <span class="muted small">(es. un'area riservata non deve essere pubblica)</span></label>
      <label class="f" data-types="http api"><span>Versione IP</span><select name="ipVersion">${[['auto', 'automatica'], ['4', 'solo IPv4'], ['6', 'solo IPv6']].map(([v, l]) => `<option value="${v}"${(m.ipVersion || 'auto') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="f wide"><span>Descrizione (note per chi interviene)</span><textarea name="description" rows="2" maxlength="500" placeholder="Hosting, contatti, cosa fare in caso di guasto…">${esc(m.description || '')}</textarea></label>
      <label class="f" data-types="http api ssl"><span>Avvisi certificato (giorni)</span><input type="text" name="sslDays" value="${esc((m.sslDays || [30, 14, 7, 1]).join(', '))}"></label>
      <fieldset class="f wide policy"><label class="check"><input type="checkbox" name="ownPolicy"${m.alertPolicy ? ' checked' : ''}> politica di allerta propria <span class="muted small">(altrimenti vale quella dell'account, nella pagina Notifiche)</span></label>
        <div class="fields" data-policy${m.alertPolicy ? '' : ' hidden'}>${policyFields({ ...DEFAULT_POLICY_UI, ...(m.alertPolicy || {}), reminders: { ...DEFAULT_POLICY_UI.reminders, ...((m.alertPolicy || {}).reminders || {}) } }, { kinds: true })}</div></fieldset>
      <label class="f"><span>Obiettivo SLA (%)</span><input type="number" name="slaPct" step="0.01" min="90" max="100" value="${m.slaPct || 99.9}"></label>
      <label class="f wide"><span>Tag (separati da virgola)</span><input type="text" name="tags" list="tagSuggest" value="${esc((m.tags || []).join(', '))}" placeholder="cliente:acme, ambiente:prod…" autocomplete="off"><datalist id="tagSuggest">${(state.knownTags || []).map((t) => `<option value="${esc(t)}">`).join('')}</datalist></label>
      <label class="f wide" data-types="http api"><span>Variabili di questo monitor (una per riga, «NOME=valore»)</span><textarea name="vars" rows="2" placeholder="HOST=staging.esempio.it">${esc(Object.entries(m.vars || {}).map(([k, v]) => `${k}=${v}`).join('\n'))}</textarea><small>Usale come <span class="mono">{{HOST}}</span> nell'indirizzo, negli header, nel corpo e nelle asserzioni; valgono al posto di quelle dello spazio di lavoro con lo stesso nome (pagina Variabili).</small></label>
      <label class="f" data-types="http api"><span>Basic auth: utente</span><input type="text" name="authUser" value="${esc(m.auth?.username || '')}" autocomplete="off"></label>
      <label class="f" data-types="http api"><span>Basic auth: password</span><input type="password" name="authPass" value="${esc(m.auth?.password || '')}" autocomplete="new-password"></label>
      <label class="f wide" data-types="http api"><span>Header (uno per riga, «Nome: valore»)</span><textarea name="headers" rows="2">${esc(headers)}</textarea></label>
      ${(state.channels || []).length ? `<fieldset class="f wide"><span>Canali di notifica (nessuno selezionato = tutti)</span><div class="row">${state.channels.map((c) => `<label class="check"><input type="checkbox" name="channels" value="${esc(c.id)}"${(m.channels || []).includes(c.id) ? ' checked' : ''}> ${esc(c.name)}</label>`).join('')}</div></fieldset>` : ''}
    </div></details>
    <div class="row" data-types="http api dns tcp ssl"><button type="button" class="btn small" data-test>Esegui una prova</button><span class="muted small">Un controllo con queste impostazioni, senza salvare nulla.</span></div>
    <div data-testout class="panel small" hidden></div>`;
}

const DNS_COMPARISONS = { contains: 'contiene', notContains: 'non contiene', equalsSet: 'è esattamente', matches: 'corrisponde a (espressione)', notEmpty: 'esiste almeno un record' };

/** The fields that belong to a type (DNS, TCP, SSL), from the form. */
function typeFields(fd) {
  const t = fd.get('type');
  if (t === 'dns') {
    const resolver = fd.get('resolver') === 'custom' ? String(fd.get('resolverIp') || '').trim() : fd.get('resolver');
    return { dnsName: String(fd.get('dnsName') || '').trim(), recordType: fd.get('recordType'), resolver, dnsAssertions: fd.getAll('dns_comparison').map((comparison, i) => ({ comparison, target: fd.getAll('dns_target')[i] })).filter((a) => a.comparison === 'notEmpty' || a.target.trim()) };
  }
  if (t === 'tcp') return { host: String(fd.get('tcpHost') || '').trim(), port: intOrNull(fd.get('tcpPort')) ?? undefined, tcpSend: fd.get('tcpSend') || '', tcpExpect: fd.get('tcpExpect') || '' };
  if (t === 'ssl') return { host: String(fd.get('sslHost') || '').trim(), port: intOrNull(fd.get('sslPort')) ?? undefined, minTls: fd.get('minTls'), checkDomain: fd.get('checkDomain') === 'on', domainDays: String(fd.get('domainDays')).split(/[,\s]+/).filter(Boolean).map(Number) };
  return {};
}

/** The retry settings of the form: null when it is the default (one more attempt after 10 s), so that old monitors stay untouched. */
function retryFields(fd) {
  const strategy = fd.get('retryStrategy') || 'single';
  const base = { strategy, attempts: Number(fd.get('retryAttempts') || 2), baseSec: Number(fd.get('retryBase') || 10), onlyNetwork: fd.get('retryNetwork') === 'on', sameLocation: fd.get('retrySame') !== null ? fd.get('retrySame') === 'on' : true };
  if (strategy === 'single' && base.baseSec === 10 && !base.onlyNetwork && base.sameLocation) return null;
  return base;
}

function readMonitorForm(fd) {
  const headers = {};
  for (const l of lines(fd.get('headers'))) {
    const i = l.indexOf(':');
    if (i > 0) headers[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return {
    url: fd.get('url').trim(), name: fd.get('name').trim(), intervalMin: Number(fd.get('intervalMin')), timeoutS: Number(fd.get('timeoutS')),
    type: fd.get('type') || 'http', method: fd.get('method'), bodyType: fd.get('bodyType') || 'none', body: fd.get('body') || '', contentType: fd.get('contentType') || '',
    assertions: fd.getAll('as_source').map((source, i) => ({ source, property: fd.getAll('as_property')[i].trim(), comparison: fd.getAll('as_comparison')[i], target: fd.getAll('as_target')[i], ci: fd.getAll('as_ci')[i] === '1' })),
    degradedMs: intOrNull(fd.get('degradedMs')), failedMs: intOrNull(fd.get('failedMs')), notifyDegraded: fd.get('notifyDegraded') === 'on',
    followRedirects: fd.get('followRedirects') === 'on', skipSsl: fd.get('skipSsl') === 'on', shouldFail: fd.get('shouldFail') === 'on', ipVersion: fd.get('ipVersion'), description: fd.get('description'),
    ...typeFields(fd),
    retry: retryFields(fd),
    locations: fd.getAll('loc'), locStrategy: fd.get('locStrategy') || 'rotate',
    vars: Object.fromEntries(lines(fd.get('vars')).map((l) => { const i = l.indexOf('='); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : null; }).filter(Boolean)),
    expectedMin: intOrNull(fd.get('expectedMin')) ?? undefined, toleranceMin: intOrNull(fd.get('toleranceMin')) ?? undefined,
    sslDays: String(fd.get('sslDays')).split(/[,\s]+/).filter(Boolean).map(Number),
    alertPolicy: fd.get('ownPolicy') === 'on' ? readPolicy(fd, { kinds: true }) : null, slaPct: Number(fd.get('slaPct')), tags: String(fd.get('tags')).split(',').map((t) => t.trim()).filter(Boolean),
    auth: fd.get('authUser').trim() ? { username: fd.get('authUser').trim(), password: fd.get('authPass') } : null, headers,
    channels: fd.getAll('channels').length ? fd.getAll('channels') : null,
  };
}

const tagSlug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
function similarTag(tags) {
  const known = state.knownTags || [];
  for (const t of tags) {
    if (known.includes(t)) continue;
    const hit = known.find((k) => tagSlug(k) === tagSlug(t));
    if (hit) return `Il tag «${t}» somiglia a «${hit}», che esiste già: usa quello per non averne due.`;
  }
  return null;
}

async function editMonitorDialog(m = null) {
  let saved = null;
  state.channels = await api('GET', 'channels').then((x) => x.channels.filter((c) => c.status !== 'pending')).catch(() => []);
  state.knownTags = await api('GET', 'tags').then((x) => x.tags.map((t) => t.tag)).catch(() => []);
  if (!state.locInfo) state.locInfo = await api('GET', 'monitor-locations').catch(() => null);
  if (!state.typeInfo) state.typeInfo = await api('GET', 'monitor-types').catch(() => ({ http: { label: 'Sito web', hint: '' } }));
  const fd = await formDialog({
    title: m ? `Modifica «${m.name}»` : 'Aggiungi monitor',
    body: monitorForm(m || {}),
    confirm: m ? 'Salva' : 'Aggiungi e controlla',
    // RF-TAG-02: a tag that looks like one that exists is probably the same, written differently
    check: (f) => similarTag(String(f.get('tags') || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)),
    setup: (dlg, form) => {
      wireMonitorForm(dlg, form, m || {});
      // RF-RIS-07: one run with the configuration of the form
      const out = dlg.querySelector('[data-testout]');
      dlg.querySelector('[data-test]').onclick = async (e) => {
        e.target.disabled = true;
        out.hidden = false;
        out.textContent = 'Controllo in corso…';
        try {
          const r = await api('POST', 'monitors/test', { ...(m ? { id: m.id } : {}), ...readMonitorForm(new FormData(form)) });
          const hdr = r.headers ? Object.entries(r.headers).slice(0, 12).map(([k, v]) => `${k}: ${v}`).join('\n') : '';
          out.innerHTML = `<div class="row"><span class="tag ${r.outcome === 'ok' ? 'ok' : r.outcome === 'degraded' ? 'warn' : 'error'}">${r.outcome === 'ok' ? 'riuscito' : r.outcome === 'degraded' ? 'degradato' : 'fallito'}</span>
            <b>${r.status ? `HTTP ${r.status}` : ''}</b> <span>${r.ms ?? '—'} ms${r.ttfbMs != null ? ` (primo byte ${r.ttfbMs} ms)` : ''}</span></div>
            ${r.phases ? `<div class="small muted">DNS ${r.phases.dnsMs} · connessione ${r.phases.tcpMs}${r.phases.tlsMs ? ` · TLS ${r.phases.tlsMs}` : ''} · attesa ${r.phases.waitMs} · download ${r.phases.downloadMs} ms${r.phases.redirectMs ? ` · redirect ${r.phases.redirectMs} ms` : ''}${r.tls ? ` · ${esc(r.tls.protocol)}` : ''}${r.ip ? ` · ${esc(r.ip)}` : ''}</div>` : ''}
            ${r.assertions && r.assertions.length ? `<ul class="plain small">${r.assertions.map((a) => `<li>${a.ok ? '✅' : '❌'} ${esc(a.text)}${a.ok ? '' : ` — <span class="sev-e">${esc(a.message)}</span>`}</li>`).join('')}</ul>` : ''}
            ${r.message && !(r.assertions && r.assertions.some((a) => !a.ok)) ? `<div>${esc(r.message)}</div>` : ''}${r.finalUrl && r.finalUrl !== readMonitorForm(new FormData(form)).url ? `<div class="muted">Indirizzo finale: <span class="mono">${esc(r.finalUrl)}</span></div>` : ''}
            ${hdr ? `<details><summary>Header della risposta</summary><pre class="excerpt">${esc(hdr)}</pre></details>` : ''}
            ${r.excerpt ? `<details><summary>Inizio della risposta</summary><pre class="excerpt">${esc(r.excerpt)}</pre></details>` : ''}`;
        } catch (x) {
          out.innerHTML = `<span class="sev-e">${esc(x.message)}</span>`;
        } finally {
          e.target.disabled = false;
        }
      };
    },
    submit: async (f) => { saved = m ? await api('PUT', `monitors/${m.id}`, { ...m, ...readMonitorForm(f) }) : await api('POST', 'monitors', readMonitorForm(f)); },
  });
  if (!fd) return null;
  toast(m ? 'Monitor salvato' : `Monitor aggiunto: ${MSTATUS[saved.status] ? MSTATUS[saved.status][0] : saved.status}`);
  return saved;
}

// ---- the list of the monitors (spec §13.8) ----
const LIST_PERIODS = [['24h', '24 ore'], ['7d', '7 giorni'], ['30d', '30 giorni'], ['90d', '90 giorni']];
const LIST_COLS = [['name', 'Monitor'], ['status', 'Stato'], ['health', 'Salute'], ['availability', 'Disponibilità'], ['avg', 'Media'], ['p95', 'p95'], ['last', 'Ultimo run']];
const TYPE_LABEL = { http: 'Sito', api: 'API', heartbeat: 'Heartbeat', dns: 'DNS', tcp: 'TCP', ssl: 'SSL' };
const LIST_TABS = [['', 'Tutti', 'all'], ['up', 'Su', 'up'], ['degraded', 'Degradati', 'degraded'], ['down', 'Giù', 'down'], ['paused', 'In pausa', 'paused']];

const readListState = () => {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  return { period: q.get('period') || '30d', q: q.get('q') || '', status: q.get('status') || '', sort: q.get('sort') || 'default', dir: q.get('dir') || 'asc', page: q.get('page') || '1', tag: q.get('tag') || '' };
};
const listHash = (s) => {
  const q = new URLSearchParams(Object.entries({ period: s.period === '30d' ? '' : s.period, q: s.q, status: s.status, sort: s.sort === 'default' ? '' : s.sort, dir: s.sort === 'default' || s.dir === 'asc' ? '' : s.dir, page: s.page === '1' ? '' : s.page, tag: s.tag }).filter(([, v]) => v));
  return `#/monitoring${q.toString() ? `?${q}` : ''}`;
};

/** The 20 last runs as small bars (RF-LST-03): green, orange, red. */
function recentBars(codes) {
  const cells = Array.from({ length: 20 }, (_, i) => {
    const c = codes[codes.length - 20 + i];
    return `<i class="rb ${c === 'o' ? 'rb-o' : c === 'd' ? 'rb-d' : c === 'e' ? 'rb-e' : 'rb-n'}"></i>`;
  });
  return `<span class="recent" aria-label="Ultimi ${codes.length} run">${cells.join('')}</span>`;
}

/** Sets or removes the `key:` part of the written search, keeping the rest. */
function setQueryToken(query, key, value) {
  const kept = String(query || '').split(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/).filter((t) => t && !new RegExp(`^-?${key}:`, 'i').test(t));
  if (value) kept.push(/\s/.test(value) ? `${key}:"${value}"` : `${key}:${value}`);
  return kept.join(' ');
}
const queryToken = (query, key) => { const m = new RegExp(`(?:^|\\s)${key}:("[^"]*"|\\S+)`, 'i').exec(query || ''); return m ? m[1].replace(/^"|"$/g, '') : ''; };

function rowMenu(m) {
  return `<details class="menu"><summary aria-label="Azioni">⋯</summary><div class="menupop">
    <button data-row="check" data-id="${esc(m.id)}"${m.paused || m.type === 'heartbeat' ? ' disabled' : ''}>Esegui ora</button>
    ${m.managed ? '<span class="menunote" data-tip="Gestito da codice: si modifica nel file, o si duplica">🔒 da codice</span>' : `<a href="#/monitor/${encodeURIComponent(m.id)}?edit=1">Modifica</a>`}
    <button data-row="duplicate" data-id="${esc(m.id)}">Duplica</button>
    <button data-row="${m.muted ? 'unmute' : 'mute'}" data-id="${esc(m.id)}">${m.muted ? 'Riattiva gli avvisi' : 'Silenzia gli avvisi'}</button>
    <button data-row="${m.paused ? 'resume' : 'pause'}" data-id="${esc(m.id)}">${m.paused ? 'Riprendi' : 'Metti in pausa'}</button>
    <button data-row="badge" data-id="${esc(m.id)}">Badge di stato</button>
    <button data-row="code" data-id="${esc(m.id)}">Esporta come codice</button>
    ${m.managed ? '' : `<button data-row="delete" data-id="${esc(m.id)}" class="danger">Elimina…</button>`}</div></details>`;
}

async function viewMonitoring() {
  let s = readListState();
  const views = await api('GET', 'monitor-views').catch(() => []);
  // the home view applies when the section is opened without any parameter
  const home = views.find((v) => v.home);
  if (home && !(location.hash.split('?')[1] || '')) {
    s = { period: home.period, q: home.q, status: home.status || '', sort: home.sort, dir: home.dir, page: '1', tag: '' };
    history.replaceState(null, '', listHash(s));
  }
  const qs = new URLSearchParams({ period: s.period, q: s.q, status: s.status, sort: s.sort, dir: s.dir, page: s.page, tag: s.tag });
  const [d, list] = await Promise.all([api('GET', 'monitoring'), api('GET', `monitor-list?${qs}`)]);
  setView('monitoring', { refresh: () => {} });
  const selected = new Set();
  const incRow = (i) => `<li><a href="#/incident/${encodeURIComponent(i.id)}">${esc(i.monitorName)}</a> <span class="muted small">${esc(fmtDate(i.start))} · ${dur(i.durationMs)}${i.end ? '' : ' (in corso)'}</span><div class="small">${esc(i.cause.message)}</div></li>`;
  const here = () => viewMonitoring();
  const go = (patch) => { s = { ...s, page: '1', ...patch }; location.hash = listHash(s); };
  const th = ([k, l]) => {
    const on = s.sort === k;
    return `<th class="${['availability', 'avg', 'p95'].includes(k) ? 'num ' : ''}sortable" data-sort="${k}" aria-sort="${on ? (s.dir === 'desc' ? 'descending' : 'ascending') : 'none'}">${l}${on ? (s.dir === 'desc' ? ' ▼' : ' ▲') : ''}</th>`;
  };
  const tagVal = queryToken(s.q, 'tag') || s.tag, healthVal = queryToken(s.q, 'salute'), typeVal = queryToken(s.q, 'tipo');
  app().innerHTML = `${monTabs('monitoring')}
    ${d.dev ? '<div class="notice warn">Modalità sviluppo: il monitoraggio gira in questo processo solo finché il server è attivo, quindi i dati non sono affidabili. In produzione gira su Vercel.</div>' : ''}
    ${d.beat.stale ? `<div class="notice error">Monitoraggio fermo${d.beat.last ? ` da ${esc(dur(d.now - d.beat.last))}` : ': nessun giro di controllo ancora eseguito'}.</div>` : ''}
    ${d.channelsInError.map((c) => `<div class="notice error">Il canale di notifica «${esc(c.name)}» non funziona da ${esc(dur(d.now - c.failingSince))}: ${esc(c.lastError || '')}. <a href="#/notifications">Controlla le notifiche</a></div>`).join('')}
    ${!d.channelCount ? '<div class="notice warn">Nessun canale di notifica: gli incidenti restano solo qui. <a href="#/notifications">Aggiungi email, Slack o Telegram</a></div>' : ''}
    ${d.beat.unreliable.length ? `<div class="notice warn">Monitoraggio non affidabile nelle ultime 24 ore (${d.beat.unreliable.length} giri scartati per problemi di rete del monitor): quei periodi non contano nei KPI.</div>` : ''}
    <div class="head"><div><h1>Monitoraggio</h1><div class="sub">Disponibilità dei tuoi siti, controllati ogni pochi minuti</div></div>
      <div class="row"><button class="btn" id="monBulk">Aggiunta in blocco</button><button class="btn" id="monImport">Da un sito</button><a class="btn" href="/api/monitors.csv">CSV ↓</a><button class="btn primary" id="monAdd">+ Aggiungi monitor</button></div></div>
    <div class="stats" id="monStats">${[
      stat('Su', fmtNum(list.counts.up + list.counts.degraded), list.counts.degraded ? `di cui ${list.counts.degraded} degradati` : ''),
      stat('Giù', `<span class="${list.counts.down ? 'sev-e' : ''}">${fmtNum(list.counts.down)}</span>`),
      stat('In pausa / manutenzione', `${list.counts.paused} / ${list.counts.maintenance}`),
      stat('Salute', `<span class="sev-e">${list.health.critica}</span> · <span class="sev-w">${list.health.attenzione}</span> · ${list.health.buona}`, 'critica · attenzione · buona'),
      stat(`Disponibilità ${esc((LIST_PERIODS.find(([k]) => k === list.period) || [])[1] || '')}`, pct(list.availability), s.q || s.tag ? 'dei monitor mostrati' : 'tutti i monitor'),
    ].join('')}</div>
    <div class="tabs statustabs">${LIST_TABS.map(([k, l, c]) => `<a href="${listHash({ ...s, status: k, page: '1' })}" class="${s.status === k ? 'on' : ''}">${l} <span class="count">${list.counts[c] ?? 0}</span></a>`).join('')}</div>
    <div class="row filters">
      <input class="input" id="fQ" type="search" placeholder="Cerca: nome, URL, tag:cliente:x stato:giù tipo:api salute:critica" value="${esc(s.q)}" aria-label="Cerca">
      <select id="fTag" aria-label="Tag"><option value="">Tutti i tag</option>${list.tags.map((t) => `<option${tagVal === t ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <select id="fType" aria-label="Tipo"><option value="">Ogni tipo</option>${list.types.map((t) => `<option value="${t}"${typeVal === t ? ' selected' : ''}>${TYPE_LABEL[t] || t}</option>`).join('')}</select>
      <select id="fHealth" aria-label="Salute"><option value="">Ogni salute</option>${Object.keys(HEALTH).map((k) => `<option${healthVal === k ? ' selected' : ''}>${k}</option>`).join('')}</select>
      <select id="fPeriod" aria-label="Periodo">${LIST_PERIODS.map(([k, l]) => `<option value="${k}"${s.period === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <select id="fView" aria-label="Viste salvate"><option value="">Viste…</option>${views.map((v) => `<option value="${esc(v.id)}">${v.home ? '★ ' : ''}${esc(v.name)}</option>`).join('')}</select>
      <button class="btn small" id="viewSave" title="Salva la ricerca, il periodo e l'ordinamento correnti">Salva vista</button>
    </div>
    ${list.errors.length ? `<div class="notice warn">${list.errors.map(esc).join(' · ')}</div>` : ''}
    <div class="bulkbar row" id="bulkBar" hidden><b id="bulkCount"></b>
      <button class="btn small" data-act="check">Esegui ora</button>
      <button class="btn small" data-act="pause">Pausa</button><button class="btn small" data-act="resume">Riprendi</button><button class="btn small" data-act="duplicate">Duplica</button><button class="btn small" id="bulkCode">Esporta come codice</button>
      <select class="input small" data-act-select="interval"><option value="">Intervallo…</option>${[5, 10, 15, 30, 60].map((v) => `<option value="${v}">ogni ${v} min</option>`).join('')}</select>
      <select class="input small" data-act-select="mute"><option value="">Silenzia…</option><option value="60">per 1 ora</option><option value="480">per 8 ore</option><option value="1440">per 24 ore</option><option value="-1">fino alla riattivazione</option></select>
      <button class="btn small" data-act="unmute">Riattiva avvisi</button>
      <button class="btn small" data-act="add-tag">Aggiungi tag…</button>
      <select class="input small" data-act-select="maintenance"><option value="">Manutenzione…</option><option value="15">per 15 min</option><option value="30">per 30 min</option><option value="60">per 60 min</option></select>
      <button class="btn small danger" data-act="delete">Elimina…</button></div>
    <div class="monlayout"><div class="panel tablewrap" id="monList">${list.rows.length ? `<table class="montable"><thead><tr><th><input type="checkbox" id="selAll" aria-label="Seleziona tutti"></th>${LIST_COLS.map(th).join('')}<th>Ultimi 20 run</th><th></th></tr></thead><tbody>
      ${list.rows.map((m) => `<tr>
        <td><input type="checkbox" data-sel="${esc(m.id)}"${selected.has(m.id) ? ' checked' : ''} aria-label="Seleziona"></td>
        <td><a href="#/monitor/${encodeURIComponent(m.id)}"><b>${esc(m.name)}</b></a> <span class="tag">${esc(TYPE_LABEL[m.type] || m.type)}</span>${m.managed ? ' <span class="tag info" data-tip="Gestito da codice (sitescanner.monitors.yml)">da codice</span>' : ''}<div class="small muted mono">${esc(m.url || m.target || '')}</div>${m.tags.map((t) => `<a class="tag" href="${listHash({ ...s, q: setQueryToken(s.q, 'tag', t), page: '1' })}">${esc(t)}</a>`).join(' ')}</td>
        <td>${mstatusTag(m.status, m.muted)}<div class="small muted">da ${dur(d.now - (m.since || d.now))}</div></td>
        <td>${healthTag(m.health)}</td>
        <td class="num">${pct(m.availability)}${m.coverage != null && m.coverage < 0.99 ? `<div class="small muted" data-tip="Tempo effettivamente monitorato sul periodo">copertura ${Math.round(m.coverage * 100)}%</div>` : ''}</td>
        <td class="num">${m.avgMs != null ? `${m.avgMs} ms` : '—'}</td><td class="num">${m.p95Ms != null ? `${m.p95Ms} ms` : '—'}</td>
        <td class="small">${m.lastAt ? `${esc(dur(d.now - m.lastAt))} fa` : '—'}</td>
        <td>${recentBars(m.recent)}</td><td>${rowMenu(m)}</td></tr>`).join('')}</tbody></table>
      ${list.pages > 1 ? `<div class="row pager"><a class="btn small${list.page <= 1 ? ' disabled' : ''}" href="${listHash({ ...s, page: String(Math.max(1, list.page - 1)) })}">← Precedenti</a><span class="muted small">pagina ${list.page} di ${list.pages} · ${list.total} monitor</span><a class="btn small${list.page >= list.pages ? ' disabled' : ''}" href="${listHash({ ...s, page: String(Math.min(list.pages, list.page + 1)) })}">Successivi →</a></div>` : ''}`
      : `<p class="empty">${list.counts.all || s.q || s.status ? 'Nessun monitor con questi filtri.' : 'Nessun monitor. Aggiungi il primo sito da tenere d\'occhio.'}</p>`}</div>
      <aside>
        <div class="panel"><h3>Incidenti in corso</h3>${d.openIncidents.length ? `<ul class="plain">${d.openIncidents.map(incRow).join('')}</ul>` : '<p class="muted small">Nessuno</p>'}</div>
        <div class="panel"><h3>Ultimi incidenti</h3>${d.recentIncidents.length ? `<ul class="plain">${d.recentIncidents.map(incRow).join('')}</ul><a class="small" href="/api/incidents.csv">Esporta CSV ↓</a>` : '<p class="muted small">Nessuno negli ultimi 90 giorni</p>'}</div>
        <div class="panel"><h3>Certificati in scadenza</h3>${d.certs.length ? `<ul class="plain">${d.certs.map((c) => `<li><a href="#/monitor/${encodeURIComponent(c.id)}">${esc(c.name)}</a> <span class="${c.days <= 7 ? 'sev-e' : 'sev-w'}">${c.days < 0 ? 'scaduto' : `tra ${c.days} giorni`}</span></li>`).join('')}</ul>` : '<p class="muted small">Nessuno entro 30 giorni</p>'}</div>
        <div class="panel"><h3>Manutenzione</h3>${d.windows.length ? `<ul class="plain">${d.windows.slice(0, 8).map((w) => `<li>${w.active ? '<span class="tag info">in corso</span> ' : ''}<b>${esc(w.name)}</b> <span class="small muted">${esc(fmtDate(w.start))} → ${esc(new Date(w.end).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }))} · ${w.monitors.length} monitor</span></li>`).join('')}</ul>` : '<p class="muted small">Nessuna nei prossimi 7 giorni</p>'}</div>
      </aside></div>`;

  // search and menus: they rewrite the written search, which stays in the URL
  let typing;
  $('#fQ').oninput = (e) => { clearTimeout(typing); typing = setTimeout(() => go({ q: e.target.value.trim() }), 400); };
  $('#fTag').onchange = (e) => go({ q: setQueryToken(s.q, 'tag', e.target.value), tag: '' });
  $('#fType').onchange = (e) => go({ q: setQueryToken(s.q, 'tipo', e.target.value) });
  $('#fHealth').onchange = (e) => go({ q: setQueryToken(s.q, 'salute', e.target.value) });
  $('#fPeriod').onchange = (e) => go({ period: e.target.value });
  for (const h of $$('th[data-sort]')) h.onclick = () => go({ sort: h.dataset.sort, dir: s.sort === h.dataset.sort && s.dir === 'asc' ? 'desc' : 'asc' });
  $('#fView').onchange = (e) => {
    const v = views.find((x) => x.id === e.target.value);
    if (v) { s = { period: v.period, q: v.q, status: v.status || '', sort: v.sort, dir: v.dir, page: '1', tag: '' }; location.hash = listHash(s); }
  };
  $('#viewSave').onclick = async () => {
    const fd = await formDialog({
      title: 'Salva la vista', confirm: 'Salva',
      body: `<p class="small muted">Ricerca: <span class="mono">${esc(s.q || '(tutti)')}</span> · periodo ${esc(s.period)} · ordine ${esc(s.sort)}</p><label class="f"><span>Nome</span><input type="text" name="name" required maxlength="60" placeholder="Clienti premium giù"></label>
        <label class="check"><input type="checkbox" name="home"> usala come pagina iniziale del monitoraggio</label>`,
      submit: async (f) => { await api('POST', 'monitor-views', { name: f.get('name'), q: s.q, period: s.period, sort: s.sort, dir: s.dir, status: s.status, home: f.get('home') === 'on' }); },
    });
    if (fd) { toast('Vista salvata'); here(); }
  };
  // a saved view can be removed or made the home from the selector (the selected one is applied above)
  if (views.length) {
    const del = document.createElement('button');
    del.className = 'btn small';
    del.textContent = 'Gestisci viste';
    del.onclick = async () => {
      const fd = await formDialog({
        title: 'Viste salvate', confirm: 'Chiudi', cancel: false,
        body: views.map((v) => `<div class="row between"><span>${v.home ? '★ ' : ''}<b>${esc(v.name)}</b> <span class="muted small mono">${esc(v.q || '(tutti)')}</span></span><span class="row"><button type="button" class="btn small" data-vhome="${esc(v.id)}">${v.home ? 'Non più iniziale' : 'Rendi iniziale'}</button><button type="button" class="btn small danger" data-vdel="${esc(v.id)}">Elimina</button></span></div>`).join(''),
        setup: (dlg) => {
          for (const b of dlg.querySelectorAll('[data-vdel]')) b.onclick = async () => { await api('DELETE', `monitor-views/${b.dataset.vdel}`); dlg.close(''); here(); };
          for (const b of dlg.querySelectorAll('[data-vhome]')) b.onclick = async () => { const v = views.find((x) => x.id === b.dataset.vhome); await api('PUT', `monitor-views/${v.id}`, { home: !v.home }); dlg.close(''); here(); };
        },
      });
      void fd;
    };
    $('#viewSave').after(del);
  }

  // the row menus open over the table, which scrolls: the popup is placed on the screen, not in the table
  for (const dt of $$('details.menu')) {
    dt.addEventListener('toggle', () => {
      if (!dt.open) return;
      for (const other of $$('details.menu[open]')) if (other !== dt) other.open = false;
      dt.dataset.scrollY = window.scrollY;
      const r = dt.querySelector('summary').getBoundingClientRect(), pop = dt.querySelector('.menupop');
      pop.style.left = `${Math.max(8, r.right - 190)}px`;
      // the real height of the menu (it grows with its items): a menu that does not fit below opens above
      const h = pop.offsetHeight;
      pop.style.top = `${r.bottom + h > window.innerHeight ? Math.max(8, r.top - h) : r.bottom}px`;
    });
  }

  // selection and bulk actions (RF-LST-05)
  const sync = () => { $('#bulkBar').hidden = !selected.size; $('#bulkCount').textContent = `${selected.size} selezionati`; };
  for (const c of $$('[data-sel]')) c.onchange = () => { c.checked ? selected.add(c.dataset.sel) : selected.delete(c.dataset.sel); sync(); };
  const all = $('#selAll');
  if (all) all.onchange = () => { for (const c of $$('[data-sel]')) { c.checked = all.checked; all.checked ? selected.add(c.dataset.sel) : selected.delete(c.dataset.sel); } sync(); };
  $('#monAdd').onclick = async () => { if (await editMonitorDialog()) here(); };
  $('#monBulk').onclick = bulkAddDialog;
  $('#monImport').onclick = importSiteDialog;
  const act = async (action, value, ids = [...selected]) => {
    if (action === 'delete') {
      const ok = await formDialog({ title: `Eliminare ${ids.length === 1 ? 'il monitor' : `${ids.length} monitor`}?`, body: '<p>Vengono cancellati anche il loro storico: controlli, incidenti e KPI.</p>', confirm: 'Elimina', danger: true });
      if (!ok) return;
    }
    if (action === 'add-tag') {
      const fd = await formDialog({ title: 'Aggiungi un tag', body: '<label class="f"><span>Tag</span><input type="text" name="tag" required></label>', confirm: 'Aggiungi' });
      if (!fd) return;
      value = fd.get('tag');
    }
    try {
      const r = await api('POST', 'monitors/actions', { ids, action, value });
      toast(action === 'maintenance' ? `In manutenzione per ${value} minuti: ${r.count} monitor` : action === 'check' ? `Controllati: ${r.count}` : `Fatto: ${r.count} monitor`);
      here();
    } catch (e) { toast(e.message, true); }
  };
  for (const b of $$('[data-act]')) b.onclick = () => act(b.dataset.act);
  $('#bulkCode').onclick = () => codeDialog([...selected]);
  for (const b of $$('[data-row]')) b.onclick = () => (b.dataset.row === 'badge' ? badgeDialog(list.rows.find((x) => x.id === b.dataset.id)) : b.dataset.row === 'code' ? codeDialog([b.dataset.id]) : act(b.dataset.row, b.dataset.row === 'mute' ? 0 : undefined, [b.dataset.id]));
  for (const x of $$('[data-act-select]')) x.onchange = () => { if (x.value) act(x.dataset.actSelect, x.dataset.actSelect === 'mute' && x.value === '-1' ? 0 : Number(x.value)); };
  // RF-KPI-02: refreshed every 30 seconds while the page is open, unless something is being edited
  const timer = setInterval(() => {
    if (state.view.name !== 'monitoring' || document.querySelector('dialog[open], details.menu[open]') || selected.size || document.activeElement === $('#fQ')) return;
    if (!location.hash.startsWith('#/monitoring')) return clearInterval(timer);
    here();
  }, 30000);
  state.view.stop = () => clearInterval(timer);
}

async function bulkAddDialog() {
  let r = null;
  const fd = await formDialog({
    title: 'Aggiunta in blocco',
    body: `<label class="f"><span>Un sito per riga: «URL» oppure «nome, URL»</span><textarea name="text" rows="8" required placeholder="https://www.esempio.it/\nNegozio, https://shop.esempio.it/"></textarea></label>
      <div class="fields"><label class="f"><span>Intervallo</span><select name="intervalMin">${[5, 10, 15, 30, 60].map((v) => `<option value="${v}">ogni ${v} min</option>`).join('')}</select></label>
      <label class="f"><span>Tag comuni</span><input type="text" name="tags" placeholder="cliente, server…"></label></div>`,
    confirm: 'Aggiungi',
    submit: async (f) => { r = await api('POST', 'monitors/bulk', { text: f.get('text'), intervalMin: Number(f.get('intervalMin')), tags: String(f.get('tags')).split(',').map((t) => t.trim()).filter(Boolean) }); },
  });
  if (!fd) return;
  if (r.skipped.length) {
    await formDialog({ title: `${r.created.length} monitor aggiunti, ${r.skipped.length} righe saltate`, body: `<ul class="plain small">${r.skipped.map((s) => `<li><span class="mono">${esc(s.line)}</span> — ${esc(s.reason)}</li>`).join('')}</ul>`, confirm: 'Ok', cancel: false });
  } else toast(`${r.created.length} monitor aggiunti: il primo controllo arriva al prossimo giro`);
  viewMonitoring();
}

async function importSiteDialog() {
  const sites = (state.info.sites || []).filter((s) => s.configured && !s.error);
  if (!sites.length) return toast('Nessun sito configurato da importare', true);
  let r = null;
  const fd = await formDialog({
    title: 'Monitor da un sito',
    body: `<p>Un monitor per ogni ambiente del sito, con le sue credenziali di basic auth.</p><label class="f"><span>Sito</span><select name="site">${sites.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} (${Object.keys(s.envs).join(', ')})</option>`).join('')}</select></label>`,
    confirm: 'Crea i monitor',
    submit: async (f) => { r = await api('POST', 'monitors/import-site', { site: f.get('site') }); },
  });
  if (!fd) return;
  toast(`${r.created.length} monitor creati${r.skipped.length ? `, ${r.skipped.length} già presenti` : ''}`);
  viewMonitoring();
}

// ---- runs, percentiles, groups of errors, run detail (spec §13.4) ----
const RUN_PERIODS = [['today', 'Oggi'], ['1h', '1 ora'], ['3h', '3 ore'], ['24h', '24 ore'], ['7d', '7 giorni'], ['30d', '30 giorni'], ['90d', '90 giorni'], ['custom', 'Personalizzato']];
const PHASE_META = [['dnsMs', 'DNS', '#8b5cf6'], ['tcpMs', 'Connessione', '#f59e0b'], ['tlsMs', 'TLS', '#ec4899'], ['waitMs', 'Attesa', '#3b82f6'], ['downloadMs', 'Download', '#10b981']];
const OUTCOME_TAG = (o) => (o === 'ok' ? '<span class="tag ok">riuscito</span>' : o === 'degraded' || o === 'slow' ? '<span class="tag warn">degradato</span>' : '<span class="tag error">fallito</span>');

// the phases of one run as a thin stacked bar
function phaseBar(p, scale) {
  if (!p) return '<span class="muted small">—</span>';
  const total = PHASE_META.reduce((s, [k]) => s + (p[k] || 0), 0) || 1;
  const w = Math.max(6, Math.min(100, (total / scale) * 100));
  return `<div class="pbar" style="width:${w}%" data-tip="${esc(PHASE_META.map(([k, l]) => `${l}: <b>${p[k] || 0} ms</b>`).join('<br>'))}">${PHASE_META.map(([k, , c]) => (p[k] ? `<i style="flex:${p[k]};background:${c}"></i>` : '')).join('')}</div>`;
}

const phaseLegend = () => `<div class="legend">${PHASE_META.map(([, l, c]) => `<span><i style="background:${c}"></i>${l}</span>`).join('')}</div>`;

// average phases per hour (or per day), stacked
function phasesChart(series, granularity) {
  const pts = series.filter((s) => s.n > 0);
  if (pts.length < 1) return '<p class="muted small">Nessun dato sulle fasi nel periodo: compaiono dopo i primi controlli.</p>';
  const w = 700, h = 150;
  const tot = (s) => PHASE_META.reduce((n, [k]) => n + (s[k] || 0), 0);
  const max = Math.max(...pts.map(tot)) * 1.08 || 1;
  const t0 = series[0].t, t1 = series[series.length - 1].t;
  const bw = Math.max(2, Math.min(24, (w / Math.max(1, series.length)) * 0.8));
  const x = (t) => (t1 === t0 ? w / 2 : ((t - t0) / (t1 - t0)) * (w - bw));
  const bars = pts.map((s) => {
    let y = h;
    const parts = PHASE_META.map(([k, l, c]) => {
      const hh = ((s[k] || 0) / max) * h;
      y -= hh;
      return hh > 0 ? `<rect x="${x(s.t).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" fill="${c}"/>` : '';
    }).join('');
    const label = `${granularity === 'day' ? new Date(s.t).toLocaleDateString('it-IT') : new Date(s.t).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}: ${PHASE_META.map(([k, l]) => `${l} ${s[k]} ms`).join(' · ')} (${s.n} controlli)`;
    return `<g><title>${esc(label)}</title>${parts}</g>`;
  }).join('');
  return `<svg class="rchart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${bars}</svg>${phaseLegend()}<div class="small muted">Tempo medio per fase, un blocco per ${granularity === 'day' ? 'giorno' : 'ora'}. Scala fino a ${Math.round(max)} ms.</div>`;
}

const kv = (k, v) => (v == null || v === '' ? '' : `<div class="kv"><span>${k}</span><b>${v}</b></div>`);

// RF-RIS-21: everything needed to understand a run without repeating it
function runDetailHtml(d) {
  const p = d.phases;
  const cert = d.tls && d.tls.cert;
  const hdr = d.headers ? Object.entries(d.headers) : [];
  return `
    <div class="panel"><div class="row">${OUTCOME_TAG(d.outcome)} <b>${d.status ? `HTTP ${d.status}` : 'nessuna risposta'}</b> <span>${d.ms ?? '—'} ms</span> <span class="muted">${esc(fmtDate(d.at))} · località ${esc(locLabel(d.location) || 'predefinita')}${d.attempts > 1 ? ` · ${d.attempts} tentativi` : ''}</span></div>
      ${d.error ? `<div class="${d.outcome === 'error' ? 'sev-e' : 'muted'}" style="margin-top:6px">${esc(d.error)}</div>` : ''}
      <div class="kvs">${kv('Richiesta', `${esc(d.method || 'GET')} <span class="mono">${esc(d.url || '')}</span>`)}${d.finalUrl && d.finalUrl !== d.url ? kv('Indirizzo finale', `<span class="mono">${esc(d.finalUrl)}</span>`) : ''}${kv('Indirizzo IP', d.ip ? `<span class="mono">${esc(d.ip)}</span>` : '')}${kv('TLS', d.tls ? `${esc(d.tls.protocol || '')}${d.tls.authorized === false ? ' <span class="tag error">certificato non valido</span>' : ''}` : '')}${cert ? kv('Certificato', `${esc(cert.issuer || '')} · scade il ${esc(new Date(cert.expiresAt).toLocaleDateString('it-IT'))}${cert.names && cert.names.length ? `<br><span class="muted small">${esc(cert.names.slice(0, 6).join(', '))}</span>` : ''}`) : ''}</div></div>
    ${p ? `<div class="panel"><h3>Fasi della richiesta</h3>${phaseBar(p, p.totalMs || 1)}<table class="phases"><tbody>${PHASE_META.map(([k, l, c]) => `<tr><td><i class="dot" style="background:${c}"></i>${l}</td><td class="num">${p[k] || 0} ms</td></tr>`).join('')}${p.redirectMs ? `<tr><td>Redirect precedenti</td><td class="num">${p.redirectMs} ms</td></tr>` : ''}<tr><th>Totale</th><td class="num"><b>${p.totalMs} ms</b></td></tr></tbody></table></div>` : ''}
    ${d.assertions && d.assertions.length ? `<div class="panel"><h3>Asserzioni</h3><ul class="plain">${d.assertions.map((a) => `<li>${a.ok ? '✅' : '❌'} ${esc(a.text)}${a.ok ? '' : ` — <span class="sev-e">${esc(a.message)}</span>`}</li>`).join('')}</ul></div>` : ''}
    ${d.chain && d.chain.length ? `<div class="panel"><h3>Redirect seguiti</h3><ol class="plain">${d.chain.map((c) => `<li><span class="tag">${c.status}</span> <span class="mono small">${esc(c.url)}</span></li>`).join('')}<li><span class="tag ok">${d.status || ''}</span> <span class="mono small">${esc(d.finalUrl || '')}</span></li></ol></div>` : ''}
    ${hdr.length ? `<div class="panel tablewrap"><h3>Header della risposta</h3><table class="phases"><tbody>${hdr.map(([k, v]) => `<tr><td class="mono small">${esc(k)}</td><td class="mono small" style="overflow-wrap:anywhere">${esc(v)}</td></tr>`).join('')}</tbody></table><p class="small muted">Cookie, token e chiavi sono mascherati.</p></div>` : ''}
    ${d.excerpt ? `<div class="panel"><h3>Inizio della risposta</h3><pre class="excerpt">${esc(d.excerpt)}</pre></div>` : ''}`;
}

async function viewRun(monitorId, runId) {
  const r = await api('GET', `monitors/${encodeURIComponent(monitorId)}/runs/${encodeURIComponent(runId)}`);
  if (!state.locInfo) state.locInfo = await api('GET', 'monitor-locations').catch(() => null);
  setView('monitoring');
  const light = r.run;
  app().innerHTML = `
    <div class="head"><div><h1>Run · ${esc(r.monitor.name)}</h1><div class="sub">${esc(fmtDate((r.detail || light).at))}</div></div>
      <div class="row"><a class="btn" href="#/monitor/${encodeURIComponent(monitorId)}">← Monitor</a></div></div>
    ${r.detail ? runDetailHtml(r.detail) : `<div class="panel"><div class="row">${OUTCOME_TAG(light.outcome)} <b>${light.status ? `HTTP ${light.status}` : ''}</b> <span>${light.ms ?? '—'} ms</span></div>${light.phases ? phaseBar(light.phases, light.phases.totalMs || 1) : ''}<p class="muted">Di questo run restano esito e tempi: il dettaglio completo si conserva per i run falliti e degradati e per uno riuscito ogni ora.</p></div>`}`;
}

function runQuery() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  return { period: q.get('period') || '24h', from: q.get('from') || '', to: q.get('to') || '', outcome: q.get('outcome') || '', retried: q.get('retried') || '', group: q.get('group') || '', page: q.get('page') || '1' };
}

// The «Esecuzioni» section of the monitor page: period, percentiles, groups, phases, filtered list
async function renderRunsSection(m) {
  const box = $('#runsSection');
  if (!box) return;
  const q = runQuery();
  const write = (patch) => {
    const next = { ...runQuery(), ...patch };
    if (!('page' in patch)) next.page = '1';
    const s = new URLSearchParams(Object.entries(next).filter(([k, v]) => v && !(k === 'period' && v === '24h') && !(k === 'page' && v === '1')));
    history.replaceState(null, '', `#/monitor/${encodeURIComponent(m.id)}${s.toString() ? `?${s}` : ''}`);
    renderRunsSection(m);
  };
  const params = new URLSearchParams({ period: q.period, ...(q.period === 'custom' ? { from: q.from, to: q.to } : {}) });
  const listParams = new URLSearchParams(params);
  for (const [k, v] of Object.entries({ outcome: q.outcome, retried: q.retried, group: q.group, page: q.page })) if (v) listParams.set(k, v);
  let a, list;
  try {
    [a, list] = await Promise.all([api('GET', `monitors/${encodeURIComponent(m.id)}/analysis?${params}`), api('GET', `monitors/${encodeURIComponent(m.id)}/runs?${listParams}`)]);
  } catch (e) {
    box.innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
    return;
  }
  const k = a.kpis, rs = k.response;
  const outcomes = new Set(q.outcome ? q.outcome.split(',') : []);
  const scale = Math.max(1, ...list.runs.map((r) => (r.phases ? r.phases.totalMs : r.ms || 0)));
  box.innerHTML = `
    <div class="head"><h2 style="margin:0">Esecuzioni e diagnosi</h2>
      <div class="row">${RUN_PERIODS.map(([v, l]) => `<button class="btn small${q.period === v ? ' primary' : ''}" data-period="${v}">${l}</button>`).join('')}</div></div>
    ${q.period === 'custom' ? `<div class="row" style="margin-bottom:10px"><label class="f"><span>Dal</span><input type="date" id="rFrom" value="${esc(q.from)}"></label><label class="f"><span>Al</span><input type="date" id="rTo" value="${esc(q.to)}"></label><button class="btn small" id="rApply">Applica</button></div>` : ''}
    ${a.from < a.retentionFrom ? `<div class="notice warn small">I singoli run si conservano per ${Math.round((Date.now() - a.retentionFrom) / 864e5)} giorni: oltre, l'elenco e i gruppi di errori sono parziali; disponibilità e percentili restano dagli aggregati.</div>` : ''}
    <div class="stats">
      ${stat('Esecuzioni', fmtNum(a.runs.total), `${fmtNum(a.runs.ok)} riuscite · ${fmtNum(a.runs.degraded)} degradate · ${fmtNum(a.runs.failed)} fallite${a.runs.retried ? ` · ${a.runs.retried} con retry` : ''}`)}
      ${stat('Disponibilità', pct(k.availability), k.coverage != null && k.coverage < 0.99 ? `copertura ${Math.round(k.coverage * 100)}%` : '')}
      ${stat('Risposta p50 / p95 / p99', rs ? `${rs.p50} / ${rs.p95} / ${rs.p99} ms` : '—', rs ? `media ${rs.avg} ms${rs.approximate ? ' · approssimati' : ''}` : '')}
      ${stat('Fasi medie', a.phases.average ? `${PHASE_META.map(([key]) => a.phases.average[key]).reduce((s, x) => s + x, 0).toFixed(0)} ms` : '—', a.phases.average ? PHASE_META.map(([key, l]) => `${l} ${Math.round(a.phases.average[key])}`).join(' · ') : '')}
    </div>
    <div class="panel"><h3>Dove va il tempo</h3>${phasesChart(a.phases.series, a.phases.granularity)}</div>
    ${a.locations && a.locations.some((l) => l.location !== '—') ? `<div class="panel tablewrap"><h3>Per località</h3><table><thead><tr><th>Località</th><th class="num">Esecuzioni</th><th class="num">Disponibilità</th><th class="num">p50</th><th class="num">p95</th><th class="num">p99</th><th class="num">Guasti locali</th></tr></thead><tbody>${a.locations.map((l) => `<tr><td><b>${esc(locLabel(l.location))}</b></td><td class="num">${fmtNum(l.runs)}</td><td class="num">${l.availability == null ? '—' : pct(l.availability)}</td><td class="num">${l.p50 ?? '—'}</td><td class="num">${l.p95 ?? '—'}</td><td class="num">${l.p99 ?? '—'}</td><td class="num">${l.localFailures || 0}</td></tr>`).join('')}</tbody></table><p class="small muted">Un guasto visto da poche località non apre un incidente: è «guasto locale». La disponibilità qui è dei singoli run; quella del monitor, dei suoi incidenti.</p></div>` : ''}
    <div class="panel tablewrap"><h3>Errori raggruppati</h3>${a.groups.length ? `<table><thead><tr><th>Messaggio</th><th class="num">Volte</th><th>Prima volta</th><th>Ultima volta</th><th>Località</th></tr></thead><tbody>${a.groups.map((g) => `<tr class="${q.group === g.fingerprint ? 'on' : ''}"><td><a href="#" data-group="${esc(g.fingerprint)}">${esc(g.message)}</a>${g.normalized !== g.message ? `<div class="small muted">${esc(g.normalized)}</div>` : ''}</td><td class="num">${fmtNum(g.count)}</td><td>${esc(fmtDate(g.firstSeen))}</td><td>${esc(fmtDate(g.lastSeen))}</td><td class="small">${esc(g.locations.join(', '))}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small">Nessun errore nel periodo.</p>'}</div>
    <div class="panel"><div class="row" style="margin-bottom:8px">
      ${[['ok', 'Riusciti'], ['degraded', 'Degradati'], ['error', 'Falliti']].map(([v, l]) => `<label class="check"><input type="checkbox" data-outcome="${v}"${outcomes.has(v) ? ' checked' : ''}> ${l}</label>`).join('')}
      <label class="check"><input type="checkbox" id="fRetried"${q.retried ? ' checked' : ''}> con retry</label>
      ${q.group ? '<button class="btn small" id="fClearGroup">× gruppo di errori</button>' : ''}
      <span class="muted small">${fmtNum(list.total)} esecuzioni</span></div>
      ${list.runs.length ? `<div class="tablewrap"><table><thead><tr><th>Ora</th><th>Esito</th><th class="num">Status</th><th class="num">ms</th><th style="width:22%">Fasi</th><th>Dettaglio</th><th></th></tr></thead><tbody>${list.runs.map((r) => `<tr><td>${esc(fmtDate(r.at))}${r.location ? ` <span class="tag">${esc(locLabel(r.location))}</span>` : ''}</td><td>${OUTCOME_TAG(r.outcome)}${r.localFailure ? ' <span class="tag warn" data-tip="Visto solo da questa località: non apre un incidente">guasto locale</span>' : ''}</td><td class="num">${r.status ?? '—'}</td><td class="num">${r.ms ?? '—'}</td><td>${phaseBar(r.phases, scale)}</td><td class="small">${esc(r.error || '')}${r.retried ? ' <span class="muted">(ripetuto)</span>' : ''}</td><td>${r.hasDetail ? `<a class="small" href="#/run/${encodeURIComponent(m.id)}/${encodeURIComponent(r.id)}">dettaglio</a>` : ''}</td></tr>`).join('')}</tbody></table></div>
        <div class="row" style="justify-content:space-between;margin-top:8px"><span class="small muted">Pagina ${list.page} di ${list.pages}</span><span class="row"><button class="btn small" id="pPrev"${list.page <= 1 ? ' disabled' : ''}>← Più recenti</button><button class="btn small" id="pNext"${list.page >= list.pages ? ' disabled' : ''}>Meno recenti →</button></span></div>`
      : '<p class="muted">Nessuna esecuzione con questi filtri nel periodo.</p>'}</div>`;
  for (const b of $$('[data-period]', box)) b.onclick = () => write({ period: b.dataset.period, ...(b.dataset.period === 'custom' ? {} : { from: '', to: '' }), group: '' });
  const apply = $('#rApply', box);
  if (apply) apply.onclick = () => { if ($('#rFrom').value && $('#rTo').value) write({ from: $('#rFrom').value, to: $('#rTo').value }); else toast('Scegli le due date', true); };
  for (const c of $$('[data-outcome]', box)) c.onchange = () => write({ outcome: $$('[data-outcome]', box).filter((x) => x.checked).map((x) => x.dataset.outcome).join(',') });
  $('#fRetried', box).onchange = (e) => write({ retried: e.target.checked ? '1' : '' });
  for (const g of $$('[data-group]', box)) g.onclick = (e) => { e.preventDefault(); write({ group: q.group === g.dataset.group ? '' : g.dataset.group, outcome: 'error' }); };
  const cg = $('#fClearGroup', box);
  if (cg) cg.onclick = () => write({ group: '' });
  const prev = $('#pPrev', box), next = $('#pNext', box);
  if (prev) prev.onclick = () => write({ page: String(list.page - 1) });
  if (next) next.onclick = () => write({ page: String(list.page + 1) });
}

async function viewMonitor(id) {
  const m = await api('GET', `monitors/${encodeURIComponent(id)}`);
  if (!state.locInfo) state.locInfo = await api('GET', 'monitor-locations').catch(() => null);
  setView('monitoring');
  const P = [['24h', '24 ore'], ['7d', '7 giorni'], ['30d', '30 giorni'], ['90d', '90 giorni'], ['12m', '12 mesi'], ['month', 'Mese corrente']];
  const row = (label, f) => `<tr><th>${label}</th>${P.map(([k]) => `<td class="num">${f(m.periods[k])}</td>`).join('')}</tr>`;
  const cert = m.state.cert;
  app().innerHTML = `
    <div class="head"><div><h1>${esc(m.name)}</h1><div class="sub mono">${m.type === 'heartbeat' ? `Heartbeat: una chiamata ogni ${dur(m.expectedMin * 60000)}, tolleranza ${dur(m.toleranceMin * 60000)}` : m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">${esc(m.url)}</a>` : `${esc((TYPE_LABEL[m.type] || m.type))}: ${esc(m.target || '')}`}</div>
      <div class="row">${mstatusTag(m.status, m.muted)} ${healthTag(m.health)} <span class="muted small">${m.status === 'down' ? 'giù' : 'nello stato attuale'} da ${dur(Date.now() - (m.state.since || Date.now()))} · ogni ${m.intervalMin} min</span>${m.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div></div>
      <div class="row">${m.type === 'heartbeat' ? '' : `<button class="btn" id="mCheck"${m.paused ? ' disabled' : ''}>Controlla ora</button>`}${m.managedBy === 'code' ? '' : '<button class="btn" id="mEdit">Modifica</button>'}<button class="btn" id="mDup">Duplica</button><button class="btn" id="mCode">Esporta come codice</button>
        <button class="btn" id="mMute">${m.muted ? 'Riattiva avvisi' : 'Silenzia…'}</button>
        <button class="btn" id="mPause">${m.paused ? 'Riprendi' : 'Metti in pausa'}</button>${m.managedBy === 'code' ? '' : '<button class="btn danger" id="mDel">Elimina…</button>'}</div></div>
    ${m.type === 'heartbeat' ? heartbeatPanel(m) : ''}
    ${m.description ? `<div class="panel"><h3>Note per chi interviene</h3><div style="white-space:pre-wrap">${esc(m.description)}</div></div>` : ''}
    ${m.managedBy === 'code' ? '<div class="notice info">Gestito da codice (<span class="mono">sitescanner.monitors.yml</span>, id «' + esc(m.codeId) + '»): si modifica nel file e si applica con <span class="mono">sitescanner monitor apply</span>. Si può eseguire, silenziare, mettere in pausa e duplicare (la copia è libera).</div>' : ''}
    ${m.skipSsl ? '<div class="notice warn">Gli errori del certificato sono ignorati per questo monitor: un certificato non valido non viene segnalato come guasto.</div>' : ''}
    ${m.shouldFail ? '<div class="notice warn">Questo monitor è in modalità «la richiesta deve fallire»: è riuscito quando il sito risponde con un errore.</div>' : ''}
    ${m.health.reasons.length ? `<div class="notice ${m.health.level === 'critica' ? 'error' : 'warn'}">${esc(m.health.level === 'critica' ? 'Critica' : 'Attenzione')}: ${esc(m.health.reasons.join('; '))}</div>` : ''}
    ${m.state.lastError && m.status === 'down' ? `<div class="notice error">${esc(m.state.lastError.message)}</div>` : ''}
    <div class="stats">
      ${stat('Disponibilità 30 giorni', pct(m.k30.availability), `obiettivo ${pct(m.slaPct)}`)}
      ${stat('Budget di errore (mese)', m.budget.leftMs >= 0 ? `restano ${dur(m.budget.leftMs)}` : `<span class="sev-e">superato di ${dur(-m.budget.leftMs)}</span>`, `ammessi ${dur(m.budget.allowedMs)}`)}
      ${stat('Risposta (30 giorni)', m.k30.response ? `${m.k30.response.avg} ms` : '—', m.k30.response ? `p95 ${m.k30.response.p95} ms` : '')}
      ${m.type === 'ssl' && m.state.domain ? stat('Dominio', m.state.domain.expiresAt ? `${Math.round((m.state.domain.expiresAt - Date.now()) / 864e5)} giorni` : '—', m.state.domain.expiresAt ? esc(fmtDate(m.state.domain.expiresAt)) : esc(m.state.domain.error || '')) : m.type === 'heartbeat' ? stat('Prossima chiamata entro', m.nextDeadline ? esc(fmtDate(m.nextDeadline)) : '—', m.state.lastPingAt ? `ultima ${esc(fmtDate(m.state.lastPingAt))}` : 'nessuna ancora') : stat('Certificato', cert ? `${m.certDays < 0 ? 'scaduto' : `${m.certDays} giorni`}` : '—', cert ? esc(cert.issuer || '') : m.url.startsWith('https') ? 'non ancora letto' : 'non https')}
    </div>
    <div class="panel tablewrap"><h2>KPI</h2><table class="kpi"><thead><tr><th></th>${P.map(([, l]) => `<th class="num">${l}</th>`).join('')}</tr></thead><tbody>
      ${row('Disponibilità', (k) => pct(k.availability))}
      ${row('Downtime', (k) => dur(k.downtimeMs))}
      ${row('Incidenti', (k) => fmtNum(k.incidents))}
      ${row('MTTR', (k) => dur(k.mttrMs))}
      ${row('MTBF', (k) => dur(k.mtbfMs))}
      ${row('Incidente più lungo', (k) => (k.longest ? dur(k.longest.ms) : '—'))}
      ${row('Risposta media / p95', (k) => (k.response ? `${k.response.avg} / ${k.response.p95} ms` : '—'))}
      ${row('Copertura', (k) => (k.coverage == null ? '—' : `${Math.round(k.coverage * 100)}%`))}
    </tbody></table><p class="small muted">Copertura: parte del periodo effettivamente monitorata (pause, manutenzione e periodi senza giri non contano). Il p95 oltre l'ora corrente è calcolato dagli aggregati ed è approssimato.</p></div>
    <div class="panel"><h2>Tempo di risposta, ultimi 7 giorni</h2>${responseChart(m.responses7d)}</div>
    <div class="panel"><h2>Disponibilità giornaliera, ultimi 90 giorni</h2>${bars90(m.last90, Date.now())}<a class="small" href="/api/monitors/daily.csv?monitor=${encodeURIComponent(m.id)}">Esporta CSV ↓</a></div>
    <div class="grid2">
      <div class="panel tablewrap"><h2>Incidenti</h2>${m.incidents.length ? `<table><thead><tr><th>Inizio</th><th>Durata</th><th>Causa</th></tr></thead><tbody>${m.incidents.map((i) => `<tr><td><a href="#/incident/${encodeURIComponent(i.id)}">${esc(fmtDate(i.start))}</a></td><td>${dur(i.durationMs)}${i.end ? '' : ' <span class="tag error">in corso</span>'}</td><td>${esc(i.cause.message)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Nessun incidente</p>'}</div>
</div>
    <div id="runsSection"><p class="muted">Carico le esecuzioni…</p></div>`;
  renderRunsSection(m);
  if (m.type === 'heartbeat') for (const b of $$('[data-copy]')) b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copiato'); } catch { toast('Copia non riuscita: seleziona il testo', true); } };
  if ($('#mCheck')) $('#mCheck').onclick = async () => { try { await api('POST', `monitors/${m.id}/check`, {}); viewMonitor(id); } catch (e) { toast(e.message, true); } };
  if ($('#mEdit')) $('#mEdit').onclick = async () => { if (await editMonitorDialog(m)) viewMonitor(id); };
  $('#mCode').onclick = () => codeDialog([m.id]);
  if ($('#mEdit') && new URLSearchParams(location.hash.split('?')[1] || '').get('edit') === '1') {
    history.replaceState(null, '', `#/monitor/${encodeURIComponent(id)}`);
    $('#mEdit').click();
  }
  // RF-RIS-04: the copy is created and opened for editing (the URL is usually the one to change)
  $('#mDup').onclick = async () => {
    try {
      const copy = await api('POST', `monitors/${m.id}/duplicate`, {});
      toast(`Creata «${copy.name}»: modificala`);
      location.hash = `#/monitor/${encodeURIComponent(copy.id)}`;
      setTimeout(async () => { const fresh = await api('GET', `monitors/${encodeURIComponent(copy.id)}`); if (await editMonitorDialog(fresh)) viewMonitor(copy.id); }, 300);
    } catch (e) { toast(e.message, true); }
  };
  // RF-RIS-03
  $('#mMute').onclick = async () => {
    if (m.muted) {
      await api('POST', 'monitors/actions', { ids: [m.id], action: 'unmute' });
      return viewMonitor(id);
    }
    const fd = await formDialog({
      title: 'Silenzia gli avvisi',
      body: '<p>I controlli e gli incidenti continuano; non arrivano avvisi.</p><label class="f"><span>Per quanto tempo</span><select name="d"><option value="60">1 ora</option><option value="480">8 ore</option><option value="1440">24 ore</option><option value="0">fino alla riattivazione</option></select></label>',
      confirm: 'Silenzia',
    });
    if (!fd) return;
    await api('POST', 'monitors/actions', { ids: [m.id], action: 'mute', value: Number(fd.get('d')) });
    viewMonitor(id);
  };
  $('#mPause').onclick = async () => { await api('POST', 'monitors/actions', { ids: [m.id], action: m.paused ? 'resume' : 'pause' }); viewMonitor(id); };
  if ($('#mDel')) $('#mDel').onclick = async () => {
    const days = Math.max(1, Math.round((Date.now() - m.createdAt) / 864e5));
    const ok = await formDialog({ title: `Eliminare «${m.name}»?`, body: `<p>Si perdono ${days} giorni di storico: controlli, incidenti e KPI.</p>`, confirm: 'Elimina', danger: true });
    if (!ok) return;
    await api('DELETE', `monitors/${m.id}`);
    toast('Monitor eliminato');
    location.hash = '#/monitoring';
  };
}

async function viewIncident(id) {
  const i = await api('GET', `incidents/${encodeURIComponent(id)}`);
  setView('monitoring');
  const m = i.monitor;
  app().innerHTML = `
    <div class="head"><div><h1>Incidente${m ? ` · ${esc(m.name)}` : ''}</h1><div class="sub">${esc(fmtDate(i.start))} → ${i.end ? esc(fmtDate(i.end)) : '<b>in corso</b>'} · ${dur(i.durationMs)}${i.closedBy === 'paused' ? ' · chiuso mettendo in pausa il monitor' : ''}</div></div>
      <div class="row">${m ? `<a class="btn" href="#/monitor/${encodeURIComponent(m.id)}">Monitor</a>` : ''}${m ? '<button class="btn" id="iComm">Comunica ai clienti…</button>' : ''}${m && m.source && i.end ? `<button class="btn primary" id="iScan">Lancia una scan</button>` : ''}</div></div>
    <div class="grid2">
      <div class="panel"><h2>Cause</h2><ul class="plain">${i.causes.map((c) => `<li><span class="muted small">${esc(fmtDate(c.at))}</span> ${esc(c.message)}</li>`).join('')}</ul>
        ${i.excerpt ? `<h3>Risposta del server</h3><pre class="excerpt">${esc(i.excerpt)}</pre>` : ''}</div>
      <div class="panel"><h2>Avvisi</h2>${i.events.length ? `<ul class="plain">${i.events.map((e) => `<li><b>${esc(e.type)}</b> <span class="muted small">${esc(fmtDate(e.at))}</span> ${e.deliveries ? e.deliveries.map((x) => `<span class="tag ${x.ok ? 'ok' : 'error'}">${esc(x.channel)}</span>`).join(' ') : `<span class="muted small">${esc(EVENT_STATUS[e.status] || e.status)}</span>`}</li>`).join('')}</ul>` : '<p class="muted small">Nessun avviso registrato</p>'}</div>
    </div>
    ${i.firstRun ? `<h2>Primo run fallito</h2>${runDetailHtml(i.firstRun)}` : ''}
    <form class="panel form" id="iNote"><h2>Nota</h2><textarea class="input" name="note" rows="3" placeholder="Cosa è successo, cosa è stato fatto…">${esc(i.note || '')}</textarea><div class="row"><button class="btn primary">Salva nota</button></div></form>
    <div class="panel tablewrap"><h2>Controlli</h2><table><thead><tr><th>Ora</th><th>Esito</th><th class="num">ms</th><th>Dettaglio</th></tr></thead><tbody>${i.checks.map((c) => `<tr><td>${esc(fmtDate(c.at))}</td><td><span class="tag ${c.outcome === 'error' ? 'error' : 'ok'}">${c.outcome === 'error' ? 'errore' : 'ok'}</span></td><td class="num">${c.ms ?? '—'}</td><td class="small">${esc(c.error || (c.status ? `HTTP ${c.status}` : ''))}</td></tr>`).join('')}</tbody></table></div>`;
  $('#iNote').onsubmit = async (e) => { e.preventDefault(); await api('PUT', `incidents/${i.id}`, { note: e.target.note.value }); toast('Nota salvata'); };
  // RF-PUB-02: the incident suggests a communication for the pages that use this monitor, it publishes nothing by itself
  const comm = $('#iComm');
  if (comm) comm.onclick = async () => {
    const pages = (await api('GET', 'statuspages')).filter((p) => p.components.some((c) => c.monitorIds.includes(m.id)));
    if (!pages.length) return toast('Nessuna status page usa questo monitor: creane una dalla pagina «Stato pubblico»', true);
    const page = pages[0];
    const comps = page.components.filter((c) => c.monitorIds.includes(m.id));
    communicationsDialog(page, { prefill: { title: `${comps.map((c) => c.name).join(', ')}: problema in corso`, components: comps.map((c) => c.id), text: 'Stiamo verificando un problema. Aggiorneremo questa pagina appena possibile.', incidentId: i.id } });
  };
  const scan = $('#iScan');
  // RF-MON-31: verify what changed after the site came back
  if (scan) scan.onclick = async () => { try { await startJob({ type: 'scan', site: m.source.site, env: m.source.env, label: `dopo incidente ${new Date(i.start).toLocaleDateString('it-IT')}` }); toast('Scan avviata'); } catch (x) { toast(x.message, true); } };
}

const EVENT_STATUS = { pending: 'da inviare', sent: 'inviato', failed: 'non consegnato', suppressed: 'non inviato', delayed: 'in attesa del ritardo' };
const WEEKDAYS = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];

async function viewMaintenance() {
  const [windows, monitors] = await Promise.all([api('GET', 'maintenance'), api('GET', 'monitors')]);
  setView('monitoring');
  const names = new Map(monitors.map((m) => [m.id, m.name]));
  const when = (w) => (w.type === 'once' ? esc(fmtDate(w.start)) : w.type === 'weekly' ? `ogni ${w.days.map((d) => WEEKDAYS[d]).join(', ')} alle ${esc(w.time)}` : w.type === 'repeat' ? `dal ${esc(fmtDate(w.start))}, ogni ${w.every === 1 ? '' : `${w.every} `}${{ day: w.every === 1 ? 'giorno' : 'giorni', week: w.every === 1 ? 'settimana' : 'settimane', month: w.every === 1 ? 'mese' : 'mesi' }[w.unit]}${w.until ? `, fino al ${esc(fmtDate(w.until))}` : ''}` : `il giorno ${w.dayOfMonth} di ogni mese alle ${esc(w.time)}`);
  app().innerHTML = `${monTabs('maintenance')}
    <div class="head"><div><h1>Manutenzione</h1><div class="sub">Durante una finestra i controlli continuano ma non aprono incidenti né mandano avvisi, e quel tempo non conta nei KPI.</div></div>
      <div class="row"><a class="btn" href="#/monitoring">← Monitoraggio</a><button class="btn primary" id="wNew">+ Nuova finestra</button></div></div>
    <div class="panel tablewrap">${windows.length ? `<table><thead><tr><th>Nome</th><th>Quando</th><th>Durata</th><th>Monitor</th><th></th></tr></thead><tbody>${windows.map((w) => `<tr><td><b>${esc(w.name)}</b>${w.endedAt ? ' <span class="tag">chiusa</span>' : ''}</td><td>${when(w)}</td><td>${dur(w.durationMin * 60000)}</td>
      <td>${[...w.tags.map((t) => `<span class="tag">tag ${esc(t)}</span>`), ...w.monitorIds.map((x) => esc(names.get(x) || x))].join(', ')}</td>
      <td><div class="row">${!w.endedAt ? `<button class="btn small" data-wend="${esc(w.id)}">Chiudi ora</button>` : ''}<button class="btn small danger" data-wdel="${esc(w.id)}">Elimina</button></div></td></tr>`).join('')}</tbody></table>` : '<p class="empty">Nessuna finestra di manutenzione. Sono facoltative.</p>'}</div>`;
  for (const b of $$('[data-wend]')) b.onclick = async () => { await api('POST', `maintenance/${b.dataset.wend}/end`, {}); viewMaintenance(); };
  for (const b of $$('[data-wdel]')) b.onclick = async () => { await api('DELETE', `maintenance/${b.dataset.wdel}`); viewMaintenance(); };
  $('#wNew').onclick = async () => {
    const tags = [...new Set(monitors.flatMap((m) => m.tags))];
    const fd = await formDialog({
      title: 'Nuova finestra di manutenzione',
      body: `<label class="f"><span>Nome</span><input type="text" name="name" required placeholder="Rilascio settimanale"></label>
        <div class="fields"><label class="f"><span>Tipo</span><select name="type"><option value="once">una volta</option><option value="weekly">ogni settimana</option><option value="monthly">ogni mese</option><option value="repeat">si ripete ogni N giorni, settimane o mesi</option></select></label>
        <label class="f"><span>Inizio (una volta, o la prima volta)</span><input type="datetime-local" name="start"></label>
        <label class="f"><span>Si ripete ogni</span><input type="number" name="every" min="1" max="365" value="1"></label>
        <label class="f"><span>Unità</span><select name="unit"><option value="day">giorni</option><option value="week">settimane</option><option value="month">mesi</option></select></label>
        <label class="f"><span>Fino al (vuoto = per sempre)</span><input type="date" name="until"></label>
        <label class="f"><span>Ora (ricorrente)</span><input type="time" name="time" value="22:00"></label>
        <label class="f"><span>Giorno del mese</span><input type="number" name="dayOfMonth" min="1" max="31" value="1"></label>
        <label class="f"><span>Durata (min)</span><input type="number" name="durationMin" min="5" max="1440" value="60"></label></div>
        <div class="row small">${WEEKDAYS.map((d, i) => `<label class="check"><input type="checkbox" name="day" value="${i}"> ${d}</label>`).join('')}</div>
        <label class="f"><span>Tag (vale anche per i monitor aggiunti dopo)</span><select name="tag"><option value="">—</option>${tags.map((t) => `<option>${esc(t)}</option>`).join('')}</select></label>
        <label class="f"><span>Oppure i monitor</span><select name="monitorIds" multiple size="6">${monitors.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select></label>`,
      confirm: 'Crea',
      submit: (f) => api('POST', 'maintenance', {
        name: f.get('name'), type: f.get('type'), start: f.get('start') ? new Date(f.get('start')).getTime() : null, every: Number(f.get('every')), unit: f.get('unit'), until: f.get('until') || null, time: f.get('time'), dayOfMonth: Number(f.get('dayOfMonth')),
        durationMin: Number(f.get('durationMin')), days: f.getAll('day').map(Number), tags: f.get('tag') ? [f.get('tag')] : [], monitorIds: f.getAll('monitorIds'),
      }),
    });
    if (fd) viewMaintenance();
  };
}

// RF-MON-30: the monitors of a site's environments, on the site page
async function siteMonitors(d) {
  if (!monitoringOn() || !d.config) return;
  const monitors = await api('GET', 'monitoring').then((x) => x.monitors).catch(() => []);
  const urls = new Set(Object.values(d.config.envs).map((e) => e.baseUrl));
  const mine = monitors.filter((m) => urls.has(m.url) || (m.source && m.source.site === d.id));
  const box = document.createElement('div');
  box.className = 'panel';
  box.innerHTML = `<h3>Monitoraggio</h3>${mine.length ? mine.map((m) => `<div class="row"><a href="#/monitor/${encodeURIComponent(m.id)}">${esc(m.name)}</a> ${mstatusTag(m.status)} <span class="small muted">${pct(m.k30.availability)} a 30 giorni</span></div>`).join('') : '<p class="small muted">Nessun monitor per gli ambienti di questo sito. <a href="#/monitoring">Aggiungili dal monitoraggio</a> («Da un sito»).</p>'}`;
  const body = $('#tabBody');
  if (body) body.before(box);
}

// ---- notifications (spec §12.5) ----
const CH_TYPE = { email: 'Email', slack: 'Slack', telegram: 'Telegram', teams: 'Microsoft Teams', discord: 'Discord', webhook: 'Webhook' };
const CH_STATUS = { active: ['attivo', 'ok'], pending: ['da confermare', 'warn'], error: ['in errore', 'error'] };

// ---- navigation inside the monitoring section (RNF-40: few entries) ----
// RNF-40: the section has at most 8 entries; the main ones are tabs, the rest is under «Altro»
const MON_TABS = [['monitoring', 'Panoramica', '#/monitoring'], ['problems', 'Nuovi problemi', '#/problems'], ['history', 'Cronologia', '#/history'], ['maintenance', 'Manutenzione', '#/maintenance'], ['notifications', 'Notifiche', '#/notifications']];
/** The name of a location: the private ones («Privata · Sede») are only known by the list of the workspace. */
const locLabel = (id) => { const l = state.locInfo && state.locInfo.locations.find((x) => x.id === id); return l ? l.name : id; };
const MON_MORE = [['log', 'Registro avvisi', '#/log'], ['agents', 'Agenti', '#/agents'], ['variables', 'Variabili', '#/variables'], ['tags', 'Tag', '#/tags'], ['public', 'Stato pubblico', '#/public'], ['report', 'Report', '#/report']];
const monTabs = (on) => `<nav class="tabs">${MON_TABS.map(([k, l, h]) => `<a href="${h}" class="${k === on ? 'on' : ''}">${l}</a>`).join('')}<details class="tabmore${MON_MORE.some(([k]) => k === on) ? ' on' : ''}"><summary>${(MON_MORE.find(([k]) => k === on) || [null, 'Altro'])[1]} ▾</summary><div class="menupop">${MON_MORE.map(([k, l, h]) => `<a href="${h}" class="${k === on ? 'on' : ''}">${l}</a>`).join('')}</div></details></nav>`;

const KIND_LABELS = { down: 'Giù', up: 'Di nuovo su', degraded: 'Degradato', cert: 'Certificato e dominio', maintenance: 'Manutenzione', heartbeat: 'Heartbeat mancato' };
const KINDS = Object.keys(KIND_LABELS);

/** Fields of an alert policy (RF-ALR-01/02), for the account and for a single monitor. */
function policyFields(p, { kinds = null } = {}) {
  return `<label class="f"><span>Avvisa</span><select name="pol_mode"><option value="failures"${p.mode === 'failures' ? ' selected' : ''}>dopo N run falliti di fila</option><option value="minutes"${p.mode === 'minutes' ? ' selected' : ''}>quando è giù da più di X minuti</option></select></label>
    <label class="f"><span>Run falliti di fila (1–5)</span><input type="number" name="pol_failures" min="1" max="5" value="${p.failures}"></label>
    <label class="f"><span>Minuti giù (0–60)</span><input type="number" name="pol_minutes" min="0" max="60" value="${p.minutes}"></label>
    <label class="f"><span>Con più località: giù se falliscono almeno (%)</span><input type="number" name="pol_locPct" min="1" max="100" value="${p.locationPct ?? 50}"></label>
    <label class="f"><span>Promemoria al massimo (0–10)</span><input type="number" name="pol_remMax" min="0" max="10" value="${p.reminders.max}"></label>
    <label class="f"><span>Promemoria ogni (10–240 min)</span><input type="number" name="pol_remEvery" min="10" max="240" value="${p.reminders.everyMin}"></label>
    ${kinds ? `<fieldset class="f wide"><span>Eventi per questo monitor (nessuno selezionato = quelli di ogni canale)</span><div class="row">${KINDS.map((k) => `<label class="check"><input type="checkbox" name="pol_kind" value="${k}"${(p.events || []).includes(k) ? ' checked' : ''}> ${KIND_LABELS[k]}</label>`).join('')}</div></fieldset>` : ''}`;
}

function readPolicy(fd, { kinds = false } = {}) {
  const events = fd.getAll('pol_kind');
  return {
    mode: fd.get('pol_mode'), failures: Number(fd.get('pol_failures')), minutes: Number(fd.get('pol_minutes')), locationPct: Number(fd.get('pol_locPct') || 50),
    reminders: { max: Number(fd.get('pol_remMax')), everyMin: Number(fd.get('pol_remEvery')) }, ...(kinds ? { events: events.length ? events : null } : {}),
  };
}

const DEFAULT_POLICY_UI = { mode: 'failures', failures: 1, minutes: 0, locationPct: 50, reminders: { max: 0, everyMin: 60 } };

const EVENT_LABEL = {
  down: ['🔴 giù', 'error'], up: ['🟢 di nuovo su', 'ok'], reminder: ['🔴 ancora giù', 'error'], degraded: ['🟠 degradato', 'warn'], slow: ['🟠 degradato', 'warn'], cert: ['🔐 certificato in scadenza', 'warn'],
  'cert-expired': ['⛔ certificato scaduto', 'error'], 'maintenance-start': ['🛠 manutenzione iniziata', 'info'], 'maintenance-end': ['🛠 manutenzione finita', 'info'],
  'monitor-change': ['✏️ modifica', ''], 'ci-test': ['🧪 test da CI', 'info'], 'ci-apply': ['🧩 apply da CI', 'info'], 'heartbeat-missed': ['💔 heartbeat mancato', 'error'], 'agent-missed': ['🛰 agente fermo', 'error'], 'agent-back': ['🛰 agente di nuovo collegato', 'info'], test: ['✅ prova', ''],
};
const eventTag = (type) => { const [l, c] = EVENT_LABEL[type] || [type, '']; return `<span class="tag ${c}">${l}</span>`; };
const timeOf = (t, tz) => new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: tz });
const dayLabel = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

// ---- Public status: status pages, TV dashboard, badges (spec §13.11) ----
const PUB_STATUS = { operational: ['Operativo', 'ok'], degraded: ['Prestazioni ridotte', 'warn'], maintenance: ['In manutenzione', 'info'], outage: ['Non disponibile', 'error'], unknown: ['Nessun dato', ''] };
const UPDATE_STATUS = { investigating: 'In analisi', identified: 'Identificato', monitoring: 'In osservazione', resolved: 'Risolto' };

const copyBtn = (text, label = 'Copia') => `<button type="button" class="btn small" data-copy="${esc(text)}">${label}</button>`;
function wireCopy(root = document) {
  for (const b of $$('[data-copy]', root)) b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copiato'); } catch { toast('Copia non riuscita: seleziona il testo', true); } };
}

async function viewPublic() {
  const [pages, links, monitors] = await Promise.all([api('GET', 'statuspages'), api('GET', 'public-links'), api('GET', 'monitors')]);
  setView('monitoring');
  const nameOf = new Map(monitors.map((m) => [m.id, m.name]));
  const tvs = links.filter((l) => l.kind === 'tv');
  const badges = links.filter((l) => l.kind === 'badge');
  const targetName = (l) => (l.target.monitorId ? nameOf.get(l.target.monitorId) || '(monitor eliminato)' : (() => { const p = pages.find((x) => x.id === l.target.pageId); const c = p && p.components.find((x) => x.id === l.target.componentId); return p && c ? `${p.name} · ${c.name}` : '(eliminato)'; })());
  app().innerHTML = `${monTabs('public')}
    <div class="head"><div><h1>Stato pubblico</h1><div class="sub">Quello che i clienti possono vedere senza un account: una <b>status page</b> con i servizi e le comunicazioni scritte da voi, una <b>dashboard TV</b> per lo schermo dell'ufficio, i <b>badge</b> per i README. Non mostrano mai indirizzi interni, cause tecniche, IP né header.</div></div>
      <div class="row"><button class="btn primary" id="spNew"${monitors.length ? '' : ' disabled'}>+ Nuova status page</button></div></div>
    ${monitors.length ? '' : '<p class="empty">Aggiungi prima qualche monitor: ogni componente della pagina ne usa uno o più.</p>'}
    ${pages.map((p) => `<div class="panel" data-page="${esc(p.id)}"><div class="row between"><div><h2>${esc(p.name)} ${p.hasPassword ? '<span class="tag warn">con password</span>' : ''} ${p.noindex ? '' : '<span class="tag">indicizzabile</span>'}</h2>
        <div class="small"><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a> ${copyBtn(p.url)}${p.customUrl ? ` · <a href="${esc(p.customUrl)}" target="_blank" rel="noopener">${esc(p.customUrl)}</a>` : ''}</div>
        <div class="small muted">${p.components.map((c) => `${esc(c.name)} (${c.monitorIds.length} monitor)`).join(' · ')}</div></div>
        <div class="row"><button class="btn small" data-comm="${esc(p.id)}">Comunicazioni</button><button class="btn small" data-spedit="${esc(p.id)}">Modifica</button><button class="btn small danger" data-spdel="${esc(p.id)}">Elimina</button></div></div></div>`).join('')}
    ${pages.length ? '' : '<p class="empty">Nessuna status page. Serve a dire ai clienti «il sito funziona» senza che vi chiamino, e «stiamo lavorando» quando non funziona.</p>'}
    <div class="panel"><div class="row between"><h2>Dashboard TV</h2><button class="btn small" id="tvNew">+ Nuovo link</button></div><p class="small muted">Una pagina a schermo intero per l'ufficio: i monitor dei tag scelti, i guasti in testa, aggiornata ogni 30 secondi. Il link è segreto: chi ce l'ha la vede, e si revoca.</p>
      ${tvs.length ? `<table><tbody>${tvs.map((l) => `<tr><td><b>${esc(l.name)}</b><div class="small muted">${l.tags.length ? `tag ${l.tags.map(esc).join(', ')}` : 'tutti i monitor'}</div></td><td class="small"><a href="${esc(l.url)}" target="_blank" rel="noopener">apri</a> ${copyBtn(l.url, 'Copia il link')}</td><td><button class="btn small danger" data-ldel="${esc(l.token)}">Revoca</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted small">Nessun link.</p>'}</div>
    <div class="panel"><div class="row between"><h2>Badge</h2><button class="btn small" id="bgNew">+ Nuovo badge</button></div><p class="small muted">Un'immagine «stato · su · 99,98%» per il README di un progetto o la pagina interna di un cliente.</p>
      ${badges.length ? `<table><tbody>${badges.map((l) => `<tr><td><img src="${esc(l.url)}" alt="badge" height="20"></td><td><b>${esc(targetName(l))}</b></td><td class="small">${copyBtn(l.markdown, 'Copia Markdown')} ${copyBtn(l.url, 'Copia l\'indirizzo')}</td><td><button class="btn small danger" data-ldel="${esc(l.token)}">Elimina</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted small">Nessun badge.</p>'}</div>`;
  wireCopy();
  const reload = () => viewPublic();
  const editPage = async (p) => {
    const monOpts = (sel) => monitors.map((m) => `<option value="${esc(m.id)}"${sel.includes(m.id) ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
    const compRow = (c = { name: '', monitorIds: [] }) => `<div class="row comprow"><input class="input" name="cname" placeholder="Sito, Area riservata, API…" maxlength="60" value="${esc(c.name)}"><select name="cmon" multiple size="3" aria-label="Monitor del componente">${monOpts(c.monitorIds)}</select><input type="hidden" name="cid" value="${esc(c.id || '')}"><button type="button" class="btn small danger" data-crm aria-label="Togli">×</button></div>`;
    const fd = await formDialog({
      title: p ? `Modifica «${p.name}»` : 'Nuova status page', confirm: p ? 'Salva' : 'Crea',
      body: `<label class="f"><span>Nome</span><input type="text" name="name" required maxlength="80" value="${esc(p ? p.name : '')}" placeholder="Acme · stato dei servizi"></label>
        <label class="f"><span>Indirizzo (${esc(location.origin)}/status/…)</span><input type="text" name="slug" required pattern="[a-z0-9][a-z0-9\\-]{2,39}" value="${esc(p ? p.slug : '')}" placeholder="acme"></label>
        <fieldset class="f"><span>Componenti: quello che il cliente vede (stato = il peggiore dei monitor)</span><div id="comps">${(p ? p.components : [{ name: '', monitorIds: [] }]).map(compRow).join('')}</div><button type="button" class="btn small" id="addComp">+ Componente</button></fieldset>
        <details class="adv"><summary>Altre impostazioni</summary><div class="fields">
          <label class="f wide"><span>Descrizione</span><input type="text" name="description" maxlength="300" value="${esc(p ? p.description : '')}"></label>
          <label class="f"><span>Sito del cliente (link)</span><input type="url" name="siteUrl" value="${esc(p ? p.siteUrl : '')}" placeholder="https://www.acme.it/"></label>
          <label class="f"><span>Logo (indirizzo dell'immagine)</span><input type="url" name="logoUrl" value="${esc(p ? p.logoUrl : '')}"></label>
          <label class="f"><span>Dominio personalizzato</span><input type="text" name="customDomain" value="${esc(p && p.customDomain ? p.customDomain : '')}" placeholder="status.cliente.it"><small>Si imposta un CNAME verso la deployment e si aggiunge il dominio al progetto Vercel (vedi README).</small></label>
          <label class="f"><span>Password (${p && p.hasPassword ? 'lascia vuoto per non cambiarla' : 'facoltativa'})</span><input type="password" name="password" autocomplete="new-password" minlength="8"></label>
          ${p && p.hasPassword ? '<label class="check"><input type="checkbox" name="clearPassword"> togli la password</label>' : ''}
          <label class="check"><input type="checkbox" name="noindex"${!p || p.noindex ? ' checked' : ''}> nascondi ai motori di ricerca</label></div></details>`,
      setup: (dlg) => {
        const box = dlg.querySelector('#comps');
        const wire = () => { for (const b of dlg.querySelectorAll('[data-crm]')) b.onclick = () => { if (box.children.length > 1) b.closest('.comprow').remove(); }; };
        dlg.querySelector('#addComp').onclick = () => { box.insertAdjacentHTML('beforeend', compRow()); wire(); };
        wire();
      },
      submit: async (f) => {
        const names = f.getAll('cname'), ids = f.getAll('cid');
        const mons = [...document.querySelectorAll('dialog [name=cmon]')].map((s) => [...s.selectedOptions].map((o) => o.value));
        const body = {
          name: f.get('name'), slug: f.get('slug'), description: f.get('description'), siteUrl: f.get('siteUrl'), logoUrl: f.get('logoUrl'), customDomain: f.get('customDomain'), noindex: f.get('noindex') === 'on',
          components: names.map((name, i) => ({ id: ids[i] || undefined, name, monitorIds: mons[i] || [] })), ...(f.get('password') ? { password: f.get('password') } : {}), ...(f.get('clearPassword') === 'on' ? { clearPassword: true } : {}),
        };
        await (p ? api('PUT', `statuspages/${p.id}`, body) : api('POST', 'statuspages', body));
      },
    });
    if (fd) { toast('Status page salvata'); reload(); }
  };
  $('#spNew').onclick = () => editPage(null);
  for (const b of $$('[data-spedit]')) b.onclick = () => editPage(pages.find((x) => x.id === b.dataset.spedit));
  for (const b of $$('[data-spdel]')) b.onclick = async () => {
    const p = pages.find((x) => x.id === b.dataset.spdel);
    const ok = await formDialog({ title: `Eliminare «${p.name}»?`, body: '<p>La pagina smette di esistere, con le sue comunicazioni e i badge dei suoi componenti.</p>', confirm: 'Elimina', danger: true, submit: async () => { await api('DELETE', `statuspages/${p.id}`); } });
    if (ok) reload();
  };
  for (const b of $$('[data-comm]')) b.onclick = () => communicationsDialog(pages.find((x) => x.id === b.dataset.comm));
  for (const b of $$('[data-ldel]')) b.onclick = async () => { await api('DELETE', `public-links/${b.dataset.ldel}`); reload(); };
  $('#tvNew').onclick = async () => {
    const tags = [...new Set(monitors.flatMap((m) => m.tags))].sort();
    const fd = await formDialog({
      title: 'Nuova dashboard TV', confirm: 'Crea il link',
      body: `<label class="f"><span>Nome</span><input type="text" name="name" maxlength="60" value="Stato dei servizi"></label>
        <fieldset class="f"><span>Tag da mostrare (nessuno = tutti i monitor)</span><div class="row">${tags.map((t) => `<label class="check"><input type="checkbox" name="tag" value="${esc(t)}"> ${esc(t)}</label>`).join('') || '<span class="muted small">Nessun tag</span>'}</div></fieldset>`,
      submit: async (f) => { await api('POST', 'public-links', { kind: 'tv', name: f.get('name'), tags: f.getAll('tag') }); },
    });
    if (fd) reload();
  };
  $('#bgNew').onclick = async () => {
    const targets = [...monitors.map((m) => [`m:${m.id}`, `Monitor · ${m.name}`]), ...pages.flatMap((p) => p.components.map((c) => [`c:${p.id}:${c.id}`, `Componente · ${p.name} · ${c.name}`]))];
    const fd = await formDialog({
      title: 'Nuovo badge', confirm: 'Crea',
      body: `<label class="f"><span>Per</span><select name="t">${targets.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select></label>`,
      submit: async (f) => {
        const [k, a, b2] = f.get('t').split(':');
        await api('POST', 'public-links', k === 'm' ? { kind: 'badge', monitorId: a } : { kind: 'badge', pageId: a, componentId: b2 });
      },
    });
    if (fd) reload();
  };
}

/** The communications of a page (RF-PUB-02): the team writes them, a technical incident publishes nothing by itself. */
async function communicationsDialog(page, { prefill = null } = {}) {
  const list = await api('GET', `statuspages/${page.id}/communications`);
  const compOpts = page.components.map((c) => `<label class="check"><input type="checkbox" name="comp" value="${esc(c.id)}"${prefill && prefill.components && prefill.components.includes(c.id) ? ' checked' : ''}> ${esc(c.name)}</label>`).join('');
  const statusOpts = (sel) => Object.entries(UPDATE_STATUS).map(([k, l]) => `<option value="${k}"${sel === k ? ' selected' : ''}>${l}</option>`).join('');
  await formDialog({
    title: `Comunicazioni · ${page.name}`, confirm: 'Chiudi', cancel: false,
    body: `<div class="comm-new"><h3>Nuova comunicazione</h3>
        <label class="f"><span>Titolo</span><input type="text" name="title" maxlength="120" value="${esc(prefill ? prefill.title : '')}" placeholder="Il sito è raggiungibile a intermittenza"></label>
        <label class="f"><span>Stato</span><select name="status">${statusOpts('investigating')}</select></label>
        <fieldset class="f"><span>Servizi coinvolti</span><div class="row">${compOpts}</div></fieldset>
        <label class="f"><span>Testo (lo leggono i clienti: niente dettagli interni)</span><textarea name="text" rows="3" maxlength="2000">${esc(prefill ? prefill.text : '')}</textarea></label>
        <div class="row"><button type="button" class="btn primary" data-publish>Pubblica</button></div></div>
      <h3>Pubblicate</h3>${list.length ? list.map((u) => `<div class="panel" data-comm-id="${esc(u.id)}"><div class="row between"><b>${esc(u.title)}</b><span><span class="tag ${u.status === 'resolved' ? 'ok' : 'warn'}">${UPDATE_STATUS[u.status]}</span> <button type="button" class="btn small danger" data-cdel="${esc(u.id)}">Elimina</button></span></div>
        ${u.posts.slice().reverse().map((p) => `<div class="small"><span class="muted">${esc(fmtDate(p.at))} · ${UPDATE_STATUS[p.status]}${p.by ? ` · ${esc(p.by)}` : ''}</span><br>${esc(p.text)}</div>`).join('')}
        ${u.status === 'resolved' ? '' : `<div class="row" style="margin-top:6px"><select data-pstatus>${statusOpts(u.status)}</select><input class="input" data-ptext placeholder="Aggiornamento" style="flex:1"><button type="button" class="btn small" data-post>Aggiorna</button></div>`}</div>`).join('') : '<p class="muted small">Nessuna comunicazione.</p>'}`,
    setup: (dlg) => {
      const redo = () => { dlg.close(''); communicationsDialog(page); };
      dlg.querySelector('[data-publish]').onclick = async () => {
        const g = (n) => dlg.querySelector(`[name=${n}]`);
        try {
          await api('POST', `statuspages/${page.id}/communications`, { title: g('title').value, status: g('status').value, text: g('text').value, components: [...dlg.querySelectorAll('[name=comp]:checked')].map((c) => c.value), ...(prefill && prefill.incidentId ? { incidentId: prefill.incidentId } : {}) });
          toast('Comunicazione pubblicata');
          redo();
        } catch (e) { toast(e.message, true); }
      };
      for (const b of dlg.querySelectorAll('[data-post]')) b.onclick = async () => {
        const card = b.closest('[data-comm-id]');
        try { await api('POST', `statuspages/${page.id}/communications/${card.dataset.commId}`, { status: card.querySelector('[data-pstatus]').value, text: card.querySelector('[data-ptext]').value }); redo(); } catch (e) { toast(e.message, true); }
      };
      for (const b of dlg.querySelectorAll('[data-cdel]')) b.onclick = async () => { await api('DELETE', `statuspages/${page.id}/communications/${b.dataset.cdel}`); redo(); };
    },
  });
}

/** «Esporta come codice» (RF-MAC-03): the YAML of some monitors, to paste in sitescanner.monitors.yml. */
async function codeDialog(ids) {
  const res = await fetch(`/api/monitors/export?ids=${ids.map(encodeURIComponent).join(',')}`);
  if (!res.ok) return toast((await res.json().catch(() => ({}))).error || 'Esportazione non riuscita', true);
  const yaml = await res.text();
  await formDialog({
    title: 'Come codice', confirm: 'Chiudi', cancel: false,
    body: `<p class="small muted">Incolla questo in <span class="mono">sitescanner.monitors.yml</span>, nel repository del sito; poi <span class="mono">sitescanner monitor apply</span> allinea il servizio al file. Un monitor gestito da codice non si modifica più dall'interfaccia.</p><pre class="excerpt" style="max-height:340px;overflow:auto">${esc(yaml)}</pre><div class="row">${copyBtn(yaml, 'Copia')}</div>`,
    setup: (dlg) => wireCopy(dlg),
  });
}

/** «Badge di stato» of the menu of a monitor (RF-PUB-06): the one that exists, or a new one. */
async function badgeDialog(monitor) {
  const links = await api('GET', 'public-links');
  let l = links.find((x) => x.kind === 'badge' && x.target.monitorId === monitor.id);
  if (!l) l = await api('POST', 'public-links', { kind: 'badge', monitorId: monitor.id });
  await formDialog({
    title: `Badge di «${monitor.name}»`, confirm: 'Chiudi', cancel: false,
    body: `<p><img src="${esc(l.url)}" alt="badge" height="20"></p><label class="f"><span>Markdown (per un README)</span><input type="text" readonly value="${esc(l.markdown)}"></label><label class="f"><span>Indirizzo dell'immagine</span><input type="text" readonly value="${esc(l.url)}"></label><div class="row">${copyBtn(l.markdown, 'Copia Markdown')} ${copyBtn(l.url, 'Copia l\'indirizzo')}</div><p class="small muted">Aggiungi <span class="mono">?label=testo</span> per cambiare la scritta a sinistra.</p>`,
    setup: (dlg) => wireCopy(dlg),
  });
}

// ---- Report of the availability (spec §13.12) ----
const REPORT_PERIODS = [['month', 'Mese corrente'], ['last-month', 'Mese scorso'], ['quarter', 'Trimestre'], ['custom', 'Intervallo libero']];

async function viewReport(params) {
  const period = params.get('period') || 'last-month';
  const qs = new URLSearchParams({ period, ...(params.get('from') ? { from: params.get('from') } : {}), ...(params.get('to') ? { to: params.get('to') } : {}), ...(params.get('tag') ? { tag: params.get('tag') } : {}), ...(params.get('q') ? { q: params.get('q') } : {}) });
  const [r, subs, channels, tagsInfo] = await Promise.all([api('GET', `report?${qs}`).catch((e) => ({ error: e.message })), api('GET', 'report-subscriptions'), api('GET', 'channels'), api('GET', 'tags')]);
  setView('monitoring');
  const o = r.overall;
  const emails = channels.channels.filter((c) => c.type === 'email' && c.status === 'active');
  const go = (patch) => { const next = new URLSearchParams(params); for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k)); location.hash = `#/report?${next}`; };
  app().innerHTML = `${monTabs('report')}
    <div class="head"><div><h1>Report di disponibilità</h1><div class="sub">Gli stessi numeri della dashboard, per un periodo e un gruppo di monitor: da mandare a un cliente, in CSV o in PDF.</div></div>
      <div class="row"><a class="btn" id="rCsv" href="/api/report.csv?${esc(qs)}">CSV ↓</a><button class="btn primary" id="rPdf">PDF…</button></div></div>
    <div class="row filters"><select id="rPeriod" aria-label="Periodo">${REPORT_PERIODS.map(([k, l]) => `<option value="${k}"${period === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
      ${period === 'custom' ? `<input type="date" id="rFrom" value="${esc(params.get('from') || '')}" aria-label="Dal"><input type="date" id="rTo" value="${esc(params.get('to') || '')}" aria-label="Al">` : ''}
      <select id="rTag" aria-label="Tag"><option value="">Tutti i tag</option>${tagsInfo.tags.map((t) => `<option${params.get('tag') === t.tag ? ' selected' : ''}>${esc(t.tag)}</option>`).join('')}</select>
      <input class="input" id="rQ" type="search" placeholder="Cerca nome o URL" value="${esc(params.get('q') || '')}"></div>
    ${r.error ? `<div class="notice error">${esc(r.error)}</div>` : `
    <div class="stats">${stat('Periodo', esc(r.period.label), `${r.overall.monitors} monitor`)}${stat('Disponibilità', pct(o.availability), 'pesata sul tempo monitorato')}${stat('Downtime', dur(o.downtimeMs))}${stat('Incidenti', fmtNum(o.incidents))}${stat('Obiettivi rispettati', `${o.slaMet}/${o.slaMet + o.slaMissed}`)}</div>
    <div class="panel tablewrap">${r.rows.length ? `<table><thead><tr><th>Monitor</th><th class="num">Disponibilità</th><th class="num">Obiettivo</th><th class="num">Downtime</th><th class="num">Incidenti</th><th class="num">MTTR</th><th class="num">Media</th><th class="num">p95</th><th class="num">p99</th></tr></thead><tbody>${r.rows.map((x) => `<tr><td><a href="#/monitor/${encodeURIComponent(x.id)}"><b>${esc(x.name)}</b></a>${x.tags.map((t) => ` <span class="tag">${esc(t)}</span>`).join('')}</td><td class="num ${x.slaMet === false ? 'sev-e' : ''}">${pct(x.availability)}</td><td class="num">${pct(x.slaPct)} ${x.slaMet == null ? '' : x.slaMet ? '✓' : '✗'}</td><td class="num">${dur(x.downtimeMs)}</td><td class="num">${x.incidents}</td><td class="num">${dur(x.mttrMs)}</td><td class="num">${x.avgMs ?? '—'}</td><td class="num">${x.p95Ms ?? '—'}</td><td class="num">${x.p99Ms ?? '—'}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">Nessun monitor con questi filtri.</p>'}</div>
    ${r.tags.length > 1 ? `<div class="panel tablewrap"><h3>Totali per tag</h3><table><thead><tr><th>Tag</th><th class="num">Monitor</th><th class="num">Disponibilità (pesata)</th><th class="num">Downtime</th><th class="num">Incidenti</th><th class="num">Obiettivi</th></tr></thead><tbody>${r.tags.map((t) => `<tr><td><a href="#/report?${new URLSearchParams({ period, tag: t.tag })}">${esc(t.tag)}</a></td><td class="num">${t.monitors}</td><td class="num">${pct(t.availability)}</td><td class="num">${dur(t.downtimeMs)}</td><td class="num">${t.incidents}</td><td class="num">${t.slaMet}/${t.slaMet + t.slaMissed}</td></tr>`).join('')}</tbody></table></div>` : ''}`}
    <div class="panel"><div class="row between"><h3>Report mensili per email</h3><button class="btn small" id="subNew">+ Nuovo</button></div><p class="small muted">Il primo giorno del mese il PDF del mese precedente parte agli indirizzi scelti (canali email già confermati, pagina Notifiche).</p>
      ${subs.length ? `<table><tbody>${subs.map((s) => `<tr><td><b>${esc(s.name)}</b><div class="small muted">${s.tag ? `tag ${esc(s.tag)}` : 'tutti i monitor'} → ${s.channelIds.map((id) => esc((emails.find((c) => c.id === id) || { name: '(canale eliminato)' }).name)).join(', ')}</div></td><td><div class="row"><button class="btn small" data-subsend="${esc(s.id)}">Invia ora il mese scorso</button><button class="btn small danger" data-subdel="${esc(s.id)}">Elimina</button></div></td></tr>`).join('')}</tbody></table>` : '<p class="muted small">Nessun report mensile.</p>'}</div>`;
  $('#rPeriod').onchange = (e) => go({ period: e.target.value, from: '', to: '' });
  $('#rTag').onchange = (e) => go({ tag: e.target.value });
  let typing;
  $('#rQ').oninput = (e) => { clearTimeout(typing); typing = setTimeout(() => go({ q: e.target.value.trim() }), 400); };
  if (period === 'custom') for (const id of ['rFrom', 'rTo']) $(`#${id}`).onchange = () => { if ($('#rFrom').value && $('#rTo').value) go({ from: $('#rFrom').value, to: $('#rTo').value }); };
  $('#rPdf').onclick = async () => {
    const fd = await formDialog({ title: 'PDF del report', confirm: 'Scarica il PDF', body: `<label class="f"><span>Per (nome del cliente, in copertina)</span><input type="text" name="client" maxlength="80" value="${esc(params.get('tag') || '')}" placeholder="Acme Srl"></label><p class="small muted">Usa il periodo, il tag e la ricerca scelti qui sopra. La creazione richiede qualche secondo.</p>` });
    if (fd) location.href = `/api/report.pdf?${new URLSearchParams({ ...Object.fromEntries(qs), client: fd.get('client') })}`;
  };
  $('#subNew').onclick = async () => {
    if (!emails.length) return toast('Serve un canale email confermato: aggiungilo nella pagina Notifiche', true);
    const fd = await formDialog({
      title: 'Nuovo report mensile', confirm: 'Crea',
      body: `<label class="f"><span>Nome (il cliente)</span><input type="text" name="name" required maxlength="60" placeholder="Acme Srl"></label>
        <label class="f"><span>Tag (vuoto = tutti i monitor)</span><input type="text" name="tag" list="repTags" value="${esc(params.get('tag') || '')}"><datalist id="repTags">${tagsInfo.tags.map((t) => `<option value="${esc(t.tag)}">`).join('')}</datalist></label>
        <fieldset class="f"><span>A questi indirizzi</span><div class="row">${emails.map((c) => `<label class="check"><input type="checkbox" name="ch" value="${esc(c.id)}"> ${esc(c.name)} <span class="muted small">${esc(c.target)}</span></label>`).join('')}</div></fieldset>`,
      submit: async (f) => { await api('POST', 'report-subscriptions', { name: f.get('name'), tag: f.get('tag'), channelIds: f.getAll('ch') }); },
    });
    if (fd) viewReport(params);
  };
  for (const b of $$('[data-subdel]')) b.onclick = async () => { await api('DELETE', `report-subscriptions/${b.dataset.subdel}`); viewReport(params); };
  for (const b of $$('[data-subsend]')) b.onclick = async () => {
    b.disabled = true;
    try { const x = await api('POST', `report-subscriptions/${b.dataset.subsend}/send`, {}); toast(x.sent ? `Inviato a ${x.sent} ${x.sent === 1 ? 'indirizzo' : 'indirizzi'}${x.pdf ? '' : ' (senza PDF)'}` : `Non inviato: ${x.failed} errori`, !x.sent); } catch (e) { toast(e.message, true); }
    b.disabled = false;
  };
}

// ---- Variables and secrets (spec §13.9, RF-SEG-01..04) ----
const AGENT_STATUS = { waiting: ['in attesa', 'info'], online: ['collegato', 'ok'], offline: ['fermo', 'error'] };

/** RF-AGT-01: the agents of the workspace, private locations that run in a network the service cannot see. */
async function viewAgents() {
  const d = await api('GET', 'agents');
  setView('monitoring');
  app().innerHTML = `${monTabs('agents')}
    <div class="head"><div><h1>Agenti locali</h1><div class="sub">Un agente è un programma che gira in una macchina della rete del cliente (o dell'agenzia) e chiede al servizio i controlli da fare: serve per i siti dietro VPN o con accesso limitato. Non apre nessuna porta; appare come località «Privata · nome» nei monitor.</div></div>
      <div class="row"><button class="btn primary" id="aNew">+ Nuovo agente</button></div></div>
    <div class="panel tablewrap">${d.agents.length ? `<table><thead><tr><th>Agente</th><th>Stato</th><th>Ultima chiamata</th><th>Macchina</th><th>Monitor</th><th></th></tr></thead><tbody>${d.agents.map((a) => `<tr>
      <td><b>${esc(a.name)}</b><div class="small muted mono">${esc(a.location)}</div></td>
      <td><span class="tag ${AGENT_STATUS[a.status][1]}">${AGENT_STATUS[a.status][0]}</span></td>
      <td class="small">${a.lastSeenAt ? esc(fmtDate(a.lastSeenAt)) : '<span class="muted">mai</span>'}</td>
      <td class="small">${esc(a.host || '—')}${a.version ? `<div class="muted">versione ${esc(a.version)}</div>` : ''}</td>
      <td class="small">${a.monitors.length ? a.monitors.map((m) => `<a href="#/monitor/${encodeURIComponent(m.id)}">${esc(m.name)}</a>`).join(', ') : '<span class="muted">nessuno</span>'}</td>
      <td><button class="btn small danger" data-adel="${esc(a.id)}">Elimina…</button></td></tr>`).join('')}</tbody></table>`
      : '<p class="empty">Nessun agente. Creane uno, copia il comando e avvialo nella macchina che vede il sito da controllare; poi scegli «Privata · nome» tra le località del monitor.</p>'}</div>`;
  $('#aNew').onclick = async () => {
    let made = null;
    const fd = await formDialog({
      title: 'Nuovo agente',
      body: '<label class="f"><span>Nome (la sede o la rete)</span><input type="text" name="name" required maxlength="40" placeholder="Sede di Roma"></label>',
      confirm: 'Crea',
      submit: async (f) => { made = await api('POST', 'agents', { name: f.get('name') }); },
    });
    if (!fd || !made) return;
    const cmd = `sitescanner monitor agent --url ${location.origin} --token ${made.token}`;
    await formDialog({
      title: `Agente «${made.agent.name}»`, confirm: "Fatto, l'ho copiato", cancel: false,
      body: `<p class="small">Avvia questo comando nella macchina che deve fare i controlli (serve Node 20 e <span class="mono">npm i -g sitescanner</span>). Il token non verrà mostrato di nuovo.</p><div class="secret" id="aCmd">${esc(cmd)}</div><div class="row">${copyBtn(cmd, 'Copia il comando')}</div>`,
      setup: (dlg) => wireCopy(dlg),
    });
    viewAgents();
  };
  for (const b of $$('[data-adel]')) b.onclick = async () => {
    const a = d.agents.find((x) => x.id === b.dataset.adel);
    const ok = await formDialog({ title: `Eliminare «${a.name}»?`, body: '<p>Il token smette di funzionare e l\'agente, se è acceso, si ferma con un errore. I monitor che lo usano vanno prima spostati su un\'altra località.</p>', confirm: 'Elimina', danger: true, submit: () => api('DELETE', `agents/${a.id}`) });
    if (ok) { toast('Agente eliminato'); viewAgents(); }
  };
}

async function viewVariables(params) {
  const [d, log] = await Promise.all([api('GET', 'secrets'), api('GET', 'secrets/log')]);
  setView('monitoring');
  const q = (params.get('q') || '').toLowerCase();
  const items = d.items.filter((s) => !q || s.name.toLowerCase().includes(q));
  const stale = d.items.some((s) => s.kind === 'secret' && s.current === false);
  app().innerHTML = `${monTabs('variables')}
    <div class="head"><div><h1>Variabili e segreti</h1><div class="sub">Valori da usare nei monitor come <span class="mono">{{NOME}}</span>: nell'indirizzo, negli header, nella password, nel corpo e nelle asserzioni. Una <b>variabile</b> si legge; un <b>segreto</b> si scrive e non si legge più, e non compare mai nei dati salvati.</div></div>
      <div class="row">${stale ? '<button class="btn" id="vRotate">Cifra di nuovo con la chiave attuale</button>' : ''}<button class="btn primary" id="vNew">+ Nuova</button></div></div>
    ${d.available ? '' : '<div class="notice warn">I segreti non sono disponibili: il deploy non ha <span class="mono">SITESCANNER_SECRETS_KEY</span> (per crearla: <span class="mono">openssl rand -base64 32</span>). Le variabili funzionano.</div>'}
    ${d.missing.length ? `<div class="notice error">Usate ma non definite: ${d.missing.map((m) => `<b class="mono">${esc(m.name)}</b> (${m.usedBy.map((u) => `<a href="#/monitor/${encodeURIComponent(u.id)}">${esc(u.name)}</a>`).join(', ')}) <button class="btn small" data-define="${esc(m.name)}">Definisci</button>`).join(' · ')}. Quei monitor non controllano finché non si definiscono.</div>` : ''}
    <div class="row filters"><input class="input" id="vQ" type="search" placeholder="Cerca per nome" value="${esc(params.get('q') || '')}"></div>
    <div class="panel tablewrap">${items.length ? `<table><thead><tr><th>Nome</th><th>Tipo</th><th>Valore</th><th>Usata da</th><th>Modificata</th><th></th></tr></thead><tbody>${items.map((s) => `<tr>
      <td class="mono"><b>${esc(s.name)}</b></td><td>${s.kind === 'secret' ? '<span class="tag warn">segreto</span>' : '<span class="tag">variabile</span>'}</td>
      <td class="mono small">${s.kind === 'secret' ? '••••••••' : esc(s.value)}${s.kind === 'secret' && s.current === false ? '<div class="muted">cifrato con una chiave precedente</div>' : ''}</td>
      <td class="small">${s.usedBy.length ? s.usedBy.map((u) => `<a href="#/monitor/${encodeURIComponent(u.id)}">${esc(u.name)}</a>`).join(', ') : '<span class="muted">nessun monitor</span>'}</td>
      <td class="small">${esc(fmtDate(s.updatedAt))}${s.updatedBy ? `<div class="muted">${esc(s.updatedBy)}</div>` : ''}</td>
      <td><div class="row"><button class="btn small" data-vedit="${esc(s.name)}">${s.kind === 'secret' ? 'Cambia valore' : 'Modifica'}</button><button class="btn small danger" data-vdel="${esc(s.name)}">Elimina</button></div></td></tr>`).join('')}</tbody></table>`
      : `<p class="empty">${d.items.length ? 'Nessuna variabile con questo nome.' : "Nessuna variabile. Servono, per esempio, per un token da mandare in un header senza scriverlo in ogni monitor."}</p>`}</div>
    <details class="panel"><summary><b>Registro delle modifiche</b> <span class="muted small">chi e quando, mai i valori</span></summary>${log.length ? `<table><thead><tr><th>Quando</th><th>Chi</th><th>Cosa</th></tr></thead><tbody>${log.map((l) => `<tr><td class="small">${esc(fmtDate(l.at))}</td><td>${esc(l.by || '—')}</td><td>${esc(l.action)}${l.name ? ` <span class="mono">${esc(l.name)}</span>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small">Nessuna modifica.</p>'}</details>`;
  $('#vQ').onchange = (e) => { location.hash = `#/variables${e.target.value ? `?q=${encodeURIComponent(e.target.value)}` : ''}`; };
  const edit = async (name = '', existing = null) => {
    const kind0 = existing ? existing.kind : 'var';
    const fd = await formDialog({
      title: existing ? `${existing.kind === 'secret' ? 'Nuovo valore di' : 'Modifica'} ${name}` : 'Nuova variabile o segreto',
      body: `<label class="f"><span>Nome (A-Z, 0-9, _)</span><input type="text" name="name" required maxlength="64" pattern="[A-Za-z0-9_]+" value="${esc(name)}"${existing ? ' readonly' : ''} placeholder="API_TOKEN"></label>
        ${existing ? `<input type="hidden" name="kind" value="${kind0}">` : `<div class="row"><label class="check"><input type="radio" name="kind" value="var" checked> Variabile (visibile)</label><label class="check"><input type="radio" name="kind" value="secret"${d.available ? '' : ' disabled'}> Segreto (non si rilegge)</label></div>`}
        <label class="f"><span>Valore</span><textarea name="value" rows="3" required autocomplete="off" spellcheck="false">${existing && existing.kind === 'var' ? esc(existing.value) : ''}</textarea><small>Fino a 4 KB. Un segreto ha almeno 4 caratteri.</small></label>`,
      submit: async (f) => { await api('PUT', `secrets/${encodeURIComponent(f.get('name').toUpperCase())}`, { kind: f.get('kind'), value: f.get('value') }); },
    });
    if (fd) { toast('Salvato'); viewVariables(params); }
  };
  $('#vNew').onclick = () => edit();
  for (const b of $$('[data-define]')) b.onclick = () => edit(b.dataset.define);
  for (const b of $$('[data-vedit]')) b.onclick = () => edit(b.dataset.vedit, d.items.find((s) => s.name === b.dataset.vedit));
  for (const b of $$('[data-vdel]')) b.onclick = async () => {
    const s = d.items.find((x) => x.name === b.dataset.vdel);
    const ok = await formDialog({ title: `Eliminare ${s.name}?`, body: `<p>${s.usedBy.length ? `La usano ${s.usedBy.length} monitor: smetteranno di controllare finché non la definisci di nuovo.` : 'Nessun monitor la usa.'}</p>`, confirm: 'Elimina', danger: true });
    if (!ok) return;
    await api('DELETE', `secrets/${encodeURIComponent(s.name)}`);
    viewVariables(params);
  };
  const rot = $('#vRotate');
  if (rot) rot.onclick = async () => { try { const r = await api('POST', 'secrets/rotate', {}); toast(`Cifrati di nuovo: ${r.rotated}`); viewVariables(params); } catch (e) { toast(e.message, true); } };
}

// ---- Tag manager (spec §13.9, RF-TAG-01) ----
async function viewTags(params) {
  const d = await api('GET', 'tags');
  setView('monitoring');
  const ns = params.get('ns') || '';
  const list = d.tags.filter((t) => !ns || (ns === '-' ? !t.namespace : t.namespace === ns));
  const dot = (c) => `<i class="tagdot" style="background:${esc(c || 'var(--line)')}"></i>`;
  app().innerHTML = `${monTabs('tags')}
    <div class="head"><div><h1>Tag</h1><div class="sub">Con i due punti un tag ha un <b>namespace</b> (<span class="mono">cliente:acme</span>, <span class="mono">ambiente:prod</span>) e si filtra per namespace. Rinomina e unisci si applicano a monitor, manutenzioni e canali.</div></div>
      <div class="row"><select id="tNs" aria-label="Namespace"><option value="">Tutti</option>${d.namespaces.map((n) => `<option value="${esc(n)}"${ns === n ? ' selected' : ''}>${esc(n)}:…</option>`).join('')}<option value="-"${ns === '-' ? ' selected' : ''}>Senza namespace</option></select>
      <button class="btn" id="tMerge" disabled>Unisci selezionati…</button></div></div>
    <div class="panel tablewrap">${list.length ? `<table><thead><tr><th></th><th>Tag</th><th>Descrizione</th><th class="num">Monitor</th><th class="num">Manutenzioni</th><th class="num">Canali</th><th></th></tr></thead><tbody>${list.map((t) => `<tr>
      <td><input type="checkbox" data-tsel="${esc(t.tag)}" aria-label="Seleziona"></td><td>${dot(t.color)}<a href="#/monitoring?q=${encodeURIComponent(`tag:${t.tag}`)}"><b class="mono">${esc(t.tag)}</b></a></td><td class="small">${esc(t.description)}</td>
      <td class="num">${t.monitors}</td><td class="num">${t.windows}</td><td class="num">${t.channels}</td>
      <td><div class="row"><button class="btn small" data-tedit="${esc(t.tag)}">Dettagli</button><button class="btn small" data-trename="${esc(t.tag)}">Rinomina</button></div></td></tr>`).join('')}</tbody></table>`
      : '<p class="empty">Nessun tag. Si aggiungono ai monitor (per cliente, per server, per ambiente) per filtrare, silenziare e fare i report.</p>'}</div>`;
  $('#tNs').onchange = (e) => { location.hash = `#/tags${e.target.value ? `?ns=${encodeURIComponent(e.target.value)}` : ''}`; };
  const sel = () => $$('[data-tsel]:checked').map((c) => c.dataset.tsel);
  for (const c of $$('[data-tsel]')) c.onchange = () => { $('#tMerge').disabled = sel().length < 2; };
  for (const b of $$('[data-tedit]')) b.onclick = async () => {
    const t = d.tags.find((x) => x.tag === b.dataset.tedit);
    const fd = await formDialog({
      title: `Dettagli di ${t.tag}`,
      body: `<label class="f"><span>Descrizione</span><input type="text" name="description" maxlength="200" value="${esc(t.description)}" placeholder="Acme Srl, contratto premium"></label>
        <label class="f"><span>Colore</span><input type="color" name="color" value="${esc(t.color || '#888888')}"></label><label class="check"><input type="checkbox" name="nocolor"${t.color ? '' : ' checked'}> nessun colore</label>`,
      submit: async (f) => { await api('PUT', `tags/${encodeURIComponent(t.tag)}`, { description: f.get('description'), color: f.get('nocolor') === 'on' ? null : f.get('color') }); },
    });
    if (fd) viewTags(params);
  };
  for (const b of $$('[data-trename]')) b.onclick = async () => {
    const t = d.tags.find((x) => x.tag === b.dataset.trename);
    const fd = await formDialog({
      title: `Rinomina ${t.tag}`,
      body: `<p class="small muted">Vale per ${t.monitors} monitor, ${t.windows} manutenzioni e ${t.channels} canali. Se il nuovo tag esiste già, i due si uniscono.</p><label class="f"><span>Nuovo nome</span><input type="text" name="to" required maxlength="60" value="${esc(t.tag)}"></label>`,
      submit: async (f) => { await api('POST', 'tags/rename', { from: t.tag, to: f.get('to') }); },
    });
    if (fd) { toast('Tag rinominato'); viewTags(params); }
  };
  $('#tMerge').onclick = async () => {
    const from = sel();
    const fd = await formDialog({
      title: `Unisci ${from.length} tag`,
      body: `<p class="small muted">${from.map((t) => `<span class="mono">${esc(t)}</span>`).join(', ')} diventano un solo tag.</p><label class="f"><span>Tag finale</span><input type="text" name="to" required maxlength="60" list="tagList" value="${esc(from[0])}"></label><datalist id="tagList">${from.map((t) => `<option>${esc(t)}</option>`).join('')}</datalist>`,
      submit: async (f) => { await api('POST', 'tags/merge', { from, to: f.get('to') }); },
    });
    if (fd) { toast('Tag uniti'); viewTags(params); }
  };
}

// ---- New problems (RF-ALR-08) ----
async function viewProblems(params) {
  const q = new URLSearchParams();
  for (const k of ['days', 'type', 'tag']) if (params.get(k)) q.set(k, params.get(k));
  const d = await api('GET', `new-problems?${q}`);
  setView('monitoring');
  const tags = [...new Set(d.problems.flatMap((p) => p.monitor.tags))];
  app().innerHTML = `${monTabs('problems')}
    <div class="head"><div><h1>Nuovi problemi</h1><div class="sub">Monitor e tipi di errore che hanno <b>iniziato</b> a fallire negli ultimi ${d.days} giorni. La lista del lunedì mattina.</div></div>
      <div class="row"><select id="pDays" aria-label="Periodo">${[1, 3, 7, 14, 30].map((v) => `<option value="${v}"${v === d.days ? ' selected' : ''}>ultimi ${v} giorni</option>`).join('')}</select>
      <select id="pTag" aria-label="Tag"><option value="">Tutti i tag</option>${tags.map((t) => `<option${params.get('tag') === t ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></div></div>
    ${d.problems.length ? d.problems.map((p) => `<div class="panel"><div class="row between"><div><a href="#/monitor/${encodeURIComponent(p.monitor.id)}"><b>${esc(p.monitor.name)}</b></a> <span class="muted small mono">${esc(p.monitor.url)}</span> ${p.monitor.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ')}</div>
      <div class="small muted">dal ${esc(fmtDate(p.firstSeen))} · ultimo ${esc(fmtDate(p.lastSeen))} · ${p.count} run falliti</div></div>
      <ul class="plain">${p.groups.map((g) => `<li><span class="sev-e">${esc(g.message)}</span> <span class="muted small">${g.count} volte, dal ${esc(fmtDate(g.firstSeen))}</span> <a class="small" href="#/monitor/${encodeURIComponent(p.monitor.id)}?group=${encodeURIComponent(g.fingerprint)}&outcome=error&period=30d">vedi i run</a></li>`).join('')}</ul></div>`).join('')
      : `<p class="empty">Nessun nuovo problema negli ultimi ${d.days} giorni. I problemi già noti non compaiono qui: li trovi negli incidenti.</p>`}`;
  const go = () => { location.hash = `#/problems?${new URLSearchParams({ days: $('#pDays').value, ...($('#pTag').value ? { tag: $('#pTag').value } : {}) })}`; };
  $('#pDays').onchange = go;
  $('#pTag').onchange = go;
}

// ---- History of the events (RF-ALR-06) ----
const HISTORY_FILTERS = [['', 'Tutto'], ['down', 'Guasti'], ['up', 'Ripristini'], ['degraded', 'Degradi'], ['cert', 'Certificati'], ['maintenance', 'Manutenzioni'], ['heartbeat', 'Heartbeat'], ['agents', 'Agenti'], ['changes', 'Modifiche'], ['ci', 'Test da CI']];

function eventLine(e, tz) {
  const what = e.type === 'ci-test' ? `${e.branch ? `ramo ${esc(e.branch)}` : ''}${e.commit ? ` · ${esc(String(e.commit).slice(0, 7))}` : ''} · ${e.passed} riusciti, ${e.failed} falliti · ${Math.round((e.durationMs || 0) / 1000)} s${e.by ? ` · ${esc(e.by)}` : ''}` : e.type === 'ci-apply' ? `${e.created} creati, ${e.updated} modificati, ${e.deleted} eliminati${e.by ? ` · ${esc(e.by)}` : ''}` : e.type === 'monitor-change' ? `${esc(e.action)}${e.by ? ` da ${esc(e.by)}` : ''}` : e.cause ? esc(e.cause.message) : e.type === 'degraded' ? `${e.ms} ms` : '';
  const link = e.incidentId ? `<a class="small" href="#/incident/${encodeURIComponent(e.incidentId)}">incidente</a>` : '';
  const sent = e.status === 'sent' ? `<span class="muted small">avviso inviato</span>` : e.status === 'suppressed' ? `<span class="muted small" data-tip="${esc(e.reason || '')}">non inviato</span>` : e.status === 'failed' ? '<span class="sev-e small">invio fallito</span>' : '';
  return `<li><span class="mono small">${timeOf(e.at, tz)}</span> ${eventTag(e.type)} ${e.monitorId ? `<a href="#/monitor/${encodeURIComponent(e.monitorId)}">${esc(e.monitorName)}</a>` : ''} <span class="small">${what}</span> ${link} ${sent}</li>`;
}

async function viewHistory(params) {
  const q = new URLSearchParams();
  for (const k of ['type', 'tag', 'from', 'to', 'monitor']) if (params.get(k)) q.set(k, params.get(k));
  const d = await api('GET', `history?${q}`);
  setView('monitoring');
  const cur = params.get('type') || '';
  app().innerHTML = `${monTabs('history')}
    <div class="head"><div><h1>Cronologia</h1><div class="sub">Tutto quello che è successo nell'account: guasti, ripristini, manutenzioni, modifiche. ${d.total} eventi.</div></div>
      <div class="row"><input class="input" id="hTag" type="search" placeholder="Filtra per tag" value="${esc(params.get('tag') || '')}"></div></div>
    <div class="row filters">${HISTORY_FILTERS.map(([k, l]) => `<a class="btn small${k === cur ? ' primary' : ''}" href="#/history?${new URLSearchParams({ ...(k ? { type: k } : {}), ...(params.get('tag') ? { tag: params.get('tag') } : {}) })}">${l}</a>`).join('')}</div>
    ${d.days.length ? d.days.map((day) => `<div class="panel"><h3>${esc(dayLabel(day.day))}</h3><ul class="plain history">${day.events.map((e) => eventLine(e, d.tz)).join('')}</ul></div>`).join('') : '<p class="empty">Nessun evento con questi filtri.</p>'}`;
  $('#hTag').onchange = (e) => { location.hash = `#/history?${new URLSearchParams({ ...(cur ? { type: cur } : {}), ...(e.target.value.trim() ? { tag: e.target.value.trim().toLowerCase() } : {}) })}`; };
}

/** How to call a heartbeat (RF-TYP-01): the address, ready-to-copy commands, and the calls received. */
function heartbeatPanel(m) {
  const url = m.hbUrl;
  const cmds = [
    ['Un cron job (ogni giorno alle 3), con la durata', `0 3 * * *  curl -fsS -m 10 ${url}/start; /usr/local/bin/backup.sh && curl -fsS -m 10 ${url} || curl -fsS -m 10 ${url}/fail`],
    ['Solo «ho finito»', `curl -fsS -m 10 ${url}`],
    ['Un errore, con il motivo', `curl -fsS -m 10 --data "disco pieno" ${url}/fail`],
  ];
  return `<div class="panel"><h3>Come chiamarlo</h3>
    <p class="small muted">L'indirizzo è segreto: chi lo conosce può segnalare che il job è andato bene. Va chiamato con GET o POST, senza login. Se non arriva una chiamata entro ${dur((m.expectedMin + m.toleranceMin) * 60000)} dall'ultima, il monitor va giù.</p>
    <div class="row"><input class="input mono" readonly value="${esc(url)}" style="flex:1" aria-label="Indirizzo da chiamare"><button class="btn small" data-copy="${esc(url)}">Copia</button></div>
    ${cmds.map(([l, c]) => `<div class="small muted" style="margin-top:8px">${l}</div><div class="row"><pre class="excerpt" style="flex:1;margin:0">${esc(c)}</pre><button class="btn small" data-copy="${esc(c)}">Copia</button></div>`).join('')}
    <h3 style="margin-top:14px">Chiamate ricevute</h3>${m.pings.length ? `<table><thead><tr><th>Quando</th><th>Tipo</th><th>Da</th><th>Nota</th></tr></thead><tbody>${m.pings.map((p) => `<tr><td class="small">${esc(fmtDate(p.at))}</td><td>${p.kind === 'ok' ? '<span class="tag ok">riuscita</span>' : p.kind === 'fail' ? '<span class="tag error">errore</span>' : '<span class="tag">inizio</span>'}</td><td class="small mono">${esc(p.ip || '')}</td><td class="small">${esc(p.note || '')}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small">Nessuna chiamata ancora: appena il job la fa, compare qui.</p>'}</div>`;
}

// ---- Notification log (RF-ALR-07) ----
async function viewLog(params) {
  const q = new URLSearchParams();
  for (const k of ['channel', 'ok']) if (params.get(k)) q.set(k, params.get(k));
  const [d, ch] = await Promise.all([api('GET', `notification-log?${q}`), api('GET', 'channels')]);
  setView('monitoring');
  const link = (extra) => `#/log?${new URLSearchParams({ ...Object.fromEntries(params), ...extra })}`;
  app().innerHTML = `${monTabs('log')}
    <div class="head"><div><h1>Registro degli avvisi</h1><div class="sub">Ogni invio, riuscito o no, degli ultimi ${d.days} giorni. Serve a capire perché un avviso non è arrivato.</div></div>
      <div class="row"><select id="lCh" aria-label="Canale"><option value="">Tutti i canali</option>${ch.channels.map((c) => `<option value="${esc(c.id)}"${params.get('channel') === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <select id="lOk" aria-label="Esito"><option value="">Ogni esito</option><option value="1"${params.get('ok') === '1' ? ' selected' : ''}>Riusciti</option><option value="0"${params.get('ok') === '0' ? ' selected' : ''}>Falliti o non inviati</option></select></div></div>
    <div class="panel tablewrap">${d.entries.length ? `<table><thead><tr><th>Quando</th><th>Evento</th><th>Monitor</th><th>Canale</th><th>Esito</th><th>Dettaglio</th></tr></thead><tbody>${d.entries.map((e) => `<tr>
      <td class="small">${esc(fmtDate(e.at))}</td><td>${eventTag(e.event)}</td><td>${e.monitorId ? `<a href="#/monitor/${encodeURIComponent(e.monitorId)}">${esc(e.monitorName)}</a>` : '—'}</td>
      <td>${e.channel ? esc(e.channel) : '<span class="muted">—</span>'}</td><td>${e.ok ? '<span class="tag ok">inviato</span>' : '<span class="tag error">non inviato</span>'}${e.attempts > 1 ? `<div class="small muted">${e.attempts} tentativi</div>` : ''}</td>
      <td class="small">${e.error ? `<span class="sev-e">${esc(e.error)}</span>` : e.response ? `<span class="muted">${esc(e.response)}</span>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">Nessun invio con questi filtri.</p>'}</div>`;
  $('#lCh').onchange = (e) => { location.hash = link({ channel: e.target.value }).replace(/channel=&?/, ''); };
  $('#lOk').onchange = (e) => { location.hash = link({ ok: e.target.value }).replace(/ok=&?/, ''); };
}

async function viewNotifications() {
  const d = await api('GET', 'channels');
  setView('notifications');
  const tzs = ['Europe/Rome', 'Europe/London', 'Europe/Berlin', 'Europe/Madrid', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'UTC'];
  if (!tzs.includes(d.tz)) tzs.unshift(d.tz);
  app().innerHTML = `${monTabs('notifications')}
    <div class="head"><div><h1>Notifiche</h1><div class="sub">Dove arrivano gli avvisi del monitoraggio e quando. I canali sono tuoi e li vedi solo tu.</div></div>
      <div class="row"><a class="btn" href="#/log">Registro degli avvisi</a></div></div>
    <div class="panel tablewrap">${d.channels.length ? `<table><thead><tr><th>Canale</th><th>Destinazione</th><th>Eventi</th><th>Raggiunge</th><th>Stato</th><th>Ultimo invio riuscito</th><th></th></tr></thead><tbody>${d.channels.map((c) => `<tr>
      <td><b>${esc(c.name)}</b><div class="small muted">${CH_TYPE[c.type]}</div></td><td class="mono small">${esc(c.target)}</td>
      <td class="small">${c.events.map((k) => KIND_LABELS[k]).join(', ')}</td>
      <td class="small">${c.reach} di ${d.monitorCount} monitor${c.tags.length ? `<div class="muted">solo tag ${c.tags.map(esc).join(', ')}</div>` : ''}</td>
      <td><span class="tag ${CH_STATUS[c.status][1]}">${CH_STATUS[c.status][0]}</span>${c.lastError ? `<div class="small sev-e">${esc(c.lastError)}</div>` : ''}${c.status === 'pending' ? '<div class="small muted">apri il link che ti abbiamo inviato</div>' : ''}</td>
      <td class="small">${c.lastOkAt ? esc(fmtDate(c.lastOkAt)) : '—'}</td>
      <td><div class="row"><button class="btn small" data-cedit="${esc(c.id)}">Eventi e tag</button><button class="btn small" data-ctest="${esc(c.id)}"${c.status === 'pending' ? ' disabled' : ''}>Prova</button><button class="btn small danger" data-cdel="${esc(c.id)}">Elimina</button></div></td></tr>`).join('')}</tbody></table>`
      : '<p class="empty">Nessun canale: senza canali gli incidenti restano solo nella dashboard.</p>'}</div>
    <div class="grid2">
      <form class="card form" id="addMail"><h2>Email</h2>${d.available.email ? `<label class="f"><span>Indirizzo</span><input type="email" name="address" required></label><p class="small muted">Riceverai un link: l'indirizzo diventa attivo quando lo apri.</p><div class="row"><button class="btn primary">Aggiungi</button></div>` : '<p class="muted small">Non disponibile: il deploy non ha configurato Resend (RESEND_API_KEY, SITESCANNER_EMAIL_FROM).</p>'}</form>
      <form class="card form" id="addSlack"><h2>Slack</h2><label class="f"><span>Nome</span><input type="text" name="name" placeholder="#ops"></label><label class="f"><span>URL dell'Incoming Webhook</span><input type="url" name="webhookUrl" required placeholder="https://hooks.slack.com/services/…"></label><p class="small muted">In Slack: App → Incoming Webhooks → «Add New Webhook», scegli il canale e copia l'URL.</p><div class="row"><button class="btn primary">Aggiungi</button></div></form>
      <form class="card form" id="addTeams"><h2>Microsoft Teams</h2><label class="f"><span>Nome</span><input type="text" name="name" placeholder="Team ops"></label><label class="f"><span>URL del webhook (Workflows)</span><input type="url" name="webhookUrl" required placeholder="https://…webhook.office.com/…"></label><p class="small muted">In Teams: canale → Workflows → «Quando si riceve una richiesta webhook», e copia l'URL.</p><div class="row"><button class="btn primary">Aggiungi</button></div></form>
      <form class="card form" id="addDiscord"><h2>Discord</h2><label class="f"><span>Nome</span><input type="text" name="name" placeholder="#ops"></label><label class="f"><span>URL del webhook</span><input type="url" name="webhookUrl" required placeholder="https://discord.com/api/webhooks/…"></label><p class="small muted">In Discord: impostazioni del canale → Integrazioni → Webhook → «Copia URL».</p><div class="row"><button class="btn primary">Aggiungi</button></div></form>
      <form class="card form" id="addHook"><h2>Webhook</h2><label class="f"><span>Nome</span><input type="text" name="name" placeholder="Il mio sistema"></label><label class="f"><span>URL</span><input type="url" name="url" required placeholder="https://esempio.it/sitescanner"></label><p class="small muted">Riceve un JSON con l'evento, firmato con HMAC-SHA256 (intestazioni <span class="mono">x-sitescanner-timestamp</span> e <span class="mono">x-sitescanner-signature</span>). Il segreto si mostra una volta sola.</p><div class="row"><button class="btn primary">Aggiungi</button></div></form>
      <div class="card"><h2>Telegram</h2>${d.available.telegram ? '<p class="small">Apri il link con Telegram, in una chat privata o in un gruppo, e premi «Avvia»: la chat si collega da sola. Il link vale 15 minuti.</p><div class="row"><button class="btn primary" id="tgLink">Genera il link</button></div><p id="tgOut" class="small"></p>' : '<p class="muted small">Non disponibile: il deploy non ha un bot Telegram (SITESCANNER_TELEGRAM_BOT_TOKEN).</p>'}</div>
      <form class="card form" id="policyForm"><h2>Quando avvisare</h2><div class="fields">${policyFields(d.policy)}
        <label class="f"><span>«Nuovi problemi»: ultimi giorni</span><input type="number" name="npDays" min="1" max="30" value="${d.newProblemsDays}"></label></div>
        <p class="small muted">Vale per tutti i monitor, salvo quelli con una politica propria. Un guasto breve, che finisce prima della soglia, non manda né l'avviso né il ripristino.</p><div class="row"><button class="btn primary">Salva</button></div></form>
      <form class="card form" id="tzForm"><h2>Fuso orario degli avvisi</h2><label class="f"><span>Fuso orario</span><select name="tz">${tzs.map((t) => `<option${t === d.tz ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label><div class="row"><button class="btn primary">Salva</button></div></form>
    </div>`;
  const add = (form, body) => async (e) => {
    e.preventDefault();
    try {
      const made = await api('POST', 'channels', body(new FormData(e.target)));
      if (made.secret) await formDialog({ title: 'Segreto del webhook', confirm: "Fatto, l'ho copiato", cancel: false, body: `<p class="small">Serve a verificare la firma. Non verrà mostrato di nuovo.</p><p class="mono" id="whSecret">${esc(made.secret)}</p><div class="row">${copyBtn(made.secret, 'Copia')}</div>`, setup: (dlg) => wireCopy(dlg) });
      toast('Canale aggiunto');
      viewNotifications();
    } catch (x) { toast(x.message, true); }
  };
  if ($('#addMail input')) $('#addMail').onsubmit = add('#addMail', (f) => ({ type: 'email', address: f.get('address') }));
  $('#addTeams').onsubmit = add('#addTeams', (f) => ({ type: 'teams', name: f.get('name') || 'Teams', webhookUrl: f.get('webhookUrl') }));
  $('#addDiscord').onsubmit = add('#addDiscord', (f) => ({ type: 'discord', name: f.get('name') || 'Discord', webhookUrl: f.get('webhookUrl') }));
  $('#addHook').onsubmit = add('#addHook', (f) => ({ type: 'webhook', name: f.get('name') || 'Webhook', url: f.get('url') }));
  $('#addSlack').onsubmit = add('#addSlack', (f) => ({ type: 'slack', name: f.get('name') || 'Slack', webhookUrl: f.get('webhookUrl') }));
  $('#policyForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try { await api('PUT', 'notify-prefs', { policy: readPolicy(fd), newProblemsDays: Number(fd.get('npDays')) }); toast('Politica salvata'); } catch (x) { toast(x.message, true); }
  };
  for (const b of $$('[data-cedit]')) b.onclick = async () => {
    const c = d.channels.find((x) => x.id === b.dataset.cedit);
    const fd = await formDialog({
      title: `Eventi di «${c.name}»`,
      body: `<fieldset class="f"><span>Questo canale riceve</span>${KINDS.map((k) => `<label class="check"><input type="checkbox" name="kind" value="${k}"${c.events.includes(k) ? ' checked' : ''}> ${KIND_LABELS[k]}</label>`).join('')}</fieldset>
        <label class="f"><span>Solo per i monitor con questi tag (vuoto = tutti)</span><input type="text" name="tags" value="${esc(c.tags.join(', '))}" placeholder="cliente:acme, prod"></label>`,
      submit: async (f) => { await api('PUT', `channels/${c.id}`, { events: f.getAll('kind'), tags: String(f.get('tags')).split(',').map((t) => t.trim()).filter(Boolean) }); },
    });
    if (fd) { toast('Canale aggiornato'); viewNotifications(); }
  };
  $('#tzForm').onsubmit = async (e) => { e.preventDefault(); try { await api('PUT', 'notify-prefs', { tz: new FormData(e.target).get('tz') }); toast('Fuso orario salvato'); } catch (x) { toast(x.message, true); } };
  const tg = $('#tgLink');
  if (tg) tg.onclick = async () => {
    try {
      const r = await api('POST', 'channels/telegram-link', {});
      $('#tgOut').innerHTML = `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a><br><span class="muted">Dopo «Avvia» ricarica questa pagina.</span>`;
    } catch (x) { toast(x.message, true); }
  };
  for (const b of $$('[data-ctest]')) b.onclick = async () => {
    try {
      const r = await api('POST', `channels/${b.dataset.ctest}/test`, {});
      toast(r.ok ? 'Notifica di prova inviata' : `Invio fallito: ${r.error}`, !r.ok);
      viewNotifications();
    } catch (x) { toast(x.message, true); }
  };
  for (const b of $$('[data-cdel]')) b.onclick = async () => {
    const ok = await formDialog({ title: 'Eliminare il canale?', body: '<p>Gli avvisi non arriveranno più qui.</p>', confirm: 'Elimina', danger: true });
    if (!ok) return;
    await api('DELETE', `channels/${b.dataset.cdel}`);
    viewNotifications();
  };
}

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
    else if (parts[0] === 'inventory' && parts[1]) await viewInventory(parts[1], params);
    else if (parts[0] === 'inventory') await viewInventories(params);
    else if (parts[0] === 'profile' && multi()) await viewProfile();
    else if (parts[0] === 'workspaces' && multi()) await viewWorkspaces();
    else if (parts[0] === 'monitoring' && monitoringOn()) await viewMonitoring();
    else if (parts[0] === 'monitor' && parts[1] && monitoringOn()) await viewMonitor(parts[1]);
    else if (parts[0] === 'incident' && parts[1] && monitoringOn()) await viewIncident(parts[1]);
    else if (parts[0] === 'run' && parts[1] && parts[2] && monitoringOn()) await viewRun(parts[1], parts[2]);
    else if (parts[0] === 'maintenance' && monitoringOn()) await viewMaintenance();
    else if (parts[0] === 'notifications' && monitoringOn()) await viewNotifications();
    else if (parts[0] === 'problems' && monitoringOn()) await viewProblems(params);
    else if (parts[0] === 'history' && monitoringOn()) await viewHistory(params);
    else if (parts[0] === 'log' && monitoringOn()) await viewLog(params);
    else if (parts[0] === 'variables' && monitoringOn()) await viewVariables(params);
    else if (parts[0] === 'agents' && monitoringOn()) await viewAgents();
    else if (parts[0] === 'public' && monitoringOn()) await viewPublic();
    else if (parts[0] === 'report' && monitoringOn()) await viewReport(params);
    else if (parts[0] === 'tags' && monitoringOn()) await viewTags(params);
    else if (parts[0] === 'users' && me() && me().role === 'admin') await viewUsers();
    else location.hash = '#/';
  } catch (e) {
    errorView(e);
  }
  window.scrollTo(0, 0);
}

async function boot() {
  try {
    state.info = await api('GET', 'state');
  } catch (e) {
    if (e.mustChangePassword) return forcePasswordChange();
    throw e;
  }
  $('#ver').textContent = state.info.tool.version;
  $('#root').textContent = state.info.root || '';
  $('#rootwrap').hidden = !state.info.root;
  renderAccount();
  $('[data-nav="monitoring"]').hidden = !monitoringOn();
  // the row menus of the lists close when one clicks elsewhere or scrolls
  document.addEventListener('click', (e) => { if (!e.target.closest('details.menu')) for (const o of $$('details.menu[open]')) o.open = false; });
  // the popup of a row menu is fixed on the screen: it closes when the page has scrolled away from its row, not at the few pixels the browser itself scrolls to bring a button into view
  window.addEventListener('scroll', () => { for (const o of $$('details.menu[open]')) if (Math.abs(window.scrollY - Number(o.dataset.scrollY || 0)) > 40) o.open = false; }, { passive: true });
  window.addEventListener('hashchange', route);
  connectEvents();
  route();
}

boot().catch((e) => errorView(e));
