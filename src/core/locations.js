import { percentile } from './uptime.js';
import { isPrivateLocation } from './agent.js';

// Locations of the checks (spec §13.6, RF-LOC-02..05). Pure.

export const DEFAULT_LOCATIONS = 'fra1:Francoforte,lhr1:Londra,cdg1:Parigi,iad1:Washington';
export const STRATEGIES = ['rotate', 'parallel'];
export const STRATEGY_LABELS = { rotate: 'A rotazione (ogni controllo da una località diversa)', parallel: 'In parallelo (ogni controllo da tutte)' };

/** «fra1:Francoforte,lhr1:Londra» → [{ id, name }]; the first one is the main location. */
export function parseLocations(text) {
  const out = [];
  for (const part of String(text || DEFAULT_LOCATIONS).split(',')) {
    const [id, ...name] = part.trim().split(':');
    const key = String(id || '').trim().toLowerCase();
    if (/^[a-z0-9-]{2,12}$/.test(key) && !out.some((l) => l.id === key)) out.push({ id: key, name: name.join(':').trim() || key });
  }
  return out;
}

/** The locations a monitor asks for, checked against the ones of the deploy (RF-LOC-02). Default: the main one. */
export function normalizeLocations(list, available) {
  const known = new Set(available.map((l) => l.id));
  const ids = [...new Set((Array.isArray(list) && list.length ? list : [available[0].id]).map((x) => String(x).toLowerCase()))];
  // a private location is the agent of the workspace: that it exists is seen when it runs, so that deleting an agent cannot break the saving of a monitor
  const unknown = ids.find((x) => !known.has(x) && !isPrivateLocation(x));
  if (unknown) throw new Error(`Località sconosciuta: ${unknown} (disponibili: ${[...known].join(', ')})`);
  if (ids.length > 6) throw new Error('Al massimo 6 località per monitor');
  return ids;
}

/**
 * Where the next run goes (RF-LOC-03): rotating, one location, the next one after the last used; in parallel, all of
 * them. A retry that is not «from the same location» goes to the next one.
 */
export function pickLocations({ strategy, locations, last = null, attempt = 0, sameLocation = true }) {
  if (locations.length <= 1) return [locations[0]];
  if (strategy === 'parallel') return [...locations];
  const i = last == null ? -1 : locations.indexOf(last);
  const base = (i + 1) % locations.length;
  return [locations[sameLocation ? base : (base + attempt) % locations.length]];
}

/**
 * The verdict of a round with the runs of several locations (RF-LOC-03/04): it is a failure only if at least `pct`% of the
 * locations that ran failed; a failure seen by fewer is a «local failure» of those runs, which opens no incident. Returns
 * the result that goes to the state machine and the runs to store, each with its `location` and `localFailure`.
 */
export function combineRound(runs, pct = 50) {
  if (runs.length === 1) return { combined: runs[0], runs: runs.map((r) => ({ ...r, localFailure: false })) };
  const failed = runs.filter((r) => r.outcome === 'error');
  const share = (failed.length / runs.length) * 100;
  const down = failed.length > 0 && share >= pct;
  const rank = { ok: 0, degraded: 1, error: 2 };
  let combined;
  if (down) combined = [...failed].sort((a, b) => a.at - b.at)[0];
  else {
    const rest = runs.filter((r) => r.outcome !== 'error');
    combined = [...rest].sort((a, b) => rank[b.outcome] - rank[a.outcome] || a.at - b.at)[0];
  }
  return {
    combined: { ...combined, locationShare: { failed: failed.length, total: runs.length } },
    runs: runs.map((r) => ({ ...r, localFailure: r.outcome === 'error' && !down })),
  };
}

/**
 * Availability and response times per location from the runs (RF-LOC-04): the share of runs that were not failures, and
 * p50/p95/p99 of the ones that got an answer.
 */
export function locationStats(runs) {
  const by = new Map();
  for (const r of runs) {
    const k = r.location || '—';
    const s = by.get(k) || { location: k, runs: 0, failed: 0, local: 0, ms: [] };
    s.runs++;
    if (r.outcome === 'error') { s.failed++; if (r.localFailure) s.local++; } else if (r.ms != null) s.ms.push(r.ms);
    by.set(k, s);
  }
  return [...by.values()].map((s) => ({
    location: s.location, runs: s.runs, failed: s.failed, localFailures: s.local, availability: s.runs ? Math.round((1 - s.failed / s.runs) * 10000) / 100 : null,
    p50: s.ms.length ? percentile(s.ms, 0.5) : null, p95: s.ms.length ? percentile(s.ms, 0.95) : null, p99: s.ms.length ? percentile(s.ms, 0.99) : null,
  })).sort((a, b) => String(a.location).localeCompare(String(b.location)));
}

/**
 * Locations whose network looks unreliable in this round (RF-LOC-05, RF-MON-13 per location): at least `minRuns` runs, half
 * or more failed for network reasons, and the reference URLs do not answer from there. Only those results are discarded.
 */
export function unreliableLocations(results, { networkClasses, canaryOk, minRuns = 5 }) {
  const by = new Map();
  for (const x of results) {
    const l = by.get(x.location) || [];
    l.push(x);
    by.set(x.location, l);
  }
  const out = new Set();
  for (const [loc, list] of by) {
    const net = list.filter((x) => x.r.outcome === 'error' && networkClasses.has(x.r.errorClass)).length;
    if (list.length >= minRuns && net * 2 >= list.length && !canaryOk(loc)) out.add(loc);
  }
  return out;
}
