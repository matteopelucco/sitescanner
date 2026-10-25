import { UserError, loadSite } from '../config.js';
import { send, readJson, NotFound } from '../api.js';
import { DAY, HOUR, maintenanceFor, windowOccurrences, fmtDuration } from '../core/uptime.js';
import {
  monitoringEnabled, monitoringConfig, monitorStoreFor, monitorArea, normalizeMonitor, publicMonitor, unmask, checkMonitor, applyResult,
  monitorSummary, monitorKpis, displayStatus,
} from './engine.js';
import { networkGuardEnabled } from '../net-guard.js';
import crypto from 'node:crypto';
import { publicChannel, emailAvailable, telegramAvailable, slackPrefix, sendToChannel, publicBaseUrl, telegramBotUsername, telegramReply } from './channels.js';
import { testChannel } from './notify.js';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const token = () => crypto.randomBytes(24).toString('base64url');

// /api/monitoring, /api/monitors…, /api/incidents…, /api/maintenance… (spec §12). Everything is
// limited to the area of the request, like the rest of the API (RF-ISO-02).

const PERIODS = [['24h', DAY], ['7d', 7 * DAY], ['30d', 30 * DAY], ['90d', 90 * DAY], ['12m', 365 * DAY]];
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

/** Minimal CSV parser: comma separated, double quotes, header row. */
export function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  const s = String(text || '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; } else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  return head ? body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()]))) : [];
}

const CSV_COLUMNS = ['name', 'url', 'intervalMin', 'timeoutS', 'method', 'expect', 'keyword', 'keywordMode', 'slowMs', 'slaPct', 'tags'];
const monitorFromCsv = (r) => ({
  name: r.name, url: r.url, intervalMin: r.intervalMin || 5, timeoutS: r.timeoutS || 30, method: r.method || 'GET', expect: r.expect || '200-399',
  keyword: r.keyword ? { text: r.keyword, mode: r.keywordMode === 'absent' ? 'absent' : 'present', caseInsensitive: true } : null,
  slowMs: r.slowMs || null, slaPct: r.slaPct || 99.9, tags: (r.tags || '').split(';').map((t) => t.trim()).filter(Boolean),
});

export function monitoringContext(st, user) {
  return { store: monitorStoreFor(), area: monitorArea(st), tz: (user && user.tz) || monitoringConfig().tz, guard: st.isolated ? networkGuardEnabled(true) : false };
}

/** Runs one check now (after creating a monitor: the result is visible at once, §12.8). */
async function checkNow(ctx, m) {
  const r = await checkMonitor(m, { guard: ctx.guard, retryMs: Math.min(monitoringConfig().retryMs, 2000) });
  await applyResult(ctx.store, ctx.area, m, r, { windows: await ctx.store.listWindows(ctx.area), tz: ctx.tz });
  const { deliverArea } = await import('./notify.js');
  await deliverArea(ctx.store, ctx.area);
  return m;
}

async function createMonitors(ctx, inputs, { isolated, check = false }) {
  const existing = await ctx.store.listMonitors(ctx.area);
  const max = monitoringConfig().maxMonitors;
  const urls = new Set(existing.map((m) => m.url));
  const created = [], skipped = [];
  for (const { line, input } of inputs) {
    try {
      if (existing.length + created.length >= max) throw new UserError(`Limite di ${max} monitor raggiunto`);
      const m = normalizeMonitor(input, null, { isolated });
      if (urls.has(m.url)) throw new UserError('URL già monitorato');
      urls.add(m.url);
      await ctx.store.saveMonitor(ctx.area, m);
      created.push(m);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      skipped.push({ line, reason: e.message });
    }
  }
  if (check) for (const m of created) await checkNow(ctx, m);
  return { created, skipped };
}

/** "nome, URL" or "URL", one per line (RF-MON-02). */
function parseBulk(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((line) => {
    const i = line.lastIndexOf(',');
    const [name, url] = i > 0 && /^https?:\/\//i.test(line.slice(i + 1).trim()) ? [line.slice(0, i).trim(), line.slice(i + 1).trim()] : ['', line];
    return { line, input: { name, url } };
  });
}

async function selection(ctx, body) {
  const all = await ctx.store.listMonitors(ctx.area);
  if (body.tag) return all.filter((m) => m.tags.includes(String(body.tag).toLowerCase()));
  const ids = new Set(body.ids || []);
  return all.filter((m) => ids.has(m.id));
}

async function dashboard(ctx, { now }) {
  const monitors = await ctx.store.listMonitors(ctx.area);
  const windows = await ctx.store.listWindows(ctx.area);
  const summaries = [];
  for (const m of monitors) summaries.push(await monitorSummary(ctx.store, ctx.area, m, { now, windows, tz: ctx.tz }));
  // the ones that are down first, then the critical ones, then by availability (RF-KPI-02)
  summaries.sort((a, b) => (a.status === 'down' ? 0 : a.health.level === 'critica' ? 1 : 2) - (b.status === 'down' ? 0 : b.health.level === 'critica' ? 1 : 2) || (a.k30.availability ?? 101) - (b.k30.availability ?? 101) || a.name.localeCompare(b.name));
  const incidents = await ctx.store.listIncidents(ctx.area, { from: now - 90 * DAY, limit: 50 });
  const byId = new Map(monitors.map((m) => [m.id, m]));
  const incView = (i) => ({ ...i, monitorName: byId.get(i.monitorId)?.name || '(eliminato)', durationMs: (i.end ?? now) - i.start, excerpt: undefined });
  const last = await ctx.store.lastBeat();
  const beats = await ctx.store.listBeats(now - DAY);
  const occurrences = windows.flatMap((w) => windowOccurrences(w, now - HOUR, now + 7 * DAY, ctx.tz).map(([s, e]) => ({ id: w.id, name: w.name, start: s, end: e, active: s <= now && now < e, monitors: monitors.filter((m) => maintenanceFor([w], m, s, e, ctx.tz).length).map((m) => m.name) })));
  const channels = await ctx.store.listChannels(ctx.area);
  return {
    now,
    channelsInError: channels.filter((ch) => ch.status === 'error').map(publicChannel),
    channelCount: channels.filter((ch) => ch.status !== 'pending').length,
    dev: process.env.VERCEL !== '1',
    tz: ctx.tz,
    monitors: summaries,
    tags: [...new Set(monitors.flatMap((m) => m.tags))].sort(),
    openIncidents: incidents.filter((i) => i.end == null).map(incView),
    recentIncidents: incidents.slice(0, 10).map(incView),
    certs: summaries.filter((s) => s.certDays != null && s.certDays <= 30).map((s) => ({ id: s.id, name: s.name, days: s.certDays, issuer: s.state.cert.issuer })).sort((a, b) => a.days - b.days),
    beat: { last: last ? last.at : null, stale: !last || now - last.at > 12 * 60000, unreliable: beats.filter((b) => b.unreliable).map((b) => b.at) },
    windows: occurrences.filter((o) => o.end > now).sort((a, b) => a.start - b.start),
    heartbeatConfigured: !!monitoringConfig().heartbeatUrl,
  };
}

async function monitorDetail(ctx, m, { now }) {
  const windows = await ctx.store.listWindows(ctx.area);
  const summary = await monitorSummary(ctx.store, ctx.area, m, { now, windows, tz: ctx.tz });
  const periods = {};
  for (const [k, ms] of PERIODS) periods[k] = await monitorKpis(ctx.store, ctx.area, m, { from: now - ms, to: now, now, windows, tz: ctx.tz });
  const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
  periods.month = await monitorKpis(ctx.store, ctx.area, m, { from: monthStart, to: now, now, windows, tz: ctx.tz });
  const checks = (await ctx.store.listChecks(ctx.area, m.id, now - DAY, now + 1)).slice(-288);
  const hourly = await ctx.store.listAggregates(ctx.area, 'hourly', m.id, now - 7 * DAY, now);
  const incidents = await ctx.store.listIncidents(ctx.area, { monitorId: m.id, limit: 100 });
  return {
    ...summary,
    periods,
    checks: checks.reverse(),
    responses7d: hourly.map((a) => ({ t: a.hour, avgMs: a.msCount ? Math.round(a.msSum / a.msCount) : null, p95Ms: a.p95Ms, downtimeMs: a.downtimeMs })),
    incidents: incidents.map((i) => ({ ...i, durationMs: (i.end ?? now) - i.start, excerpt: undefined })),
  };
}

/** Handles the monitoring routes; returns false if the path is not one of them. */
export async function handleMonitorApi(req, res, url, { st, user = null }) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1);
  const [a, b, c] = parts;
  if (!['monitoring', 'monitors', 'monitors.csv', 'incidents', 'incidents.csv', 'maintenance', 'channels', 'notify-prefs'].includes(a)) return false;
  if (!monitoringEnabled()) throw new NotFound('Monitoraggio non attivo: in locale si abilita con SITESCANNER_MONITOR_DEV=1');
  const ctx = monitoringContext(st, user);
  const m = req.method;
  const now = Date.now();
  const getMonitor = async (id) => {
    const mon = await ctx.store.getMonitor(ctx.area, id);
    if (!mon) throw new NotFound('Monitor non trovato');
    return mon;
  };

  if (a === 'monitoring' && m === 'GET') return send(res, 200, await dashboard(ctx, { now })), true;
  if (a === 'channels' || a === 'notify-prefs') return handleChannels(req, res, ctx, parts, now);

  if (a === 'monitors.csv' && m === 'GET') {
    const list = await ctx.store.listMonitors(ctx.area);
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="monitor.csv"' });
    res.end(toCsv([CSV_COLUMNS, ...list.map((x) => [x.name, x.url, x.intervalMin, x.timeoutS, x.method, x.expect, x.keyword?.text || '', x.keyword?.mode || '', x.slowMs || '', x.slaPct, x.tags.join(';')])]));
    return true;
  }

  if (a === 'monitors') {
    if (!b && m === 'GET') return send(res, 200, (await ctx.store.listMonitors(ctx.area)).map(publicMonitor)), true;
    if (!b && m === 'POST') {
      const body = await readJson(req);
      const { created, skipped } = await createMonitors(ctx, [{ line: body.url, input: body }], { isolated: st.isolated, check: true });
      if (!created.length) throw new UserError(skipped[0].reason);
      return send(res, 201, await monitorSummary(ctx.store, ctx.area, created[0], { now: Date.now(), windows: await ctx.store.listWindows(ctx.area), tz: ctx.tz })), true;
    }
    if (b === 'bulk' && m === 'POST') {
      const body = await readJson(req);
      const common = { intervalMin: body.intervalMin || 5, tags: body.tags || [], channels: body.channels || null };
      const r = await createMonitors(ctx, parseBulk(body.text).map((x) => ({ ...x, input: { ...common, ...x.input } })), { isolated: st.isolated, check: !!body.check });
      return send(res, 200, { created: r.created.map(publicMonitor), skipped: r.skipped }), true;
    }
    if (b === 'import-csv' && m === 'POST') {
      const body = await readJson(req);
      const rows = parseCsv(body.csv);
      const r = await createMonitors(ctx, rows.map((row, i) => ({ line: `riga ${i + 2}: ${row.url || ''}`, input: monitorFromCsv(row) })), { isolated: st.isolated });
      return send(res, 200, { created: r.created.map(publicMonitor), skipped: r.skipped }), true;
    }
    if (b === 'import-site' && m === 'POST') {
      // RF-MON-03: one monitor per environment of a site, with its basic auth
      const body = await readJson(req);
      const cfg = await loadSite(st, body.site);
      const inputs = Object.entries(cfg.envs).map(([env, e]) => ({ line: `${cfg.id} · ${env}`, input: { name: `${cfg.name} · ${env}`, url: e.baseUrl, auth: e.auth || null, tags: [cfg.id], source: { site: cfg.id, env } } }));
      const r = await createMonitors(ctx, inputs, { isolated: st.isolated, check: true });
      return send(res, 200, { created: r.created.map(publicMonitor), skipped: r.skipped }), true;
    }
    if (b === 'actions' && m === 'POST') {
      // RF-MON-04 and RF-MNT-05
      const body = await readJson(req);
      const list = await selection(ctx, body);
      if (!list.length) throw new UserError('Nessun monitor selezionato');
      if (body.action === 'maintenance') {
        const minutes = Number(body.value);
        if (![15, 30, 60].includes(minutes)) throw new UserError('Durata della manutenzione: 15, 30 o 60 minuti');
        const w = { id: crypto.randomBytes(5).toString('hex'), name: `Manutenzione immediata (${minutes} min)`, type: 'once', start: now, durationMin: minutes, monitorIds: body.tag ? [] : list.map((x) => x.id), tags: body.tag ? [String(body.tag).toLowerCase()] : [], createdAt: now };
        await ctx.store.saveWindow(ctx.area, w);
        return send(res, 200, { ok: true, window: w, count: list.length }), true;
      }
      for (const mon of list) {
        if (body.action === 'delete') { await ctx.store.deleteMonitor(ctx.area, mon.id); continue; }
        if (body.action === 'pause' && !mon.paused) await pause(ctx, mon, now);
        else if (body.action === 'resume') { mon.paused = false; mon.state.nextCheckAt = 0; mon.state.since = now; }
        else if (body.action === 'interval') Object.assign(mon, normalizeMonitor({ intervalMin: Number(body.value) }, mon));
        else if (body.action === 'tags') mon.tags = normalizeMonitor({ tags: body.value || [] }, mon).tags;
        else if (body.action === 'add-tag') mon.tags = normalizeMonitor({ tags: [...mon.tags, body.value] }, mon).tags;
        else if (body.action === 'channels') mon.channels = Array.isArray(body.value) ? body.value : null;
        else if (body.action !== 'pause') throw new UserError(`Azione sconosciuta: ${body.action}`);
        await ctx.store.saveMonitor(ctx.area, mon);
      }
      return send(res, 200, { ok: true, count: list.length }), true;
    }
    if (b === 'daily.csv' && m === 'GET') {
      // RF-KPI-06: daily availability (UTC days) of one or all monitors in a period
      const q = url.searchParams;
      const from = q.get('from') ? Date.parse(q.get('from')) : now - 30 * DAY;
      const to = q.get('to') ? Date.parse(q.get('to')) + DAY : now;
      const list = (await ctx.store.listMonitors(ctx.area)).filter((x) => !q.get('monitor') || x.id === q.get('monitor'));
      const rows = [['monitor', 'url', 'giorno', 'disponibilita', 'downtime_s', 'monitorato_s', 'controlli', 'errori', 'risposta_media_ms']];
      for (const x of list) {
        for (const d of await ctx.store.listAggregates(ctx.area, 'daily', x.id, Math.floor(from / DAY) * DAY, to)) {
          rows.push([x.name, x.url, new Date(d.day).toISOString().slice(0, 10), d.monitoredMs ? ((1 - d.downtimeMs / d.monitoredMs) * 100).toFixed(3) : '', Math.round(d.downtimeMs / 1000), Math.round(d.monitoredMs / 1000), d.checks, d.errors, d.msCount ? Math.round(d.msSum / d.msCount) : '']);
        }
      }
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="disponibilita-giornaliera.csv"' });
      res.end(toCsv(rows));
      return true;
    }
    if (b && !c) {
      const mon = await getMonitor(b);
      if (m === 'GET') return send(res, 200, await monitorDetail(ctx, mon, { now })), true;
      if (m === 'PUT') {
        const body = unmask(await readJson(req), mon);
        const wasPaused = mon.paused;
        const { state, id, createdAt, ...fields } = body;
        const next = normalizeMonitor(fields, mon, { isolated: st.isolated });
        if (!wasPaused && next.paused) { next.paused = false; await pause(ctx, next, now); }
        if (wasPaused && !next.paused) { next.state.nextCheckAt = 0; next.state.since = now; }
        await ctx.store.saveMonitor(ctx.area, next);
        return send(res, 200, publicMonitor(next)), true;
      }
      if (m === 'DELETE') {
        await ctx.store.deleteMonitor(ctx.area, mon.id);
        return send(res, 200, { ok: true }), true;
      }
    }
    if (b && c === 'check' && m === 'POST') {
      const mon = await getMonitor(b);
      if (mon.paused) throw new UserError('Il monitor è in pausa');
      await checkNow(ctx, mon);
      return send(res, 200, await monitorSummary(ctx.store, ctx.area, mon, { now: Date.now(), windows: await ctx.store.listWindows(ctx.area), tz: ctx.tz })), true;
    }
  }

  if (a === 'incidents.csv' && m === 'GET') {
    // RF-KPI-06: incidents of a period, optionally of one monitor
    const q = url.searchParams;
    const from = q.get('from') ? Date.parse(q.get('from')) : now - 30 * DAY;
    const to = q.get('to') ? Date.parse(q.get('to')) + DAY : now;
    const monitors = new Map((await ctx.store.listMonitors(ctx.area)).map((x) => [x.id, x]));
    const list = await ctx.store.listIncidents(ctx.area, { monitorId: q.get('monitor') || null, from, to });
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="incidenti.csv"' });
    res.end(toCsv([['monitor', 'url', 'inizio', 'fine', 'durata', 'causa'], ...list.map((i) => [monitors.get(i.monitorId)?.name || '', monitors.get(i.monitorId)?.url || '', new Date(i.start).toISOString(), i.end ? new Date(i.end).toISOString() : '', fmtDuration((i.end ?? now) - i.start), i.cause.message])]));
    return true;
  }

  if (a === 'incidents') {
    if (!b && m === 'GET') {
      const q = url.searchParams;
      return send(res, 200, await ctx.store.listIncidents(ctx.area, { monitorId: q.get('monitor') || null, limit: Number(q.get('limit')) || 100 })), true;
    }
    if (b) {
      const inc = await ctx.store.getIncident(ctx.area, b);
      if (!inc) throw new NotFound('Incidente non trovato');
      if (m === 'GET') {
        const mon = await ctx.store.getMonitor(ctx.area, inc.monitorId);
        const checks = await ctx.store.listChecks(ctx.area, inc.monitorId, inc.start - HOUR, (inc.end ?? now) + HOUR);
        const events = (await ctx.store.listEvents(ctx.area, { limit: 2000 })).filter((e) => e.incidentId === inc.id);
        return send(res, 200, { ...inc, durationMs: (inc.end ?? now) - inc.start, monitor: mon ? publicMonitor(mon) : null, checks, events }), true;
      }
      if (m === 'PUT') {
        const body = await readJson(req);
        inc.note = String(body.note ?? '').slice(0, 5000);
        await ctx.store.saveIncident(ctx.area, inc);
        return send(res, 200, inc), true;
      }
    }
  }

  if (a === 'maintenance') {
    if (!b && m === 'GET') return send(res, 200, await ctx.store.listWindows(ctx.area)), true;
    if (!b && m === 'POST') {
      const w = normalizeWindow(await readJson(req), null, ctx.tz);
      await ctx.store.saveWindow(ctx.area, w);
      return send(res, 201, w), true;
    }
    if (b) {
      const w = (await ctx.store.listWindows(ctx.area)).find((x) => x.id === b);
      if (!w) throw new NotFound('Finestra di manutenzione non trovata');
      if (!c && m === 'PUT') {
        const next = normalizeWindow(await readJson(req), w, ctx.tz);
        await ctx.store.saveWindow(ctx.area, next);
        return send(res, 200, next), true;
      }
      if (!c && m === 'DELETE') {
        await ctx.store.deleteWindow(ctx.area, b);
        return send(res, 200, { ok: true }), true;
      }
      if (c === 'end' && m === 'POST') {
        w.endedAt = now;
        await ctx.store.saveWindow(ctx.area, w);
        return send(res, 200, w), true;
      }
    }
  }
  throw new NotFound(`API sconosciuta: ${m} ${url.pathname}`);
}

// ---------------- notification channels (spec §12.5) ----------------

async function handleChannels(req, res, ctx, parts, now) {
  const [a, b, c] = parts;
  const m = req.method;
  if (a === 'notify-prefs' && m === 'PUT') {
    const body = await readJson(req);
    try { new Intl.DateTimeFormat('it-IT', { timeZone: String(body.tz) }); } catch { throw new UserError(`Fuso orario non valido: ${body.tz}`); }
    await ctx.store.savePrefs(ctx.area, { ...(await ctx.store.getPrefs(ctx.area)), tz: String(body.tz) });
    return send(res, 200, { ok: true }), true;
  }
  if (!b && m === 'GET') {
    const prefs = await ctx.store.getPrefs(ctx.area);
    return send(res, 200, { channels: (await ctx.store.listChannels(ctx.area)).map(publicChannel), available: { email: emailAvailable(), slack: true, telegram: telegramAvailable() }, tz: prefs.tz || monitoringConfig().tz }), true;
  }
  if (!b && m === 'POST') {
    const body = await readJson(req);
    const ch = { id: crypto.randomBytes(5).toString('hex'), type: body.type, createdAt: now, status: 'active' };
    if (body.type === 'email') {
      if (!emailAvailable()) throw new UserError('Il canale email non è disponibile: il deploy non ha RESEND_API_KEY e SITESCANNER_EMAIL_FROM');
      const address = String(body.address || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new UserError('Indirizzo email non valido');
      // the address works only after its owner confirms it (§12.5)
      const t = token();
      Object.assign(ch, { name: body.name || address, config: { address }, status: 'pending', tokenHash: sha(t), tokenExpiresAt: now + 2 * DAY });
      await sendToChannel(ch, { subject: "Conferma l'indirizzo per gli avvisi di sitescanner", lines: ["Conferma l'indirizzo", `Per ricevere gli avvisi del monitoraggio su ${address}, apri il link entro 48 ore.`, 'Se non hai chiesto tu questi avvisi, ignora questo messaggio.'], link: `${publicBaseUrl()}/api/notify/confirm?token=${t}` })
        .catch((e) => { throw new UserError(`Email di conferma non inviata: ${e.message}`); });
    } else if (body.type === 'slack') {
      const url = String(body.webhookUrl || '').trim();
      if (!url.startsWith(slackPrefix())) throw new UserError(`Serve l'URL di un Incoming Webhook di Slack (${slackPrefix()}…)`);
      Object.assign(ch, { name: body.name || 'Slack', config: { webhookUrl: url } });
    } else throw new UserError('Tipo di canale: email o slack (Telegram si collega con il link)');
    await ctx.store.saveChannel(ctx.area, ch);
    return send(res, 201, publicChannel(ch)), true;
  }
  if (b === 'telegram-link' && m === 'POST') {
    if (!telegramAvailable()) throw new UserError('Telegram non è disponibile: il deploy non ha SITESCANNER_TELEGRAM_BOT_TOKEN');
    const code = crypto.randomBytes(12).toString('hex');
    const expiresAt = now + 15 * 60000;
    await ctx.store.saveLink(sha(code), ctx.area, expiresAt);
    return send(res, 200, { url: `https://t.me/${await telegramBotUsername()}?start=${code}`, expiresAt }), true;
  }
  const ch = b && (await ctx.store.listChannels(ctx.area)).find((x) => x.id === b);
  if (!ch) throw new NotFound('Canale non trovato');
  if (!c && m === 'PUT') {
    const body = await readJson(req);
    ch.name = String(body.name || ch.name).slice(0, 80);
    await ctx.store.saveChannel(ctx.area, ch);
    return send(res, 200, publicChannel(ch)), true;
  }
  if (!c && m === 'DELETE') {
    await ctx.store.deleteChannel(ctx.area, ch.id);
    // monitors that listed only this channel go back to «all the channels»
    for (const mon of await ctx.store.listMonitors(ctx.area)) {
      if (mon.channels && mon.channels.includes(ch.id)) {
        mon.channels = mon.channels.filter((x) => x !== ch.id);
        if (!mon.channels.length) mon.channels = null;
        await ctx.store.saveMonitor(ctx.area, mon);
      }
    }
    return send(res, 200, { ok: true }), true;
  }
  if (c === 'test' && m === 'POST') {
    if (ch.status === 'pending') throw new UserError("Conferma prima l'indirizzo email");
    const d = await testChannel(ctx.store, ctx.area, ch);
    return send(res, 200, { ...d, channel: publicChannel(ch) }), true;
  }
  throw new NotFound('API sconosciuta');
}

const page = (title, text) => `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/app/app.css"></head><body class="loginpage"><main class="login"><div class="card"><h1>${title}</h1><p>${text}</p><p><a href="/#/notifications">Vai alle notifiche</a></p></div></main></body></html>`;

/**
 * Routes reachable without a session: the confirmation link of an email address and the webhook of
 * the Telegram bot (protected by its secret token). Returns false for other paths.
 */
export async function handleNotifyPublic(req, res, url) {
  if (url.pathname === '/api/notify/confirm' && req.method === 'GET') {
    const store = monitorStoreFor();
    const t = url.searchParams.get('token') || '';
    const found = t && (await store.findChannelByToken(sha(t)));
    const valid = found && found.channel.tokenExpiresAt >= Date.now();
    res.writeHead(valid ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    if (!valid) return res.end(page('Link non valido', "Il link di conferma è scaduto o è già stato usato: aggiungi di nuovo l'indirizzo.")), true;
    const { channel } = found;
    channel.status = 'active';
    delete channel.tokenHash;
    delete channel.tokenExpiresAt;
    await store.saveChannel(found.area, channel);
    return res.end(page('Indirizzo confermato', `Gli avvisi del monitoraggio arriveranno a ${channel.config.address.replace(/[<>&"]/g, '')}.`)), true;
  }
  if (url.pathname === '/api/telegram/webhook' && req.method === 'POST') {
    const secret = process.env.SITESCANNER_TELEGRAM_WEBHOOK_SECRET;
    if (!secret || req.headers['x-telegram-bot-api-secret-token'] !== secret) return send(res, 401, { error: 'Non autorizzato' }), true;
    const update = await readJson(req);
    const msg = update.message || update.channel_post;
    const match = msg && /^\/start(?:@\w+)?\s+([0-9a-f]{24})$/.exec(String(msg.text || '').trim());
    if (match) {
      const store = monitorStoreFor();
      const area = await store.takeLink(sha(match[1]));
      if (area === null) await telegramReply(msg.chat.id, 'Link scaduto o già usato: generane uno nuovo dalla pagina Notifiche di sitescanner.');
      else {
        const chat = msg.chat;
        const title = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || 'Telegram';
        const existing = (await store.listChannels(area)).find((x) => x.type === 'telegram' && String(x.config.chatId) === String(chat.id));
        const ch = existing || { id: crypto.randomBytes(5).toString('hex'), type: 'telegram', createdAt: Date.now() };
        Object.assign(ch, { name: `Telegram · ${title}`, status: 'active', config: { chatId: chat.id, chatTitle: title } });
        await store.saveChannel(area, ch);
        await telegramReply(chat.id, '✅ Chat collegata: qui arriveranno gli avvisi del monitoraggio di sitescanner.');
      }
    }
    return send(res, 200, { ok: true }), true;
  }
  return false;
}

// RF-INC-04: pausing a monitor that is down closes its incident
async function pause(ctx, mon, now) {
  mon.paused = true;
  mon.state.since = now;
  if (mon.state.openIncident) {
    const inc = await ctx.store.getIncident(ctx.area, mon.state.openIncident);
    if (inc) {
      inc.end = now;
      inc.closedBy = 'paused';
      inc.causes.push({ at: now, class: 'pausa', status: null, message: 'messo in pausa' });
      await ctx.store.saveIncident(ctx.area, inc);
    }
    mon.state.openIncident = null;
  }
  mon.state.status = displayStatus(mon, now, []);
  await ctx.store.saveMonitor(ctx.area, mon);
}

/** RF-MNT-01/02: name, type, times, duration, monitors and tags. */
export function normalizeWindow(input, existing, tz) {
  const w = { ...(existing || {}), ...input };
  w.name = String(w.name || '').trim().slice(0, 80) || 'Manutenzione';
  w.durationMin = Number(w.durationMin);
  if (!(w.durationMin >= 5 && w.durationMin <= 1440)) throw new UserError('Durata della finestra tra 5 minuti e 24 ore');
  if (!['once', 'weekly', 'monthly'].includes(w.type)) throw new UserError('Tipo di finestra: singola, settimanale o mensile');
  if (w.type === 'once') {
    w.start = typeof w.start === 'number' ? w.start : Date.parse(w.start);
    if (!Number.isFinite(w.start)) throw new UserError('Data e ora di inizio non valide');
  } else {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(w.time || ''))) throw new UserError('Ora non valida (HH:MM)');
    if (w.type === 'weekly') {
      w.days = [...new Set((w.days || []).map(Number).filter((d) => d >= 0 && d <= 6))].sort();
      if (!w.days.length) throw new UserError('Scegli almeno un giorno della settimana');
    } else if (!(Number(w.dayOfMonth) >= 1 && Number(w.dayOfMonth) <= 31)) throw new UserError('Giorno del mese tra 1 e 31');
  }
  w.monitorIds = (w.monitorIds || []).map(String);
  w.tags = (w.tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  if (!w.monitorIds.length && !w.tags.length) throw new UserError('Scegli i monitor o un tag');
  w.tz = tz;
  w.id ||= crypto.randomBytes(5).toString('hex');
  w.createdAt ||= Date.now();
  return w;
}

