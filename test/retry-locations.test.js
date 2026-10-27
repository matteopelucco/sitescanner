import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RETRY, normalizeRetry, retryDelays, shouldRetry, describeRetry, MAX_TOTAL_WAIT_SEC } from '../src/core/retry.js';
import { parseLocations, normalizeLocations, pickLocations, combineRound, locationStats, unreliableLocations } from '../src/core/locations.js';

// Retry strategies and locations (spec §13.6, RF-LOC-01..05). Pure.

test('retry settings are validated, with the total wait bounded', () => {
  assert.deepEqual(normalizeRetry(), { strategy: 'single', attempts: 1, baseSec: 10, onlyNetwork: false, sameLocation: true });
  assert.equal(Object.isFrozen(DEFAULT_RETRY), true);
  assert.deepEqual(normalizeRetry({ strategy: 'none' }), { strategy: 'none', attempts: 0, baseSec: 10, onlyNetwork: false, sameLocation: true });
  assert.deepEqual(normalizeRetry({ strategy: 'exponential', attempts: '3', baseSec: '10', onlyNetwork: true, sameLocation: false }), { strategy: 'exponential', attempts: 3, baseSec: 10, onlyNetwork: true, sameLocation: false });
  assert.throws(() => normalizeRetry({ strategy: 'boh' }), /Strategia di retry/);
  assert.throws(() => normalizeRetry({ baseSec: 4 }), /da 5 a 60 secondi/);
  assert.throws(() => normalizeRetry({ baseSec: 61 }), /da 5 a 60 secondi/);
  assert.throws(() => normalizeRetry({ strategy: 'fixed', attempts: 4 }), /da 1 a 3/);
  assert.throws(() => normalizeRetry({ strategy: 'fixed', attempts: 0 }), /da 1 a 3/);
  // a round cannot wait for ever: 3 attempts of 60 s are 180 s
  assert.throws(() => normalizeRetry({ strategy: 'fixed', attempts: 3, baseSec: 60 }), /più di 120 secondi in tutto \(ora 180\)/);
  assert.throws(() => normalizeRetry({ strategy: 'exponential', attempts: 3, baseSec: 30 }), /ora 210/);
  assert.equal(MAX_TOTAL_WAIT_SEC, 120);
  assert.doesNotThrow(() => normalizeRetry({ strategy: 'linear', attempts: 3, baseSec: 20 }), '20 + 40 + 60 = 120');
});

test('the wait before every attempt, and which failures are retried', () => {
  const d = (strategy, attempts = 3, baseSec = 10) => retryDelays({ strategy, attempts, baseSec });
  assert.deepEqual([d('none'), d('single'), d('fixed'), d('linear'), d('exponential')], [[], [10], [10, 10, 10], [10, 20, 30], [10, 20, 40]]);
  assert.deepEqual(d('fixed', 2, 5), [5, 5]);
  const net = new Set(['dns', 'connessione', 'timeout']);
  const r = (outcome, errorClass) => ({ outcome, errorClass });
  assert.equal(shouldRetry(r('ok'), { onlyNetwork: false }, net), false);
  assert.equal(shouldRetry(r('degraded'), { onlyNetwork: false }, net), false);
  assert.equal(shouldRetry(r('error', 'http'), { onlyNetwork: false }, net), true);
  assert.equal(shouldRetry(r('error', 'http'), { onlyNetwork: true }, net), false, 'a 503 is not a network error');
  assert.equal(shouldRetry(r('error', 'timeout'), { onlyNetwork: true }, net), true);
  assert.equal(describeRetry({ strategy: 'none' }), 'nessun nuovo tentativo');
  assert.equal(describeRetry({ strategy: 'single', attempts: 1, baseSec: 10 }), '1 nuovo tentativo dopo 10 s');
  assert.equal(describeRetry({ strategy: 'exponential', attempts: 3, baseSec: 10, onlyNetwork: true }), '3 nuovi tentativi dopo 10 s, 20 s, 40 s, solo per errori di rete');
});

test('locations: the list of the deploy, the choice of a monitor, rotation and parallel runs (RF-LOC-02/03)', () => {
  const all = parseLocations('fra1:Francoforte, lhr1:Londra,xx,fra1:Doppia,BAD NAME:x');
  assert.deepEqual(all, [{ id: 'fra1', name: 'Francoforte' }, { id: 'lhr1', name: 'Londra' }, { id: 'xx', name: 'xx' }]);
  assert.deepEqual(parseLocations('').map((l) => l.id), ['fra1', 'lhr1', 'cdg1', 'iad1'], 'the default list');
  assert.deepEqual(normalizeLocations(undefined, all), ['fra1'], 'the main location by default');
  assert.deepEqual(normalizeLocations([], all), ['fra1']);
  assert.deepEqual(normalizeLocations(['LHR1', 'fra1', 'lhr1'], all), ['lhr1', 'fra1']);
  assert.throws(() => normalizeLocations(['tokyo'], all), /Località sconosciuta: tokyo \(disponibili: fra1, lhr1, xx\)/);
  assert.throws(() => normalizeLocations(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => `${x}x`), parseLocations('ax,bx,cx,dx,ex,fx,gx')), /Al massimo 6/);

  const three = ['fra1', 'lhr1', 'cdg1'];
  assert.deepEqual(pickLocations({ strategy: 'rotate', locations: ['fra1'] }), ['fra1']);
  assert.deepEqual(pickLocations({ strategy: 'parallel', locations: three }), three);
  const seq = []; let last = null;
  for (let i = 0; i < 5; i++) { const [l] = pickLocations({ strategy: 'rotate', locations: three, last }); seq.push(l); last = l; }
  assert.deepEqual(seq, ['fra1', 'lhr1', 'cdg1', 'fra1', 'lhr1'], 'every run from a different location, in turn');
  assert.deepEqual(pickLocations({ strategy: 'rotate', locations: three, last: 'removed' }), ['fra1'], 'the last one is not in the list any more');
  // a retry from the same location, or from another one
  assert.deepEqual(pickLocations({ strategy: 'rotate', locations: three, last: 'fra1', attempt: 1, sameLocation: true }), ['lhr1']);
  assert.deepEqual(pickLocations({ strategy: 'rotate', locations: three, last: 'fra1', attempt: 1, sameLocation: false }), ['cdg1']);
});

const run = (location, outcome, ms = 100, extra = {}) => ({ location, at: 1000, outcome, ms, errorClass: outcome === 'error' ? 'http' : null, ...extra });

test('the verdict of a round with several locations: the percentage rule and the local failure (RF-LOC-03/04)', () => {
  // one location: as before
  let r = combineRound([run('fra1', 'error')]);
  assert.deepEqual([r.combined.outcome, r.runs[0].localFailure], ['error', false]);
  // three in parallel, one fails: 33% < 50%: not down, a local failure that opens nothing
  r = combineRound([run('fra1', 'ok'), run('lhr1', 'error'), run('cdg1', 'ok')], 50);
  assert.equal(r.combined.outcome, 'ok');
  assert.deepEqual(r.runs.map((x) => [x.location, x.localFailure]), [['fra1', false], ['lhr1', true], ['cdg1', false]]);
  // two of three: 67%: down, with the cause of the first failure, and no local failures
  r = combineRound([run('fra1', 'error', 5000, { at: 3 }), run('lhr1', 'error', 100, { at: 1 }), run('cdg1', 'ok')], 50);
  assert.deepEqual([r.combined.outcome, r.combined.location, r.combined.locationShare], ['error', 'lhr1', { failed: 2, total: 3 }]);
  assert.equal(r.runs.some((x) => x.localFailure), false);
  // the percentage is the account's: 100% means all of them
  assert.equal(combineRound([run('fra1', 'error'), run('lhr1', 'error'), run('cdg1', 'ok')], 100).combined.outcome, 'ok');
  assert.equal(combineRound([run('fra1', 'error'), run('lhr1', 'error')], 100).combined.outcome, 'error');
  assert.equal(combineRound([run('fra1', 'error'), run('lhr1', 'ok')], 50).combined.outcome, 'error', 'exactly 50% is enough');
  // not down: the worst of the others stands for the round, a degraded one counts
  r = combineRound([run('fra1', 'ok'), run('lhr1', 'degraded'), run('cdg1', 'error')], 70);
  assert.equal(r.combined.outcome, 'degraded');
  assert.equal(combineRound([run('a', 'ok')], 1).combined.locationShare, undefined);
});

test('per-location figures: availability and p50/p95/p99 (RF-LOC-04)', () => {
  const runs = [];
  for (let i = 1; i <= 100; i++) runs.push(run('fra1', 'ok', i));
  runs.push(run('lhr1', 'error', 3000, { localFailure: true }), run('lhr1', 'ok', 200), run('lhr1', 'ok', 400), run('lhr1', 'error', 3000, { localFailure: false }));
  const stats = locationStats(runs);
  assert.deepEqual(stats.map((s) => s.location), ['fra1', 'lhr1']);
  assert.deepEqual([stats[0].runs, stats[0].availability, stats[0].p50, stats[0].p95, stats[0].p99], [100, 100, 50, 95, 99]);
  assert.deepEqual([stats[1].runs, stats[1].failed, stats[1].localFailures, stats[1].availability, stats[1].p50], [4, 2, 1, 50, 200], 'failures are not response times');
  assert.deepEqual(locationStats([]), []);
  assert.equal(locationStats([{ outcome: 'ok', ms: 5 }])[0].location, '—', 'a run with no location');
});

test('an unreliable location is discarded on its own (RF-LOC-05)', () => {
  const net = new Set(['dns', 'connessione', 'timeout']);
  const mk = (location, n, failing) => Array.from({ length: n }, (_, i) => ({ location, r: { outcome: i < failing ? 'error' : 'ok', errorClass: i < failing ? 'timeout' : null } }));
  const results = [...mk('fra1', 10, 9), ...mk('lhr1', 10, 1), ...mk('cdg1', 3, 3)];
  // fra1: 9 of 10 failed for the network and its canaries do not answer; lhr1 is fine; cdg1 has too few runs to say
  const bad = unreliableLocations(results, { networkClasses: net, canaryOk: (loc) => loc !== 'fra1' });
  assert.deepEqual([...bad], ['fra1']);
  assert.deepEqual([...unreliableLocations(results, { networkClasses: net, canaryOk: () => true })], [], 'the canaries answer: the failures are the sites');
  assert.deepEqual([...unreliableLocations(results, { networkClasses: net, canaryOk: () => false })], ['fra1'], 'only the ones with enough failures');
  const http = mk('fra1', 10, 10).map((x) => ({ ...x, r: { ...x.r, errorClass: 'http' } }));
  assert.deepEqual([...unreliableLocations(http, { networkClasses: net, canaryOk: () => false })], [], 'a 503 is not the network');
});
