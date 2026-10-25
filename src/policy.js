import { networkGuardEnabled } from './net-guard.js';

const envInt = (name, def) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 && process.env[name] !== '' && process.env[name] !== undefined ? Math.floor(n) : def;
};

/**
 * Rules for the crawls of a private area (multi-user mode, RF-SEC-01/03, RF-ISO-05); null for the
 * working folder, where the user crawls from their own machine.
 */
export function areaPolicy(st) {
  if (!st || !st.isolated) return null;
  return {
    guardNetwork: networkGuardEnabled(true),
    maxPages: envInt('SITESCANNER_MAX_PAGES', 1000),
    maxConcurrency: envInt('SITESCANNER_MAX_CONCURRENCY', 8),
    minDelayMs: envInt('SITESCANNER_MIN_DELAY_MS', 0),
    maxJobs: envInt('SITESCANNER_MAX_JOBS_PER_USER', 2),
  };
}

/**
 * Applies the limits of a policy to a configuration: values over a limit are brought down to it.
 * @returns {{cfg: object, maxPages: number, notes: string[]}} notes describe what was reduced
 */
export function applyLimits(cfg, maxPages, policy) {
  if (!policy) return { cfg, maxPages, notes: [] };
  const notes = [];
  const out = { ...cfg };
  let pages = maxPages;
  if (policy.maxPages && pages > policy.maxPages) {
    notes.push(`maxPages ridotto da ${pages} a ${policy.maxPages} (limite del server)`);
    pages = policy.maxPages;
  }
  if (policy.maxConcurrency && out.concurrency > policy.maxConcurrency) {
    notes.push(`concurrency ridotta da ${out.concurrency} a ${policy.maxConcurrency} (limite del server)`);
    out.concurrency = policy.maxConcurrency;
  }
  if (policy.minDelayMs && (out.delayMs || 0) < policy.minDelayMs) {
    notes.push(`delayMs portato da ${out.delayMs || 0} a ${policy.minDelayMs} (minimo del server)`);
    out.delayMs = policy.minDelayMs;
  }
  return { cfg: out, maxPages: pages, notes };
}
