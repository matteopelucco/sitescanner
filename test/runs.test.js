import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  periodRange, filterRuns, normalizeErrorMessage, errorFingerprint, groupErrors, responseStats, phaseSums, phaseAverages, paginate, outcomeOf,
} from '../src/core/runs.js';
import { hourlyAggregates, dailyAggregates, kpis, phaseSums as aggPhaseSums, HOUR, DAY } from '../src/core/uptime.js';

// Periods, filters, percentiles, error groups and phases of the runs (spec §13.4, RF-RIS-20/23/24). Pure.

const T = Date.UTC(2026, 9, 25, 13, 30); // 25 October 2026, 15:30 in Rome (CET since that morning)
const run = (at, outcome, extra = {}) => ({ id: `r${at}`, at, outcome, status: outcome === 'error' ? 503 : 200, ms: 100, ...extra });

test('periods: fixed, today in the time zone of the account, custom', () => {
  assert.deepEqual(periodRange('1h', T), [T - HOUR, T]);
  assert.deepEqual(periodRange('3h', T), [T - 3 * HOUR, T]);
  assert.deepEqual(periodRange('24h', T), [T - DAY, T]);
  assert.deepEqual(periodRange('7d', T), [T - 7 * DAY, T]);
  assert.deepEqual(periodRange('90d', T), [T - 90 * DAY, T]);
  // «today» starts at local midnight: Rome moved to CET (UTC+1) at 03:00 that day, so midnight was still UTC+2
  const [from, to] = periodRange('today', T, { tz: 'Europe/Rome' });
  assert.equal(new Date(from).toISOString(), '2026-10-24T22:00:00.000Z');
  assert.equal(to, T);
  assert.equal(new Date(periodRange('today', T, { tz: 'UTC' })[0]).toISOString(), '2026-10-25T00:00:00.000Z');
  assert.equal(new Date(periodRange('today', T, { tz: 'America/New_York' })[0]).toISOString(), '2026-10-25T04:00:00.000Z');
  assert.deepEqual(periodRange('custom', T, { from: T - 5 * DAY, to: T - 2 * DAY }), [T - 5 * DAY, T - 2 * DAY]);
  assert.equal(periodRange('custom', T, { from: T - DAY, to: T + 9 * DAY })[1], T, 'never in the future');
  assert.throws(() => periodRange('custom', T, { from: T, to: T - 1 }), /Intervallo non valido/);
  assert.throws(() => periodRange('custom', T, {}), /Intervallo non valido/);
  assert.throws(() => periodRange('12h', T), /Periodo sconosciuto/);
});

test('filters on outcome, retries, location and error group', () => {
  const runs = [
    run(1, 'ok'), run(2, 'ok', { location: 'fra1' }), run(3, 'slow'), run(4, 'degraded', { retried: true }),
    run(5, 'error', { error: 'Errore HTTP 503', errorClass: 'http' }), run(6, 'error', { error: 'Errore HTTP 502', errorClass: 'http', retried: true, location: 'fra1' }),
  ];
  assert.deepEqual(runs.map(outcomeOf), ['ok', 'ok', 'degraded', 'degraded', 'error', 'error'], 'the «slow» of the first version is degraded');
  const at = (list) => list.map((r) => r.at);
  assert.deepEqual(at(filterRuns(runs, {})), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(at(filterRuns(runs, { outcomes: ['error'] })), [5, 6]);
  assert.deepEqual(at(filterRuns(runs, { outcomes: ['degraded', 'error'] })), [3, 4, 5, 6]);
  assert.deepEqual(at(filterRuns(runs, { retried: true })), [4, 6]);
  assert.deepEqual(at(filterRuns(runs, { retried: true, outcomes: ['error'] })), [6]);
  assert.deepEqual(at(filterRuns(runs, { location: 'fra1' })), [2, 6]);
  assert.deepEqual(at(filterRuns(runs, { group: errorFingerprint(runs[4]) })), [5]);
  assert.deepEqual(at(filterRuns([{ at: 9, outcome: 'ok', attempts: 2 }], { retried: true })), [9], 'attempts count as retries too');
});

test('error messages are normalized without losing the HTTP status (RF-RIS-24)', () => {
  const n = normalizeErrorMessage;
  assert.equal(n('Errore HTTP 503'), 'Errore HTTP 503');
  assert.equal(n('Status 502, atteso 200-399'), 'Status 502, atteso #-#');
  assert.equal(n('Risposta in 3456 ms, oltre la soglia di guasto di 3000 ms'), 'Risposta in # ms, oltre la soglia di guasto di # ms');
  assert.equal(n('Timeout dopo 30 s'), 'Timeout dopo # s');
  assert.equal(n('Parola «Carrello» non trovata'), 'Parola «Carrello» non trovata');
  assert.equal(n('ordine 8f14e45f-ceea-467a-9575-0e4d3f6a9d2c fallito il 2026-10-25 alle 13:30:15'), 'ordine <id> fallito il <data> alle #:#:#');
  assert.equal(n('sessione deadbeef12345678 scaduta'), 'sessione <id> scaduta');
  assert.equal(n('  spazi   extra  '), 'spazi extra');
  assert.equal(n(null), '');
  // runs that differ only in numbers share a group; a different status or class does not
  const f = (error, errorClass = 'asserzione') => errorFingerprint({ error, errorClass });
  assert.equal(f('Risposta in 3100 ms, oltre la soglia'), f('Risposta in 4800 ms, oltre la soglia'));
  assert.notEqual(f('Errore HTTP 502', 'http'), f('Errore HTTP 503', 'http'));
  assert.notEqual(f('x', 'http'), f('x', 'asserzione'));
});

test('groups: counts, first and last time, locations, order', () => {
  const runs = [
    run(10, 'error', { error: 'Errore HTTP 503', errorClass: 'http' }),
    run(20, 'error', { error: 'Risposta in 3100 ms, oltre la soglia', errorClass: 'soglia', location: 'fra1' }),
    run(30, 'error', { error: 'Errore HTTP 503', errorClass: 'http', location: 'lon1' }),
    run(40, 'error', { error: 'Risposta in 5200 ms, oltre la soglia', errorClass: 'soglia', location: 'fra1' }),
    run(50, 'error', { error: 'Errore HTTP 503', errorClass: 'http' }),
    run(60, 'ok'),
  ];
  const g = groupErrors(runs);
  assert.equal(g.length, 2);
  assert.deepEqual([g[0].message, g[0].count, g[0].firstSeen, g[0].lastSeen, g[0].locations], ['Errore HTTP 503', 3, 10, 50, ['—', 'lon1']]);
  assert.deepEqual([g[1].count, g[1].normalized, g[1].locations], [2, 'Risposta in # ms, oltre la soglia', ['fra1']]);
  assert.deepEqual(groupErrors([run(1, 'ok'), run(2, 'degraded')]), []);
});

test('percentiles and phases of a set of runs', () => {
  const runs = Array.from({ length: 100 }, (_, i) => run(i, 'ok', { ms: i + 1, phases: { dnsMs: 10, tcpMs: 20, tlsMs: 0, waitMs: i, downloadMs: 4, totalMs: i + 34 } }));
  runs.push(run(500, 'error', { ms: 5000 }));
  const st = responseStats(runs);
  assert.deepEqual([st.count, st.avg, st.p50, st.p95, st.p99, st.min, st.max], [100, 51, 50, 95, 99, 1, 100], 'failures are not response times');
  assert.equal(responseStats([run(1, 'error')]), null);
  const sums = phaseSums(runs);
  assert.deepEqual([sums.n, sums.dnsMs, sums.waitMs], [100, 1000, 4950]);
  assert.deepEqual(phaseAverages(sums), { n: 100, dnsMs: 10, tcpMs: 20, tlsMs: 0, waitMs: 49.5, downloadMs: 4 });
  assert.equal(phaseAverages(phaseSums([run(1, 'ok')])), null, 'no phases, no average');
});

test('pagination', () => {
  const list = Array.from({ length: 120 }, (_, i) => i);
  assert.deepEqual([paginate(list).items.length, paginate(list).pages, paginate(list).total], [50, 3, 120]);
  assert.deepEqual(paginate(list, 3).items, list.slice(100));
  assert.equal(paginate(list, 99).items.length, 0);
  assert.equal(paginate(list, -4, 10).page, 1);
  assert.equal(paginate(list, 1, 9999).pageSize, 200);
  assert.equal(paginate([], 1).pages, 1);
});

test('aggregates carry the phases and the percentiles of the response times', () => {
  const t0 = Date.UTC(2026, 9, 1);
  const checks = [];
  for (let i = 0; i < 24; i++) checks.push({ at: t0 + i * 5 * 60000, outcome: i === 3 ? 'error' : 'ok', ms: 100 + i, phases: { dnsMs: 5, tcpMs: 10, tlsMs: 15, waitMs: 50 + i, downloadMs: 20, totalMs: 100 + i } });
  const monitored = [[t0, t0 + 2 * HOUR]];
  const hourly = hourlyAggregates({ checks, monitored, downtime: [], fromHour: t0, toHour: t0 + 2 * HOUR });
  assert.deepEqual(hourly.map((h) => h.phases.n), [11, 12], 'the failure has no phases');
  assert.equal(hourly[0].phases.dnsMs, 55);
  assert.deepEqual(aggPhaseSums(checks.slice(0, 3)), { n: 3, dnsMs: 15, tcpMs: 30, tlsMs: 45, waitMs: 153, downloadMs: 60 });
  const daily = dailyAggregates(hourly);
  assert.deepEqual([daily[0].phases.n, daily[0].phases.dnsMs, daily[0].phases.waitMs], [23, 115, hourly[0].phases.waitMs + hourly[1].phases.waitMs]);
  // percentiles in the KPIs: exact from values, approximate from histograms; p50 is the median
  const exact = kpis({ from: t0, to: t0 + DAY, monitoredMs: DAY, downtimeMs: 0, incidents: [], now: t0 + DAY, responses: { values: Array.from({ length: 200 }, (_, i) => i + 1) } });
  assert.deepEqual([exact.response.p50, exact.response.median, exact.response.p95, exact.response.p99], [100, 100, 190, 198]);
  const approx = kpis({ from: t0, to: t0 + DAY, monitoredMs: DAY, downtimeMs: 0, incidents: [], now: t0 + DAY, responses: { hist: hourly[0].hist, sum: hourly[0].msSum, count: hourly[0].msCount } });
  assert.equal(approx.response.approximate, true);
  assert.ok(approx.response.p99 >= approx.response.p95 && approx.response.p95 >= approx.response.p50);
});
