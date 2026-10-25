import { fmtDuration } from '../core/uptime.js';

// Notification channels (spec §12.5): message texts and the three adapters. Only fetch, no SDKs.
// The endpoints can be redirected for the tests (SITESCANNER_RESEND_URL, SITESCANNER_TELEGRAM_API).

export const resendUrl = () => process.env.SITESCANNER_RESEND_URL || 'https://api.resend.com/emails';
export const telegramApi = () => process.env.SITESCANNER_TELEGRAM_API || 'https://api.telegram.org';
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

/**
 * The content of an alert (RF-NOT-02): status first, monitor, cause in plain Italian, time in the
 * account's time zone, duration, link. Never credentials or headers.
 * @returns {{ subject: string, lines: string[], link: string|null }}
 */
export function describeEvent(e, { tz = 'Europe/Rome', base = publicBaseUrl() } = {}) {
  const link = e.incidentId ? `${base}/#/incident/${encodeURIComponent(e.incidentId)}` : e.monitorId ? `${base}/#/monitor/${encodeURIComponent(e.monitorId)}` : `${base}/#/monitoring`;
  switch (e.type) {
    case 'down':
      return { subject: `🔴 GIÙ: ${e.monitorName}`, lines: [`🔴 GIÙ — ${e.monitorName}`, e.url, `Causa: ${e.cause.message}`, `Dalle ${when(e.at, tz)}`], link };
    case 'up':
      return { subject: `🟢 SU: ${e.monitorName}`, lines: [`🟢 DI NUOVO SU — ${e.monitorName}`, e.url, `Giù per ${fmtDuration(e.durationMs)} (${e.cause.message})`, `Tornato su alle ${when(e.at, tz)}`], link };
    case 'reminder':
      return { subject: `🔴 ANCORA GIÙ: ${e.monitorName}`, lines: [`🔴 ANCORA GIÙ — ${e.monitorName}`, e.url, `Giù da ${fmtDuration(e.durationMs)}`, `Causa: ${e.cause.message}`], link };
    case 'slow':
      return { subject: `🟠 LENTO: ${e.monitorName}`, lines: [`🟠 LENTO — ${e.monitorName}`, e.url, `Risposta in ${e.ms} ms, oltre la soglia di ${e.slowMs} ms negli ultimi 3 controlli`], link };
    case 'cert':
      return { subject: `🔐 Certificato in scadenza: ${e.monitorName}`, lines: [`🔐 CERTIFICATO IN SCADENZA — ${e.monitorName}`, e.url, `Scade tra ${e.days} giorni (${when(e.expiresAt, tz)})${e.issuer ? `, emesso da ${e.issuer}` : ''}`], link };
    case 'cert-expired':
      return { subject: `⛔ Certificato scaduto: ${e.monitorName}`, lines: [`⛔ CERTIFICATO SCADUTO — ${e.monitorName}`, e.url, `Scaduto il ${when(e.expiresAt, tz)}`], link };
    case 'monitor-unreliable':
      return { subject: '⚠️ Monitoraggio non affidabile', lines: ['⚠️ MONITORAGGIO NON AFFIDABILE', `Alle ${when(e.at, tz)} ${e.failed} controlli su ${e.checked} sono falliti per rete e anche gli URL di riferimento non rispondevano: il giro è stato scartato.`], link };
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

async function post(url, body, headers = {}) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
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
    return post(resendUrl(), { from: process.env.SITESCANNER_EMAIL_FROM, to: [channel.config.address], subject: message.subject, text, html }, { authorization: `Bearer ${process.env.RESEND_API_KEY}` });
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
  throw new DeliveryError(`tipo di canale sconosciuto: ${channel.type}`);
}

/** Masked view of a channel (RF-NOT-09): never the full webhook URL or chat id. */
export function publicChannel(c) {
  const cfg = c.config || {};
  const shown = c.type === 'email' ? cfg.address : c.type === 'slack' ? `${slackPrefix()}…${String(cfg.webhookUrl || '').slice(-4)}` : `chat «${cfg.chatTitle || 'Telegram'}»`;
  return { id: c.id, type: c.type, name: c.name, target: shown, status: c.status, lastError: c.lastError || null, failingSince: c.failingSince || null, lastOkAt: c.lastOkAt || null, createdAt: c.createdAt };
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
