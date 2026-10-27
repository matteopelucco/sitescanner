import { createGraph, loadD3 } from './mapgraph.js';
import { openRulesEditor, openMoveDialog } from './maprules.js';
import { withAreaRule, withParentRule } from '/app/mapoverlay.js';

// Views of the site map in the inventory detail (spec §14.5): filters shared by the views, Tree, Catalog,
// Redirects and ecosystem, the page inspector and the statistics of the overview. The map comes from
// GET /api/inventories/<id>/map (src/core/sitemap.js); tab, selection and filters live in the URL fragment.

/** Statistics of §14.3.5 for the overview tab. */
export async function mountMapStats({ root, id, api, esc, fmtNum, sites = [], readonly = false }) {
  let m;
  try {
    m = await api('GET', `inventories/${encodeURIComponent(id)}/map`);
  } catch (e) {
    root.innerHTML = `<div class="notice warn">Mappa non disponibile: ${esc(e.message)}</div>`;
    return;
  }
  if (!m.nodes.length) {
    root.innerHTML = m.warnings.map((w) => `<div class="notice warn">${esc(w)}</div>`).join('');
    return;
  }
  const s = m.stats;
  const reload = () => mountMapStats({ root, id, api, esc, fmtNum, sites, readonly });
  const rows = (list) => `<tbody>${list.map(([a, b]) => `<tr><td>${a}</td><td class="num">${b}</td></tr>`).join('')}</tbody>`;
  const top = (list, label) => (list.length ? `<table><thead><tr><th>${label}</th><th class="num">Pagine</th></tr></thead>${rows(list)}</table>` : '<p class="muted small">Nessuno.</p>');
  root.innerHTML = `
    ${m.warnings.map((w) => `<div class="notice warn">${esc(w)}</div>`).join('')}
    <div class="head" style="margin-top:22px"><h2 style="margin:0">Mappa del sito</h2>
      <div class="row"><button type="button" class="btn" id="mrules">Aree e gerarchia</button>${m.site ? '<button type="button" class="btn" id="mimport">Importa le note dell\'inventario precedente</button>' : ''}</div></div>
    <div class="panel notebox"><h3>Nota generale</h3><textarea class="input" id="mgen" maxlength="20000" rows="4" placeholder="Il contesto che i dati non dicono: tecnologie, flussi con gate, motivazioni…" aria-label="Nota generale">${esc(m.notes.general)}</textarea>
      <div class="row"><button type="button" class="btn small" id="mgensave">Salva la nota</button><span class="muted small" id="mgenmsg" role="status"></span></div></div>
    <div class="grid2">
      <div class="panel"><h3>Aree</h3><table><thead><tr><th>Area</th><th class="num">Pagine</th><th class="num">Quota</th></tr></thead><tbody>${s.composition.byArea.map((a) => {
        const ar = m.areas.find((x) => x.name === a.area);
        return `<tr><td>${dot(ar, esc)} ${esc(a.area)}</td><td class="num">${fmtNum(a.pages)}</td><td class="num">${a.pct}%</td></tr>`;
      }).join('')}</tbody></table></div>
      <div class="panel"><h3>Host</h3>${top(s.composition.byHost.map((h) => [`<span class="mono">${esc(h.host)}</span> <span class="muted small">${h.relation === 'main' ? 'principale' : 'fratello'}</span>`, fmtNum(h.pages)]), 'Host')}
        <h3 style="margin-top:14px">Livelli</h3>${top(Object.entries(s.composition.byLevel).map(([l, n]) => [`Livello ${esc(l)}`, fmtNum(n)]), 'Livello')}</div>
    </div>
    <div class="grid2">
      <div class="panel"><h3>Collegamenti</h3><table>${rows([
        ['Archi di contenuto', fmtNum(s.links.contentEdges)], ['Media di link di contenuto in uscita', fmtNum(s.links.avgContentOut)],
        ['Voci della navigazione globale', fmtNum(s.links.globalNavPages)], ['Raggiungibili solo dai menu', fmtNum(s.links.onlyFromMenus)],
        ['Senza link di contenuto in uscita', fmtNum(s.links.noContentOut)], ['Non collegate dalla partenza', fmtNum(s.links.notLinked)],
      ])}</table></div>
      <div class="panel"><h3>Contenuto e documenti</h3><table>${rows([
        ['Parole: media / mediana', `${fmtNum(s.content.avgWords)} / ${fmtNum(s.content.medianWords)}`],
        ['Pagine con poco testo', fmtNum(s.content.thin)],
        ['Documenti unici', fmtNum(s.documents.unique)],
        ['Pagine con documenti', fmtNum(s.documents.pagesWithDocuments)],
        ['Documenti controllati / rotti', `${fmtNum(s.documents.checked)} / ${fmtNum(s.documents.broken)}`],
        ['Lingue', s.languages.map((l) => `${esc(l.lang)} ${fmtNum(l.pages)}`).join(' · ') || '—'],
      ])}</table></div>
    </div>`;
  if (readonly) {
    // the offline bundle shows the map, it does not change it
    for (const sel of ['#mrules', '#mimport']) root.querySelector(sel)?.remove();
    const nb = root.querySelector('.notebox');
    if (m.notes.general.trim()) nb.innerHTML = `<h3>Nota generale</h3><p style="white-space:pre-wrap">${esc(m.notes.general)}</p>`;
    else nb.remove();
    return;
  }
  root.querySelector('#mrules').onclick = () => openRulesEditor({ id, m, api, esc, fmtNum, sites: m.site ? [] : sites, onSaved: reload });
  root.querySelector('#mgensave').onclick = async () => {
    const msg = root.querySelector('#mgenmsg');
    try {
      await api('PUT', `inventories/${encodeURIComponent(id)}/overlay`, { general: root.querySelector('#mgen').value });
      msg.textContent = 'Salvata.';
    } catch (e) { msg.textContent = e.message; }
  };
  const imp = root.querySelector('#mimport');
  if (imp) {
    imp.onclick = async () => {
      const msg = root.querySelector('#mgenmsg');
      try {
        const r = await api('POST', `inventories/${encodeURIComponent(id)}/import-notes`, {});
        msg.textContent = r.from
          ? `Dall'inventario ${r.from}: ${r.copied} note di pagina copiate${r.dropped.length ? `, ${r.dropped.length} di pagine scomparse non copiate (${r.dropped.slice(0, 5).join(', ')}${r.dropped.length > 5 ? '…' : ''})` : ''}.`
          : 'Non c\'è un inventario precedente di questo sito.';
        if (r.from) reload();
      } catch (e) { msg.textContent = e.message; }
    };
  }
}

function dot(area, esc) {
  const c = area ? area.color : { light: '#8a8f98', dark: '#8a8f98' };
  return `<span class="adot" style="--c-l:${esc(c.light)};--c-d:${esc(c.dark)}" aria-hidden="true"></span>`;
}

const hostLabel = (n, m) => (n.host === m.mainHost ? '' : n.host);
const pathOf = (n, m) => `${hostLabel(n, m)}${n.key}`;

/** The map views of one inventory: `tab` is graph, tree, catalog or redirects. */
export async function mountMapViews({ root, id, tab, params, api, esc, fmtNum, site = null, sites = [], readonly = false }) {
  const inventoryHasSite = !!site;
  let m;
  try {
    m = await api('GET', `inventories/${encodeURIComponent(id)}/map`);
  } catch (e) {
    root.innerHTML = `<div class="notice warn">Mappa non disponibile: ${esc(e.message)}</div>`;
    return;
  }
  if (!m.nodes.length) {
    root.innerHTML = `<div class="panel empty">${m.warnings.map(esc).join(' ') || 'Nessuna pagina HTML da mostrare.'}</div>`;
    return;
  }
  const byId = new Map(m.nodes.map((n) => [n.id, n]));
  const areaByName = new Map(m.areas.map((a) => [a.name, a]));
  const base = `#/inventory/${encodeURIComponent(id)}`;
  // rules changed: the whole map is derived again, on the same view
  const reload = () => mountMapViews({ root, id, tab, params: new URLSearchParams(location.hash.split('?')[1] || ''), api, esc, fmtNum, site, sites, readonly });

  // ---- state in the URL (RF-UI-13) ----
  const F = {
    q: params.get('q') || '',
    areas: new Set((params.get('area') || '').split('|').filter(Boolean)),
    host: params.get('host') || '',
    nav: params.get('nav') === '1',
    menus: params.get('menus') === '1',
    docs: params.get('docs') === '1',
    level: params.get('level') || '',
    sel: params.get('sel') && byId.has(params.get('sel')) ? params.get('sel') : null,
    layout: params.get('layout') || 'radial',
    sort: params.get('sort') || 'level',
    dir: params.get('dir') === 'desc' ? -1 : 1,
  };
  const syncUrl = () => {
    const p = new URLSearchParams({ tab });
    if (F.q) p.set('q', F.q);
    if (F.areas.size) p.set('area', [...F.areas].join('|'));
    if (F.host) p.set('host', F.host);
    if (F.nav) p.set('nav', '1');
    if (F.menus) p.set('menus', '1');
    if (F.docs) p.set('docs', '1');
    if (F.level) p.set('level', F.level);
    if (F.sel) p.set('sel', F.sel);
    if (tab === 'graph' && graph) { const l = graph.state().layout; if (l !== 'radial') p.set('layout', l); }
    if (tab === 'catalog' && (F.sort !== 'level' || F.dir !== 1)) { p.set('sort', F.sort); if (F.dir < 0) p.set('dir', 'desc'); }
    try { history.replaceState(null, '', `${base}?${p}`); } catch { /* sandboxed */ }
  };

  const matchText = (n) => !F.q || [n.shortName, n.title, n.key, n.description, n.h1].some((x) => x && String(x).toLowerCase().includes(F.q.toLowerCase()));
  const passes = (n) => (!F.areas.size || F.areas.has(n.area))
    && (!F.host || (F.host === '__main' ? n.host === m.mainHost : n.host !== m.mainHost))
    && (!F.nav || n.globalNav) && (!F.menus || n.onlyFromMenus) && (!F.docs || n.documents.length)
    && (F.level === '' || String(n.level) === F.level) && matchText(n);
  let visibleIds = new Set();
  const computeVisible = () => {
    visibleIds = new Set(m.nodes.filter(passes).map((n) => n.id));
  };

  // ---- layout ----
  const hosts = [...new Set(m.nodes.map((n) => n.host))];
  root.innerHTML = `
    <div class="mapbar panel">
      <div class="row" style="gap:10px;flex-wrap:wrap">
        <input class="input" id="mq" type="search" placeholder="Cerca per nome, title, path, description" aria-label="Cerca nella mappa" style="max-width:320px" value="${esc(F.q)}">
        ${hosts.length > 1 ? `<select class="input" id="mh" aria-label="Host" style="max-width:200px"><option value="">Tutti gli host</option><option value="__main">Solo host principale</option><option value="__sib">Solo host fratelli</option></select>` : ''}
        <select class="input" id="ml" aria-label="Livello" style="max-width:150px"><option value="">Tutti i livelli</option>${Object.keys(m.stats.composition.byLevel).map((l) => `<option value="${esc(l)}">Livello ${esc(l)}</option>`).join('')}</select>
        <label class="check"><input type="checkbox" id="mn"> solo navigazione globale</label>
        <label class="check"><input type="checkbox" id="mm"> solo raggiungibili dai menu</label>
        <label class="check"><input type="checkbox" id="md"> con documenti</label>
        <span class="muted small" id="mcount" role="status" aria-live="polite"></span>
      </div>
      <div class="chips" id="mareas" role="group" aria-label="Aree"></div>
    </div>
    <div class="maplayout">
      <div id="mapMain" class="mapmain"></div>
      <aside id="mapInsp" class="mapinsp panel" hidden aria-label="Dettaglio della pagina"></aside>
    </div>`;
  const $ = (s) => root.querySelector(s);
  if ($('#mh')) $('#mh').value = F.host;
  $('#ml').value = F.level;
  $('#mn').checked = F.nav;
  $('#mm').checked = F.menus;
  $('#md').checked = F.docs;
  if (!m.support.links) {
    $('#mn').disabled = $('#mm').disabled = true;
    $('#mn').parentElement.title = $('#mm').parentElement.title = 'Servono i dati dei link: rilancia l\'inventario.';
  }

  // ---- filters ----
  const drawAreas = () => {
    const counts = new Map();
    for (const n of m.nodes) if (passesExceptArea(n)) counts.set(n.area, (counts.get(n.area) || 0) + 1);
    $('#mareas').innerHTML = m.areas.map((a) => `<button type="button" class="chip${F.areas.has(a.name) ? ' on' : ''}" data-area="${esc(a.name)}" aria-pressed="${F.areas.has(a.name)}">${dot(a, esc)} ${esc(a.name)} <span class="muted">${fmtNum(counts.get(a.name) || 0)}</span></button>`).join('')
      + (F.areas.size ? ' <button type="button" class="chip" data-area="">Mostra tutte</button>' : '');
  };
  const passesExceptArea = (n) => {
    const keep = F.areas;
    F.areas = new Set();
    const r = passes(n);
    F.areas = keep;
    return r;
  };
  const changed = () => {
    computeVisible();
    $('#mcount').textContent = `${fmtNum(visibleIds.size)} di ${fmtNum(m.nodes.length)} pagine`;
    drawAreas();
    syncUrl();
    if (tab === 'graph' && graph) graph.update();
    else drawMain();
  };
  let timer = null;
  $('#mq').oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => { F.q = e.target.value.trim(); changed(); }, 150); };
  if ($('#mh')) $('#mh').onchange = (e) => { F.host = e.target.value; changed(); };
  $('#ml').onchange = (e) => { F.level = e.target.value; changed(); };
  $('#mn').onchange = (e) => { F.nav = e.target.checked; changed(); };
  $('#mm').onchange = (e) => { F.menus = e.target.checked; changed(); };
  $('#md').onchange = (e) => { F.docs = e.target.checked; changed(); };
  $('#mareas').onclick = (e) => {
    const b = e.target.closest('[data-area]');
    if (!b) return;
    const a = b.dataset.area;
    if (!a) F.areas.clear();
    else if (e.ctrlKey || e.metaKey || e.shiftKey) F.areas.has(a) ? F.areas.delete(a) : F.areas.add(a);
    else if (F.areas.size === 1 && F.areas.has(a)) F.areas.clear();
    else F.areas = new Set([a]);
    changed();
  };

  // ---- selection and inspector (RF-MAP-101, 140..143) ----
  const select = (nid) => {
    F.sel = nid && byId.has(nid) ? nid : null;
    syncUrl();
    drawInspector();
    for (const el of root.querySelectorAll('[data-sel]')) el.classList.toggle('selected', el.dataset.sel === F.sel);
    if (graph) graph.redraw();
  };
  const nodeLink = (nid) => {
    const n = byId.get(nid);
    return n ? `<button type="button" class="linklike" data-pick="${esc(nid)}">${esc(n.shortName || n.key)}</button> <span class="muted small mono">${esc(pathOf(n, m))}</span>` : `<span class="mono small">${esc(nid)}</span> <span class="muted small">(non visitata)</span>`;
  };
  const docName = (u) => { try { return decodeURIComponent(new URL(u).pathname.split('/').pop()) || u; } catch { return u; } };
  const list = (ids, empty) => (ids.length ? `<ul class="inspl">${ids.map((x) => `<li>${nodeLink(x)}</li>`).join('')}</ul>` : `<p class="muted small">${empty}</p>`);
  function drawInspector() {
    const el = $('#mapInsp');
    const n = F.sel && byId.get(F.sel);
    if (!n) { el.hidden = true; return; }
    el.hidden = false;
    const flags = [
      n.host !== m.mainHost ? 'Pagina di confine' : '', n.globalNav ? 'Navigazione globale' : '', n.onlyFromMenus ? 'Raggiungibile solo dai menu' : '',
      n.regions === 'template' ? 'Menu rilevati dal modello' : '',
    ].filter(Boolean);
    const navIn = n.navInCount;
    el.innerHTML = `
      <div class="row" style="justify-content:space-between"><h3 style="margin:0">${dot(areaByName.get(n.area), esc)} ${esc(n.shortName)}</h3><button type="button" class="btn small" id="icl" aria-label="Chiudi">✕</button></div>
      <p class="muted small">${esc(n.area)} · livello ${n.level}${flags.length ? ` · ${flags.map(esc).join(' · ')}` : ''}${navIn ? ` · linkata da ${fmtNum(navIn)} pagine di menu` : ''}</p>
      ${tab === 'graph' ? '' : `<p><a class="btn small" href="${base}?tab=graph&sel=${encodeURIComponent(n.id)}">Mostra nel grafo</a></p>`}
      <p id="diag"></p>
      <p><a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer" class="mono small">${esc(n.url)}</a></p>
      ${n.title && n.title !== n.shortName ? `<p><strong>Title</strong> ${esc(n.title)}</p>` : ''}
      ${n.h1 && n.h1 !== n.title ? `<p><strong>H1</strong> ${esc(n.h1)}</p>` : ''}
      ${n.reachedFrom ? `<p class="muted small">Raggiunta da ${nodeLink(n.reachedFrom)}</p>` : ''}
      <p>${n.description ? esc(n.description) : '<span class="muted">nessuna description</span>'}</p>
      <div class="notebox"><h4>Nota</h4><textarea class="input" id="pnote" maxlength="2000" rows="3" aria-label="Nota della pagina" placeholder="Contesto che i dati non dicono">${esc(m.notes.pages[n.id] || '')}</textarea>
        <div class="row"><button type="button" class="btn small" id="pnsave">Salva la nota</button><span class="muted small" id="pnmsg" role="status"></span></div></div>
      <details><summary>Regole per questa pagina</summary><div class="row" style="margin-top:6px"><button type="button" class="btn small" id="mvarea">Sposta in area…</button><button type="button" class="btn small" id="mvpar">Imposta genitore…</button></div></details>
      <table><tbody>
        <tr><td>Parole</td><td class="num">${fmtNum(n.wordCount)}</td></tr>
        <tr><td>Status</td><td class="num">${esc(n.status ?? '—')}</td></tr>
        <tr><td>Click dalla partenza</td><td class="num">${fmtNum(n.clickDepth)}</td></tr>
        <tr><td>Lingua</td><td class="num">${esc(n.lang || '—')}${n.hreflang.length ? ` · alternate ${esc(n.hreflang.map((h) => h.lang).join(', '))}` : ''}</td></tr>
        <tr><td>Sottopagine</td><td class="num">${fmtNum(n.subtree - 1)}</td></tr>
      </tbody></table>
      <h4>Posizione</h4>
      <p class="small">Genitore: ${n.parent ? `${nodeLink(n.parent)} <span class="muted small">(${esc(n.parentKind)})</span>` : '<span class="muted">radice</span>'}</p>
      <details open><summary>Sottopagine dirette (${n.children.length})</summary>${list(n.children, 'Nessuna.')}</details>
      <details><summary>Link di contenuto in uscita (${n.contentOut.length})</summary>${list(n.contentOut, 'Nessuno.')}</details>
      <details><summary>Link di contenuto in entrata (${n.contentIn.length})</summary>${list(n.contentIn, 'Nessuno.')}</details>
      <details><summary>Link di navigazione: ${fmtNum(n.navOutCount)} in uscita, ${fmtNum(n.navInCount)} in entrata</summary><p class="muted small">Sono i link dei menu e del piè di pagina; non entrano nell'albero.</p></details>
      <h4>Documenti (${n.documents.length})</h4>
      ${n.documents.length ? `<ul class="inspl">${n.documents.map((d) => `<li>${esc(docName(d.url))} <span class="muted small">${esc(d.ext)} · ${esc(d.host)}</span></li>`).join('')}</ul>` : '<p class="muted small">Nessuno.</p>'}
      ${n.externalHosts.length ? `<h4>Domini esterni</h4><p class="small mono">${n.externalHosts.map(esc).join('<br>')}</p>` : ''}`;
    $('#icl').onclick = () => select(null);
    if (readonly) {
      el.querySelector('#diag')?.remove();
      el.querySelector('#mvarea').closest('details').remove();
      const nb = el.querySelector('.notebox');
      if (m.notes.pages[n.id]) nb.innerHTML = `<h4>Nota</h4><p style="white-space:pre-wrap">${esc(m.notes.pages[n.id])}</p>`;
      else nb.remove();
      $('#icl').onclick = () => select(null);
      for (const b of el.querySelectorAll('[data-pick]')) b.onclick = () => select(b.dataset.pick);
      return;
    }
    $('#pnsave').onclick = async () => {
      const text = $('#pnote').value;
      try {
        await api('PUT', `inventories/${encodeURIComponent(id)}/overlay`, { pages: { [n.id]: text } });
        if (text.trim()) m.notes.pages[n.id] = text; else delete m.notes.pages[n.id];
        $('#pnmsg').textContent = 'Salvata.';
        if (tab !== 'graph') drawMain();
      } catch (e) { $('#pnmsg').textContent = e.message; }
    };
    $('#mvarea').onclick = () => openMoveDialog({ kind: 'area', node: n, m, api, id, esc, withAreaRule, withParentRule, onSaved: reload });
    $('#mvpar').onclick = () => openMoveDialog({ kind: 'parent', node: n, m, api, id, esc, withAreaRule, withParentRule, onSaved: reload });
    if (inventoryHasSite && n.host === m.mainHost) {
      const nid = n.id;
      api('GET', `inventories/${encodeURIComponent(id)}/diagnostic?key=${encodeURIComponent(n.key)}`).then((d) => {
        const slot = el.querySelector('#diag');
        if (d.url && F.sel === nid && slot) slot.innerHTML = `<a class="btn small" href="${esc(d.url)}" target="_blank" rel="noopener">Apri nella diagnostica</a>`;
      }).catch(() => {});
    }
    for (const b of el.querySelectorAll('[data-pick]')) b.onclick = () => select(b.dataset.pick);
  }

  // ---- Tree (RF-MAP-120..122) ----
  const open = new Set();
  let openInit = false;
  const filtering = () => visibleIds.size !== m.nodes.length;
  function treeRows() {
    // with a filter, the ancestors of the matches stay visible and are opened
    const keep = new Set();
    if (filtering()) {
      for (const id of visibleIds) for (let c = id; c && !keep.has(c); c = byId.get(c)?.parent) keep.add(c);
    }
    const walkStr = (id) => {
      const n = byId.get(id);
      if (!n || (filtering() && !keep.has(id))) return '';
      const isOpen = filtering() ? true : open.has(id);
      if (!n.children.length) return `<li role="treeitem">${treeRow(n, false)}</li>`;
      return `<li role="treeitem" aria-expanded="${isOpen}">${treeRow(n, isOpen)}${isOpen ? `<ul role="group">${n.children.map(walkStr).join('')}</ul>` : ''}</li>`;
    };
    return `<ul role="tree" class="mtree">${walkStr(m.root)}</ul>`;
  }
  function treeRow(n, isOpen) {
    const badges = [n.host !== m.mainHost ? '<span class="badge">confine</span>' : '', n.globalNav ? '<span class="badge">menu</span>' : '', m.notes.pages[n.id] ? '<span class="notemark" title="Ha una nota">✎</span>' : ''].join('');
    return `<div class="trow${F.sel === n.id ? ' selected' : ''}" data-sel="${esc(n.id)}">
      ${n.children.length ? `<button type="button" class="twist" data-tog="${esc(n.id)}" aria-label="${isOpen ? 'Comprimi' : 'Espandi'}">${isOpen ? '▾' : '▸'}</button>` : '<span class="twist"></span>'}
      ${dot(areaByName.get(n.area), esc)}
      <button type="button" class="linklike tname" data-pick="${esc(n.id)}">${esc(n.shortName)}</button>
      <span class="muted small mono tpath">${esc(pathOf(n, m) || '/')}</span>
      ${badges}
      <span class="muted small tnum">${n.children.length ? `${fmtNum(n.subtree - 1)} sotto` : ''}${n.documents.length ? ` · ${n.documents.length} doc` : ''}${m.support.links ? ` · ${fmtNum(n.contentIn.length)}↓ ${fmtNum(n.contentOut.length)}↑` : ''}</span>
      ${n.description ? `<div class="tdesc muted small">${esc(n.description)}</div>` : ''}
    </div>`;
  }
  function drawTree() {
    if (!openInit) {
      openInit = true;
      for (const n of m.nodes) if (n.level <= 1 && n.children.length) open.add(n.id);
    }
    const main = $('#mapMain');
    main.innerHTML = `<div class="panel"><div class="row" style="margin-bottom:8px"><button type="button" class="btn small" id="texp">Espandi tutto</button> <button type="button" class="btn small" id="tcol">Comprimi dal livello 2</button></div>${treeRows()}</div>`;
    $('#texp').onclick = () => { for (const n of m.nodes) if (n.children.length) open.add(n.id); drawTree(); };
    $('#tcol').onclick = () => { open.clear(); for (const n of m.nodes) if (n.level <= 1 && n.children.length) open.add(n.id); drawTree(); };
    main.onclick = (e) => {
      const t = e.target.closest('[data-tog]');
      if (t) {
        const id2 = t.dataset.tog;
        open.has(id2) ? open.delete(id2) : open.add(id2);
        drawTree();
        return;
      }
      const p = e.target.closest('[data-pick]');
      if (p) select(p.dataset.pick);
    };
  }

  // ---- Catalog (RF-MAP-130..131) ----
  const COLS = [
    ['area', 'Area', (n) => `${dot(areaByName.get(n.area), esc)} ${esc(n.area)}`, (n) => n.area],
    ['level', 'Livello', (n) => n.level, (n) => n.level, true],
    ['name', 'Nome', (n) => `<button type="button" class="linklike" data-pick="${esc(n.id)}">${esc(n.shortName)}</button>`, (n) => n.shortName.toLowerCase()],
    ['title', 'Title', (n) => esc(n.title || ''), (n) => (n.title || '').toLowerCase()],
    ['path', 'Path', (n) => `<span class="mono small">${esc(pathOf(n, m) || '/')}</span>${n.reachedFrom ? `<div class="muted small">raggiunta da ${esc(n.reachedFrom)}</div>` : ''}`, (n) => pathOf(n, m)],
    ['h1', 'H1', (n) => esc(n.h1 || ''), (n) => (n.h1 || '').toLowerCase()],
    ['desc', 'Description', (n) => `<span class="small">${esc(n.description || '')}</span>`, (n) => (n.description || '').toLowerCase()],
    ['words', 'Parole', (n) => fmtNum(n.wordCount), (n) => n.wordCount ?? -1, true],
    ['docs', 'Documenti', (n) => n.documents.length, (n) => n.documents.length, true],
    ['cin', 'Contenuto in', (n) => fmtNum(n.contentIn.length), (n) => n.contentIn.length, true],
    ['cout', 'Contenuto out', (n) => fmtNum(n.contentOut.length), (n) => n.contentOut.length, true],
    ['tin', 'Link in', (n) => fmtNum(n.totalIn), (n) => n.totalIn, true],
    ['tout', 'Link out', (n) => fmtNum(n.totalOut), (n) => n.totalOut, true],
    ['gnav', 'Nav. globale', (n) => (n.globalNav ? '●' : ''), (n) => (n.globalNav ? 1 : 0), true],
    ['click', 'Click', (n) => fmtNum(n.clickDepth), (n) => n.clickDepth ?? 1e9, true],
    ['note', 'Nota', (n) => (m.notes.pages[n.id] ? `<span class="notemark" title="${esc(m.notes.pages[n.id].slice(0, 300))}">✎</span>` : ''), (n) => (m.notes.pages[n.id] ? 1 : 0), true],
    ['lang', 'Lingua', (n) => esc(n.lang || ''), (n) => n.lang || ''],
  ];
  const DEFAULT_COLS = ['area', 'level', 'name', 'title', 'path', 'words', 'docs', 'cin', 'cout', 'gnav', 'click', 'note'];
  let cols = DEFAULT_COLS;
  try { const saved = JSON.parse(localStorage.getItem('sitescanner.mapcols') || 'null'); if (Array.isArray(saved) && saved.length) cols = saved.filter((c) => COLS.some((x) => x[0] === c)); } catch { /* default */ }
  let limit = 200;
  function drawCatalog() {
    const def = COLS.find((c) => c[0] === F.sort) || COLS[1];
    const rows = m.nodes.filter((n) => visibleIds.has(n.id)).sort((a, b) => {
      const x = def[3](a), y = def[3](b);
      return (x < y ? -1 : x > y ? 1 : a.id.localeCompare(b.id)) * F.dir;
    });
    const shown = rows.slice(0, limit);
    const shownCols = COLS.filter((c) => cols.includes(c[0]));
    $('#mapMain').innerHTML = `<div class="panel">
      <details class="colpick"><summary>Colonne</summary><div class="row" style="flex-wrap:wrap;gap:10px">${COLS.map((c) => `<label class="check"><input type="checkbox" data-col="${c[0]}" ${cols.includes(c[0]) ? 'checked' : ''}> ${esc(c[1])}</label>`).join('')}</div></details>
      <div class="tablewrap"><table class="mcat"><thead><tr>${shownCols.map((c) => `<th${c[4] ? ' class="num"' : ''}><button type="button" class="linklike" data-sort="${c[0]}" aria-label="Ordina per ${esc(c[1])}">${esc(c[1])}${F.sort === c[0] ? (F.dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`).join('')}</tr></thead>
      <tbody>${shown.map((n) => `<tr data-sel="${esc(n.id)}" class="${F.sel === n.id ? 'selected' : ''}">${shownCols.map((c) => `<td${c[4] ? ' class="num"' : ''}>${c[2](n)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      ${rows.length > shown.length ? `<p><button type="button" class="btn" id="cmore">Mostra altre ${Math.min(500, rows.length - shown.length)} di ${fmtNum(rows.length - shown.length)}</button></p>` : ''}
      ${rows.length ? '' : '<p class="muted">Nessuna pagina corrisponde ai filtri.</p>'}</div>`;
    const main = $('#mapMain');
    main.onclick = (e) => {
      const s = e.target.closest('[data-sort]');
      if (s) {
        const k = s.dataset.sort;
        F.dir = F.sort === k ? -F.dir : COLS.find((c) => c[0] === k)[4] ? -1 : 1;
        F.sort = k;
        syncUrl();
        drawCatalog();
        return;
      }
      const p = e.target.closest('[data-pick]');
      if (p) return select(p.dataset.pick);
      const r = e.target.closest('tr[data-sel]');
      if (r && !e.target.closest('a,input')) select(r.dataset.sel);
    };
    main.onchange = (e) => {
      const c = e.target.closest('[data-col]');
      if (!c) return;
      cols = COLS.map((x) => x[0]).filter((k) => (k === c.dataset.col ? c.checked : cols.includes(k)));
      try { localStorage.setItem('sitescanner.mapcols', JSON.stringify(cols)); } catch { /* ignore */ }
      drawCatalog();
    };
    const more = $('#cmore');
    if (more) more.onclick = () => { limit += 500; drawCatalog(); };
  }

  // ---- Redirects and ecosystem (RF-MAP-84, 85) ----
  const REL = { main: 'principale', 'sibling-visited': 'fratello visitato', 'sibling-not-visited': 'fratello non visitato', external: 'esterno' };
  function drawRedirects() {
    const s = m.stats;
    $('#mapMain').innerHTML = `
      <div class="panel"><h2>Ecosistema</h2><p class="muted small">Host linkati dalle pagine del sito (pagine che li linkano, non singoli link).</p>
        <div class="tablewrap"><table><thead><tr><th>Host</th><th>Relazione</th><th class="num">Pagine che lo linkano</th><th class="num">Pagine visitate</th></tr></thead>
        <tbody>${s.ecosystem.map((e) => `<tr><td class="mono small">${esc(e.host)}</td><td>${esc(REL[e.relation] || e.relation)}</td><td class="num">${fmtNum(e.pages)}</td><td class="num">${fmtNum(e.visited)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nessun host.</td></tr>'}</tbody></table></div></div>
      <div class="panel"><h2>Redirect</h2>
        <div class="tablewrap"><table><thead><tr><th>Da</th><th>A</th><th class="num">Status</th><th class="num">Salti</th><th>Tipo</th><th class="num">Link da menu</th><th class="num">Link da contenuto</th></tr></thead>
        <tbody>${s.redirects.map((r) => `<tr><td class="mono small">${esc(r.id)}</td><td>${r.target && byId.has(r.target) ? `<button type="button" class="linklike" data-pick="${esc(r.target)}">${esc(byId.get(r.target).shortName)}</button>` : `<span class="mono small">${esc(r.finalUrl)}</span>`}</td>
          <td class="num">${esc(r.status)}</td><td class="num">${r.hops}</td><td>${r.crossHost ? 'tra host' : 'stesso host'}${r.crossArea ? ' · tra aree' : ''}</td><td class="num">${fmtNum(r.linkedFromNav)}</td><td class="num">${fmtNum(r.linkedFromContent)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Nessun redirect.</td></tr>'}</tbody></table></div></div>`;
    $('#mapMain').onclick = (e) => {
      const p = e.target.closest('[data-pick]');
      if (p) select(p.dataset.pick);
    };
  }

  let graph = null;
  async function drawGraph() {
    const box = $('#mapMain');
    box.innerHTML = '<div class="muted">Caricamento del grafo…</div>';
    try {
      await loadD3();
    } catch (e) {
      box.innerHTML = `<div class="notice warn">Il grafo non è disponibile (${esc(e.message)}). Albero e Catalogo mostrano gli stessi dati.</div>`;
      return;
    }
    graph = createGraph({ root: box, m, byId, areaByName, getVisible: () => visibleIds, getSel: () => F.sel, select, esc, fmtNum, initial: { layout: F.layout, baseHash: base } });
    window.__mapGraph = graph;
    if (F.sel) graph.center(F.sel);
    const lay = box.querySelector('#glay');
    lay.addEventListener('change', syncUrl);
  }
  const drawMain = () => (tab === 'catalog' ? drawCatalog() : tab === 'redirects' ? drawRedirects() : tab === 'graph' ? drawGraph() : drawTree());
  // keyboard (RF-MAP-117): "/" goes to the search, Enter on it selects the first result
  root.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) { e.preventDefault(); $('#mq').focus(); }
  });
  $('#mq').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = m.nodes.find((n) => visibleIds.has(n.id));
    if (first) { select(first.id); if (graph) graph.center(first.id); }
  });
  computeVisible();
  $('#mcount').textContent = `${fmtNum(visibleIds.size)} di ${fmtNum(m.nodes.length)} pagine`;
  drawAreas();
  drawMain();
  drawInspector();
  if (tab === 'redirects') { /* filters do not apply to these tables */ $('.mapbar').hidden = true; }
}
