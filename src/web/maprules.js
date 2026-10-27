// Editor of the rules of the site map and the small dialogs of the inspector (spec §14.5.6, RF-MAP-150..152).
// Rules are saved in the overlay of the inventory (or in the site's file); every change is previewed by the server.

const lines = (v) => String(v || '').split('\n').map((s) => s.trim()).filter(Boolean);

function dialog(html) {
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog wide';
  dlg.innerHTML = html;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  return dlg;
}

/**
 * The editor of areas, parents, brand affix and sub-area size. `m` is the map in force: its rules are the start.
 * @param {{id: string, m: object, api: Function, esc: Function, fmtNum: Function, sites: string[], onSaved: Function}} o
 */
export function openRulesEditor({ id, m, api, esc, fmtNum, sites = [], onSaved }) {
  const rules = JSON.parse(JSON.stringify(m.rules || {}));
  const areas = rules.areas || [];
  const parents = rules.parents || [];
  const hosts = [...new Set(m.nodes.map((n) => n.host))];
  const affix = rules.titleAffix && typeof rules.titleAffix === 'object' ? rules.titleAffix : {};
  const noAffix = rules.titleAffix === false;
  const dlg = dialog(`<form method="dialog" class="rules">
    <h2>Aree e gerarchia</h2>
    <p class="muted small">${m.rulesFrom === 'inventory' ? 'Regole salvate con questo inventario.' : m.rulesFrom === 'site' ? `Regole del sito «${esc(m.site)}».` : 'Nessuna regola: aree automatiche.'} I criteri sono prefissi di path (<span class="mono">/it/prestiti/</span>) o espressioni regolari (<span class="mono">re:^/it/mutui/</span>); una per riga. La prima regola che corrisponde vince.</p>
    <h3>Aree</h3><div id="rAreas"></div><p><button type="button" class="btn small" id="rAddArea">Aggiungi area</button></p>
    <h3>Genitori</h3><p class="muted small">Una pagina (o un gruppo di pagine) agganciata a un genitore diverso da quello che avrebbe per path. Il genitore è un path o l'id di una pagina.</p>
    <div id="rParents"></div><p><button type="button" class="btn small" id="rAddParent">Aggiungi regola</button></p>
    <h3>Nome breve</h3>
    <label class="check"><input type="checkbox" id="rNoAffix" ${noAffix ? 'checked' : ''}> non togliere il nome del brand dai title</label>
    <div class="fields" id="rAffix">${hosts.map((h) => `<label class="f"><span>Prefisso/suffisso di ${esc(h)}</span><input class="input" data-host="${esc(h)}" value="${esc(affix[h] ?? '')}" placeholder="automatico, es. &quot; | Marca&quot;"></label>`).join('')}</div>
    <label class="f"><span>Pagine minime di una sottoarea</span><input class="input" type="number" id="rSub" min="1" max="1000" value="${esc(rules.subareaMin ?? 3)}" style="max-width:120px"></label>
    <h3>Anteprima</h3><div id="rPrev" class="small muted">…</div>
    <p class="formerr" id="rErr" hidden></p>
    <div class="row end" style="flex-wrap:wrap">
      ${sites.length ? `<select class="input" id="rSite" style="max-width:200px" aria-label="Sito">${sites.map((s) => `<option>${esc(s)}</option>`).join('')}</select><button type="button" class="btn" id="rToSite">Usa come regole del sito</button>` : ''}
      ${m.site ? '<button type="button" class="btn" id="rSaveSite">Salva nel sito</button>' : ''}
      <button type="button" class="btn" data-x>Annulla</button>
      <button type="button" class="btn primary" id="rSave">Salva con l'inventario</button>
    </div></form>`);
  const $ = (s) => dlg.querySelector(s);
  const err = (msg) => { $('#rErr').textContent = msg || ''; $('#rErr').hidden = !msg; };

  function drawAreas() {
    $('#rAreas').innerHTML = areas.length ? areas.map((a, i) => `<div class="rrow" data-i="${i}">
      <input class="input" data-f="name" placeholder="Nome dell'area" value="${esc(a.name)}" aria-label="Nome">
      <input class="input" data-f="color" placeholder="#rrggbb (facoltativo)" value="${esc(a.color || '')}" style="max-width:150px" aria-label="Colore">
      <textarea class="input" data-f="match" rows="2" placeholder="/it/prestiti/" aria-label="Criteri">${esc((a.match || []).join('\n'))}</textarea>
      <span class="rbtn"><button type="button" class="btn small" data-up aria-label="Su">↑</button><button type="button" class="btn small" data-down aria-label="Giù">↓</button><button type="button" class="btn small" data-del aria-label="Elimina">✕</button></span></div>`).join('') : '<p class="muted small">Nessuna regola: le aree sono quelle automatiche.</p>';
  }
  function drawParents() {
    $('#rParents').innerHTML = parents.length ? parents.map((p, i) => `<div class="rrow" data-i="${i}">
      <textarea class="input" data-f="match" rows="2" placeholder="/it/vecchia/" aria-label="Criteri">${esc((p.match || []).join('\n'))}</textarea>
      <input class="input" data-f="parent" placeholder="genitore, es. /it/nuova/" value="${esc(p.parent || '')}" aria-label="Genitore">
      <span class="rbtn"><button type="button" class="btn small" data-del aria-label="Elimina">✕</button></span></div>`).join('') : '<p class="muted small">Nessuna regola.</p>';
  }
  const current = () => {
    const out = {
      areas: areas.filter((a) => a.name || (a.match || []).length).map((a) => ({ name: a.name, match: a.match || [], ...(a.color ? { color: a.color } : {}) })),
      parents: parents.filter((p) => (p.match || []).length || p.parent).map((p) => ({ match: p.match || [], parent: p.parent })),
      subareaMin: Number($('#rSub').value) || 3,
    };
    if ($('#rNoAffix').checked) out.titleAffix = false;
    else {
      const t = {};
      for (const i of dlg.querySelectorAll('[data-host]')) if (i.value) t[i.dataset.host] = i.value;
      if (Object.keys(t).length) out.titleAffix = t;
    }
    return out;
  };
  let timer = null, seq = 0;
  const preview = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const r = await api('POST', `inventories/${encodeURIComponent(id)}/map`, { rules: current() });
        if (mine !== seq) return;
        err('');
        $('#rPrev').innerHTML = `${r.areas.map((a) => `<span class="chip"><span class="adot" style="--c-l:${esc(a.color.light)};--c-d:${esc(a.color.dark)}"></span> ${esc(a.name)} <span class="muted">${fmtNum(a.pages)}</span></span>`).join(' ')}${r.warnings.map((w) => `<p class="notice warn">${esc(w)}</p>`).join('')}`;
      } catch (e) {
        if (mine === seq) { err(e.message); $('#rPrev').textContent = ''; }
      }
    }, 250);
  };
  const read = (kind, list, row, f, value) => { list[Number(row.dataset.i)][f] = f === 'match' ? lines(value) : value; void kind; };
  $('#rAreas').addEventListener('input', (e) => { const row = e.target.closest('.rrow'); if (row) { read('a', areas, row, e.target.dataset.f, e.target.value); preview(); } });
  $('#rParents').addEventListener('input', (e) => { const row = e.target.closest('.rrow'); if (row) { read('p', parents, row, e.target.dataset.f, e.target.value); preview(); } });
  $('#rAreas').addEventListener('click', (e) => {
    const row = e.target.closest('.rrow');
    if (!row) return;
    const i = Number(row.dataset.i);
    if (e.target.closest('[data-del]')) areas.splice(i, 1);
    else if (e.target.closest('[data-up]') && i > 0) [areas[i - 1], areas[i]] = [areas[i], areas[i - 1]];
    else if (e.target.closest('[data-down]') && i < areas.length - 1) [areas[i + 1], areas[i]] = [areas[i], areas[i + 1]];
    else return;
    drawAreas();
    preview();
  });
  $('#rParents').addEventListener('click', (e) => {
    const row = e.target.closest('.rrow');
    if (row && e.target.closest('[data-del]')) { parents.splice(Number(row.dataset.i), 1); drawParents(); preview(); }
  });
  $('#rAddArea').onclick = () => { areas.push({ name: '', match: [] }); drawAreas(); preview(); };
  $('#rAddParent').onclick = () => { parents.push({ match: [], parent: '' }); drawParents(); preview(); };
  for (const el of dlg.querySelectorAll('#rSub, #rNoAffix, #rAffix')) el.addEventListener('input', preview);
  dlg.querySelector('[data-x]').onclick = () => dlg.close();

  const save = async (body, done) => {
    err('');
    try {
      await api('PUT', `inventories/${encodeURIComponent(id)}/overlay`, body);
      dlg.close();
      done && done();
      onSaved();
    } catch (e) { err(e.message); }
  };
  $('#rSave').onclick = () => save({ rules: current() });
  if ($('#rSaveSite')) $('#rSaveSite').onclick = () => save({ rules: current(), toSite: true });
  if ($('#rToSite')) {
    $('#rToSite').onclick = async () => {
      try {
        await api('PUT', `inventories/${encodeURIComponent(id)}/overlay`, { rules: current() });
        await api('POST', `inventories/${encodeURIComponent(id)}/rules-to-site`, { site: $('#rSite').value });
        dlg.close();
        onSaved();
      } catch (e) { err(e.message); }
    };
  }
  drawAreas();
  drawParents();
  preview();
}

/** «Sposta in area…» and «Imposta genitore…» (RF-MAP-152): one rule for the exact path of the page. */
export function openMoveDialog({ kind, node, m, api, id, esc, withAreaRule, withParentRule, onSaved }) {
  const isArea = kind === 'area';
  const dlg = dialog(`<form method="dialog"><h2>${isArea ? 'Sposta in area' : 'Imposta genitore'}</h2>
    <p class="small"><span class="mono">${esc(node.host === m.mainHost ? '' : node.host)}${esc(node.key)}</span> — ${esc(node.shortName)}</p>
    ${isArea
    ? `<label class="f"><span>Area</span><input class="input" id="mv" list="mvList" value="${esc(node.area)}" required></label><datalist id="mvList">${m.areas.map((a) => `<option value="${esc(a.name)}">`).join('')}</datalist>`
    : `<label class="f"><span>Genitore (path o id della pagina; vuoto per ripristinare quello automatico)</span><input class="input" id="mv" list="mvList" value="${esc(node.parentKind === 'rule' ? node.parent : '')}"></label><datalist id="mvList">${m.nodes.slice(0, 400).map((n) => `<option value="${esc(n.id)}">${esc(n.shortName)}</option>`).join('')}</datalist>`}
    <p class="formerr" id="mvErr" hidden></p>
    <div class="row end"><button type="button" class="btn" data-x>Annulla</button><button type="button" class="btn primary" id="mvOk">Crea la regola</button></div></form>`);
  dlg.querySelector('[data-x]').onclick = () => dlg.close();
  dlg.querySelector('#mvOk').onclick = async () => {
    const v = dlg.querySelector('#mv').value.trim();
    if (isArea && !v) return;
    const base = JSON.parse(JSON.stringify(m.rules || {}));
    const rules = isArea
      ? withAreaRule(base, { key: node.key, host: node.host, name: v, mainHost: m.mainHost })
      : withParentRule(base, { key: node.key, host: node.host, parent: v, mainHost: m.mainHost });
    try {
      await api('PUT', `inventories/${encodeURIComponent(id)}/overlay`, { rules });
      dlg.close();
      onSaved();
    } catch (e) {
      const el = dlg.querySelector('#mvErr');
      el.textContent = e.message;
      el.hidden = false;
    }
  };
}
