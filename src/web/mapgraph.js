// Graph of the site map on a canvas (spec §14.5.2). Positions come from d3-hierarchy (radial, levels) and
// d3-force (force, in a Web Worker); drawing, labels and interaction are ours (ADR-0021). The map comes from
// src/core/sitemap.js; the filters and the selection are those of mapview.js.

const VENDOR = ['d3-dispatch', 'd3-quadtree', 'd3-timer', 'd3-force', 'd3-hierarchy'];
const AGGREGATE_ABOVE = 1500; // RF-MAP-116
const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let d3Promise = null;
/** The d3 libraries are classic scripts that attach to `window.d3`; loaded once, in order. */
export function loadD3() {
  if (window.d3 && window.d3.hierarchy && window.d3.forceSimulation) return Promise.resolve(window.d3);
  d3Promise ||= VENDOR.reduce((p, name) => p.then(() => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `/app/vendor/${name}.min.js`;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`${name} non disponibile`));
    document.head.appendChild(s);
  })), Promise.resolve()).then(() => window.d3);
  return d3Promise;
}

const EDGE_MODES = [['hc', 'Gerarchia + contenuto'], ['h', 'Solo gerarchia'], ['c', 'Solo contenuto'], ['n', 'Solo navigazione']];
const LAYOUTS = [['radial', 'Radiale'], ['levels', 'Livelli'], ['force', 'Forza']];

export function createGraph({ root, m, byId, areaByName, getVisible, getSel, select, esc, fmtNum, initial = {} }) {
  const dark = () => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const opt = { layout: initial.layout || 'radial', edges: initial.edges || 'hc', size: initial.size || 'level' };
  const expanded = new Set();
  let nodes = [], edges = [], pos = new Map(), nodeIdx = new Map(), adj = new Map();
  let view = { k: 1, x: 0, y: 0 };
  let hover = null, raf = 0, worker = null, tween = null, aggregated = false, w = 0, h = 0, dpr = 1;
  // groups of the aggregated view: the sub-areas (RF-MAP-73), or the pages of level 1 when the site has none
  const subareaIds = new Set(m.subareas.length ? m.subareas.map((s) => s.id) : m.nodes.filter((n) => n.level === 1).map((n) => n.id));

  root.innerHTML = `
    <div class="gbar row" style="gap:10px;flex-wrap:wrap;margin-bottom:8px">
      <label class="small">Disposizione <select class="input" id="glay" style="width:auto">${LAYOUTS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
      <label class="small">Archi <select class="input" id="ged" style="width:auto">${EDGE_MODES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
      <label class="small">Dimensione <select class="input" id="gsz" style="width:auto"><option value="level">per livello</option><option value="links">per link in entrata</option></select></label>
      <span class="gzoom"><button type="button" class="btn small" id="gzi" aria-label="Ingrandisci">+</button> <button type="button" class="btn small" id="gzo" aria-label="Riduci">−</button> <button type="button" class="btn small" id="gcen">Centra</button> <button type="button" class="btn small" id="gfit">Adatta</button></span>
      <span class="muted small" id="gnote" role="status"></span>
    </div>
    <div class="gwrap panel"><canvas id="gcv" tabindex="0" role="img" aria-label="Grafo della mappa del sito: pagine colorate per area. Lo stesso contenuto, navigabile da tastiera, è nell'Albero e nel Catalogo."></canvas>
      <div class="glegend" id="gleg"></div><div class="gtip" id="gtip" hidden></div></div>
    <p class="muted small">Equivalente navigabile da tastiera: <a href="${esc(initial.baseHash || '#')}?tab=tree">Albero</a> · <a href="${esc(initial.baseHash || '#')}?tab=catalog">Catalogo</a>. Tasti: <kbd>/</kbd> cerca, <kbd>+</kbd> <kbd>−</kbd> zoom, <kbd>0</kbd> centra.</p>`;
  const $ = (s) => root.querySelector(s);
  const cv = $('#gcv');
  const ctx = cv.getContext('2d');
  $('#glay').value = opt.layout;
  $('#ged').value = opt.edges;
  $('#gsz').value = opt.size;

  // ---- data of the current view: the visible nodes, or one node per sub-area on large sites ----
  function build() {
    const vis = getVisible();
    aggregated = vis.size > AGGREGATE_ABOVE;
    const groupOf = new Map();
    if (aggregated) {
      for (const id of vis) {
        let g = id;
        for (let c = id; c; c = byId.get(c)?.parent) if (subareaIds.has(c) && !expanded.has(c)) g = c;
        groupOf.set(id, g);
      }
    } else for (const id of vis) groupOf.set(id, id);
    const groups = new Map();
    for (const id of vis) {
      const g = groupOf.get(id);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(id);
    }
    nodes = [];
    nodeIdx = new Map();
    for (const [g, members] of groups) {
      const n = byId.get(g);
      const rec = { id: g, agg: aggregated && members.length > 1, count: members.length, area: n.area, level: n.level, label: n.shortName, host: n.host, inl: n.contentIn.length, sub: n.subtree };
      nodeIdx.set(g, rec);
      nodes.push(rec);
    }
    // a member of a group stands for the group in the edges
    const key = (id) => groupOf.get(id);
    const seen = new Set();
    edges = [];
    const add = (s, t, type) => {
      const a = key(s), b = key(t);
      if (a === undefined || b === undefined || a === b) return;
      const k = `${type}|${a}|${b}`;
      if (seen.has(k)) return;
      seen.add(k);
      edges.push({ s: a, t: b, type });
    };
    for (const e of m.edges.hierarchy) add(e.source, e.target, 'h');
    if (m.edges.content.length < 400000) for (const e of m.edges.content) add(e.source, e.target, 'c');
    for (const e of m.edges.navigation) if (opt.edges === 'n') add(e.source, e.target, 'n');
    adj = new Map();
    for (const e of edges) {
      for (const [a, b, dir] of [[e.s, e.t, 'out'], [e.t, e.s, 'in']]) {
        if (!adj.has(a)) adj.set(a, { out: new Set(), in: new Set() });
        adj.get(a)[dir].add(b);
      }
    }
    $('#gnote').textContent = aggregated ? `Oltre ${fmtNum(AGGREGATE_ABOVE)} pagine: un nodo per sottoarea (${fmtNum(nodes.length)}). Clic su un nodo con il numero per espanderlo.` : `${fmtNum(nodes.length)} nodi`;
    const fo = $('#glay').querySelector('option[value="force"]');
    fo.disabled = vis.size > AGGREGATE_ABOVE;
    if (fo.disabled && opt.layout === 'force') { opt.layout = 'radial'; $('#glay').value = 'radial'; }
    drawLegend();
  }

  function drawLegend() {
    const used = [...new Set(nodes.map((n) => n.area))];
    $('#gleg').innerHTML = `<div class="small"><span class="lg-h"></span> gerarchia <span class="lg-c"></span> contenuto <span class="lg-b"></span> pagine di confine</div>`
      + used.slice(0, 12).map((a) => { const c = areaByName.get(a).color; return `<span class="small"><span class="adot" style="--c-l:${esc(c.light)};--c-d:${esc(c.dark)}"></span> ${esc(a)}</span>`; }).join(' ');
  }

  // ---- layouts ----
  function treeOfVisible() {
    const d3 = window.d3;
    const parentOf = (id) => {
      for (let c = byId.get(id)?.parent; c; c = byId.get(c)?.parent) if (nodeIdx.has(c)) return c;
      return null;
    };
    // a group takes the parent of its top page
    const rows = nodes.map((n) => ({ id: n.id, parent: parentOf(n.id) }));
    const roots = rows.filter((r) => !r.parent);
    if (roots.length !== 1) rows.push({ id: '__root', parent: null }), roots.forEach((r) => { r.parent = '__root'; });
    return d3.stratify().id((r) => r.id).parentId((r) => r.parent)(rows);
  }
  function layoutTargets(kind) {
    const d3 = window.d3;
    const t = treeOfVisible();
    const leaves = t.leaves().length;
    const depth = t.height || 1;
    const out = new Map();
    if (kind === 'levels') {
      d3.tree().nodeSize([20, 190])(t);
      t.each((d) => out.set(d.id, { x: d.y, y: d.x }));
    } else {
      const R = Math.max(240, 95 * depth + Math.sqrt(leaves) * 14);
      d3.tree().size([2 * Math.PI, R]).separation(() => 1)(t);
      t.each((d) => out.set(d.id, { x: d.y * Math.cos(d.x - Math.PI / 2), y: d.y * Math.sin(d.x - Math.PI / 2) }));
    }
    out.delete('__root');
    return out;
  }
  function moveTo(targets, animate = true) {
    const from = new Map(pos);
    pos = new Map(nodes.map((n) => [n.id, { ...(targets.get(n.id) || { x: 0, y: 0 }) }]));
    if (!animate || reduced() || !from.size) { tween = null; schedule(); return; }
    for (const [id, p] of pos) { const f = from.get(id); p.fx0 = f ? f.x : p.x; p.fy0 = f ? f.y : p.y; }
    tween = { t0: performance.now(), dur: 450 };
    schedule();
  }
  function applyLayout(animate = true) {
    if (worker) { worker.terminate(); worker = null; }
    const base = layoutTargets(opt.layout === 'levels' ? 'levels' : 'radial');
    moveTo(base, animate);
    if (opt.layout === 'force') runForce(base);
    fit();
  }
  // d3-force runs in a Worker (RF-MAP-116); the positions arrive as it cools down
  function runForce(start) {
    const data = {
      nodes: nodes.map((n) => ({ id: n.id, x: (start.get(n.id) || { x: 0 }).x, y: (start.get(n.id) || { y: 0 }).y, fixed: n.level === 0 })),
      links: edges.filter((e) => e.type === 'h').map((e) => ({ source: e.s, target: e.t })),
    };
    try {
      worker = new Worker('/app/mapgraph-worker.js');
    } catch {
      worker = null;
    }
    if (!worker) { forceOnMainThread(data); return; }
    const mine = worker;
    mine.onmessage = (ev) => {
      if (worker !== mine) return;
      for (const p of ev.data.nodes) { const q = pos.get(p.id); if (q) { q.x = p.x; q.y = p.y; q.fx0 = q.fy0 = undefined; } }
      tween = null;
      if (ev.data.done) { mine.terminate(); worker = null; fit(); }
      schedule();
    };
    mine.onerror = () => { mine.terminate(); if (worker === mine) { worker = null; forceOnMainThread(data); } };
    mine.postMessage(data);
  }
  function forceOnMainThread(data) {
    const d3 = window.d3;
    const sim = d3.forceSimulation(data.nodes).force('link', d3.forceLink(data.links).id((d) => d.id).distance(40).strength(0.6)).force('charge', d3.forceManyBody().strength(-60)).force('center', d3.forceCenter(0, 0)).stop();
    for (const n of data.nodes) if (n.fixed) { n.fx = 0; n.fy = 0; }
    let i = 0;
    const step = () => {
      for (let j = 0; j < 10 && i < 300; j++, i++) sim.tick();
      for (const p of data.nodes) { const q = pos.get(p.id); if (q) { q.x = p.x; q.y = p.y; q.fx0 = q.fy0 = undefined; } }
      tween = null;
      schedule();
      if (i < 300) setTimeout(step, 0); else fit();
    };
    step();
  }

  // ---- view ----
  function size() {
    const r = cv.parentElement.getBoundingClientRect();
    w = Math.max(280, Math.floor(r.width));
    h = Math.max(360, Math.min(700, Math.floor(window.innerHeight * 0.7)));
    dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr;
    cv.height = h * dpr;
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
  }
  function curPos(n) {
    const p = pos.get(n.id);
    if (!p) return { x: 0, y: 0 };
    if (tween && p.fx0 !== undefined) {
      const t = Math.min(1, (performance.now() - tween.t0) / tween.dur);
      const e = t * t * (3 - 2 * t);
      return { x: p.fx0 + (p.x - p.fx0) * e, y: p.fy0 + (p.y - p.fy0) * e };
    }
    return p;
  }
  function fit() {
    if (!nodes.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) { const p = pos.get(n.id); if (!p) continue; x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    if (!isFinite(x0)) return;
    const pad = 50;
    const k = Math.max(0.2, Math.min(4, Math.min((w - pad * 2) / Math.max(1, x1 - x0), (h - pad * 2) / Math.max(1, y1 - y0))));
    view = { k, x: w / 2 - ((x0 + x1) / 2) * k, y: h / 2 - ((y0 + y1) / 2) * k };
    schedule();
  }
  function centerOn(id) {
    const p = pos.get(id);
    if (!p) return fit();
    view = { k: Math.max(view.k, 1), x: w / 2 - p.x * Math.max(view.k, 1), y: h / 2 - p.y * Math.max(view.k, 1) };
    schedule();
  }
  function zoomAt(f, cx = w / 2, cy = h / 2) {
    const k = Math.max(0.2, Math.min(4, view.k * f));
    view = { k, x: cx - ((cx - view.x) / view.k) * k, y: cy - ((cy - view.y) / view.k) * k };
    schedule();
  }

  // ---- drawing ----
  const css = () => {
    const cs = getComputedStyle(cv);
    return { bg: cs.getPropertyValue('--panel').trim() || '#fff', text: cs.getPropertyValue('--text').trim() || '#111', muted: cs.getPropertyValue('--muted').trim() || '#666', line: cs.getPropertyValue('--line').trim() || '#ccc', accent: cs.getPropertyValue('--accent').trim() || '#2f5fd0' };
  };
  const radius = (n) => (opt.size === 'links' ? 3 + Math.min(14, Math.sqrt(n.inl) * 1.6) : Math.max(3.5, 10 - n.level * 1.6)) + (n.agg ? Math.min(8, Math.log2(n.count)) : 0);
  const colorOf = (n) => { const c = areaByName.get(n.area).color; return dark() ? c.dark : c.light; };
  let lastDrawMs = 0;
  function draw() {
    raf = 0;
    const t0 = performance.now();
    const c = css();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y);
    const sel = getSel();
    const focus = hover || sel;
    const near = focus && adj.get(focus) ? adj.get(focus) : null;
    const visibleType = (t) => (opt.edges === 'hc' ? t === 'h' || t === 'c' : opt.edges === 'h' ? t === 'h' : opt.edges === 'c' ? t === 'c' : t === 'n');
    const manyContent = edges.filter((e) => e.type === 'c').length > 3000;
    for (const e of edges) {
      if (!visibleType(e.type)) continue;
      const a = nodeIdx.get(e.s), b = nodeIdx.get(e.t);
      if (!a || !b) continue;
      const touch = focus && (e.s === focus || e.t === focus);
      if (e.type !== 'h' && manyContent && !touch && view.k < 1.5) continue;
      const p = curPos(a), q = curPos(b);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      if (e.type === 'h') { ctx.setLineDash([]); ctx.lineTo(q.x, q.y); }
      else { ctx.setLineDash([4 / view.k, 3 / view.k]); ctx.quadraticCurveTo((p.x + q.x) / 2 - (q.y - p.y) * 0.15, (p.y + q.y) / 2 + (q.x - p.x) * 0.15, q.x, q.y); }
      if (nodeIdx.get(e.t).host !== m.mainHost || nodeIdx.get(e.s).host !== m.mainHost) ctx.setLineDash([1.5 / view.k, 3 / view.k]);
      ctx.lineWidth = (touch ? 1.8 : e.type === 'h' ? 1 : 0.7) / view.k;
      ctx.strokeStyle = touch ? (e.s === focus ? c.accent : '#d95926') : c.line;
      ctx.globalAlpha = focus && !touch ? 0.25 : 1;
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    const showLabel = (n) => n.level <= 1 || n.id === sel || n.id === hover || view.k > 1.6 || (near && (near.out.has(n.id) || near.in.has(n.id)) && focus);
    ctx.font = `${12 / view.k}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    const labels = [];
    for (const n of nodes) {
      const p = curPos(n);
      const r = radius(n);
      const dim = focus && n.id !== focus && !(near && (near.out.has(n.id) || near.in.has(n.id)));
      ctx.globalAlpha = dim ? 0.3 : 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = colorOf(n);
      ctx.fill();
      if (n.host !== m.mainHost) { ctx.setLineDash([2 / view.k, 2 / view.k]); ctx.strokeStyle = c.text; ctx.lineWidth = 1.2 / view.k; ctx.stroke(); ctx.setLineDash([]); }
      if (n.id === sel) { ctx.lineWidth = 2.5 / view.k; ctx.strokeStyle = c.text; ctx.beginPath(); ctx.arc(p.x, p.y, r + 3 / view.k, 0, Math.PI * 2); ctx.stroke(); }
      if (n.agg) { ctx.fillStyle = '#fff'; ctx.font = `${11 / view.k}px system-ui`; ctx.textAlign = 'center'; ctx.fillText(String(n.count), p.x, p.y); ctx.textAlign = 'start'; ctx.font = `${12 / view.k}px system-ui, sans-serif`; }
      if (showLabel(n)) labels.push([n, p, r]);
    }
    ctx.globalAlpha = 1;
    for (const [n, p, r] of labels) {
      const text = n.label.length > 28 ? `${n.label.slice(0, 27)}…` : n.label;
      ctx.lineWidth = 3 / view.k;
      ctx.strokeStyle = c.bg;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, p.x + r + 3 / view.k, p.y);
      ctx.fillStyle = c.text;
      ctx.fillText(text, p.x + r + 3 / view.k, p.y);
    }
    lastDrawMs = performance.now() - t0;
    if (tween && performance.now() - tween.t0 < tween.dur) schedule();
    else tween = null;
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(draw); }

  // ---- interaction (RF-MAP-113, 114) ----
  const toWorld = (sx, sy) => ({ x: (sx - view.x) / view.k, y: (sy - view.y) / view.k });
  function hit(sx, sy) {
    const p = toWorld(sx, sy);
    let best = null, bd = Infinity;
    for (const n of nodes) {
      const q = curPos(n);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d <= radius(n) + 4 / view.k && d < bd) { best = n; bd = d; }
    }
    return best;
  }
  const rect = () => cv.getBoundingClientRect();
  const pointers = new Map();
  let drag = null, pinch = 0, moved = false;
  cv.onpointerdown = (e) => {
    cv.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); drag = null; return; }
    const r = rect();
    const n = hit(e.clientX - r.left, e.clientY - r.top);
    drag = n ? { node: n.id, ox: 0, oy: 0 } : { pan: true, x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  };
  cv.onpointermove = (e) => {
    const r = rect();
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) zoomAt(d / pinch, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      pinch = d;
      moved = true;
      return;
    }
    if (drag && drag.pan) {
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) moved = true;
      view.x = drag.vx + e.clientX - drag.x;
      view.y = drag.vy + e.clientY - drag.y;
      schedule();
    } else if (drag && drag.node) {
      moved = true;
      const p = toWorld(e.clientX - r.left, e.clientY - r.top);
      const q = pos.get(drag.node);
      if (q) { q.x = p.x; q.y = p.y; q.fx0 = q.fy0 = undefined; tween = null; }
      schedule();
    } else {
      const n = hit(e.clientX - r.left, e.clientY - r.top);
      setHover(n ? n.id : null, e.clientX - r.left, e.clientY - r.top);
    }
  };
  cv.onpointerup = (e) => {
    const r = rect();
    pointers.delete(e.pointerId);
    pinch = 0;
    if (!moved) {
      const n = hit(e.clientX - r.left, e.clientY - r.top);
      if (n && n.agg) { expanded.add(n.id); refresh(false); } else if (n) select(n.id);
    }
    drag = null;
  };
  cv.onpointerleave = () => { if (!drag) setHover(null); };
  cv.onwheel = (e) => {
    e.preventDefault();
    const r = rect();
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
  };
  cv.onkeydown = (e) => {
    if (e.key === '+' || e.key === '=') zoomAt(1.2);
    else if (e.key === '-') zoomAt(1 / 1.2);
    else if (e.key === '0') { const s = getSel(); s ? centerOn(s) : fit(); } else return;
    e.preventDefault();
  };
  function setHover(id, x, y) {
    const tip = $('#gtip');
    if (id !== hover) { hover = id; schedule(); }
    if (!id) { tip.hidden = true; return; }
    const n = byId.get(id);
    const g = nodeIdx.get(id);
    tip.innerHTML = g.agg ? `<strong>${esc(g.label)}</strong><br>${fmtNum(g.count)} pagine · ${esc(g.area)}` : `<strong>${esc(n.shortName)}</strong><br><span class="muted">${esc(n.area)}</span><br><span class="mono small">${esc((n.host === m.mainHost ? '' : n.host) + n.key)}</span>${n.description ? `<br>${esc(n.description.slice(0, 140))}` : ''}`;
    tip.hidden = false;
    tip.style.left = `${Math.min(w - 260, x + 14)}px`;
    tip.style.top = `${Math.min(h - 90, y + 14)}px`;
  }
  $('#glay').onchange = (e) => { opt.layout = e.target.value; applyLayout(true); };
  $('#ged').onchange = (e) => { opt.edges = e.target.value; schedule(); };
  $('#gsz').onchange = (e) => { opt.size = e.target.value; schedule(); };
  $('#gzi').onclick = () => zoomAt(1.25);
  $('#gzo').onclick = () => zoomAt(1 / 1.25);
  $('#gfit').onclick = fit;
  $('#gcen').onclick = () => { const s = getSel(); s ? centerOn(s) : fit(); };

  function refresh(animate = true) {
    build();
    applyLayout(animate);
  }
  const onResize = () => { size(); schedule(); };
  window.addEventListener('resize', onResize);
  size();
  refresh(false);
  if (getSel()) centerOn(getSel());

  return {
    /** Filters changed. */
    update: () => refresh(true),
    /** Selection changed from outside. */
    redraw: () => schedule(),
    center: (id) => centerOn(id),
    destroy: () => { window.removeEventListener('resize', onResize); if (worker) worker.terminate(); cancelAnimationFrame(raf); },
    // for tests: where a node is on the screen
    screenPos: (id) => { const p = pos.get(id); return p ? { x: p.x * view.k + view.x, y: p.y * view.k + view.y } : null; },
    state: () => ({ layout: opt.layout, aggregated, nodes: nodes.length, edges: edges.length, drawMs: lastDrawMs }),
  };
}
