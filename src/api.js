import { parseSite, saveSite, deleteSite, applySiteForm, siteDefaults, dirs, validSiteId, UserError, EXAMPLE_SITE } from './config.js';
import { resolveScanRef, allSiteIds } from './store.js';
import { storageFor } from './storage/index.js';
import { startJob, listJobs, listJobsOf, jobDetail, cancelJobOf, jobView, onJobChange, runningJobsOf } from './jobs.js';
import { buildReport } from './report/build.js';
import { inventoryCsv, INVENTORY_DEFAULTS } from './inventory.js';
import { TOOL } from './version.js';
import { renderPdf } from './pdf.js';
import { handleMonitorApi } from './monitor/api.js';
import { monitoringEnabled } from './monitor/engine.js';

const MAX_BODY = 1024 * 1024;

export class NotFound extends UserError {
  status = 404;
}

export function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

export async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new UserError('Richiesta troppo grande');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new UserError('JSON non valido');
  }
}

async function siteSummary(st, id) {
  const raw = await st.readSiteRaw(id);
  const configured = raw !== null;
  let cfg = null, error = null;
  if (configured) {
    try { cfg = parseSite(id, raw, st.siteLocation(id), { allowEnv: !st.isolated }); } catch (e) { error = e.message; }
  }
  const scans = await st.listScans(id);
  const last = scans[scans.length - 1] || null;
  return {
    id,
    name: (cfg && cfg.name) || id,
    configured,
    error,
    envs: cfg ? Object.fromEntries(Object.entries(cfg.envs).map(([k, v]) => [k, v.baseUrl])) : {},
    scans: scans.length,
    lastScan: last,
  };
}

async function siteDetail(st, id) {
  const raw = validSiteId(id) ? await st.readSiteRaw(id) : null;
  if (raw === null && !(await st.listDataSites()).includes(id)) throw new NotFound(`Sito "${id}" non trovato`);
  let config = null, error = null;
  if (raw !== null) {
    try {
      const { configHash, id: _id, ...cfg } = parseSite(id, raw, undefined, { allowEnv: !st.isolated });
      config = cfg;
    } catch (e) {
      error = e.message;
    }
  }
  return { ...(await siteSummary(st, id)), raw, config, error, history: [...(await st.listScans(id))].reverse() };
}

/**
 * Deletes a site: its configuration and, with history "delete", all its scans (then the report is
 * rebuilt). A site with only history can be removed only by deleting the history.
 */
async function removeSite(st, id, history, { rebuildReport }) {
  if (!validSiteId(id)) throw new UserError(`Id sito non valido: ${id}`);
  if (!['keep', 'delete'].includes(history)) throw new UserError('history deve essere "keep" o "delete"');
  const configured = (await st.readSiteRaw(id)) !== null;
  const hasData = (await st.listDataSites()).includes(id);
  if (!configured && !hasData) throw new NotFound(`Sito "${id}" non trovato`);
  const busy = (await runningJobsOf(st)).find((j) => j.lock === `site:${id}`);
  if (busy) throw Object.assign(new UserError(`C'è un job in corso sul sito (${busy.title}): attendi la fine o annullalo`), { status: 409 });
  if (!configured && history === 'keep') throw new UserError(`Il sito "${id}" non ha una configurazione: per rimuoverlo va cancellato lo storico`);
  if (configured) await deleteSite(st, id);
  let scansDeleted = 0;
  if (history === 'delete' && hasData) {
    scansDeleted = await st.deleteSiteData(id);
    if (rebuildReport) await buildReport({ outDir: dirs.report, storage: st });
  }
  return { ok: true, configDeleted: configured, scansDeleted };
}

function events(req, res, st) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
  const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  write('jobs', listJobs(st));
  const off = onJobChange((job, area) => {
    if (area === st.key) write('job', job);
  });
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    off();
    clearInterval(ping);
  });
}

/**
 * Routes /api/… requests. Errors propagate to the server, which maps UserError to 4xx.
 * ctx.storage: the area the request works on (default: the working folder);
 * ctx.rebuildReport: keep the static report of the working folder up to date;
 * ctx.maxJobs: jobs that may run at the same time in the area; ctx.extra: state fields added by the caller.
 */
export async function handleApi(req, res, url, ctx = {}) {
  const st = ctx.storage || storageFor();
  const rebuildReport = ctx.rebuildReport ?? true;
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const m = req.method;
  const [a, b, c, d] = parts;

  if (a === 'state' && m === 'GET') {
    return send(res, 200, {
      tool: TOOL,
      root: st.kind === 'fs' && !ctx.extra ? st.root : null,
      sites: await Promise.all((await allSiteIds(st)).map((id) => siteSummary(st, id))),
      jobs: await listJobsOf(st),
      inventories: (await st.listInventories()).length,
      defaults: { site: siteDefaults(), inventory: INVENTORY_DEFAULTS },
      example: EXAMPLE_SITE,
      monitoring: monitoringEnabled() ? { enabled: true, dev: process.env.VERCEL !== '1' } : null,
      ...(ctx.extra || {}),
    });
  }
  if (a === 'events' && m === 'GET') return events(req, res, st);
  if (await handleMonitorApi(req, res, url, { st, user: ctx.extra && ctx.extra.user })) return;

  if (a === 'sites') {
    if (!b) {
      if (m === 'GET') return send(res, 200, await Promise.all((await allSiteIds(st)).map((id) => siteSummary(st, id))));
      if (m === 'POST') {
        const body = await readJson(req);
        const raw = typeof body.raw === 'string' ? body.raw : applySiteForm(EXAMPLE_SITE, body.form || {});
        const id = String(body.id || '').trim();
        await saveSite(st, id, raw, { create: true, ...ctx.siteRules });
        return send(res, 201, await siteDetail(st, id));
      }
    } else if (!c) {
      if (m === 'GET') return send(res, 200, await siteDetail(st, b));
      if (m === 'PUT') {
        const body = await readJson(req);
        const current = validSiteId(b) ? await st.readSiteRaw(b) : null;
        if (current === null) throw new NotFound(`Sito "${b}" non configurato`);
        const raw = typeof body.raw === 'string' ? body.raw : applySiteForm(current, body.form || {});
        await saveSite(st, b, raw, { ...ctx.siteRules });
        return send(res, 200, await siteDetail(st, b));
      }
      if (m === 'DELETE') return send(res, 200, await removeSite(st, b, url.searchParams.get('history') || 'keep', { rebuildReport }));
    } else if (c === 'scans' && d && m === 'PUT') {
      const body = await readJson(req);
      const id = await resolveScanRef(st, b, d);
      await st.writeLabel(b, id, { label: body.label ?? undefined, note: body.note ?? undefined });
      return send(res, 200, await siteDetail(st, b));
    }
  }

  if (a === 'jobs') {
    if (!b && m === 'GET') return send(res, 200, await listJobsOf(st));
    if (!b && m === 'POST') return send(res, 202, jobView(await startJob(await readJson(req), { storage: st, maxRunning: ctx.maxJobs })));
    if (b && !c && m === 'GET') return send(res, 200, await jobDetail(b, st));
    if (b && c === 'cancel' && m === 'POST') return send(res, 200, await cancelJobOf(b, st));
  }

  if (a === 'pdf' && !b && m === 'GET') {
    const q = url.searchParams;
    const { buffer, fileName } = await renderPdf({ site: q.get('site') || '', base: q.get('base') || '', head: q.get('head') || null, storage: st });
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': buffer.length, 'content-disposition': `attachment; filename="${fileName}"` });
    return res.end(buffer);
  }

  if (a === 'inventories') {
    if (!b && m === 'GET') return send(res, 200, await st.listInventories());
    if (b && b.endsWith('.csv') && m === 'GET') {
      const inv = await st.loadInventory(b.slice(0, -4));
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="inventario-${inv.id}.csv"` });
      return res.end(inventoryCsv(inv));
    }
    if (b && m === 'GET') return send(res, 200, await st.loadInventory(b));
    if (b && m === 'DELETE') {
      await st.deleteInventory(b);
      return send(res, 200, { ok: true });
    }
  }

  throw new NotFound(`API sconosciuta: ${m} ${url.pathname}`);
}
