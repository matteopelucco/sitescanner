import crypto from 'node:crypto';
import { fmtDuration } from '../core/uptime.js';
import { crawlFetch } from '../net-guard.js';
import { DEFAULT_CHANNEL_EVENTS } from '../core/alerting.js';

// Notification channels (spec §12.5): message texts and the three adapters. Only fetch, no SDKs.
// The endpoints can be redirected for the tests (SITESCANNER_RESEND_URL, SITESCANNER_TELEGRAM_API).

export const resendUrl = () => process.env.SITESCANNER_RESEND_URL || 'https://api.resend.com/emails';
export const telegramApi = () => process.env.SITESCANNER_TELEGRAM_API || 'https://api.telegram.org';
export const teamsOk = (url) => (process.env.SITESCANNER_TEAMS_WEBHOOK_PREFIX ? String(url).startsWith(process.env.SITESCANNER_TEAMS_WEBHOOK_PREFIX) : /^https:\/\/[a-z0-9.-]+\.(webhook\.office\.com|logic\.azure\.com|powerplatform\.com|environment\.api\.powerplatform\.com)\//i.test(String(url)));
export const discordOk = (url) => (process.env.SITESCANNER_DISCORD_WEBHOOK_PREFIX ? String(url).startsWith(process.env.SITESCANNER_DISCORD_WEBHOOK_PREFIX) : /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//i.test(String(url)));
export const slackPrefix = () => process.env.SITESCANNER_SLACK_WEBHOOK_PREFIX || 'https://hooks.slack.com/';
export const emailAvailable = () => !!(process.env.RESEND_API_KEY && process.env.SITESCANNER_EMAIL_FROM);
export const telegramAvailable = () => !!process.env.SITESCANNER_TELEGRAM_BOT_TOKEN;

/** Address of the web app in links: SITESCANNER_PUBLIC_URL, or the production URL on Vercel. */
export function publicBaseUrl() {
  if (process.env.SITESCANNER_PUBLIC_URL) return process.env.SITESCANNER_PUBLIC_URL.replace(/\/$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return 'http://localhost:4173';
}

const when = (t, tz) => new Intl.DateTimeFormat('it-IT', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(t));
const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// RF-RIS-05: the description of the monitor goes in the alert as notes for whoever intervenes
function withNote(message, e) {
  if (e.description) message.lines.push(`Note per chi interviene: ${e.description}`);
  return message;
}

/**
 * The content of an alert (RF-NOT-02): status first, monitor, cause in plain Italian, time in the
 * account's time zone, duration, link. Never credentials or headers.
 * @returns {{ subject: string, lines: string[], link: string|null }}
 */
export function describeEvent(e, opts = {}) {
  return { ...describeEventText(e, opts), event: eventPayload(e) };
}

/** The event as data, for a webhook: what a program needs, without anything internal (RF-CHN-01). */
function eventPayload(e) {
  return {
    type: e.type, at: e.at ? new Date(e.at).toISOString() : null, ...(e.monitorId ? { monitor: { id: e.monitorId, name: e.monitorName, url: e.url || null } } : {}),
    ...(e.cause ? { cause: e.cause.message } : {}), ...(e.incidentId ? { incidentId: e.incidentId } : {}), ...(e.agentId ? { agent: { id: e.agentId, name: e.agentName } } : {}), ...(e.durationMs != null ? { durationMs: e.durationMs } : {}),
    ...(e.days != null ? { days: e.days } : {}), ...(e.expiresAt ? { expiresAt: new Date(e.expiresAt).toISOString() } : {}), ...(e.ms != null ? { ms: e.ms } : {}),
  };
}

function describeEventText(e, { tz = 'Europe/Rome', base = publicBaseUrl() } = {}) {
  const link = e.incidentId ? `${base}/#/incident/${encodeURIComponent(e.incidentId)}` : e.monitorId ? `${base}/#/monitor/${encodeURIComponent(e.monitorId)}` : `${base}/#/monitoring`;
  switch (e.type) {
    case 'down':
      return withNote({ subject: `🔴 GIÙ: ${e.monitorName}`, lines: [`🔴 GIÙ — ${e.monitorName}`, e.url, `Causa: ${e.cause.message}`, `Dalle ${when(e.at, tz)}`], link }, e);
    case 'up':
      return withNote({ subject: `🟢 SU: ${e.monitorName}`, lines: [`🟢 DI NUOVO SU — ${e.monitorName}`, e.url, `Giù per ${fmtDuration(e.durationMs)} (${e.cause.message})`, `Tornato su alle ${when(e.at, tz)}`], link }, e);
    case 'reminder':
      return withNote({ subject: `🔴 ANCORA GIÙ: ${e.monitorName}`, lines: [`🔴 ANCORA GIÙ — ${e.monitorName}`, e.url, `Giù da ${fmtDuration(e.durationMs)}`, `Causa: ${e.cause.message}`], link }, e);
    case 'degraded':
    case 'slow': // the first version's name for the same event
      return withNote({ subject: `🟠 DEGRADATO: ${e.monitorName}`, lines: [`🟠 DEGRADATO — ${e.monitorName}`, e.url, `Risposta in ${e.ms} ms, oltre la soglia di degrado di ${e.degradedMs || e.slowMs} ms`], link }, e);
    case 'cert':
      return withNote({ subject: `🔐 Certificato in scadenza: ${e.monitorName}`, lines: [`🔐 CERTIFICATO IN SCADENZA — ${e.monitorName}`, e.url, `Scade tra ${e.days} giorni (${when(e.expiresAt, tz)})${e.issuer ? `, emesso da ${e.issuer}` : ''}`], link }, e);
    case 'domain':
      return withNote({ subject: `🌐 Dominio in scadenza: ${e.monitorName}`, lines: [`🌐 DOMINIO IN SCADENZA — ${e.monitorName}`, e.domain || '', `Scade tra ${e.days} giorni (${when(e.expiresAt, tz)})`], link }, e);
    case 'domain-expired':
      return withNote({ subject: `⛔ Dominio scaduto: ${e.monitorName}`, lines: [`⛔ DOMINIO SCADUTO — ${e.monitorName}`, e.domain || '', `Scaduto il ${when(e.expiresAt, tz)}`], link }, e);
    case 'cert-expired':
      return withNote({ subject: `⛔ Certificato scaduto: ${e.monitorName}`, lines: [`⛔ CERTIFICATO SCADUTO — ${e.monitorName}`, e.url, `Scaduto il ${when(e.expiresAt, tz)}`], link }, e);
    case 'maintenance-start':
      return { subject: `🛠 Manutenzione iniziata: ${e.monitorName}`, lines: [`🛠 MANUTENZIONE INIZIATA — ${e.monitorName}`, e.url, 'Fino alla fine della finestra non ci saranno avvisi di guasto.'], link };
    case 'maintenance-end':
      return { subject: `🛠 Manutenzione finita: ${e.monitorName}`, lines: [`🛠 MANUTENZIONE FINITA — ${e.monitorName}`, e.url, 'I controlli e gli avvisi sono di nuovo attivi.'], link };
    case 'heartbeat-missed':
      return withNote({ subject: `💔 Heartbeat mancato: ${e.monitorName}`, lines: [`💔 HEARTBEAT MANCATO — ${e.monitorName}`, `Nessuna chiamata ricevuta entro ${e.expectedMin} minuti (più la tolleranza).`, `Ultima chiamata: ${e.lastAt ? when(e.lastAt, tz) : 'mai'}`], link }, e);
    case 'monitor-unreliable':
      return { subject: '⚠️ Monitoraggio non affidabile', lines: ['⚠️ MONITORAGGIO NON AFFIDABILE', `Alle ${when(e.at, tz)} ${e.failed} controlli su ${e.checked} sono falliti per rete e anche gli URL di riferimento non rispondevano: il giro è stato scartato.`], link };
    case 'agent-missed':
      return { subject: `🛰 Agente fermo: ${e.agentName}`, lines: [`🛰 AGENTE FERMO — ${e.agentName}`, `Non chiede più i controlli da ${e.afterMin} minuti (l'ultima volta: ${e.lastSeenAt ? when(e.lastSeenAt, tz) : 'mai'}).`, 'I monitor che girano solo da questa località non vengono controllati.'], link: `${base}/#/agents` };
    case 'agent-back':
      return { subject: `🛰 Agente di nuovo collegato: ${e.agentName}`, lines: [`🛰 AGENTE DI NUOVO COLLEGATO — ${e.agentName}`, `Ha ripreso a chiedere i controlli alle ${when(e.at, tz)}.`], link: `${base}/#/agents` };
    case 'channel-error':
      return { subject: `⚠️ Canale di notifica in errore: ${e.channelName}`, lines: ['⚠️ CANALE DI NOTIFICA IN ERRORE', `Le notifiche verso «${e.channelName}» non vengono consegnate: ${e.error}.`, 'Controlla il canale nella pagina Notifiche.'], link: `${base}/#/notifications` };
    case 'test':
      return { subject: 'Notifica di prova da sitescanner', lines: ['✅ Notifica di prova da sitescanner', `Il canale «${e.channelName}» funziona.`], link: null };
    case 'summary':
      return { subject: `sitescanner: altri ${e.count} eventi`, lines: [`Altri ${e.count} eventi non inviati per non intasare il canale: vedi la dashboard.`], link: `${base}/#/monitoring` };
    default:
      return { subject: e.type, lines: [e.type], link };
  }
}

/** Several state changes in one message (RF-NOT-06), split between down and up. */
export function describeGroup(events, opts = {}) {
  const downs = events.filter((e) => e.type === 'down');
  const ups = events.filter((e) => e.type === 'up');
  const lines = [`${downs.length ? `🔴 ${downs.length} giù` : ''}${downs.length && ups.length ? ' · ' : ''}${ups.length ? `🟢 ${ups.length} di nuovo su` : ''}`];
  if (downs.length) lines.push('', 'GIÙ:', ...downs.map((e) => `• ${e.monitorName} — ${e.cause.message}`));
  if (ups.length) lines.push('', 'DI NUOVO SU:', ...ups.map((e) => `• ${e.monitorName} — giù per ${fmtDuration(e.durationMs)}`));
  return { subject: `sitescanner: ${lines[0]}`, lines, link: `${opts.base || publicBaseUrl()}/#/monitoring` };
}

const asText = (m) => [...m.lines, ...(m.link ? ['', m.link] : [])].join('\n');

class DeliveryError extends Error {}

async function post(url, body, headers = {}, { guarded = false, raw = false } = {}) {
  let res;
  try {
    // a webhook given by a person must not reach private addresses of the server (RF-SEC-01)
    const f = guarded ? await crawlFetch(true) : fetch;
    res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw ? body : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new DeliveryError(`rete: ${(e.cause && e.cause.code) || e.message}`);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new DeliveryError(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  return text;
}

/** Sends a message to a channel; throws on failure (the caller retries, RF-NOT-04). */
export async function sendToChannel(channel, message) {
  const text = asText(message);
  if (channel.type === 'email') {
    if (!emailAvailable()) throw new DeliveryError('email non configurata (RESEND_API_KEY, SITESCANNER_EMAIL_FROM)');
    const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">${message.lines.map((l, i) => (i === 0 ? `<p style="font-size:17px"><b>${escHtml(l)}</b></p>` : `<div>${escHtml(l)}</div>`)).join('')}${message.link ? `<p><a href="${escHtml(message.link)}">Apri in sitescanner</a></p>` : ''}</div>`;
    return post(resendUrl(), { from: process.env.SITESCANNER_EMAIL_FROM, to: [channel.config.address], subject: message.subject, text, html, ...(message.attachments ? { attachments: message.attachments } : {}) }, { authorization: `Bearer ${process.env.RESEND_API_KEY}` });
  }
  if (channel.type === 'slack') {
    // Slack's own error bodies ("no_service", "channel_is_archived") say why a webhook stopped working
    return post(channel.config.webhookUrl, { text: [`*${message.lines[0]}*`, ...message.lines.slice(1), ...(message.link ? [`<${message.link}|Apri in sitescanner>`] : [])].join('\n') });
  }
  if (channel.type === 'telegram') {
    if (!telegramAvailable()) throw new DeliveryError('bot Telegram non configurato (SITESCANNER_TELEGRAM_BOT_TOKEN)');
    const html = [`<b>${escHtml(message.lines[0])}</b>`, ...message.lines.slice(1).map(escHtml), ...(message.link ? [`<a href="${escHtml(message.link)}">Apri in sitescanner</a>`] : [])].join('\n');
    return post(`${telegramApi()}/bot${process.env.SITESCANNER_TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: channel.config.chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true });
  }
  if (channel.type === 'webhook') {
    // RF-CHN-01: JSON signed with HMAC-SHA256 of «timestamp.body», so that the receiver knows it comes from here and is not a replay
    const body = JSON.stringify({ id: crypto.randomUUID(), type: 'sitescanner.event', at: new Date().toISOString(), event: message.event || { type: 'message' }, message: { subject: message.subject, text, link: message.link } });
    const ts = String(Date.now());
    const sig = crypto.createHmac('sha256', channel.config.secret || '').update(`${ts}.${body}`).digest('hex');
    return post(channel.config.url, body, { 'x-sitescanner-timestamp': ts, 'x-sitescanner-signature': `sha256=${sig}`, 'user-agent': 'sitescanner-webhook' }, { guarded: !!channel.guard, raw: true });
  }
  if (channel.type === 'teams') {
    // an Adaptive Card, as the Workflows webhooks of Teams want it
    const card = { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4', body: [{ type: 'TextBlock', text: message.lines[0], weight: 'Bolder', size: 'Medium', wrap: true }, ...message.lines.slice(1).map((l) => ({ type: 'TextBlock', text: l, wrap: true, spacing: 'Small' }))], ...(message.link ? { actions: [{ type: 'Action.OpenUrl', title: 'Apri in sitescanner', url: message.link }] } : {}) };
    return post(channel.config.webhookUrl, { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }] });
  }
  if (channel.type === 'discord') {
    return post(channel.config.webhookUrl, { username: 'sitescanner', embeds: [{ title: message.lines[0].slice(0, 256), description: message.lines.slice(1).join('\n').slice(0, 4000), ...(message.link ? { url: message.link } : {}), color: /GIÙ|SCADUT|MANCATO|ERRORE/.test(message.lines[0]) ? 0xd64545 : /DEGRADATO|SCADENZA/.test(message.lines[0]) ? 0xe0952b : 0x2e9e5b }] });
  }
  throw new DeliveryError(`tipo di canale sconosciuto: ${channel.type}`);
}

/** Masked view of a channel (RF-NOT-09): never the full webhook URL or chat id. */
export function publicChannel(c) {
  const cfg = c.config || {};
  const tail = (u) => `…${String(u || '').slice(-4)}`;
  const shown = c.type === 'email' ? cfg.address : c.type === 'slack' ? `${slackPrefix()}${tail(cfg.webhookUrl)}` : c.type === 'webhook' ? (() => { try { return `${new URL(cfg.url).host}/${tail(cfg.url)}`; } catch { return tail(cfg.url); } })() : c.type === 'teams' ? `Teams ${tail(cfg.webhookUrl)}` : c.type === 'discord' ? `Discord ${tail(cfg.webhookUrl)}` : `chat «${cfg.chatTitle || 'Telegram'}»`;
  return { id: c.id, type: c.type, name: c.name, events: c.events || [...DEFAULT_CHANNEL_EVENTS], tags: c.tags || [], target: shown, status: c.status, lastError: c.lastError || null, failingSince: c.failingSince || null, lastOkAt: c.lastOkAt || null, createdAt: c.createdAt };
}

/** Telegram bot username for the link t.me/<bot>?start=<code>: from the environment or getMe. */
let botName = null;
export async function telegramBotUsername() {
  if (process.env.SITESCANNER_TELEGRAM_BOT_USERNAME) return process.env.SITESCANNER_TELEGRAM_BOT_USERNAME;
  if (botName) return botName;
  const r = await fetch(`${telegramApi()}/bot${process.env.SITESCANNER_TELEGRAM_BOT_TOKEN}/getMe`, { signal: AbortSignal.timeout(10000) }).then((x) => x.json());
  botName = r && r.result && r.result.username;
  if (!botName) throw new Error('bot Telegram non raggiungibile');
  return botName;
}

export async function telegramReply(chatId, text) {
  await post(`${telegramApi()}/bot${process.env.SITESCANNER_TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: chatId, text }).catch(() => {});
}
