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


// ---- accounts (multi-user mode, spec §10) ----
const multi = () => !!(state.info && state.info.mode === 'multi');
const me = () => (state.info && state.info.user) || null;
const ROLE = { admin: 'Admin', user: 'Utente' };

function renderAccount() {
  const u = me();
  $('#account').hidden = !u;
  $('[data-nav="users"]').hidden = !(u && u.role === 'admin');
  if (!u) return;
  $('#account').innerHTML = `<a href="#/profile" data-nav="profile">${esc(u.name || u.username)}</a><button class="btn small" id="logout">Esci</button>`;
  $('#logout').onclick = async () => {
    await api('POST', 'logout', {}).catch(() => {});
    location.href = '/login';
  };
}

/** Modal form; resolves with the FormData on submit, null if cancelled. `check(fd)` returns an error or null. */
function formDialog({ title, body, confirm = 'Salva', danger = false, cancel = true, check = null, submit = null }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dialog';
    dlg.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>${body}<p class="formerr" data-err hidden></p>
      <div class="row end">${cancel ? '<button type="button" class="btn" data-x>Annulla</button>' : ''}<button class="btn ${danger ? 'danger' : 'primary'}" value="ok">${esc(confirm)}</button></div></form>`;
    document.body.appendChild(dlg);
    const form = dlg.querySelector('form');
    const err = dlg.querySelector('[data-err]');
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
function showSecret(title, text, password) {
  return formDialog({
    title,
    body: `<p>${esc(text)}</p><div class="secret">${esc(password)}</div><p class="small muted">Non verrà più mostrata: comunicala all'utente in modo sicuro. Al primo accesso dovrà cambiarla.</p>
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
const MSTATUS = { up: ['su', 'ok'], slow: ['lento', 'warn'], down: ['giù', 'error'], paused: ['in pausa', ''], maintenance: ['in manutenzione', 'info'], pending: ['in attesa', ''] };
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
const mstatusTag = (s) => `<span class="tag ${MSTATUS[s][1]}">${MSTATUS[s][0]}</span>`;
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

function monitorForm(m = {}) {
  const k = m.keyword || {};
  const headers = Object.entries(m.headers || {}).map(([a, b]) => `${a}: ${b}`).join('\n');
  return `
    <label class="f"><span>URL</span><input type="url" name="url" required value="${esc(m.url || '')}" placeholder="https://www.esempio.it/"></label>
    <label class="f"><span>Nome</span><input type="text" name="name" maxlength="80" value="${esc(m.name || '')}" placeholder="dal dominio, se vuoto"></label>
    <details class="adv"><summary>Avanzate</summary><div class="fields">
      <label class="f"><span>Intervallo</span><select name="intervalMin">${[5, 10, 15, 30, 60].map((v) => `<option value="${v}"${(m.intervalMin || 5) === v ? ' selected' : ''}>ogni ${v} min</option>`).join('')}</select></label>
      <label class="f"><span>Timeout (s)</span><input type="number" name="timeoutS" min="5" max="60" value="${m.timeoutS || 30}"></label>
      <label class="f"><span>Metodo</span><select name="method"><option${m.method !== 'HEAD' ? ' selected' : ''}>GET</option><option${m.method === 'HEAD' ? ' selected' : ''}>HEAD</option></select></label>
      <label class="f"><span>Status attesi</span><input type="text" name="expect" value="${esc(m.expect || '200-399')}"></label>
      <label class="f wide"><span>Keyword</span><input type="text" name="kwText" value="${esc(k.text || '')}" placeholder="testo da cercare nella pagina"></label>
      <label class="f"><span>La keyword</span><select name="kwMode"><option value="present"${k.mode !== 'absent' ? ' selected' : ''}>deve comparire</option><option value="absent"${k.mode === 'absent' ? ' selected' : ''}>non deve comparire</option></select></label>
      <label class="check"><input type="checkbox" name="kwCase"${k.caseInsensitive !== false ? ' checked' : ''}> ignora maiuscole</label>
      <label class="f"><span>Soglia di lentezza (ms)</span><input type="number" name="slowMs" min="1" value="${m.slowMs || ''}"></label>
      <label class="check"><input type="checkbox" name="notifySlow"${m.notifySlow ? ' checked' : ''}> avvisa quando è lento</label>
      <label class="f"><span>Avvisi certificato (giorni)</span><input type="text" name="sslDays" value="${esc((m.sslDays || [30, 14, 7, 1]).join(', '))}"></label>
      <label class="f"><span>Ritardo di notifica (min)</span><input type="number" name="notifyDelayMin" min="0" value="${m.notifyDelayMin || 0}"></label>
      <label class="f"><span>Promemoria ogni (min)</span><input type="number" name="reminderMin" min="15" value="${m.reminderMin || ''}" placeholder="disattivato"></label>
      <label class="f"><span>Obiettivo SLA (%)</span><input type="number" name="slaPct" step="0.01" min="90" max="100" value="${m.slaPct || 99.9}"></label>
      <label class="f wide"><span>Tag (separati da virgola)</span><input type="text" name="tags" value="${esc((m.tags || []).join(', '))}" placeholder="cliente, server…"></label>
      <label class="f"><span>Basic auth: utente</span><input type="text" name="authUser" value="${esc(m.auth?.username || '')}" autocomplete="off"></label>
      <label class="f"><span>Basic auth: password</span><input type="password" name="authPass" value="${esc(m.auth?.password || '')}" autocomplete="new-password"></label>
      <label class="f wide"><span>Header (uno per riga, «Nome: valore»)</span><textarea name="headers" rows="2">${esc(headers)}</textarea></label>
      ${(state.channels || []).length ? `<fieldset class="f wide"><span>Canali di notifica (nessuno selezionato = tutti)</span><div class="row">${state.channels.map((c) => `<label class="check"><input type="checkbox" name="channels" value="${esc(c.id)}"${(m.channels || []).includes(c.id) ? ' checked' : ''}> ${esc(c.name)}</label>`).join('')}</div></fieldset>` : ''}
    </div></details>`;
}

function readMonitorForm(fd) {
  const headers = {};
  for (const l of lines(fd.get('headers'))) {
    const i = l.indexOf(':');
    if (i > 0) headers[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return {
    url: fd.get('url').trim(), name: fd.get('name').trim(), intervalMin: Number(fd.get('intervalMin')), timeoutS: Number(fd.get('timeoutS')),
    method: fd.get('method'), expect: fd.get('expect'), slowMs: intOrNull(fd.get('slowMs')), notifySlow: fd.get('notifySlow') === 'on',
    keyword: fd.get('kwText').trim() ? { text: fd.get('kwText').trim(), mode: fd.get('kwMode'), caseInsensitive: fd.get('kwCase') === 'on' } : null,
    sslDays: String(fd.get('sslDays')).split(/[,\s]+/).filter(Boolean).map(Number), notifyDelayMin: Number(fd.get('notifyDelayMin') || 0),
    reminderMin: intOrNull(fd.get('reminderMin')), slaPct: Number(fd.get('slaPct')), tags: String(fd.get('tags')).split(',').map((t) => t.trim()).filter(Boolean),
    auth: fd.get('authUser').trim() ? { username: fd.get('authUser').trim(), password: fd.get('authPass') } : null, headers,
    channels: fd.getAll('channels').length ? fd.getAll('channels') : null,
  };
}

async function editMonitorDialog(m = null) {
  let saved = null;
  state.channels = await api('GET', 'channels').then((x) => x.channels.filter((c) => c.status !== 'pending')).catch(() => []);
  const fd = await formDialog({
    title: m ? `Modifica «${m.name}»` : 'Aggiungi monitor',
    body: monitorForm(m || {}),
    confirm: m ? 'Salva' : 'Aggiungi e controlla',
    submit: async (f) => { saved = m ? await api('PUT', `monitors/${m.id}`, { ...m, ...readMonitorForm(f) }) : await api('POST', 'monitors', readMonitorForm(f)); },
  });
  if (!fd) return null;
  toast(m ? 'Monitor salvato' : `Monitor aggiunto: ${MSTATUS[saved.status] ? MSTATUS[saved.status][0] : saved.status}`);
  return saved;
}

function readMonFilter() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  return { tag: q.get('tag') || '', status: q.get('status') || '', health: q.get('health') || '', q: q.get('q') || '' };
}

function writeMonFilter(f) {
  const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
  history.replaceState(null, '', `#/monitoring${q.toString() ? `?${q}` : ''}`);
}

async function viewMonitoring() {
  const d = await api('GET', 'monitoring');
  setView('monitoring', { refresh: () => {} });
  const filter = readMonFilter();
  const selected = new Set();
  const visible = () => d.monitors.filter((m) => (!filter.tag || m.tags.includes(filter.tag)) && (!filter.status || m.status === filter.status) && (!filter.health || m.health.level === filter.health)
    && (!filter.q || `${m.name} ${m.url}`.toLowerCase().includes(filter.q.toLowerCase())));
  const draw = () => {
    const list = visible();
    const count = (k, v) => list.filter((m) => m[k] === v || (k === 'health' && m.health.level === v)).length;
    // RF-KPI-02/04: portfolio availability weighted on monitored time, for the shown group
    const mon = list.reduce((s, m) => s + m.k30.monitoredMs, 0), dt = list.reduce((s, m) => s + m.k30.downtimeMs, 0);
    const portfolio = mon ? (dt ? Math.min(Math.floor((1 - dt / mon) * 10000) / 100, 99.99) : 100) : null;
    $('#monStats').innerHTML = [
      stat('Su', fmtNum(count('status', 'up') + count('status', 'slow')), count('status', 'slow') ? `di cui ${count('status', 'slow')} lenti` : ''),
      stat('Giù', `<span class="${count('status', 'down') ? 'sev-e' : ''}">${fmtNum(count('status', 'down'))}</span>`),
      stat('In pausa / manutenzione', `${count('status', 'paused')} / ${count('status', 'maintenance')}`),
      stat('Salute', `<span class="sev-e">${count('health', 'critica')}</span> · <span class="sev-w">${count('health', 'attenzione')}</span> · ${count('health', 'buona')}`, 'critica · attenzione · buona'),
      stat('Disponibilità 30 giorni', pct(portfolio), filter.tag ? `gruppo «${esc(filter.tag)}»` : 'tutti i monitor mostrati'),
    ].join('');
    $('#monList').innerHTML = list.length ? `<table class="montable"><thead><tr><th><input type="checkbox" id="selAll" aria-label="Seleziona tutti"></th><th>Monitor</th><th>Stato</th><th>Salute</th><th class="num">30 giorni</th><th class="num">Risposta</th><th>Ultimi 90 giorni</th><th>24 ore</th></tr></thead><tbody>
      ${list.map((m) => `<tr>
        <td><input type="checkbox" data-sel="${esc(m.id)}"${selected.has(m.id) ? ' checked' : ''} aria-label="Seleziona"></td>
        <td><a href="#/monitor/${encodeURIComponent(m.id)}"><b>${esc(m.name)}</b></a><div class="small muted mono">${esc(m.url)}</div>${m.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ')}</td>
        <td>${mstatusTag(m.status)}<div class="small muted">da ${dur(d.now - (m.state.since || d.now))}</div></td>
        <td>${healthTag(m.health)}</td>
        <td class="num">${pct(m.k30.availability)}${m.k30.coverage != null && m.k30.coverage < 0.99 ? `<div class="small muted" data-tip="Tempo effettivamente monitorato sul periodo">copertura ${Math.round(m.k30.coverage * 100)}%</div>` : ''}</td>
        <td class="num">${m.k30.response ? `${m.k30.response.avg} ms` : '—'}</td>
        <td>${bars90(m.last90, d.now)}</td><td>${spark24(m.last24)}</td></tr>`).join('')}</tbody></table>`
      : `<p class="empty">${d.monitors.length ? 'Nessun monitor con questi filtri.' : 'Nessun monitor. Aggiungi il primo sito da tenere d\'occhio.'}</p>`;
    $('#bulkBar').hidden = !selected.size;
    $('#bulkCount').textContent = `${selected.size} selezionati`;
    for (const c of $$('[data-sel]')) c.onchange = () => { c.checked ? selected.add(c.dataset.sel) : selected.delete(c.dataset.sel); $('#bulkBar').hidden = !selected.size; $('#bulkCount').textContent = `${selected.size} selezionati`; };
    const all = $('#selAll');
    if (all) all.onchange = () => { for (const m of list) all.checked ? selected.add(m.id) : selected.delete(m.id); draw(); };
  };

  const incRow = (i) => `<li><a href="#/incident/${encodeURIComponent(i.id)}">${esc(i.monitorName)}</a> <span class="muted small">${esc(fmtDate(i.start))} · ${dur(i.durationMs)}${i.end ? '' : ' (in corso)'}</span><div class="small">${esc(i.cause.message)}</div></li>`;
  app().innerHTML = `
    ${d.dev ? '<div class="notice warn">Modalità sviluppo: il monitoraggio gira in questo processo solo finché il server è attivo, quindi i dati non sono affidabili. In produzione gira su Vercel.</div>' : ''}
    ${d.beat.stale ? `<div class="notice error">Monitoraggio fermo${d.beat.last ? ` da ${esc(dur(d.now - d.beat.last))}` : ': nessun giro di controllo ancora eseguito'}.</div>` : ''}
    ${d.channelsInError.map((c) => `<div class="notice error">Il canale di notifica «${esc(c.name)}» non funziona da ${esc(dur(d.now - c.failingSince))}: ${esc(c.lastError || '')}. <a href="#/notifications">Controlla le notifiche</a></div>`).join('')}
    ${!d.channelCount ? '<div class="notice warn">Nessun canale di notifica: gli incidenti restano solo qui. <a href="#/notifications">Aggiungi email, Slack o Telegram</a></div>' : ''}
    ${d.beat.unreliable.length ? `<div class="notice warn">Monitoraggio non affidabile nelle ultime 24 ore (${d.beat.unreliable.length} giri scartati per problemi di rete del monitor): quei periodi non contano nei KPI.</div>` : ''}
    <div class="head"><div><h1>Monitoraggio</h1><div class="sub">Disponibilità dei tuoi siti, controllati ogni pochi minuti</div></div>
      <div class="row"><button class="btn" id="monBulk">Aggiunta in blocco</button><button class="btn" id="monImport">Da un sito</button><a class="btn" href="#/maintenance">Manutenzione</a><a class="btn" href="#/notifications">Notifiche</a><a class="btn" href="/api/monitors.csv">CSV ↓</a><button class="btn primary" id="monAdd">+ Aggiungi monitor</button></div></div>
    <div class="stats" id="monStats"></div>
    <div class="row filters">
      <select id="fTag" aria-label="Tag"><option value="">Tutti i tag</option>${d.tags.map((t) => `<option${filter.tag === t ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <select id="fStatus" aria-label="Stato"><option value="">Tutti gli stati</option>${Object.entries(MSTATUS).map(([k, [l]]) => `<option value="${k}"${filter.status === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <select id="fHealth" aria-label="Salute"><option value="">Ogni salute</option>${Object.keys(HEALTH).map((k) => `<option${filter.health === k ? ' selected' : ''}>${k}</option>`).join('')}</select>
      <input class="input" id="fQ" type="search" placeholder="Cerca nome o URL" value="${esc(filter.q)}">
    </div>
    <div class="bulkbar row" id="bulkBar" hidden><b id="bulkCount"></b>
      <button class="btn small" data-act="pause">Pausa</button><button class="btn small" data-act="resume">Riprendi</button>
      <select class="input small" data-act-select="interval"><option value="">Intervallo…</option>${[5, 10, 15, 30, 60].map((v) => `<option value="${v}">ogni ${v} min</option>`).join('')}</select>
      <button class="btn small" data-act="add-tag">Aggiungi tag…</button>
      <select class="input small" data-act-select="maintenance"><option value="">Manutenzione…</option><option value="15">per 15 min</option><option value="30">per 30 min</option><option value="60">per 60 min</option></select>
      <button class="btn small danger" data-act="delete">Elimina…</button></div>
    <div class="monlayout"><div class="panel tablewrap" id="monList"></div>
      <aside>
        <div class="panel"><h3>Incidenti in corso</h3>${d.openIncidents.length ? `<ul class="plain">${d.openIncidents.map(incRow).join('')}</ul>` : '<p class="muted small">Nessuno</p>'}</div>
        <div class="panel"><h3>Ultimi incidenti</h3>${d.recentIncidents.length ? `<ul class="plain">${d.recentIncidents.map(incRow).join('')}</ul><a class="small" href="/api/incidents.csv">Esporta CSV ↓</a>` : '<p class="muted small">Nessuno negli ultimi 90 giorni</p>'}</div>
        <div class="panel"><h3>Certificati in scadenza</h3>${d.certs.length ? `<ul class="plain">${d.certs.map((c) => `<li><a href="#/monitor/${encodeURIComponent(c.id)}">${esc(c.name)}</a> <span class="${c.days <= 7 ? 'sev-e' : 'sev-w'}">${c.days < 0 ? 'scaduto' : `tra ${c.days} giorni`}</span></li>`).join('')}</ul>` : '<p class="muted small">Nessuno entro 30 giorni</p>'}</div>
        <div class="panel"><h3>Manutenzione</h3>${d.windows.length ? `<ul class="plain">${d.windows.slice(0, 8).map((w) => `<li>${w.active ? '<span class="tag info">in corso</span> ' : ''}<b>${esc(w.name)}</b> <span class="small muted">${esc(fmtDate(w.start))} → ${esc(new Date(w.end).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }))} · ${w.monitors.length} monitor</span></li>`).join('')}</ul>` : '<p class="muted small">Nessuna nei prossimi 7 giorni</p>'}</div>
      </aside></div>`;
  draw();
  const setF = (k, v) => { filter[k] = v; writeMonFilter(filter); draw(); };
  $('#fTag').onchange = (e) => setF('tag', e.target.value);
  $('#fStatus').onchange = (e) => setF('status', e.target.value);
  $('#fHealth').onchange = (e) => setF('health', e.target.value);
  $('#fQ').oninput = (e) => setF('q', e.target.value);
  $('#monAdd').onclick = async () => { if (await editMonitorDialog()) viewMonitoring(); };
  $('#monBulk').onclick = bulkAddDialog;
  $('#monImport').onclick = importSiteDialog;
  const act = async (action, value) => {
    if (action === 'delete') {
      const ok = await formDialog({ title: `Eliminare ${selected.size} monitor?`, body: '<p>Vengono cancellati anche il loro storico: controlli, incidenti e KPI.</p>', confirm: 'Elimina', danger: true });
      if (!ok) return;
    }
    if (action === 'add-tag') {
      const fd = await formDialog({ title: 'Aggiungi un tag', body: '<label class="f"><span>Tag</span><input type="text" name="tag" required></label>', confirm: 'Aggiungi' });
      if (!fd) return;
      value = fd.get('tag');
    }
    try {
      const r = await api('POST', 'monitors/actions', { ids: [...selected], action, value });
      toast(action === 'maintenance' ? `In manutenzione per ${value} minuti: ${r.count} monitor` : `Fatto: ${r.count} monitor`);
      viewMonitoring();
    } catch (e) { toast(e.message, true); }
  };
  for (const b of $$('[data-act]')) b.onclick = () => act(b.dataset.act);
  for (const s of $$('[data-act-select]')) s.onchange = () => { if (s.value) act(s.dataset.actSelect, Number(s.value)); };
  // RF-KPI-02: refreshed every 30 seconds while the page is open
  const timer = setInterval(async () => {
    if (state.view.name !== 'monitoring' || document.querySelector('dialog[open]')) return;
    if (!location.hash.startsWith('#/monitoring')) return clearInterval(timer);
    try {
      Object.assign(d, await api('GET', 'monitoring'));
      draw();
    } catch { /* next time */ }
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

async function viewMonitor(id) {
  const m = await api('GET', `monitors/${encodeURIComponent(id)}`);
  setView('monitoring');
  const P = [['24h', '24 ore'], ['7d', '7 giorni'], ['30d', '30 giorni'], ['90d', '90 giorni'], ['12m', '12 mesi'], ['month', 'Mese corrente']];
  const row = (label, f) => `<tr><th>${label}</th>${P.map(([k]) => `<td class="num">${f(m.periods[k])}</td>`).join('')}</tr>`;
  const cert = m.state.cert;
  app().innerHTML = `
    <div class="head"><div><h1>${esc(m.name)}</h1><div class="sub mono"><a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">${esc(m.url)}</a></div>
      <div class="row">${mstatusTag(m.status)} ${healthTag(m.health)} <span class="muted small">${m.status === 'down' ? 'giù' : 'nello stato attuale'} da ${dur(Date.now() - (m.state.since || Date.now()))} · ogni ${m.intervalMin} min</span>${m.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div></div>
      <div class="row"><button class="btn" id="mCheck"${m.paused ? ' disabled' : ''}>Controlla ora</button><button class="btn" id="mEdit">Modifica</button>
        <button class="btn" id="mPause">${m.paused ? 'Riprendi' : 'Metti in pausa'}</button><button class="btn danger" id="mDel">Elimina…</button></div></div>
    ${m.health.reasons.length ? `<div class="notice ${m.health.level === 'critica' ? 'error' : 'warn'}">${esc(m.health.level === 'critica' ? 'Critica' : 'Attenzione')}: ${esc(m.health.reasons.join('; '))}</div>` : ''}
    ${m.state.lastError && m.status === 'down' ? `<div class="notice error">${esc(m.state.lastError.message)}</div>` : ''}
    <div class="stats">
      ${stat('Disponibilità 30 giorni', pct(m.k30.availability), `obiettivo ${pct(m.slaPct)}`)}
      ${stat('Budget di errore (mese)', m.budget.leftMs >= 0 ? `restano ${dur(m.budget.leftMs)}` : `<span class="sev-e">superato di ${dur(-m.budget.leftMs)}</span>`, `ammessi ${dur(m.budget.allowedMs)}`)}
      ${stat('Risposta (30 giorni)', m.k30.response ? `${m.k30.response.avg} ms` : '—', m.k30.response ? `p95 ${m.k30.response.p95} ms` : '')}
      ${stat('Certificato', cert ? `${m.certDays < 0 ? 'scaduto' : `${m.certDays} giorni`}` : '—', cert ? esc(cert.issuer || '') : m.url.startsWith('https') ? 'non ancora letto' : 'non https')}
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
      <div class="panel tablewrap"><h2>Ultimi controlli</h2><table><thead><tr><th>Ora</th><th>Esito</th><th class="num">ms</th><th>Dettaglio</th></tr></thead><tbody>${m.checks.slice(0, 15).map((c) => `<tr><td>${esc(fmtDate(c.at))}</td><td><span class="tag ${c.outcome === 'ok' ? 'ok' : c.outcome === 'slow' ? 'warn' : 'error'}">${c.outcome === 'ok' ? 'ok' : c.outcome === 'slow' ? 'lento' : 'errore'}</span></td><td class="num">${c.ms ?? '—'}</td><td class="small">${esc(c.error || (c.status ? `HTTP ${c.status}` : ''))}${c.retried ? ' <span class="muted">(ripetuto)</span>' : ''}</td></tr>`).join('')}</tbody></table></div>
    </div>`;
  $('#mCheck').onclick = async () => { try { await api('POST', `monitors/${m.id}/check`, {}); viewMonitor(id); } catch (e) { toast(e.message, true); } };
  $('#mEdit').onclick = async () => { if (await editMonitorDialog(m)) viewMonitor(id); };
  $('#mPause').onclick = async () => { await api('POST', 'monitors/actions', { ids: [m.id], action: m.paused ? 'resume' : 'pause' }); viewMonitor(id); };
  $('#mDel').onclick = async () => {
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
      <div class="row">${m ? `<a class="btn" href="#/monitor/${encodeURIComponent(m.id)}">Monitor</a>` : ''}${m && m.source && i.end ? `<button class="btn primary" id="iScan">Lancia una scan</button>` : ''}</div></div>
    <div class="grid2">
      <div class="panel"><h2>Cause</h2><ul class="plain">${i.causes.map((c) => `<li><span class="muted small">${esc(fmtDate(c.at))}</span> ${esc(c.message)}</li>`).join('')}</ul>
        ${i.excerpt ? `<h3>Risposta del server</h3><pre class="excerpt">${esc(i.excerpt)}</pre>` : ''}</div>
      <div class="panel"><h2>Avvisi</h2>${i.events.length ? `<ul class="plain">${i.events.map((e) => `<li><b>${esc(e.type)}</b> <span class="muted small">${esc(fmtDate(e.at))}</span> ${e.deliveries ? e.deliveries.map((x) => `<span class="tag ${x.ok ? 'ok' : 'error'}">${esc(x.channel)}</span>`).join(' ') : `<span class="muted small">${esc(EVENT_STATUS[e.status] || e.status)}</span>`}</li>`).join('')}</ul>` : '<p class="muted small">Nessun avviso registrato</p>'}</div>
    </div>
    <form class="panel form" id="iNote"><h2>Nota</h2><textarea class="input" name="note" rows="3" placeholder="Cosa è successo, cosa è stato fatto…">${esc(i.note || '')}</textarea><div class="row"><button class="btn primary">Salva nota</button></div></form>
    <div class="panel tablewrap"><h2>Controlli</h2><table><thead><tr><th>Ora</th><th>Esito</th><th class="num">ms</th><th>Dettaglio</th></tr></thead><tbody>${i.checks.map((c) => `<tr><td>${esc(fmtDate(c.at))}</td><td><span class="tag ${c.outcome === 'error' ? 'error' : 'ok'}">${c.outcome === 'error' ? 'errore' : 'ok'}</span></td><td class="num">${c.ms ?? '—'}</td><td class="small">${esc(c.error || (c.status ? `HTTP ${c.status}` : ''))}</td></tr>`).join('')}</tbody></table></div>`;
  $('#iNote').onsubmit = async (e) => { e.preventDefault(); await api('PUT', `incidents/${i.id}`, { note: e.target.note.value }); toast('Nota salvata'); };
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
  const when = (w) => (w.type === 'once' ? esc(fmtDate(w.start)) : w.type === 'weekly' ? `ogni ${w.days.map((d) => WEEKDAYS[d]).join(', ')} alle ${esc(w.time)}` : `il giorno ${w.dayOfMonth} di ogni mese alle ${esc(w.time)}`);
  app().innerHTML = `
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
        <div class="fields"><label class="f"><span>Tipo</span><select name="type"><option value="once">una volta</option><option value="weekly">ogni settimana</option><option value="monthly">ogni mese</option></select></label>
        <label class="f"><span>Inizio (una volta)</span><input type="datetime-local" name="start"></label>
        <label class="f"><span>Ora (ricorrente)</span><input type="time" name="time" value="22:00"></label>
        <label class="f"><span>Giorno del mese</span><input type="number" name="dayOfMonth" min="1" max="31" value="1"></label>
        <label class="f"><span>Durata (min)</span><input type="number" name="durationMin" min="5" max="1440" value="60"></label></div>
        <div class="row small">${WEEKDAYS.map((d, i) => `<label class="check"><input type="checkbox" name="day" value="${i}"> ${d}</label>`).join('')}</div>
        <label class="f"><span>Tag (vale anche per i monitor aggiunti dopo)</span><select name="tag"><option value="">—</option>${tags.map((t) => `<option>${esc(t)}</option>`).join('')}</select></label>
        <label class="f"><span>Oppure i monitor</span><select name="monitorIds" multiple size="6">${monitors.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select></label>`,
      confirm: 'Crea',
      submit: (f) => api('POST', 'maintenance', {
        name: f.get('name'), type: f.get('type'), start: f.get('start') ? new Date(f.get('start')).getTime() : null, time: f.get('time'), dayOfMonth: Number(f.get('dayOfMonth')),
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
const CH_TYPE = { email: 'Email', slack: 'Slack', telegram: 'Telegram' };
const CH_STATUS = { active: ['attivo', 'ok'], pending: ['da confermare', 'warn'], error: ['in errore', 'error'] };

async function viewNotifications() {
  const d = await api('GET', 'channels');
  setView('notifications');
  const tzs = ['Europe/Rome', 'Europe/London', 'Europe/Berlin', 'Europe/Madrid', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'UTC'];
  if (!tzs.includes(d.tz)) tzs.unshift(d.tz);
  app().innerHTML = `
    <div class="head"><div><h1>Notifiche</h1><div class="sub">Dove arrivano gli avvisi del monitoraggio: giù, di nuovo su, certificati in scadenza. I canali sono tuoi e li vedi solo tu.</div></div>
      <div class="row"><a class="btn" href="#/monitoring">← Monitoraggio</a></div></div>
    <div class="panel tablewrap">${d.channels.length ? `<table><thead><tr><th>Canale</th><th>Destinazione</th><th>Stato</th><th>Ultimo invio riuscito</th><th></th></tr></thead><tbody>${d.channels.map((c) => `<tr>
      <td><b>${esc(c.name)}</b><div class="small muted">${CH_TYPE[c.type]}</div></td><td class="mono small">${esc(c.target)}</td>
      <td><span class="tag ${CH_STATUS[c.status][1]}">${CH_STATUS[c.status][0]}</span>${c.lastError ? `<div class="small sev-e">${esc(c.lastError)}</div>` : ''}${c.status === 'pending' ? '<div class="small muted">apri il link che ti abbiamo inviato</div>' : ''}</td>
      <td class="small">${c.lastOkAt ? esc(fmtDate(c.lastOkAt)) : '—'}</td>
      <td><div class="row"><button class="btn small" data-ctest="${esc(c.id)}"${c.status === 'pending' ? ' disabled' : ''}>Prova</button><button class="btn small danger" data-cdel="${esc(c.id)}">Elimina</button></div></td></tr>`).join('')}</tbody></table>`
      : '<p class="empty">Nessun canale: senza canali gli incidenti restano solo nella dashboard.</p>'}</div>
    <div class="grid2">
      <form class="card form" id="addMail"><h2>Email</h2>${d.available.email ? `<label class="f"><span>Indirizzo</span><input type="email" name="address" required></label><p class="small muted">Riceverai un link: l'indirizzo diventa attivo quando lo apri.</p><div class="row"><button class="btn primary">Aggiungi</button></div>` : '<p class="muted small">Non disponibile: il deploy non ha configurato Resend (RESEND_API_KEY, SITESCANNER_EMAIL_FROM).</p>'}</form>
      <form class="card form" id="addSlack"><h2>Slack</h2><label class="f"><span>Nome</span><input type="text" name="name" placeholder="#ops"></label><label class="f"><span>URL dell'Incoming Webhook</span><input type="url" name="webhookUrl" required placeholder="https://hooks.slack.com/services/…"></label><p class="small muted">In Slack: App → Incoming Webhooks → «Add New Webhook», scegli il canale e copia l'URL.</p><div class="row"><button class="btn primary">Aggiungi</button></div></form>
      <div class="card"><h2>Telegram</h2>${d.available.telegram ? '<p class="small">Apri il link con Telegram, in una chat privata o in un gruppo, e premi «Avvia»: la chat si collega da sola. Il link vale 15 minuti.</p><div class="row"><button class="btn primary" id="tgLink">Genera il link</button></div><p id="tgOut" class="small"></p>' : '<p class="muted small">Non disponibile: il deploy non ha un bot Telegram (SITESCANNER_TELEGRAM_BOT_TOKEN).</p>'}</div>
      <form class="card form" id="tzForm"><h2>Fuso orario degli avvisi</h2><label class="f"><span>Fuso orario</span><select name="tz">${tzs.map((t) => `<option${t === d.tz ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label><div class="row"><button class="btn primary">Salva</button></div></form>
    </div>`;
  const add = (form, body) => async (e) => {
    e.preventDefault();
    try {
      await api('POST', 'channels', body(new FormData(e.target)));
      toast('Canale aggiunto');
      viewNotifications();
    } catch (x) { toast(x.message, true); }
  };
  if ($('#addMail input')) $('#addMail').onsubmit = add('#addMail', (f) => ({ type: 'email', address: f.get('address') }));
  $('#addSlack').onsubmit = add('#addSlack', (f) => ({ type: 'slack', name: f.get('name') || 'Slack', webhookUrl: f.get('webhookUrl') }));
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
    else if (parts[0] === 'inventory' && parts[1]) await viewInventory(parts[1]);
    else if (parts[0] === 'inventory') await viewInventories(params);
    else if (parts[0] === 'profile' && multi()) await viewProfile();
    else if (parts[0] === 'monitoring' && monitoringOn()) await viewMonitoring();
    else if (parts[0] === 'monitor' && parts[1] && monitoringOn()) await viewMonitor(parts[1]);
    else if (parts[0] === 'incident' && parts[1] && monitoringOn()) await viewIncident(parts[1]);
    else if (parts[0] === 'maintenance' && monitoringOn()) await viewMaintenance();
    else if (parts[0] === 'notifications' && monitoringOn()) await viewNotifications();
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
  window.addEventListener('hashchange', route);
  connectEvents();
  route();
}

boot().catch((e) => errorView(e));
