import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_POLICY, normalizePolicy, effectivePolicy, policyFromLegacy, isImmediate, shouldAlertDown, reminderDue, eventKind, channelAccepts,
  normalizeKinds, channelReach, filterHistory, groupByDay, newProblems, DEFAULT_CHANNEL_EVENTS,
} from '../src/core/alerting.js';
import { errorFingerprint } from '../src/core/runs.js';

// Alert policy, channel subscriptions, history and new problems (spec §13.7). Pure.

const MIN = 60000;

test('the policy is validated with readable errors', () => {
  assert.deepEqual(normalizePolicy(), DEFAULT_POLICY);
  assert.deepEqual(normalizePolicy({ mode: 'minutes', minutes: '15', reminders: { max: '3', everyMin: '30' } }), { mode: 'minutes', failures: 1, minutes: 15, locationPct: 50, reminders: { max: 3, everyMin: 30 } });
  assert.throws(() => normalizePolicy({ mode: 'boh' }), /fallimenti o dopo un tempo/);
  assert.throws(() => normalizePolicy({ failures: 6 }), /da 1 a 5/);
  assert.throws(() => normalizePolicy({ minutes: 61 }), /da 0 a 60/);
  assert.throws(() => normalizePolicy({ locationPct: 0 }), /località/);
  assert.throws(() => normalizePolicy({ reminders: { max: 11 } }), /da 0 a 10/);
  assert.throws(() => normalizePolicy({ reminders: { everyMin: 5 } }), /10–240/);
  assert.equal(Object.isFrozen(DEFAULT_POLICY), true);
});

test('a monitor uses the account policy unless it has its own', () => {
  const account = { mode: 'failures', failures: 2 };
  assert.equal(effectivePolicy({}, account).failures, 2);
  assert.equal(effectivePolicy({ alertPolicy: null }, account).failures, 2);
  assert.equal(effectivePolicy({ alertPolicy: { mode: 'minutes', minutes: 10 } }, account).mode, 'minutes');
  assert.equal(effectivePolicy(null, null).failures, 1, 'no policy anywhere: alert at the first failure');
});

test('the delay and the reminder of the first version become a policy', () => {
  assert.equal(policyFromLegacy({}), null);
  assert.equal(policyFromLegacy({ notifyDelayMin: 0, reminderMin: null }), null);
  assert.deepEqual(policyFromLegacy({ notifyDelayMin: 10 }), { mode: 'minutes', failures: 1, minutes: 10, locationPct: 50, reminders: { max: 0, everyMin: 60 } });
  assert.deepEqual(policyFromLegacy({ reminderMin: 15 }), { mode: 'failures', failures: 1, minutes: 0, locationPct: 50, reminders: { max: 10, everyMin: 15 } });
  assert.equal(policyFromLegacy({ notifyDelayMin: 500, reminderMin: 1000 }).minutes, 60, 'values out of range are brought into it');
  assert.equal(policyFromLegacy({ reminderMin: 1000 }).reminders.everyMin, 240);
});

test('down alert: after N failures in a row, or after X minutes', () => {
  const byFailures = normalizePolicy({ failures: 3 });
  assert.equal(isImmediate(DEFAULT_POLICY), true);
  assert.equal(isImmediate(byFailures), false);
  assert.equal(isImmediate(normalizePolicy({ mode: 'minutes', minutes: 0 })), true);
  assert.deepEqual([1, 2, 3, 4].map((failures) => shouldAlertDown({ policy: byFailures, failures, downSince: 0, now: 0 })), [false, false, true, true]);
  const byTime = normalizePolicy({ mode: 'minutes', minutes: 10 });
  assert.deepEqual([0, 9, 10, 30].map((m) => shouldAlertDown({ policy: byTime, failures: 1, downSince: 0, now: m * MIN })), [false, false, true, true]);
  // with several locations, enough of them must fail (default 50%)
  assert.equal(shouldAlertDown({ policy: DEFAULT_POLICY, failures: 1, downSince: 0, now: 0, locationsFailingPct: 33 }), false);
  assert.equal(shouldAlertDown({ policy: DEFAULT_POLICY, failures: 1, downSince: 0, now: 0, locationsFailingPct: 67 }), true);
  assert.equal(shouldAlertDown({ policy: DEFAULT_POLICY, failures: 1, downSince: 0, now: 0, locationsFailingPct: null }), true, 'one location: no share');
});

test('reminders: at most N, every X minutes', () => {
  const p = normalizePolicy({ reminders: { max: 2, everyMin: 30 } });
  assert.equal(reminderDue({ policy: p, sent: 0, lastAt: 0, now: 29 * MIN }), false);
  assert.equal(reminderDue({ policy: p, sent: 0, lastAt: 0, now: 30 * MIN }), true);
  assert.equal(reminderDue({ policy: p, sent: 1, lastAt: 30 * MIN, now: 61 * MIN }), true);
  assert.equal(reminderDue({ policy: p, sent: 2, lastAt: 60 * MIN, now: 999 * MIN }), false, 'the limit');
  assert.equal(reminderDue({ policy: DEFAULT_POLICY, sent: 0, lastAt: 0, now: 999 * MIN }), false, 'default: none');
  assert.equal(reminderDue({ policy: p, sent: 0, lastAt: null, now: 999 * MIN }), false, 'the down alert has not gone out');
});

test('event kinds and channel subscriptions', () => {
  assert.deepEqual(['down', 'reminder', 'up', 'degraded', 'slow', 'cert', 'cert-expired', 'maintenance-start', 'maintenance-end', 'heartbeat-missed', 'test', 'monitor-unreliable'].map(eventKind),
    ['down', 'down', 'up', 'degraded', 'degraded', 'cert', 'cert', 'maintenance', 'maintenance', 'heartbeat', null, null]);
  const slack = { events: ['down', 'up', 'degraded', 'cert', 'maintenance', 'heartbeat'] };
  const client = { events: ['down', 'up'], tags: ['cliente:acme'] };
  const fresh = {};
  assert.deepEqual(DEFAULT_CHANNEL_EVENTS, ['down', 'up', 'cert', 'heartbeat']);
  const m = { tags: ['cliente:acme', 'prod'] }, other = { tags: ['cliente:zeta'] };
  assert.equal(channelAccepts(slack, { type: 'degraded' }, m), true);
  assert.equal(channelAccepts(fresh, { type: 'degraded' }, m), false, 'a new channel: down, up, certificate, heartbeat');
  assert.equal(channelAccepts(fresh, { type: 'cert' }, m), true);
  assert.equal(channelAccepts(fresh, { type: 'heartbeat-missed' }, m), true, 'a missed heartbeat reaches a new channel');
  assert.equal(channelAccepts(client, { type: 'down' }, m), true);
  assert.equal(channelAccepts(client, { type: 'cert' }, m), false, 'the client does not want the certificates');
  assert.equal(channelAccepts(client, { type: 'down' }, other), false, 'other tags');
  assert.equal(channelAccepts(client, { type: 'down' }, { tags: [] }), false);
  assert.equal(channelAccepts(client, { type: 'monitor-unreliable' }, null), true, 'events about the monitor itself always go out');
  // a monitor with its own kinds overrides the channel's
  assert.equal(channelAccepts(slack, { type: 'degraded' }, { tags: [], alertPolicy: { events: ['down'] } }), false);
  assert.equal(channelAccepts(fresh, { type: 'degraded' }, { tags: [], alertPolicy: { events: ['degraded'] } }), true);
  assert.deepEqual(normalizeKinds(['down', 'down', 'up']), ['down', 'up']);
  assert.equal(normalizeKinds(null), null);
  assert.throws(() => normalizeKinds(['boh']), /sconosciuto/);
  assert.throws(() => normalizeKinds('down'), /elenco/);
  assert.equal(channelReach(client, [m, other, { tags: [] }]), 1);
  assert.equal(channelReach({}, [m, other, { tags: [] }]), 3);
});

test('history: groups by type, tag, period; grouped by day in the time zone', () => {
  const T = Date.UTC(2026, 9, 25, 23, 30); // 00:30 of the 26th in Rome (CET since that morning)
  const ev = [
    { type: 'down', at: T, tags: ['a'], monitorId: 'm1' }, { type: 'up', at: T + 10 * MIN, tags: ['a'], monitorId: 'm1' },
    { type: 'monitor-change', at: T - 60 * MIN, tags: ['b'], monitorId: 'm2' }, { type: 'maintenance-start', at: T - 24 * 60 * MIN },
    { type: 'ci-test', at: T - 3 * 24 * 60 * MIN }, { type: 'degraded', at: T - 5 * MIN, tags: ['a'], monitorId: 'm2' },
  ];
  assert.deepEqual(filterHistory(ev, {}).map((e) => e.type), ['up', 'down', 'degraded', 'monitor-change', 'maintenance-start', 'ci-test'], 'newest first');
  assert.deepEqual(filterHistory(ev, { groups: ['down', 'up'] }).map((e) => e.type), ['up', 'down']);
  assert.deepEqual(filterHistory(ev, { groups: ['changes', 'ci'] }).map((e) => e.type), ['monitor-change', 'ci-test']);
  assert.deepEqual(filterHistory(ev, { tag: 'a' }).map((e) => e.type), ['up', 'down', 'degraded']);
  assert.deepEqual(filterHistory(ev, { monitorId: 'm2' }).map((e) => e.type), ['degraded', 'monitor-change']);
  assert.equal(filterHistory(ev, { from: T - 10 * MIN, to: T + 5 * MIN }).length, 2);
  const days = groupByDay(filterHistory(ev, {}), 'Europe/Rome');
  assert.equal(days[0].day, '2026-10-26', '00:30 in Rome is already the next day');
  assert.equal(days[0].events.length, 3);
  assert.equal(groupByDay(filterHistory(ev, {}), 'UTC')[0].day, '2026-10-25');
});

test('new problems: error groups that started in the window', () => {
  const now = 100 * 86400000, from = now - 7 * 86400000;
  const e = (at, error, errorClass = 'http') => ({ at, outcome: 'error', error, errorClass });
  const runs = [
    e(from - 1000, 'Errore HTTP 502'), // an old problem
    e(from + 1000, 'Errore HTTP 502'), e(from + 2000, 'Errore HTTP 503'), e(from + 3000, 'Errore HTTP 503'),
    e(now - 1000, 'Risposta in 4100 ms, oltre la soglia', 'soglia'), e(now - 500, 'Risposta in 5200 ms, oltre la soglia', 'soglia'),
    { at: from + 10, outcome: 'ok' },
  ];
  const found = newProblems(runs, { from, now, groupOf: errorFingerprint });
  assert.deepEqual(found.map((g) => [g.message, g.count]), [['Risposta in 4100 ms, oltre la soglia', 2], ['Errore HTTP 503', 2]], 'the 502 was already there; the numbers do not split a group');
  assert.deepEqual([found[1].firstSeen, found[1].lastSeen], [from + 2000, from + 3000]);
  assert.deepEqual(newProblems([], { from, now, groupOf: errorFingerprint }), []);
});
