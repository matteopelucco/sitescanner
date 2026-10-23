import fs from 'node:fs';
import { listSiteIds, loadSite, siteFile, parseSite, saveSite, deleteSite, applySiteForm, siteDefaults, rootDir, UserError, EXAMPLE_SITE } from './config.js';
import { listDataSites, listScans, writeLabel, resolveScanRef } from './store.js';
import { startJob, listJobs, getJob, cancelJob, jobView, onJobChange } from './jobs.js';
import { listInventories, loadInventory, deleteInventory, inventoryCsv, INVENTORY_DEFAULTS } from './inventory.js';
import { TOOL } from './version.js';

const MAX_BODY = 1024 * 1024;

class NotFound extends UserError {
  status = 404;
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
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

function siteSummary(id) {
  const configured = !!siteFile(id);
  let cfg = null, error = null;
  if (configured) {
    try { cfg = loadSite(id); } catch (e) { error = e.message; }
  }
  const scans = listScans(id);
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

function allSiteIds() {
  return [...new Set([...listSiteIds(), ...listDataSites()])].sort();
}

function siteDetail(id) {
  const file = siteFile(id);
  if (!file && !listDataSites().includes(id)) throw new NotFound(`Sito "${id}" non trovato`);
  const raw = file ? fs.readFileSync(file, 'utf8') : null;
  let config = null, error = null;
  if (raw !== null) {
    try {
      const { configHash, id: _id, ...cfg } = parseSite(id, raw);
      config = cfg;
    } catch (e) {
      error = e.message;
    }
  }
  return { ...siteSummary(id), raw, config, error, history: [...listScans(id)].reverse() };
}

function events(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
  const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  write('jobs', listJobs());
  const off = onJobChange((job) => write('job', job));
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    off();
    clearInterval(ping);
  });
}

/** Routes /api/… requests. Errors propagate to the server, which maps UserError to 4xx. */
export async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const m = req.method;
  const [a, b, c, d] = parts;

  if (a === 'state' && m === 'GET') {
    return send(res, 200, {
      tool: TOOL,
      root: rootDir(),
      sites: allSiteIds().map(siteSummary),
      jobs: listJobs(),
      inventories: listInventories().length,
      defaults: { site: siteDefaults(), inventory: INVENTORY_DEFAULTS },
      example: EXAMPLE_SITE,
    });
  }
  if (a === 'events' && m === 'GET') return events(req, res);

  if (a === 'sites') {
    if (!b) {
      if (m === 'GET') return send(res, 200, allSiteIds().map(siteSummary));
      if (m === 'POST') {
        const body = await readJson(req);
        const raw = typeof body.raw === 'string' ? body.raw : applySiteForm(EXAMPLE_SITE, body.form || {});
        saveSite(String(body.id || '').trim(), raw, { create: true });
        return send(res, 201, siteDetail(String(body.id).trim()));
      }
    } else if (!c) {
      if (m === 'GET') return send(res, 200, siteDetail(b));
      if (m === 'PUT') {
        const body = await readJson(req);
        const file = siteFile(b);
        if (!file) throw new NotFound(`Sito "${b}" non configurato`);
        const raw = typeof body.raw === 'string' ? body.raw : applySiteForm(fs.readFileSync(file, 'utf8'), body.form || {});
        saveSite(b, raw);
        return send(res, 200, siteDetail(b));
      }
      if (m === 'DELETE') {
        deleteSite(b);
        return send(res, 200, { ok: true });
      }
    } else if (c === 'scans' && d && m === 'PUT') {
      const body = await readJson(req);
      const id = resolveScanRef(b, d);
      writeLabel(b, id, { label: body.label ?? undefined, note: body.note ?? undefined });
      return send(res, 200, siteDetail(b));
    }
  }

  if (a === 'jobs') {
    if (!b && m === 'GET') return send(res, 200, listJobs());
    if (!b && m === 'POST') return send(res, 202, jobView(startJob(await readJson(req))));
    if (b && !c && m === 'GET') return send(res, 200, jobView(getJob(b), { withLog: true }));
    if (b && c === 'cancel' && m === 'POST') return send(res, 200, cancelJob(b));
  }

  if (a === 'inventories') {
    if (!b && m === 'GET') return send(res, 200, listInventories());
    if (b && b.endsWith('.csv') && m === 'GET') {
      const inv = loadInventory(b.slice(0, -4));
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="inventario-${inv.id}.csv"` });
      return res.end(inventoryCsv(inv));
    }
    if (b && m === 'GET') return send(res, 200, loadInventory(b));
    if (b && m === 'DELETE') {
      deleteInventory(b);
      return send(res, 200, { ok: true });
    }
  }

  throw new NotFound(`API sconosciuta: ${m} ${url.pathname}`);
}
