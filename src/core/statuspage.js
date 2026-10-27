// Status pages, TV dashboard and badges (spec §13.11, RF-PUB-01..06): validation, the status of a component, the
// pages as HTML and the badges as SVG. Pure: no I/O. Everything written in a page is escaped; nothing internal goes in.

export const RESERVED_SLUGS = new Set(['admin', 'api', 'app', 'login', 'report', 'status', 'tv', 'badge', 'hb', 'files', 'new']);
export const UPDATE_STATUSES = { investigating: 'In analisi', identified: 'Identificato', monitoring: 'In osservazione', resolved: 'Risolto' };
export const COMPONENT_STATUS = {
  operational: ['Operativo', 'ok'], degraded: ['Prestazioni ridotte', 'warn'], maintenance: ['In manutenzione', 'info'], outage: ['Non disponibile', 'error'], unknown: ['Nessun dato', 'none'],
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------------- validation ----------------

export function slugProblem(slug) {
  const s = String(slug ?? '');
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(s)) return "L'indirizzo ha da 3 a 40 caratteri tra a-z, 0-9 e trattino, e comincia con una lettera o una cifra";
  if (RESERVED_SLUGS.has(s)) return `«${s}» è riservato: scegline un altro`;
  return null;
}

const httpsUrl = (v, label) => {
  const s = String(v ?? '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('x');
    return u.toString();
  } catch {
    throw new Error(`${label}: serve un indirizzo http o https`);
  }
};

/**
 * A status page as the form sends it (RF-PUB-01..04). `monitorIds` of the components are checked by the caller against
 * the monitors of the workspace. Throws an Error with a message for the form.
 */
export function normalizePage(input, { newId } = {}) {
  const slug = String(input.slug ?? '').trim().toLowerCase();
  const sp = slugProblem(slug);
  if (sp) throw new Error(sp);
  const name = String(input.name ?? '').trim();
  if (name.length < 2 || name.length > 80) throw new Error('Il nome va da 2 a 80 caratteri');
  const components = (Array.isArray(input.components) ? input.components : []).map((c, i) => {
    const cname = String(c.name ?? '').trim();
    if (!cname || cname.length > 60) throw new Error(`Componente ${i + 1}: il nome va da 1 a 60 caratteri`);
    const monitorIds = [...new Set((c.monitorIds || []).map(String))];
    if (!monitorIds.length) throw new Error(`Componente «${cname}»: collega almeno un monitor`);
    return { id: c.id || (newId ? newId() : `c${i + 1}`), name: cname, monitorIds };
  });
  if (!components.length) throw new Error('Una status page ha almeno un componente');
  if (components.length > 30) throw new Error('Al massimo 30 componenti');
  if (new Set(components.map((c) => c.name.toLowerCase())).size !== components.length) throw new Error('Due componenti hanno lo stesso nome');
  const domain = String(input.customDomain ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (domain && !/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) throw new Error('Dominio non valido (per esempio status.cliente.it)');
  return {
    slug, name, logoUrl: httpsUrl(input.logoUrl, 'Logo'), siteUrl: httpsUrl(input.siteUrl, 'Sito del cliente'), description: String(input.description ?? '').trim().slice(0, 300), components,
    noindex: input.noindex !== false, customDomain: domain || null,
  };
}

/** A communication or an update of one (RF-PUB-02). */
export function normalizeCommunication(input, page) {
  const title = String(input.title ?? '').trim();
  if (title.length < 3 || title.length > 120) throw new Error('Il titolo va da 3 a 120 caratteri');
  const status = input.status || 'investigating';
  if (!UPDATE_STATUSES[status]) throw new Error(`Stato: ${Object.keys(UPDATE_STATUSES).join(', ')}`);
  const text = String(input.text ?? '').trim();
  if (!text || text.length > 2000) throw new Error('Il testo dell\'aggiornamento va da 1 a 2000 caratteri');
  const known = new Set((page.components || []).map((c) => c.id));
  const components = [...new Set((input.components || []).map(String))];
  if (components.some((c) => !known.has(c))) throw new Error('Componente sconosciuto');
  return { title, status, text, components };
}

export function normalizePost(input) {
  const status = input.status;
  if (!UPDATE_STATUSES[status]) throw new Error(`Stato: ${Object.keys(UPDATE_STATUSES).join(', ')}`);
  const text = String(input.text ?? '').trim();
  if (!text || text.length > 2000) throw new Error('Il testo dell\'aggiornamento va da 1 a 2000 caratteri');
  return { status, text };
}

// ---------------- status of a component ----------------

const RANK = { unknown: 0, operational: 1, maintenance: 2, degraded: 3, outage: 4 };

/** The status a monitor gives to its component (RF-PUB-01). */
export function monitorToComponent(status) {
  if (status === 'down') return 'outage';
  if (status === 'degraded') return 'degraded';
  if (status === 'maintenance') return 'maintenance';
  if (status === 'up') return 'operational';
  return 'unknown'; // paused, pending, not configured: nothing to say
}

/** The worst status among those of the monitors; the monitors without data do not make it «unknown» when others have it. */
export function worstStatus(list) {
  const known = list.filter((s) => s !== 'unknown');
  if (!known.length) return 'unknown';
  return known.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
}

/** The status of the whole page: the worst of its components. */
export const overallStatus = (components) => worstStatus(components.map((c) => c.status));

/** The sentence at the top of a page. */
export function overallSentence(status, openUpdates = 0) {
  if (status === 'outage') return 'Alcuni servizi non sono disponibili';
  if (status === 'degraded') return 'Alcuni servizi hanno prestazioni ridotte';
  if (status === 'maintenance') return 'Manutenzione in corso';
  if (status === 'operational') return openUpdates ? 'Tutti i servizi sono operativi' : 'Tutti i servizi sono operativi';
  return 'Stato non ancora disponibile';
}

/**
 * Availability of a component for each day: the monitored time and the downtime of its monitors summed (weighted, like the
 * rest of the monitoring), so that a day with a short failure of one of three monitors is not 66%.
 * `perMonitor`: arrays of daily aggregates { day, monitoredMs, downtimeMs }. Returns [{ day, pct }] sorted.
 */
export function componentDays(perMonitor) {
  const days = new Map();
  for (const rows of perMonitor) {
    for (const r of rows) {
      const d = days.get(r.day) || { day: r.day, monitored: 0, down: 0 };
      d.monitored += r.monitoredMs;
      d.down += r.downtimeMs;
      days.set(r.day, d);
    }
  }
  return [...days.values()].sort((a, b) => a.day - b.day).map((d) => ({ day: d.day, pct: d.monitored ? Math.max(0, (1 - d.down / d.monitored) * 100) : null }));
}

export const dayClass = (pct) => (pct == null ? 'none' : pct >= 99.9 ? 'good' : pct >= 99 ? 'mid' : 'bad');
export const fmtPct = (p) => (p == null ? '—' : `${p.toFixed(2).replace('.', ',')}%`);

// ---------------- badge ----------------

const BADGE_COLORS = { ok: '#2e9e5b', warn: '#e0952b', error: '#d64545', info: '#3b73d6', none: '#8a8f98' };
const textWidth = (s) => Math.round(String(s).length * 6.6 + 10);

/** A badge as an SVG, in the style used in READMEs (RF-PUB-06): «stato | su · 99,98%». */
export function badgeSvg({ label = 'stato', value, tone = 'none' }) {
  const lw = textWidth(label), vw = textWidth(value), w = lw + vw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}"><title>${esc(label)}: ${esc(value)}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${BADGE_COLORS[tone] || BADGE_COLORS.none}"/><rect width="${w}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text></g></svg>`;
}

/** The value and the colour of a badge from the status and the availability. */
export function badgeValue(status, availability) {
  const [label, tone] = COMPONENT_STATUS[status] || COMPONENT_STATUS.unknown;
  const short = { operational: 'su', degraded: 'degradato', maintenance: 'manutenzione', outage: 'giù', unknown: 'n/d' }[status] || label;
  return { value: availability == null ? short : `${short} · ${fmtPct(availability)}`, tone };
}

// ---------------- HTML ----------------

const CSS = `
:root{--bg:#f6f7f9;--panel:#fff;--text:#1d2330;--muted:#677084;--line:#e2e5ea;--ok:#2e9e5b;--warn:#e0952b;--error:#d64545;--info:#3b73d6;--none:#9aa0ab}
@media (prefers-color-scheme:dark){:root{--bg:#14171d;--panel:#1c2028;--text:#e8ebf1;--muted:#9aa3b5;--line:#2c3240}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 48px}header{display:flex;align-items:center;gap:12px;margin-bottom:20px}header img{max-height:40px;max-width:160px}
h1{font-size:22px;margin:0}h2{font-size:17px;margin:28px 0 10px}a{color:var(--info)}.muted{color:var(--muted)}.small{font-size:13px}
.banner{border-radius:10px;padding:14px 16px;color:#fff;font-weight:600;margin-bottom:20px}.banner.ok{background:var(--ok)}.banner.warn{background:var(--warn)}.banner.error{background:var(--error)}.banner.info{background:var(--info)}.banner.none{background:var(--none)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:10px}.row{display:flex;justify-content:space-between;align-items:center;gap:12px}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;background:var(--none)}.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.error{background:var(--error)}.dot.info{background:var(--info)}
.state{font-size:14px;font-weight:600}.state.ok{color:var(--ok)}.state.warn{color:var(--warn)}.state.error{color:var(--error)}.state.info{color:var(--info)}
.bars{display:flex;gap:2px;margin-top:10px;height:28px}.bars i{flex:1;border-radius:2px;background:var(--none);min-width:2px}.bars i.good{background:var(--ok)}.bars i.mid{background:var(--warn)}.bars i.bad{background:var(--error)}
.legend{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-top:4px}.tag{font-size:12px;border-radius:4px;padding:1px 7px;background:var(--line)}
.post{border-left:3px solid var(--line);padding-left:12px;margin:8px 0}footer{margin-top:32px;font-size:12px;color:var(--muted)}
form{display:grid;gap:10px;max-width:340px}input[type=password]{padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--text);font:inherit}button{padding:10px 14px;border:0;border-radius:8px;background:var(--info);color:#fff;font:inherit;cursor:pointer}.err{color:var(--error)}
`;

const fmtDay = (t, tz = 'Europe/Rome') => new Date(t).toLocaleDateString('it-IT', { timeZone: tz, day: 'numeric', month: 'long', year: 'numeric' });
const fmtTime = (t, tz = 'Europe/Rome') => new Date(t).toLocaleString('it-IT', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const shell = (title, body, { noindex = true, refresh = 60 } = {}) => `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>${noindex ? '<meta name="robots" content="noindex, nofollow">' : ''}${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}<style>${CSS}</style></head><body><main>${body}</main></body></html>`;

/**
 * The public page (RF-PUB-01/03): name, logo, link, status of the components with their 90 days, the communications of the team and the
 * planned maintenance. `view`: { page, components: [{ id, name, status, days: [{ day, pct }], availability }], updates, maintenance, now, tz }.
 * It never receives URLs, causes, addresses or headers, so it cannot show them.
 */
export function pageHtml(view) {
  const { page, components, updates = [], maintenance = [], now, tz = 'Europe/Rome' } = view;
  const overall = overallStatus(components);
  const tone = COMPONENT_STATUS[overall][1];
  const open = updates.filter((u) => u.status !== 'resolved');
  const bars = (days) => `<div class="bars" aria-hidden="true">${days.map((d) => `<i class="${dayClass(d.pct)}" title="${esc(fmtDay(d.day, 'UTC'))}: ${d.pct == null ? 'nessun dato' : fmtPct(d.pct)}"></i>`).join('')}</div><div class="legend"><span>90 giorni fa</span><span>oggi</span></div>`;
  const body = `
    <header>${page.logoUrl ? `<img src="${esc(page.logoUrl)}" alt="">` : ''}<div><h1>${esc(page.name)}</h1>${page.siteUrl ? `<a class="small" href="${esc(page.siteUrl)}" rel="noopener noreferrer nofollow">${esc(new URL(page.siteUrl).host)}</a>` : ''}${page.description ? `<div class="muted small">${esc(page.description)}</div>` : ''}</div></header>
    <div class="banner ${tone}" role="status">${esc(overallSentence(overall, open.length))}</div>
    ${open.length ? `<h2>Comunicazioni</h2>${open.map((u) => updateHtml(u, page, tz)).join('')}` : ''}
    ${maintenance.length ? `<h2>Manutenzioni programmate</h2>${maintenance.map((w) => `<div class="card"><div class="row"><b>Manutenzione programmata</b><span class="small muted">${esc(fmtTime(w.start, tz))} – ${esc(new Date(w.end).toLocaleTimeString('it-IT', { timeZone: tz, hour: '2-digit', minute: '2-digit' }))}</span></div><div class="small muted">${w.components.map(esc).join(', ')}</div></div>`).join('')}` : ''}
    <h2>Servizi</h2>
    ${components.map((c) => { const [label, t] = COMPONENT_STATUS[c.status]; return `<div class="card"><div class="row"><span><i class="dot ${t}"></i><b>${esc(c.name)}</b></span><span class="state ${t}">${esc(label)}</span></div>${bars(c.days)}<div class="small muted" style="margin-top:4px">${c.availability == null ? 'Nessun dato' : `Disponibilità degli ultimi 90 giorni: ${fmtPct(c.availability)}`}</div></div>`; }).join('')}
    ${updates.filter((u) => u.status === 'resolved').length ? `<h2>Ultimi problemi risolti</h2>${updates.filter((u) => u.status === 'resolved').slice(0, 10).map((u) => updateHtml(u, page, tz)).join('')}` : ''}
    <footer>Aggiornato alle ${esc(fmtTime(now, tz))}. La pagina si aggiorna da sola.</footer>`;
  return shell(`${page.name} · stato dei servizi`, body, { noindex: page.noindex });
}

function updateHtml(u, page, tz) {
  const names = (u.components || []).map((id) => (page.components.find((c) => c.id === id) || {}).name).filter(Boolean);
  return `<div class="card"><div class="row"><b>${esc(u.title)}</b><span class="tag">${esc(UPDATE_STATUSES[u.status] || u.status)}</span></div>${names.length ? `<div class="small muted">${names.map(esc).join(', ')}</div>` : ''}${(u.posts || []).slice().reverse().map((p) => `<div class="post"><div class="small muted">${esc(UPDATE_STATUSES[p.status])} · ${esc(fmtTime(p.at, tz))}</div><div>${esc(p.text).replace(/\n/g, '<br>')}</div></div>`).join('')}</div>`;
}

/** The form that asks the password of a protected page (RF-PUB-03). */
export function passwordHtml(page, { error = false } = {}) {
  return shell(`${page.name} · accesso`, `<h1>${esc(page.name)}</h1><p class="muted">Questa pagina è protetta da una password.</p>${error ? '<p class="err" role="alert">Password errata.</p>' : ''}<form method="post"><input type="password" name="password" placeholder="Password" required autofocus autocomplete="current-password" aria-label="Password"><button>Entra</button></form>`, { noindex: true, refresh: 0 });
}

/** The TV dashboard (RF-PUB-05): the monitors with their state, the ones that fail first, readable from three metres. */
export function tvHtml(view) {
  const { name, rows, now, tz = 'Europe/Rome' } = view;
  const down = rows.filter((r) => r.status === 'outage').length;
  const warn = rows.filter((r) => r.status === 'degraded' || r.status === 'maintenance').length;
  const tone = down ? 'error' : warn ? 'warn' : rows.length ? 'ok' : 'none';
  const head = down ? `${down} non ${down === 1 ? 'risponde' : 'rispondono'}` : warn ? `${warn} da controllare` : rows.length ? 'Tutto funziona' : 'Nessun monitor';
  const css = `${CSS}
body{background:#0b0d12;color:#fff;font-size:28px}main{max-width:none;padding:24px 32px}.tvhead{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:18px}.tvhead h1{font-size:40px}.tvhead .time{font-size:24px;color:#aab}
.tvbanner{font-size:44px;font-weight:800;padding:18px 28px;border-radius:14px;margin-bottom:24px}.tvbanner.ok{background:#14803e}.tvbanner.warn{background:#b8710f}.tvbanner.error{background:#c62f2f}.tvbanner.none{background:#4a5160}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:14px}.tile{border-radius:12px;padding:16px 20px;display:flex;justify-content:space-between;align-items:center;gap:12px;border:3px solid #2b3140;background:#151923}
.tile.error{background:#5c1414;border-color:#ff5a5a}.tile.warn{background:#4a3208;border-color:#ffb347}.tile.info{background:#13294d;border-color:#6aa1ff}.tile b{font-size:30px;overflow-wrap:anywhere}.tile .v{font-size:26px;font-weight:700;white-space:nowrap}.tile .a{font-size:20px;color:#bbc}`;
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(name)}</title><meta name="robots" content="noindex, nofollow"><meta http-equiv="refresh" content="30"><style>${css}</style></head><body><main>
<div class="tvhead"><h1>${esc(name)}</h1><span class="time">${esc(new Date(now).toLocaleTimeString('it-IT', { timeZone: tz, hour: '2-digit', minute: '2-digit' }))}</span></div>
<div class="tvbanner ${tone}" role="status">${esc(head)}</div>
<div class="grid">${rows.map((r) => { const [label, t] = COMPONENT_STATUS[r.status]; return `<div class="tile ${t === 'ok' || t === 'none' ? '' : t}"><b>${esc(r.name)}</b><span><span class="v">${esc(label)}</span>${r.availability == null ? '' : `<div class="a">${esc(fmtPct(r.availability))} · 30 giorni</div>`}</span></div>`; }).join('')}</div>
</main></body></html>`;
}

/** The TV rows, the ones that fail first, then by name (RF-PUB-05). */
export const tvOrder = (rows) => [...rows].sort((a, b) => RANK[b.status] - RANK[a.status] || a.name.localeCompare(b.name, 'it'));
