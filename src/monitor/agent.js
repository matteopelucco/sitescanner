import crypto from 'node:crypto';
import { send, readJson } from '../api.js';
import { UserError } from '../config.js';
import { AGENT_TOKEN_PREFIX, POLL_S, MAX_JOBS_PER_POLL, agentIdOf, agentLocationId, agentStatus, agentTransition, locationLabel, offlineAfterMs, normalizeAgentName } from '../core/agent.js';
import { substitute, maskValues } from './secrets.js';

// The local agent, server side (spec §13.14, RF-AGT-01, ADR-0025). A private location has no address the deployment can
// call: the agent calls the deployment. The round queues a run for the agent and waits for its answer; the agent asks
// for runs every 30 seconds (poll), runs them in its network and hands back the results. Nothing listens on the agent's
// side. The runs carry no secret in the queue: the monitor with its variables is built when the agent takes the run.

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const engine = () => import('./engine.js');
const waitMs = () => Number(process.env.SITESCANNER_AGENT_WAIT_MS) || 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What the pages and the API show of an agent: never the hash of its token. */
export function publicAgent(a, now = Date.now()) {
  return { id: a.id, name: a.name, location: agentLocationId(a), label: locationLabel(a), status: agentStatus(a, now), lastSeenAt: a.lastSeenAt || null, version: a.version || null, host: a.host || null, pollS: a.pollS || POLL_S, createdAt: a.createdAt, createdBy: a.createdBy || null };
}

/** A new agent; the token is returned here and never again (only its hash is kept). */
export async function createAgent(store, area, name, { by = null, now = Date.now() } = {}) {
  let n;
  try { n = normalizeAgentName(name); } catch (e) { throw new UserError(e.message); }
  const list = await store.listAgents(area);
  if (list.length >= 20) throw new UserError('Al massimo 20 agenti per spazio di lavoro');
  if (list.some((a) => a.name.toLowerCase() === n.toLowerCase())) throw new UserError('Esiste già un agente con questo nome');
  const token = `${AGENT_TOKEN_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
  const agent = { id: crypto.randomBytes(5).toString('hex'), name: n, hash: sha(token), createdAt: now, createdBy: by, lastSeenAt: null, alerted: false };
  await store.saveAgent(area, agent);
  return { agent, token };
}

/** The agents of an area as locations of the monitors: «Privata · nome». */
export async function privateLocations(store, area) {
  return (await store.listAgents(area)).map((a) => ({ id: agentLocationId(a), name: locationLabel(a), private: true, agentId: a.id }));
}

// ---------------- the round side: queue a run and wait ----------------

/**
 * The run of a private location (the runner of runner.js calls it): queues it for the agent and waits for the answer
 * up to SITESCANNER_AGENT_WAIT_MS. An agent that is not connected is not waited for: the run fails at once, saying why.
 */
export async function agentCheck(loc, ctx, { now = Date.now } = {}) {
  const { monitorStoreFor } = await engine();
  const store = monitorStoreFor();
  const fail = (why) => ({ at: now(), outcome: 'error', status: null, ms: null, errorClass: 'agente', error: why, location: loc });
  if (ctx.canary) return fail('gli URL di riferimento non si controllano da un agente');
  const agent = await store.getAgent(ctx.area ?? '', agentIdOf(loc));
  if (!agent) return fail("L'agente di questa località non esiste più");
  const status = agentStatus(agent, now());
  if (status === 'waiting') return fail(`L'agente «${agent.name}» non si è ancora collegato: il controllo non è stato eseguito`);
  if (status === 'offline') return fail(`L'agente «${agent.name}» non si fa sentire da ${Math.round((now() - agent.lastSeenAt) / 60000)} min: il controllo non è stato eseguito`);
  const job = { id: `${now().toString(36)}${crypto.randomBytes(4).toString('hex')}`, area: ctx.area ?? '', agentId: agent.id, monitorId: ctx.monitor.id, createdAt: now() };
  await store.enqueueJob(job);
  const deadline = Date.now() + waitMs();
  while (Date.now() < deadline) {
    await sleep(Math.min(300, Math.max(10, deadline - Date.now())));
    const j = await store.getJob(job.id);
    if (j && j.state === 'done' && j.result) return { ...j.result, location: loc };
  }
  await store.expireJob(job.id);
  return fail(`L'agente «${agent.name}» non ha risposto entro ${Math.round(waitMs() / 1000)} s`);
}

/**
 * Called by a round for each area: an agent that stopped polling is reported once (like a heartbeat that is missed,
 * RF-MON-19). It is reported as returned by its first poll.
 */
export async function evaluateAgents(store, area, now = Date.now()) {
  for (const a of await store.listAgents(area)) {
    if (agentTransition(a, now) !== 'missed') continue;
    a.alerted = true;
    await store.saveAgent(area, a);
    await store.addEvent(area, { type: 'agent-missed', at: now, agentId: a.id, agentName: a.name, lastSeenAt: a.lastSeenAt, afterMin: Math.round(offlineAfterMs(a.pollS || POLL_S) / 60000) });
  }
}

// ---------------- the protocol, public with the token of the agent ----------------

const polls = new Map();
/** At most 30 requests a minute per agent (the agent asks twice a minute). */
function pollAllowed(id, now) {
  const list = (polls.get(id) || []).filter((t) => t > now - 60000);
  if (list.length >= 30) return false;
  list.push(now);
  polls.set(id, list);
  return true;
}
export const resetAgentLimits = () => polls.clear();

/**
 * `POST /api/agent/poll` and `POST /api/agent/result`, with `Authorization: Bearer ssa_…` and no session. An unknown
 * token and a wrong one answer the same. Returns false for other paths.
 */
export async function handleAgentPublic(req, res, url) {
  if (url.pathname !== '/api/agent/poll' && url.pathname !== '/api/agent/result') return false;
  const { monitoringEnabled, monitorStoreFor, loadScope } = await engine();
  if (!monitoringEnabled()) return send(res, 404, { error: 'Monitoraggio non attivo' }), true;
  if (req.method !== 'POST') return send(res, 405, { error: 'Usa POST' }), true;
  const bearer = /^Bearer (ssa_[\w-]{20,80})$/.exec(String(req.headers.authorization || ''));
  const store = monitorStoreFor();
  const found = bearer && (await store.findAgentByHash(sha(bearer[1])));
  if (!found) return send(res, 401, { error: 'Token dell\'agente non valido' }), true;
  const { area, agent } = found;
  const now = Date.now();
  if (!pollAllowed(agent.id, now)) return send(res, 429, { error: 'Troppe richieste: l\'agente chiede ogni 30 secondi' }), true;
  const body = await readJson(req);

  if (url.pathname === '/api/agent/poll') {
    // the beat: when it was last heard, and what it runs on
    const wasAlerted = agent.alerted;
    Object.assign(agent, { lastSeenAt: now, alerted: false, version: String(body.version || '').slice(0, 40) || agent.version || null, host: String(body.host || '').slice(0, 80) || agent.host || null, pollS: Math.min(300, Math.max(5, Number(body.pollS) || POLL_S)) });
    await store.saveAgent(area, agent);
    if (wasAlerted) {
      await store.addEvent(area, { type: 'agent-back', at: now, agentId: agent.id, agentName: agent.name });
      const { deliverArea } = await import('./notify.js');
      await deliverArea(store, area).catch(() => {});
    }
    const jobs = await store.claimJobs(agent.id, now, Math.min(MAX_JOBS_PER_POLL, Math.max(1, Number(body.max) || MAX_JOBS_PER_POLL)));
    const out = [];
    if (jobs.length) {
      const scope = await loadScope(store, area);
      for (const j of jobs) {
        const mon = await store.getMonitor(area, j.monitorId);
        if (!mon) { await store.expireJob(j.id); continue; }
        const sub = substitute(mon, scope);
        if (sub.missing.length) {
          await store.completeJob(j.id, agent.id, { at: now, outcome: 'error', errorClass: 'configurazione', error: `Manca la variabile ${sub.missing.join(', ')}` }, now);
          continue;
        }
        out.push({ id: j.id, monitor: { ...sub.monitor, state: undefined, hbToken: undefined } });
      }
    }
    return send(res, 200, { now, name: agent.name, pollS: POLL_S, jobs: out }), true;
  }

  // result: the secrets that the run used are masked before it is stored
  const id = String(body.id || '');
  const job = await store.getJob(id);
  if (!job || job.agentId !== agent.id) return send(res, 404, { error: 'Controllo sconosciuto' }), true;
  if (job.state !== 'claimed') return send(res, 409, { error: 'Il controllo è scaduto o già consegnato' }), true;
  if (!body.result || typeof body.result !== 'object' || !['ok', 'degraded', 'error'].includes(body.result.outcome)) return send(res, 400, { error: 'Risultato non valido' }), true;
  let result = body.result;
  const mon = await store.getMonitor(area, job.monitorId);
  if (mon) {
    const sub = substitute(mon, await loadScope(store, area));
    if (sub.secretValues.length) result = maskValues(result, sub.secretValues);
  }
  const ok = await store.completeJob(id, agent.id, result, now);
  return send(res, ok ? 200 : 409, ok ? { ok: true } : { error: 'Il controllo è scaduto o già consegnato' }), true;
}
