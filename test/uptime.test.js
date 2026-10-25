import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOUR, DAY, merge, subtract, intersect, total, coverage, monitoredTime, incidentIntervals, clip, hourlyAggregates, dailyAggregates, kpis,
  availabilityPct, health, parseExpect, windowOccurrences, zonedTime, fmtDuration, histogramPercentile, histogram, errorBudget, maintenanceFor,
} from '../src/core/uptime.js';

const T0 = Date.UTC(2026, 9, 1, 0, 0); // 1 October 2026, 00:00 UTC
const MIN = 60000;

test('interval arithmetic', () => {
  assert.deepEqual(merge([[5, 10], [1, 3], [2, 6], [12, 12]]), [[1, 10]]);
  assert.deepEqual(subtract([[0, 10]], [[2, 3], [5, 7]]), [[0, 2], [3, 5], [7, 10]]);
  assert.deepEqual(intersect([[0, 5], [8, 12]], [[3, 9]]), [[3, 5], [8, 9]]);
  assert.equal(total([[0, 5], [3, 8]]), 8);
  assert.deepEqual(coverage([{ at: 0 }, { at: 5 }, { at: 20 }], 5), [[0, 10], [20, 25]]);
});

test('RF-KPI-07: KPIs from hourly aggregates equal KPIs from raw data', () => {
  // three days of checks every 5 minutes, with: a 2-hour hole without rounds, a paused afternoon,
  // a maintenance hour, incidents across hour and day boundaries, one still open
  const interval = 5 * MIN;
  const now = T0 + 3 * DAY;
  const checks = [];
  for (let t = T0; t < now; t += interval) {
    if (t >= T0 + 10 * HOUR && t < T0 + 12 * HOUR) continue; // no rounds
    if (t >= T0 + DAY + 14 * HOUR && t < T0 + DAY + 18 * HOUR) continue; // paused
    checks.push({ at: t, outcome: t % (7 * interval) === 0 ? 'slow' : 'ok', ms: 100 + (t / interval) % 300 });
  }
  const maint = [[T0 + 2 * DAY + 3 * HOUR, T0 + 2 * DAY + 4 * HOUR]];
  const incidents = [
    { start: T0 + 5 * HOUR + 50 * MIN, end: T0 + 6 * HOUR + 20 * MIN },        // across an hour
    { start: T0 + DAY - 25 * MIN, end: T0 + DAY + 35 * MIN },                  // across midnight
    { start: T0 + 2 * DAY + 3 * HOUR + 30 * MIN, end: T0 + 2 * DAY + 5 * HOUR }, // starts in maintenance
    { start: now - 40 * MIN, end: null },                                     // open
  ];
  const monitored = clip(monitoredTime(checks, interval, maint), T0, now);
  const downtime = intersect(incidentIntervals(incidents, now), monitored);
  const toHour = Math.floor(now / HOUR) * HOUR;
  const hourly = hourlyAggregates({ checks, monitored, downtime, fromHour: T0, toHour });

  for (const [from, to] of [[T0, toHour], [T0 + 5 * HOUR, T0 + 30 * HOUR], [T0 + DAY, T0 + 2 * DAY + 6 * HOUR]]) {
    const raw = kpis({ from, to, monitoredMs: total(clip(monitored, from, to)), downtimeMs: total(clip(downtime, from, to)), incidents, now });
    const rows = hourly.filter((a) => a.hour >= from && a.hour < to);
    const agg = kpis({ from, to, monitoredMs: rows.reduce((s, a) => s + a.monitoredMs, 0), downtimeMs: rows.reduce((s, a) => s + a.downtimeMs, 0), incidents, now });
    assert.deepEqual(agg, raw, `[${from}, ${to})`);
  }
  // the hole, the pause and the maintenance are not monitored
  const whole = kpis({ from: T0, to: toHour, monitoredMs: total(clip(monitored, T0, toHour)), downtimeMs: total(clip(downtime, T0, toHour)), incidents, now });
  assert.equal(whole.monitoredMs, toHour - T0 - 2 * HOUR - 4 * HOUR - HOUR);
  // downtime: 30 min + 60 min + 1 h after the maintenance (the half hour inside it does not count) + 40 min open, minus what falls after toHour
  assert.equal(whole.downtimeMs, 30 * MIN + 60 * MIN + 60 * MIN + (toHour - (now - 40 * MIN)));
  assert.equal(whole.incidents, 4);
  assert.equal(whole.mttrMs, Math.round((30 + 60 + 90) * MIN / 3));
  assert.ok(whole.availability < 100 && whole.availability > 95);
  assert.ok(whole.coverage < 1);

  // daily aggregates are sums of hourly ones
  const daily = dailyAggregates(hourly);
  assert.equal(daily.length, 3);
  assert.equal(daily.reduce((s, d) => s + d.downtimeMs, 0), hourly.reduce((s, a) => s + a.downtimeMs, 0));
  assert.equal(daily[1].checks, hourly.filter((a) => a.hour >= T0 + DAY && a.hour < T0 + 2 * DAY).reduce((s, a) => s + a.checks, 0));
});

test('availability, budget, response percentiles, health', () => {
  assert.equal(availabilityPct(DAY, 0), 100);
  assert.equal(availabilityPct(30 * DAY, 1000), 99.99, 'never 100% with downtime');
  assert.equal(availabilityPct(100, 50), 50);
  assert.equal(availabilityPct(0, 0), null);
  assert.deepEqual(errorBudget({ monthMs: 30 * DAY, downtimeMs: 12 * MIN, slaPct: 99.9 }), { allowedMs: 2592000, usedMs: 720000, leftMs: 1872000 });
  assert.equal(histogramPercentile(histogram([10, 20, 30, 400, 900]), 0.5), 50);

  const ok = { availability: 99.95, coverage: 1, response: { p95: 300 } };
  assert.deepEqual(health({ status: 'up', k30: ok, slaPct: 99.9, slowMs: 1000, certDays: 60 }), { level: 'buona', reasons: [] });
  assert.equal(health({ status: 'down', k30: ok, slaPct: 99.9 }).level, 'critica');
  assert.equal(health({ status: 'up', k30: { ...ok, availability: 99.85 }, slaPct: 99.9 }).level, 'attenzione');
  assert.equal(health({ status: 'up', k30: { ...ok, availability: 99.7 }, slaPct: 99.9 }).level, 'critica');
  assert.match(health({ status: 'up', k30: ok, certDays: 5 }).reasons[0], /scade tra 5 giorni/);
  assert.equal(health({ status: 'up', k30: ok, certDays: 10 }).level, 'attenzione');
  assert.match(health({ status: 'up', k30: ok, slowMs: 200 }).reasons[0], /p95 300 ms/);
});

test('expected status, durations', () => {
  const e = parseExpect('200-299, 304');
  assert.ok(e(204) && e(304) && !e(301));
  assert.equal(parseExpect('abc'), null);
  assert.equal(parseExpect('300-200'), null);
  assert.equal(fmtDuration(45000), '45 s');
  assert.equal(fmtDuration(72 * MIN), '1 h 12 min');
  assert.equal(fmtDuration(3 * DAY + 4 * HOUR), '3 g 4 h');
});

test('maintenance windows: once, weekly across the DST change, monthly, early end', () => {
  // Europe/Rome: 25 October 2026 at 03:00 the clocks go back to 02:00 (CEST → CET)
  const sunBefore = zonedTime(2026, 9, 18, 2, 30, 'Europe/Rome');
  const sunAfter = zonedTime(2026, 9, 25, 2, 30, 'Europe/Rome');
  assert.equal(new Date(sunBefore).toISOString(), '2026-10-18T00:30:00.000Z');
  assert.ok(['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z'].includes(new Date(sunAfter).toISOString()));
  const wed = zonedTime(2026, 9, 28, 22, 0, 'Europe/Rome');
  assert.equal(new Date(wed).toISOString(), '2026-10-28T21:00:00.000Z', 'CET after the change');

  const weekly = { type: 'weekly', days: [3], time: '22:00', durationMin: 60 };
  const occ = windowOccurrences(weekly, Date.UTC(2026, 9, 19), Date.UTC(2026, 10, 2), 'Europe/Rome');
  assert.deepEqual(occ.map(([s]) => new Date(s).toISOString()), ['2026-10-21T20:00:00.000Z', '2026-10-28T21:00:00.000Z']);
  assert.equal(occ[0][1] - occ[0][0], HOUR);

  const monthly = { type: 'monthly', dayOfMonth: 1, time: '06:00', durationMin: 30 };
  assert.equal(windowOccurrences(monthly, Date.UTC(2026, 9, 15), Date.UTC(2027, 0, 15), 'Europe/Rome').length, 3);

  const once = { type: 'once', start: T0, durationMin: 120, endedAt: T0 + 30 * MIN };
  assert.deepEqual(windowOccurrences(once, T0 - DAY, T0 + DAY), [[T0, T0 + 30 * MIN]], 'closed early (RF-MNT-05)');

  // by tag, also for monitors added later (RF-MNT-01)
  const byTag = { type: 'once', start: T0, durationMin: 60, tags: ['cliente-x'] };
  assert.equal(maintenanceFor([byTag], { id: 'm9', tags: ['cliente-x'] }, T0 - DAY, T0 + DAY, 'UTC').length, 1);
  assert.equal(maintenanceFor([byTag], { id: 'm8', tags: [] }, T0 - DAY, T0 + DAY, 'UTC').length, 0);
});
