import { describeEvent, describeGroup, sendToChannel, publicBaseUrl } from './channels.js';
import { monitoringConfig, upgradeMonitor } from './engine.js';
import { isMuted } from '../core/uptime.js';
import { effectivePolicy, shouldAlertDown, reminderDue, isImmediate, channelAccepts } from '../core/alerting.js';

// Delivery of the monitoring events (spec §12.5): delay, reminders, grouping, rate limit, retries,
// channels in error. Runs at the end of every round and after a check on demand.

const MIN = 60000;
const WINDOW = 10 * MIN; // RF-NOT-08
const MAX_PER_WINDOW = 30;
const GROUP_OVER = 3; // RF-NOT-06: more than 3 changes → one message

const retryDelays = () => (process.env.SITESCANNER_NOTIFY_RETRY_MS || '10000,60000,180000').split(',').map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sends with up to 3 retries in about 4 minutes (RF-NOT-04). */
export async function sendWithRetries(channel, message) {
  const delays = retryDelays();
  let last;
  for (let i = 0; i <= delays.length; i++) {
    try {
      const response = await sendToChannel(channel, message);
      return { ok: true, attempts: i + 1, response: String(response ?? '').slice(0, 200) };
    } catch (e) {
      last = e;
      if (i < delays.length) await sleep(delays[i]);
    }
  }
  return { ok: false, attempts: delays.length + 1, error: last.message };
}

const usable = (c) => c.status === 'active' || c.status === 'error';

/**
 * Delivers the pending events of every area. `adminAreas`: the areas of the admins, which receive
 * the events about the monitor itself (stored in area '').
 */
export async function deliverAll(store, { now = Date.now, adminAreas = [''] } = {}) {
  const out = [];
  for (const area of await store.listAreas()) out.push(...(await deliverArea(store, area, { now })));
  // events about the monitor itself (RF-MON-13), for the admins
  const admin = await store.listEvents('', { status: 'pending', limit: 500 });
  for (const e of admin.filter((x) => x.admin)) {
    const deliveries = [];
    for (const area of adminAreas) {
      const channels = (await store.listChannels(area)).filter(usable);
      const prefs = await store.getPrefs(area);
      for (const c of channels) deliveries.push(await deliver(store, area, c, describeEvent(e, { tz: prefs.tz || monitoringConfig().tz }), now));
    }
    await store.updateEvent('', e.id, { status: deliveries.some((d) => d.ok) ? 'sent' : deliveries.length ? 'failed' : 'no-channels', deliveries });
  }
  return out;
}

// One message to one channel, with retries; updates the channel state. Returns the delivery record.
async function deliver(store, area, channel, message, now) {
  const r = await sendWithRetries(channel, message);
  const t = now();
  const fresh = (await store.listChannels(area)).find((c) => c.id === channel.id) || channel;
  fresh.sent = [...(fresh.sent || []).filter((x) => x > t - WINDOW), t];
  if (r.ok) {
    fresh.status = 'active';
    fresh.lastOkAt = t;
    fresh.lastError = null;
    fresh.failingSince = null;
  } else {
    const wasOk = fresh.status !== 'error';
    fresh.status = 'error';
    fresh.lastError = r.error;
    fresh.failingSince ||= t;
    // RF-NOT-04: if possible, tell the user by email that this channel stopped working
    if (wasOk && fresh.type !== 'email') {
      const mail = (await store.listChannels(area)).find((c) => c.type === 'email' && c.status === 'active');
      if (mail) await sendWithRetries(mail, describeEvent({ type: 'channel-error', channelName: fresh.name, error: r.error })).catch(() => {});
    }
  }
  Object.assign(channel, fresh);
  await store.saveChannel(area, fresh);
  return { channelId: channel.id, channel: channel.name, type: channel.type, ok: r.ok, at: t, attempts: r.attempts, error: r.error || null, response: r.response || null };
}

/** Delivers the events of one area. */
export async function deliverArea(store, area, { now = Date.now } = {}) {
  const t = now();
  const prefs = await store.getPrefs(area);
  const tz = prefs.tz || monitoringConfig().tz;
  const base = publicBaseUrl();
  const monitors = new Map((await store.listMonitors(area)).map((m) => [m.id, upgradeMonitor(m)]));
  const channels = (await store.listChannels(area)).filter(usable);

  // RF-ALR-02: reminders for incidents still open whose down alert went out: at most N, every X minutes
  for (const m of monitors.values()) {
    if (!m.state.openIncident || isMuted(m, t)) continue;
    const policy = effectivePolicy(m, prefs.policy);
    const inc = await store.getIncident(area, m.state.openIncident);
    if (!inc || !inc.downNotifiedAt) continue;
    if (reminderDue({ policy, sent: inc.remindersSent || 0, lastAt: inc.lastReminderAt || inc.downNotifiedAt, now: t })) {
      inc.lastReminderAt = t;
      inc.remindersSent = (inc.remindersSent || 0) + 1;
      await store.saveIncident(area, inc);
      await store.addEvent(area, { type: 'reminder', at: t, monitorId: m.id, monitorName: m.name, url: m.url, tags: m.tags, incidentId: inc.id, durationMs: t - inc.start, cause: inc.causes[inc.causes.length - 1], number: inc.remindersSent });
    }
  }

  const pending = [...(await store.listEvents(area, { status: 'pending', limit: 1000 })), ...(await store.listEvents(area, { status: 'delayed', limit: 1000 }))].filter((e) => !e.admin);
  const ready = [];
  const readyDown = new Set(); // incidents whose down alert goes out in this batch
  for (const e of pending.sort((x, y) => x.at - y.at)) {
    const m = e.monitorId ? monitors.get(e.monitorId) : null;
    if (e.monitorId && !m) {
      await store.updateEvent(area, e.id, { status: 'suppressed', reason: 'monitor eliminato' });
      continue;
    }
    const inc = e.incidentId ? await store.getIncident(area, e.incidentId) : null;
    // RF-RIS-03: a muted monitor keeps its incidents but sends no alerts; neither the down nor its recovery
    if (m && isMuted(m, e.at)) {
      await store.updateEvent(area, e.id, { status: 'suppressed', reason: 'monitor silenziato' });
      if (inc && (e.type === 'down' || e.type === 'heartbeat-missed')) {
        inc.downSuppressed = true;
        await store.saveIncident(area, inc);
      }
      continue;
    }
    if ((e.type === 'down' || e.type === 'heartbeat-missed') && m && inc) {
      // RF-ALR-01: after N failed runs in a row, or after X minutes; an incident that ends first never alerts
      const policy = effectivePolicy(m, prefs.policy);
      const due = shouldAlertDown({ policy, failures: inc.failures || 1, downSince: inc.start, now: inc.end ?? t });
      if (!due) {
        if (inc.end == null) {
          if (e.status !== 'delayed') await store.updateEvent(area, e.id, { status: 'delayed' });
        } else {
          await store.updateEvent(area, e.id, { status: 'suppressed', reason: 'tornato su prima della soglia di allerta' });
          inc.downSuppressed = true;
          await store.saveIncident(area, inc);
        }
        continue;
      }
      readyDown.add(inc.id);
    }
    if (e.type === 'up' && inc && !readyDown.has(inc.id) && (inc.downSuppressed || (!inc.downNotifiedAt && m && !isImmediate(effectivePolicy(m, prefs.policy))))) {
      await store.updateEvent(area, e.id, { status: 'suppressed', reason: 'il giù non era stato notificato' });
      continue;
    }
    ready.push(e);
  }
  if (!ready.length) return [];

  // targets: the monitor's channels, or all those of the account
  const byChannel = new Map();
  for (const e of ready) {
    const m = e.monitorId ? monitors.get(e.monitorId) : null;
    const targets = channels.filter((c) => (!m || !m.channels || m.channels.includes(c.id)) && channelAccepts(c, e, m));
    if (!targets.length) {
      await store.updateEvent(area, e.id, { status: 'no-channels' });
      continue;
    }
    for (const c of targets) {
      if (!byChannel.has(c.id)) byChannel.set(c.id, { channel: c, events: [] });
      byChannel.get(c.id).events.push(e);
    }
  }

  const deliveries = new Map(); // event id → records
  const record = (e, d) => deliveries.set(e.id, [...(deliveries.get(e.id) || []), d]);
  await Promise.all([...byChannel.values()].map(async ({ channel, events }) => {
    // RF-NOT-06: many state changes at once become one message
    const changes = events.filter((e) => e.type === 'down' || e.type === 'up' || e.type === 'heartbeat-missed');
    const messages = [];
    if (changes.length > GROUP_OVER) {
      messages.push({ events: changes, message: describeGroup(changes, { base }) });
      for (const e of events.filter((x) => !changes.includes(x))) messages.push({ events: [e], message: describeEvent(e, { tz, base }) });
    } else for (const e of events) messages.push({ events: [e], message: describeEvent(e, { tz, base }) });
    // RF-NOT-08: at most 30 messages in 10 minutes per channel, the last one a summary
    const room = MAX_PER_WINDOW - (channel.sent || []).filter((x) => x > t - WINDOW).length;
    let send = messages, dropped = [];
    if (messages.length > room) {
      send = room > 1 ? messages.slice(0, room - 1) : [];
      dropped = messages.slice(send.length);
      if (room >= 1) send.push({ events: [], message: describeEvent({ type: 'summary', count: dropped.reduce((n, x) => n + x.events.length, 0) }, { base }) });
    }
    for (const x of send) {
      const d = await deliver(store, area, channel, x.message, now);
      for (const e of x.events) record(e, d);
    }
    for (const x of dropped) for (const e of x.events) record(e, { channelId: channel.id, channel: channel.name, type: channel.type, ok: false, at: t, error: 'limite di invio superato' });
  }));

  for (const e of ready) {
    const ds = deliveries.get(e.id);
    if (!ds) continue;
    const ok = ds.some((d) => d.ok);
    await store.updateEvent(area, e.id, { status: ok ? 'sent' : 'failed', deliveries: ds });
    if ((e.type === 'down' || e.type === 'heartbeat-missed') && ok && e.incidentId) {
      const inc = await store.getIncident(area, e.incidentId);
      if (inc) {
        inc.downNotifiedAt = t;
        await store.saveIncident(area, inc);
      }
    }
  }
  return ready;
}

/** RF-NOT-03: a test message to one channel, now. */
export async function testChannel(store, area, channel, now = Date.now) {
  const d = await deliver(store, area, channel, describeEvent({ type: 'test', channelName: channel.name }), now);
  // it shows in the notification log (RF-ALR-07) but is not an event to deliver
  await store.addEvent(area, { type: 'test', at: d.at, status: 'info', channelName: channel.name, deliveries: [d] });
  return d;
}
