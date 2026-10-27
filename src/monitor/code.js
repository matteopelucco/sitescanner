import { UserError } from '../errors.js';
import { normalizeMonitor, monitoringConfig, loadScope } from './engine.js';
import { performCheck } from './check.js';
import { substitute, maskValues } from './secrets.js';
import { heartbeatDeadline } from './types.js';
import { normalizeWindow } from './api.js';
import { isWeb } from './types.js';
import { monitorsToYaml, codeIdFrom, rebaseUrl } from '../core/monitorsfile.js';
import { selectMonitors } from './reports.js';

// Monitoring as code (spec §13.13): a file describes the monitors, `apply` aligns the workspace to it, `export` writes the file
// for what exists, `test` runs the monitors of the file against a preview without touching the history.

const RUNTIME = new Set(['id', 'createdAt', 'state', 'muted', 'paused', 'hbToken', 'source']);
const configOf = (m) => Object.fromEntries(Object.entries(m).filter(([k]) => !RUNTIME.has(k)));
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/** Does the monitor belong to the file (RF-MAC-02)? Those cannot be edited from the interface, only duplicated. */
export const isManaged = (m) => !!m && m.managedBy === 'code';
export const MANAGED_MESSAGE = 'Questo elemento è gestito da codice (sitescanner.monitors.yml): modificalo nel file, oppure duplicalo per averne una copia modificabile dall\'interfaccia';

/**
 * What `apply` would do with a file (RF-MAC-02). Nothing is written: the plan says what is created, changed (field by field) and
 * deleted among the elements that the file manages, and how many stay. `errors` has file, line and field of what cannot be applied.
 */
export async function planApply(store, area, parsed, { tz = monitoringConfig().tz, isolated = false, max = monitoringConfig().maxMonitors } = {}) {
  const errors = [...parsed.errors];
  const existingAll = await store.listMonitors(area);
  const managed = new Map(existingAll.filter(isManaged).map((m) => [m.codeId, m]));
  const channels = new Map((await store.listChannels(area)).map((c) => [c.name.toLowerCase(), c.id]));
  const ops = { saveMonitors: [], deleteMonitors: [], saveWindows: [], deleteWindows: [] };
  const plan = { create: [], update: [], delete: [], unchanged: 0, windows: { create: [], update: [], delete: [], unchanged: 0 } };
  const idOf = new Map(); // code id → id of the monitor

  for (const item of parsed.monitors) {
    const here = (path, message, field) => errors.push({ line: (field && item.lines[field]) || item.line, path: `monitors.${item.id}${path ? `.${path}` : ''}`, message });
    const input = { ...item.fields };
    delete input.id;
    const chans = [];
    for (const name of input.channels || []) {
      const id = channels.get(String(name).toLowerCase());
      if (id) chans.push(id);
      else here('channels', `il canale «${name}» non esiste: aggiungilo nella pagina Notifiche`, 'channels');
    }
    input.channels = chans.length ? chans : null;
    let norm;
    try { norm = normalizeMonitor(input, null, { isolated }); } catch (e) { here('', e.message); continue; }
    const old = managed.get(item.id);
    const next = { ...norm, managedBy: 'code', codeId: item.id };
    if (old) {
      Object.assign(next, { id: old.id, createdAt: old.createdAt, state: old.state, muted: old.muted, paused: old.paused, source: old.source, hbToken: old.hbToken || next.hbToken });
      if (next.type === 'heartbeat' && (old.expectedMin !== next.expectedMin || old.toleranceMin !== next.toleranceMin)) next.state = { ...old.state, nextCheckAt: heartbeatDeadline({ ...next, state: old.state }) };
      const a = configOf(old), b = configOf(next);
      const changes = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => stable(a[k]) !== stable(b[k])).map((field) => ({ field, from: a[field] ?? null, to: b[field] ?? null }));
      if (changes.length) { plan.update.push({ id: item.id, name: next.name, changes }); ops.saveMonitors.push(next); } else plan.unchanged++;
    } else {
      plan.create.push({ id: item.id, name: next.name, type: next.type });
      ops.saveMonitors.push(next);
    }
    idOf.set(item.id, next.id);
  }
  const inFile = new Set(parsed.monitors.map((m) => m.id));
  for (const [codeId, m] of managed) if (!inFile.has(codeId)) { plan.delete.push({ id: codeId, name: m.name }); ops.deleteMonitors.push(m.id); }
  if (existingAll.filter((m) => !isManaged(m)).length + parsed.monitors.length > max) errors.push({ line: 1, path: 'monitors', message: `Con questo file i monitor sarebbero più del limite di ${max}` });

  // maintenance windows of the file
  const windows = (await store.listWindows(area)).filter(isManaged);
  const wOld = new Map(windows.map((w) => [w.codeId, w]));
  for (const item of parsed.maintenance) {
    const here = (message, field) => errors.push({ line: (field && item.lines[field]) || item.line, path: `maintenance.${item.id}${field ? `.${field}` : ''}`, message });
    const f = { ...item.fields };
    delete f.id;
    const ids = (f.monitors || []).map((c) => idOf.get(c)).filter(Boolean);
    delete f.monitors;
    let w;
    try { w = normalizeWindow({ ...f, monitorIds: ids, tags: f.tags || [] }, null, tz); } catch (e) { here(e.message); continue; }
    const old = wOld.get(item.id);
    const next = { ...w, managedBy: 'code', codeId: item.id };
    if (old) {
      Object.assign(next, { id: old.id, createdAt: old.createdAt, endedAt: old.endedAt });
      const strip = (x) => { const { id, createdAt, endedAt, ...rest } = x; return rest; };
      const a = strip(old), b = strip(next);
      const changes = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => stable(a[k]) !== stable(b[k])).map((field) => ({ field, from: a[field] ?? null, to: b[field] ?? null }));
      if (changes.length) { plan.windows.update.push({ id: item.id, name: next.name, changes }); ops.saveWindows.push(next); } else plan.windows.unchanged++;
    } else { plan.windows.create.push({ id: item.id, name: next.name }); ops.saveWindows.push(next); }
  }
  const wInFile = new Set(parsed.maintenance.map((w) => w.id));
  for (const [codeId, w] of wOld) if (!wInFile.has(codeId)) { plan.windows.delete.push({ id: codeId, name: w.name }); ops.deleteWindows.push(w.id); }
  return { plan, errors, ops };
}

/** Writes the plan (RF-MAC-02). The history gets one line per change, with who asked. */
export async function applyPlan(store, area, { plan, ops }, { by = null, now = Date.now() } = {}) {
  const log = (m, action) => store.addEvent(area, { type: 'monitor-change', status: 'info', at: now, monitorId: m.id, monitorName: m.name, url: m.url || '', tags: m.tags || [], action, by });
  const names = new Map(plan.update.map((u) => [u.id, u]));
  for (const m of ops.saveMonitors) {
    await store.saveMonitor(area, m);
    await log(m, names.has(m.codeId) ? `modificato da codice (${names.get(m.codeId).changes.map((c) => c.field).join(', ')})` : 'creato da codice');
  }
  for (const id of ops.deleteMonitors) {
    const m = await store.getMonitor(area, id);
    await store.deleteMonitor(area, id);
    if (m) await log(m, 'eliminato da codice');
  }
  for (const w of ops.saveWindows) await store.saveWindow(area, w);
  for (const id of ops.deleteWindows) await store.deleteWindow(area, id);
  await store.addEvent(area, { type: 'ci-apply', status: 'info', at: now, by, created: plan.create.length, updated: plan.update.length, deleted: plan.delete.length, unchanged: plan.unchanged });
  return plan;
}

// ---------------- export (RF-MAC-03) ----------------

const BASELINES = {
  http: { type: 'http', url: 'https://baseline.test/', name: 'b' }, api: { type: 'api', url: 'https://baseline.test/', name: 'b' }, heartbeat: { type: 'heartbeat', name: 'b' },
  dns: { type: 'dns', dnsName: 'baseline.test' }, tcp: { type: 'tcp', host: 'baseline.test', port: 80 }, ssl: { type: 'ssl', host: 'baseline.test' },
};
const ALWAYS = new Set(['type', 'name', 'url', 'host', 'port', 'dnsName', 'expectedMin']);
const DERIVED = { heartbeat: ['intervalMin', 'url', 'method', 'assertions'], ssl: ['intervalMin', 'url', 'method', 'assertions'], dns: ['url', 'method', 'assertions'], tcp: ['url', 'method', 'assertions'] };

/** The fields of a monitor that differ from the defaults of its type, in file form. */
export function exportFields(m, channelNames = new Map()) {
  const base = normalizeMonitor(BASELINES[m.type] || BASELINES.http);
  const skip = new Set([...RUNTIME, 'managedBy', 'codeId', ...(DERIVED[m.type] || [])]);
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    if (skip.has(k) || k === 'channels') continue;
    if (!ALWAYS.has(k) && stable(v) === stable(base[k])) continue;
    if (v === null || v === undefined || v === '') continue;
    out[k] = v;
  }
  if (m.channels && m.channels.length) out.channels = m.channels.map((id) => channelNames.get(id) || id);
  // the first fields in a readable order
  const order = ['type', 'name', 'url', 'host', 'port', 'dnsName', 'recordType', 'expectedMin', 'toleranceMin'];
  return Object.fromEntries([...order.filter((k) => k in out).map((k) => [k, out[k]]), ...Object.entries(out).filter(([k]) => !order.includes(k))]);
}

/** The file for the monitors with these ids (all of them when `ids` is null), with the maintenance that the file manages. */
export async function exportYaml(store, area, { ids = null, tags = [] } = {}) {
  const channels = new Map((await store.listChannels(area)).map((c) => [c.id, c.name]));
  let list = await store.listMonitors(area);
  if (ids) list = list.filter((m) => ids.includes(m.id));
  list = selectMonitors(list, { tags });
  const taken = new Set();
  const items = list.sort((a, b) => a.name.localeCompare(b.name, 'it')).map((m) => {
    const id = m.codeId && !taken.has(m.codeId) ? m.codeId : codeIdFrom(m.name, taken);
    taken.add(id);
    return { monitor: m, id, fields: exportFields(m, channels) };
  });
  const byId = new Map(items.map((x) => [x.monitor.id, x.id]));
  const windows = (await store.listWindows(area)).filter(isManaged).map((w) => {
    const { id, createdAt, endedAt, tz, managedBy, codeId, monitorIds, ...rest } = w;
    const mons = (monitorIds || []).map((x) => byId.get(x)).filter(Boolean);
    return { id: codeId, fields: { ...rest, ...(mons.length ? { monitors: mons } : {}), ...(typeof rest.start === 'number' ? { start: new Date(rest.start).toISOString() } : {}) } };
  });
  return monitorsToYaml({ monitors: items.map((x) => ({ id: x.id, fields: x.fields })), maintenance: windows });
}

// ---------------- test from the CI (RF-MAC-04) ----------------

/**
 * Runs once the monitors of the file against a preview: the address of each is moved onto `baseUrl`. Nothing is stored in the history of
 * the monitors; the run is one line of the history of the account («test da CI»). Types that are not a web request are skipped.
 */
export async function runCiTest(store, area, parsed, { baseUrl, tags = [], guard = false, branch = null, commit = null, by = null, now = Date.now(), tz = monitoringConfig().tz } = {}) {
  const t0 = Date.now();
  let base;
  try { base = new URL(baseUrl); if (!/^https?:$/.test(base.protocol)) throw new Error('x'); } catch { throw Object.assign(new Error('Serve l\'indirizzo dell\'anteprima (http o https), per esempio https://mio-sito-git-ramo.vercel.app'), { status: 400 }); }
  const scope = await loadScope(store, area);
  const wanted = tags.map((t) => String(t).toLowerCase());
  const results = [];
  for (const item of parsed.monitors) {
    const fields = { ...item.fields };
    delete fields.id;
    fields.channels = null;
    let m;
    try { m = normalizeMonitor(fields, null); } catch (e) { results.push({ id: item.id, name: item.fields.name || item.id, outcome: 'error', message: e.message, line: item.line }); continue; }
    if (wanted.length && !(m.tags || []).some((t) => wanted.includes(t) || wanted.some((w) => t.startsWith(`${w}:`)))) continue;
    if (!isWeb(m.type)) { results.push({ id: item.id, name: m.name, outcome: 'skipped', message: `tipo ${m.type}: non si prova su un'anteprima` }); continue; }
    const sub = substitute(m, scope);
    if (sub.missing.length) { results.push({ id: item.id, name: m.name, outcome: 'error', message: `Manca la variabile ${sub.missing.join(', ')}` }); continue; }
    try { sub.monitor.url = rebaseUrl(sub.monitor.url, baseUrl); } catch { results.push({ id: item.id, name: m.name, outcome: 'error', message: `Indirizzo non valido: ${sub.monitor.url}` }); continue; }
    m.url = sub.monitor.url;
    const r0 = await performCheck(sub.monitor, { guard, detail: true });
    const r = sub.secretValues.length ? maskValues(r0, sub.secretValues) : r0;
    results.push({
      id: item.id, name: m.name, url: m.url, outcome: r.outcome, status: r.status, ms: r.ms, message: r.outcome === 'error' ? r.error : r.outcome === 'degraded' ? r.error : null,
      assertions: (r.assertions || []).map((a) => ({ text: a.text, ok: a.ok, message: a.message })),
    });
  }
  const failed = results.filter((x) => x.outcome === 'error').length;
  const out = { ok: failed === 0, passed: results.filter((x) => x.outcome === 'ok' || x.outcome === 'degraded').length, failed, skipped: results.filter((x) => x.outcome === 'skipped').length, durationMs: Date.now() - t0, baseUrl, results };
  await store.addEvent(area, { type: 'ci-test', status: 'info', at: now, by, branch, commit, baseUrl, passed: out.passed, failed, durationMs: out.durationMs, tags: wanted });
  void tz;
  return out;
}
