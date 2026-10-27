// Retry strategies of a monitor (spec §13.6, RF-LOC-01). Pure.

export const STRATEGIES = ['none', 'single', 'fixed', 'linear', 'exponential'];
export const STRATEGY_LABELS = {
  none: 'Nessun nuovo tentativo', single: 'Un nuovo tentativo (come prima)', fixed: 'Attesa fissa', linear: 'Attesa lineare (1×, 2×, 3×)', exponential: 'Attesa esponenziale (1×, 2×, 4×)',
};
/** What a round can afford to wait for the retries of one monitor: the function that runs it has a limit. */
export const MAX_TOTAL_WAIT_SEC = 120;

export const DEFAULT_RETRY = Object.freeze({ strategy: 'single', attempts: 1, baseSec: 10, onlyNetwork: false, sameLocation: true });

/** Validates the retry settings of a monitor; throws an Error with a message for the form. */
export function normalizeRetry(input) {
  const r = { ...DEFAULT_RETRY, ...(input || {}) };
  if (!STRATEGIES.includes(r.strategy)) throw new Error(`Strategia di retry: ${STRATEGIES.join(', ')}`);
  r.baseSec = Number(r.baseSec);
  if (!Number.isInteger(r.baseSec) || r.baseSec < 5 || r.baseSec > 60) throw new Error("L'attesa tra i tentativi va da 5 a 60 secondi");
  r.attempts = r.strategy === 'none' ? 0 : r.strategy === 'single' ? 1 : Number(r.attempts);
  if (!Number.isInteger(r.attempts) || r.attempts < 0 || r.attempts > 3) throw new Error('I tentativi in più vanno da 1 a 3');
  if (r.strategy !== 'none' && r.attempts < 1) throw new Error('I tentativi in più vanno da 1 a 3');
  r.onlyNetwork = !!r.onlyNetwork;
  r.sameLocation = r.sameLocation !== false;
  const total = retryDelays(r).reduce((s, x) => s + x, 0);
  if (total > MAX_TOTAL_WAIT_SEC) throw new Error(`I tentativi non possono aspettare più di ${MAX_TOTAL_WAIT_SEC} secondi in tutto (ora ${total}): riduci l'attesa o i tentativi`);
  return { strategy: r.strategy, attempts: r.attempts, baseSec: r.baseSec, onlyNetwork: r.onlyNetwork, sameLocation: r.sameLocation };
}

/** Seconds to wait before each new attempt. */
export function retryDelays(r) {
  const n = r.strategy === 'none' ? 0 : r.strategy === 'single' ? 1 : r.attempts;
  return Array.from({ length: n }, (_, i) => (r.strategy === 'linear' ? r.baseSec * (i + 1) : r.strategy === 'exponential' ? r.baseSec * 2 ** i : r.baseSec));
}

/** Is a failed attempt worth another one? With «only network errors» a wrong status or a missing word is not retried (RF-LOC-01). */
export const shouldRetry = (result, retry, networkClasses) => result.outcome === 'error' && (!retry.onlyNetwork || networkClasses.has(result.errorClass));

/** The line shown for the retry settings: «ogni 10 s, fino a 2 volte». */
export function describeRetry(r) {
  if (r.strategy === 'none') return 'nessun nuovo tentativo';
  const d = retryDelays(r);
  return `${d.length} ${d.length === 1 ? 'nuovo tentativo' : 'nuovi tentativi'} dopo ${d.map((x) => `${x} s`).join(', ')}${r.onlyNetwork ? ', solo per errori di rete' : ''}`;
}
