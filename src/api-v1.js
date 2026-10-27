import { send, readJson, NotFound } from './api.js';
import { UserError } from './errors.js';
import { allowedRequest } from './core/workspaces.js';
import { parseMonitorsFile, formatFileError } from './core/monitorsfile.js';
import { monitoringEnabled, publicMonitor } from './monitor/engine.js';
import { monitoringContext } from './monitor/api.js';
import { planApply, applyPlan, exportYaml, runCiTest } from './monitor/code.js';

// The API for programs (spec §13.10, §13.13): /api/v1/…, with a token of a workspace instead of a session. A token reads, or reads and
// writes, and never manages members or tokens. It is what `sitescanner monitor apply|test` and the CI talk to.

const hits = new Map();
/** At most 60 requests a minute for each token. */
function allowed(token, now) {
  const list = (hits.get(token) || []).filter((t) => t > now - 60000);
  if (list.length >= 60) { hits.set(token, list); return false; }
  list.push(now);
  hits.set(token, list);
  return true;
}

const fileOf = (body) => {
  if (typeof body.file !== 'string' || !body.file.trim()) throw new UserError('Manca il contenuto del file (campo «file», il testo YAML)');
  if (body.file.length > 512 * 1024) throw new UserError('Il file è troppo grande (al massimo 512 KB)');
  return parseMonitorsFile(body.file, { file: body.name || 'sitescanner.monitors.yml' });
};
const withLines = (name, errors) => errors.map((e) => ({ ...e, text: formatFileError(name, e) }));

/**
 * `ctx`: { st, workspace, role, token, user }. Returns after answering; throws NotFound for unknown routes.
 */
export async function handleApiV1(req, res, url, ctx) {
  const route = url.pathname.split('/').filter(Boolean).slice(1).join('/'); // v1/…
  const sub = route.replace(/^v1\//, '');
  const method = req.method;
  if (!allowed(ctx.token.id, Date.now())) return send(res, 429, { error: 'Troppe richieste: al massimo 60 al minuto per token' });
  if (route === 'v1/me' && method === 'GET') {
    return send(res, 200, { workspace: { id: ctx.workspace.id, name: ctx.workspace.name, kind: ctx.workspace.kind }, scope: ctx.token.scope, role: ctx.role, token: { id: ctx.token.id, name: ctx.token.name } });
  }
  if (!monitoringEnabled()) throw new NotFound('Monitoraggio non attivo');
  const mctx = { ...monitoringContext(ctx.st, null), by: `token «${ctx.token.name}»` };
  const writing = ['apply', 'test'].includes(sub) && method === 'POST';

  if (sub === 'monitors' && method === 'GET') {
    const list = await mctx.store.listMonitors(mctx.area);
    return send(res, 200, list.map((m) => ({ ...publicMonitor(m), state: undefined, hbToken: undefined, managedByCode: m.managedBy === 'code', codeId: m.codeId || null }))), true;
  }
  if (sub === 'export' && method === 'GET') {
    const ids = url.searchParams.get('ids');
    const yaml = await exportYaml(mctx.store, mctx.area, { ids: ids ? ids.split(',').filter(Boolean) : null, tags: (url.searchParams.get('tag') || '').split(',').filter(Boolean) });
    res.writeHead(200, { 'content-type': 'text/yaml; charset=utf-8' });
    return res.end(yaml), true;
  }
  if (sub === 'apply' && method === 'POST') {
    // RF-MAC-02: a dry run only reads; to apply the token must be allowed to write
    const body = await readJson(req);
    if (!body.dryRun) { const gate = allowedRequest(ctx.role, 'POST', 'monitors'); if (!gate.ok) return send(res, 403, { error: 'Il token è di sola lettura: per applicare serve un token di scrittura (con «--dry-run» basta quello di lettura)' }), true; }
    const parsed = fileOf(body);
    const planned = await planApply(mctx.store, mctx.area, parsed, { tz: mctx.tz, isolated: ctx.st.isolated });
    if (planned.errors.length) return send(res, 400, { error: `Il file non si può applicare: ${planned.errors.length} problemi`, errors: withLines(body.name || 'sitescanner.monitors.yml', planned.errors) }), true;
    if (!body.dryRun) await applyPlan(mctx.store, mctx.area, planned, { by: mctx.by });
    return send(res, 200, { dryRun: !!body.dryRun, applied: !body.dryRun, plan: planned.plan }), true;
  }
  if (sub === 'test' && method === 'POST') {
    // RF-MAC-04: runs the monitors of the file against a preview, with no trace in their history
    const body = await readJson(req);
    const gate = allowedRequest(ctx.role, 'POST', 'monitors');
    if (!gate.ok) return send(res, 403, { error: 'Il test fa richieste in uscita: serve un token di scrittura' }), true;
    const parsed = fileOf(body);
    if (parsed.errors.length) return send(res, 400, { error: `Il file non è valido: ${parsed.errors.length} problemi`, errors: withLines(body.name || 'sitescanner.monitors.yml', parsed.errors) }), true;
    const result = await runCiTest(mctx.store, mctx.area, parsed, { baseUrl: body.baseUrl, tags: body.tags || [], guard: ctx.st.isolated ? (await import('./net-guard.js')).networkGuardEnabled(true) : false, branch: body.branch ? String(body.branch).slice(0, 100) : null, commit: body.commit ? String(body.commit).slice(0, 40) : null, by: mctx.by });
    return send(res, 200, result), true;
  }
  void writing;
  throw new NotFound(`API sconosciuta: ${method} ${url.pathname}`);
}
