import crypto from 'node:crypto';
import { performCheck } from './check.js';
import { publicBaseUrl } from './channels.js';
import { isPrivateLocation } from '../core/agent.js';

// Where a check runs (spec §13.6, RF-LOC-02/03): in this process, or in the Function of another region. A run of a
// remote location is asked with a signed request that carries only identifiers: the other Function reads the monitor
// and its variables itself, so that no secret travels.

const SIG_WINDOW_MS = 60000;

export const internalSecret = () => process.env.SITESCANNER_INTERNAL_SECRET || process.env.CRON_SECRET || null;

/** The signature of a request between the Functions: HMAC-SHA256 of «timestamp.body». */
export const sign = (secret, ts, body) => crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

/** Verifies the headers of a request; returns a message when it must be refused. */
export function verifySignature(secret, { ts, sig }, body, now = Date.now()) {
  if (!secret) return 'Località remote non configurate (manca SITESCANNER_INTERNAL_SECRET o CRON_SECRET)';
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(now - t) > SIG_WINDOW_MS) return 'Richiesta scaduta';
  const want = Buffer.from(sign(secret, ts, body));
  const got = Buffer.from(String(sig || ''));
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return 'Firma non valida';
  return null;
}

/** Is a location served by another Function? Without a region of this process every location is «here» (development). */
export const isRemote = (config, loc) => !!(config.region && loc !== config.region);

/** The run of a location: `ctx` is { area, monitor, guard, now } or, for the reference URLs of RF-MON-13, { monitor, canary }. */
export function runnerFor(config) {
  return async (loc, ctx) => {
    // a private location is an agent in the network of a customer, which asks for its runs (ADR-0025)
    if (isPrivateLocation(loc)) return (await import('./agent.js')).agentCheck(loc, ctx);
    if (!isRemote(config, loc)) return performCheck(ctx.monitor, { guard: !!ctx.guard, now: ctx.now || Date.now, detail: true, location: loc });
    return remoteCheck(loc, ctx);
  };
}

export async function remoteCheck(loc, ctx, { fetcher = fetch, now = Date.now } = {}) {
  const base = (process.env.SITESCANNER_INTERNAL_URL || publicBaseUrl()).replace(/\/$/, '');
  const body = JSON.stringify(ctx.canary ? { canary: ctx.canary, location: loc } : { area: ctx.area, monitorId: ctx.monitor.id, location: loc });
  const secret = internalSecret();
  const ts = String(now());
  const down = (why) => ({ at: now(), outcome: 'error', status: null, ms: null, errorClass: 'connessione', error: `La località ${loc} non ha eseguito il controllo (${why})` });
  if (!secret) return down('manca il segreto interno');
  try {
    const res = await fetcher(`${base}/api/check/${encodeURIComponent(loc)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sitescanner-ts': ts, 'x-sitescanner-sig': sign(secret, ts, body) }, body, signal: AbortSignal.timeout(100000) });
    if (!res.ok) {
      // the Function says why in its body ({error}); a platform error has none
      const why = await res.json().then((j) => j && j.error, () => null);
      return down(`HTTP ${res.status}${why ? `: ${String(why).slice(0, 200)}` : ''}`);
    }
    const data = await res.json();
    return data.result ? { ...data.result, location: loc } : down('risposta vuota');
  } catch (e) {
    return down(e.name === 'TimeoutError' ? 'timeout' : e.message);
  }
}
