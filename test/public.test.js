import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  slugProblem, normalizePage, normalizeCommunication, normalizePost, monitorToComponent, worstStatus, overallStatus, overallSentence, componentDays, dayClass, fmtPct,
  badgeSvg, badgeValue, pageHtml, passwordHtml, tvHtml, tvOrder,
} from '../src/core/statuspage.js';
import { serve } from '../src/server.js';
import { resetPublicLimits } from '../src/monitor/public.js';

// Status pages, TV dashboard and badges (spec §13.11, RF-PUB-01..06): what they show, what they never show, how they are cached and protected.

test('pure: addresses, pages, communications, statuses', () => {
  assert.equal(slugProblem('acme-status'), null);
  assert.match(slugProblem('ab'), /da 3 a 40/);
  assert.match(slugProblem('Acme'), /da 3 a 40/);
  assert.match(slugProblem('api'), /riservato/);
  const comp = (name, ids = ['m1']) => ({ name, monitorIds: ids });
  const ok = normalizePage({ slug: 'Acme-Status', name: ' Acme ', components: [comp('Sito'), comp('API', ['m2', 'm2'])], siteUrl: 'https://www.acme.it/', customDomain: 'Status.Acme.it.' }, { newId: (() => { let i = 0; return () => `c${++i}`; })() });
  assert.deepEqual([ok.slug, ok.name, ok.noindex, ok.customDomain, ok.components.map((c) => [c.id, c.name, c.monitorIds])], ['acme-status', 'Acme', true, 'status.acme.it', [['c1', 'Sito', ['m1']], ['c2', 'API', ['m2']]]]);
  const bad = (x, re) => assert.throws(() => normalizePage({ slug: 'acme', name: 'Acme', components: [comp('A')], ...x }), re);
  bad({ components: [] }, /almeno un componente/);
  bad({ components: [{ name: 'A', monitorIds: [] }] }, /collega almeno un monitor/);
  bad({ components: [comp('A'), comp('a')] }, /stesso nome/);
  bad({ components: [comp('')] }, /Componente 1/);
  bad({ name: 'A' }, /da 2 a 80/);
  bad({ logoUrl: 'javascript:alert(1)' }, /Logo: serve un indirizzo http/);
  bad({ siteUrl: 'boh' }, /Sito del cliente/);
  bad({ customDomain: 'non valido' }, /Dominio non valido/);
  assert.equal(normalizePage({ slug: 'acme', name: 'Acme', components: [comp('A')], noindex: false }).noindex, false);

  const page = { components: [{ id: 'c1', name: 'Sito' }] };
  assert.deepEqual(normalizeCommunication({ title: 'Sito lento', text: 'Stiamo guardando', components: ['c1'] }, page), { title: 'Sito lento', status: 'investigating', text: 'Stiamo guardando', components: ['c1'] });
  assert.throws(() => normalizeCommunication({ title: 'x', text: 'y' }, page), /da 3 a 120/);
  assert.throws(() => normalizeCommunication({ title: 'Titolo', text: '' }, page), /da 1 a 2000/);
  assert.throws(() => normalizeCommunication({ title: 'Titolo', text: 'y', status: 'boh' }, page), /Stato/);
  assert.throws(() => normalizeCommunication({ title: 'Titolo', text: 'y', components: ['zzz'] }, page), /Componente sconosciuto/);
  assert.deepEqual(normalizePost({ status: 'resolved', text: 'Fatto' }), { status: 'resolved', text: 'Fatto' });
  assert.throws(() => normalizePost({ status: 'boh', text: 'x' }), /Stato/);

  assert.deepEqual(['up', 'down', 'degraded', 'maintenance', 'paused', 'pending', 'unconfigured'].map(monitorToComponent), ['operational', 'outage', 'degraded', 'maintenance', 'unknown', 'unknown', 'unknown']);
  assert.equal(worstStatus(['operational', 'degraded', 'operational']), 'degraded');
  assert.equal(worstStatus(['operational', 'outage', 'degraded']), 'outage');
  assert.equal(worstStatus(['unknown', 'operational']), 'operational', 'a monitor with no data does not hide the others');
  assert.equal(worstStatus(['unknown']), 'unknown');
  assert.equal(overallStatus([{ status: 'operational' }, { status: 'maintenance' }]), 'maintenance');
  assert.equal(overallSentence('outage'), 'Alcuni servizi non sono disponibili');
  assert.equal(overallSentence('unknown'), 'Stato non ancora disponibile');
  // availability by day, weighted on the monitored time: 0.01 days of downtime in 2 days of monitoring is 99.5 %, not the average of 100 and 99
  const day = 86400000;
  const days = componentDays([[{ day, monitoredMs: day, downtimeMs: 0 }], [{ day, monitoredMs: day, downtimeMs: 0.01 * day }], [{ day: 2 * day, monitoredMs: day, downtimeMs: day }]]);
  assert.deepEqual(days.map((d) => [d.day, Math.round(d.pct * 100) / 100]), [[day, 99.5], [2 * day, 0]]);
  assert.deepEqual([99.99, 99.5, 98, null].map(dayClass), ['good', 'mid', 'bad', 'none']);
  assert.equal(fmtPct(99.987), '99,99%');
});

test('pure: pages are escaped and carry only what they are given; badges are SVG', () => {
  const evil = '<script>alert("x")</script>';
  const view = {
    page: { name: evil, logoUrl: 'https://cdn.acme.it/logo.png', siteUrl: 'https://www.acme.it/', description: evil, noindex: true, components: [{ id: 'c1', name: evil }] },
    components: [{ id: 'c1', name: evil, status: 'outage', days: Array.from({ length: 90 }, (_, i) => ({ day: i * 86400000, pct: i === 89 ? 90 : 100 })), availability: 99.5 }],
    updates: [{ title: evil, status: 'identified', components: ['c1'], posts: [{ at: 1000, status: 'identified', text: `riga 1\n${evil}` }] }],
    maintenance: [{ start: 1e12, end: 1e12 + 3600000, components: [evil] }], now: 1.8e12,
  };
  const html = pageHtml(view);
  assert.equal(html.includes('<script>'), false, 'nothing written by a person is HTML');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, /<meta http-equiv="refresh" content="60">/);
  assert.match(html, /Alcuni servizi non sono disponibili/);
  assert.equal((html.match(/<i class="(good|mid|bad|none)"/g) || []).length, 90, 'one bar a day');
  assert.match(html, /<i class="bad"/);
  assert.match(html, /riga 1<br>/);
  assert.equal(pageHtml({ ...view, page: { ...view.page, noindex: false } }).includes('noindex'), false);
  assert.match(passwordHtml({ name: 'Acme' }, { error: true }), /Password errata/);
  assert.match(passwordHtml({ name: evil }), /&lt;script&gt;/);
  const tv = tvHtml({ name: 'Servizi', rows: tvOrder([{ name: 'Blog', status: 'operational', availability: 100 }, { name: evil, status: 'outage', availability: 90 }, { name: 'Alfa', status: 'degraded', availability: 99 }]), now: 1.8e12 });
  assert.equal(tv.includes('<script>'), false);
  assert.match(tv, /1 non risponde/);
  assert.match(tv, /<meta http-equiv="refresh" content="30">/);
  assert.ok(tv.indexOf('Non disponibile') < tv.indexOf('Prestazioni ridotte') && tv.indexOf('Prestazioni ridotte') < tv.indexOf('Operativo'), 'the failures first');
  assert.match(tvHtml({ name: 'x', rows: [], now: 1.8e12 }), /Nessun monitor/);
  assert.deepEqual(tvOrder([{ name: 'b', status: 'operational' }, { name: 'a', status: 'operational' }, { name: 'c', status: 'outage' }]).map((r) => r.name), ['c', 'a', 'b']);

  const svg = badgeSvg({ label: 'stato', value: 'su · 99,98%', tone: 'ok' });
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.ok(svg.includes('#2e9e5b') && svg.includes('su · 99,98%') && svg.includes('aria-label="stato: su · 99,98%"'));
  assert.equal(badgeSvg({ label: evil, value: evil }).includes('<script>'), false);
  assert.deepEqual(badgeValue('operational', 99.983), { value: 'su · 99,98%', tone: 'ok' });
  assert.deepEqual(badgeValue('outage', null), { value: 'giù', tone: 'error' });
  assert.deepEqual(badgeValue('unknown', null), { value: 'n/d', tone: 'none' });
});

// ---------------- HTTP ----------------

let home, server, base, site, siteUrl, siteMode = 'ok';
const SECRET_PATH = 'segreto-interno-del-server';

before(async () => {
  site = http.createServer((req, res) => {
    if (siteMode === 'down') return res.writeHead(502, { 'x-powered-by': 'PHP-interno-7.4' }).end('causa tecnica: database aruba-01 irraggiungibile');
    if (siteMode === 'slow') return setTimeout(() => res.writeHead(200).end('lento'), 60);
    res.writeHead(200, { 'x-powered-by': 'PHP-interno-7.4' }).end('ok');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-pub-'));
  Object.assign(process.env, { SITESCANNER_HOME: home, SITESCANNER_ADMIN_USER: 'admin', SITESCANNER_ADMIN_PASSWORD: 'admin-iniziale-123', SITESCANNER_MONITOR_DEV: '1', SITESCANNER_ALLOW_PRIVATE_NETWORKS: '1', SITESCANNER_MON_RETRY_MS: '10', SITESCANNER_PUBLIC_URL: 'https://monitor.example.com' });
  server = await serve({ port: 0, multi: true });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await new Promise((r) => site.close(r));
  for (const k of ['SITESCANNER_ADMIN_USER', 'SITESCANNER_ADMIN_PASSWORD', 'SITESCANNER_MONITOR_DEV', 'SITESCANNER_ALLOW_PRIVATE_NETWORKS', 'SITESCANNER_MON_RETRY_MS', 'SITESCANNER_PUBLIC_URL']) delete process.env[k];
  fs.rmSync(home, { recursive: true, force: true });
});

function client() {
  const jar = new Map();
  const req = async (method, p, body) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${base}${p}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, data };
  };
  return { req, api: (m, p, b) => req(m, `/api/${p}`, b) };
}

async function user(admin, name) {
  const c = client();
  await admin.api('POST', 'users', { username: name, password: `${name}-temporanea-1` });
  await c.api('POST', 'login', { username: name, password: `${name}-temporanea-1` });
  await c.api('PUT', 'me/password', { current: `${name}-temporanea-1`, password: `${name}-definitiva-12` });
  return c;
}

const pub = (p, init = {}) => fetch(`${base}${p}`, { redirect: 'manual', ...init }).then(async (r) => ({ status: r.status, headers: r.headers, text: await r.text() }));

test('HTTP: pages, communications, TV dashboard, badges, protection, cache, leaks', async () => {
  siteMode = 'ok';
  const admin = client();
  await admin.api('POST', 'login', { username: 'admin', password: 'admin-iniziale-123' });
  await admin.api('PUT', 'me/password', { current: 'admin-iniziale-123', password: 'admin-definitiva-12' });
  const ada = await user(admin, 'ada');
  const eva = await user(admin, 'eva');
  const mk = async (name, p, tags = []) => (await ada.api('POST', 'monitors', { name, url: `${siteUrl}/${p}`, tags, description: 'Contatti dell hosting: aruba-01, tel 06 1234' })).data;
  const web = await mk('Sito vetrina', SECRET_PATH, ['cliente:acme']);
  const shop = await mk('Negozio', `${SECRET_PATH}-shop`, ['cliente:acme']);
  const blog = await mk('Blog', `${SECRET_PATH}-blog`, ['cliente:zeta']);

  // ---- the page
  let r = await ada.api('POST', 'statuspages', { slug: 'acme-status', name: 'Acme · stato dei servizi', siteUrl: 'https://www.acme.it/', components: [{ name: 'Sito', monitorIds: [web.id, shop.id] }, { name: 'Blog', monitorIds: [blog.id] }] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const page = r.data;
  assert.equal(page.url, 'https://monitor.example.com/status/acme-status');
  assert.deepEqual([page.noindex, page.hasPassword], [true, false]);
  assert.equal('passwordHash' in page, false);
  assert.equal((await ada.api('POST', 'statuspages', { slug: 'acme-status', name: 'Doppia', components: [{ name: 'A', monitorIds: [web.id] }] })).status, 400, 'an address is used once');
  assert.equal((await eva.api('POST', 'statuspages', { slug: 'acme-status', name: 'Rubata', components: [{ name: 'A', monitorIds: [web.id] }] })).data.error.includes('già usato'), true, 'also across workspaces');
  assert.equal((await ada.api('POST', 'statuspages', { slug: 'altra-pagina', name: 'Altra pagina', components: [{ name: 'A', monitorIds: ['non-esiste'] }] })).data.error.includes('monitor che non esiste'), true);
  assert.equal((await ada.api('POST', 'statuspages', { slug: 'altra-pagina', name: 'Altra pagina', components: [] })).status, 400);

  // all up: the public page, without a session
  let p = await pub('/status/acme-status');
  assert.equal(p.status, 200);
  assert.match(p.text, /Tutti i servizi sono operativi/);
  assert.match(p.text, /Sito/);
  assert.equal(p.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(p.headers.get('cache-control'), /s-maxage=30/);
  assert.match(p.headers.get('content-security-policy'), /default-src 'none'/);
  assert.ok(p.headers.get('etag'));
  const again = await pub('/status/acme-status', { headers: { 'if-none-match': p.headers.get('etag') } });
  assert.equal(again.status, 304, 'a conditional request costs nothing');
  assert.equal((await pub('/status/non-esiste')).status, 404);
  assert.equal((await pub('/status/ab')).status, 401, 'not an address: the login wall, not the page');

  // a failure: the component is down, and nothing internal shows
  siteMode = 'down';
  await ada.api('POST', `monitors/${web.id}/check`, {});
  p = await pub('/status/acme-status');
  assert.match(p.text, /Alcuni servizi non sono disponibili/);
  assert.match(p.text, /Non disponibile/);
  const json = await pub('/status/acme-status.json');
  const everything = [p.text, json.text];
  // communications, the planned maintenance, the TV and the badges are checked below for the same leaks
  const leaks = [SECRET_PATH, '127.0.0.1', siteUrl, 'aruba-01', 'PHP-interno', 'Errore HTTP', 'causa tecnica', 'Contatti dell hosting', web.id, 'cliente:acme', 'passwordHash', '502'];
  const noLeaks = (label, text) => { for (const x of leaks) assert.equal(text.includes(x), false, `${label} must not contain «${x}»`); };
  for (const t of everything) noLeaks('page', t);
  assert.deepEqual(Object.keys(JSON.parse(json.text)).sort(), ['communications', 'components', 'maintenance', 'name', 'status', 'updatedAt']);
  assert.equal(JSON.parse(json.text).status, 'outage');
  assert.deepEqual(JSON.parse(json.text).components.map((c) => [c.name, c.status]), [['Sito', 'outage'], ['Blog', 'operational']]);

  // ---- a communication written by the team (RF-PUB-02), not published by the incident
  const comp = page.components[0].id;
  r = await ada.api('POST', `statuspages/${page.id}/communications`, { title: 'Sito non raggiungibile', status: 'investigating', text: 'Stiamo verificando il problema.', components: [comp] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const comm = r.data;
  p = await pub('/status/acme-status');
  assert.match(p.text, /Sito non raggiungibile/);
  assert.match(p.text, /Stiamo verificando il problema/);
  assert.match(p.text, /In analisi/);
  r = await ada.api('POST', `statuspages/${page.id}/communications/${comm.id}`, { status: 'identified', text: 'Il problema è nel server.' });
  assert.equal(r.data.posts.length, 2);
  siteMode = 'ok';
  await ada.api('POST', `monitors/${web.id}/check`, {});
  await ada.api('POST', `statuspages/${page.id}/communications/${comm.id}`, { status: 'resolved', text: 'Risolto.' });
  p = await pub('/status/acme-status');
  assert.match(p.text, /Ultimi problemi risolti/);
  assert.match(p.text, /Tutti i servizi sono operativi/);
  assert.equal((await ada.api('POST', `statuspages/${page.id}/communications`, { title: 'x', text: 'y' })).status, 400);
  assert.equal((await ada.api('POST', `statuspages/${page.id}/communications`, { title: 'Titolo', text: 'y', components: ['zzz'] })).status, 400);
  noLeaks('page with a communication', p.text);
  // maintenance: the times and the components, never the name of the window
  await ada.api('POST', 'maintenance', { name: 'Migrazione database aruba-01', type: 'once', start: Date.now() + 86400000, durationMin: 60, monitorIds: [web.id], tags: [] });
  p = await pub('/status/acme-status');
  assert.match(p.text, /Manutenzione programmata/);
  noLeaks('page with maintenance', p.text);
  assert.equal(p.text.includes('Migrazione database'), false);

  // ---- protected by a password, hidden or not from search engines (RF-PUB-03)
  assert.equal((await ada.api('PUT', `statuspages/${page.id}`, { ...page, password: 'corta' })).status, 400);
  r = await ada.api('PUT', `statuspages/${page.id}`, { ...page, password: 'una-password-lunga', noindex: true });
  assert.equal(r.data.hasPassword, true);
  p = await pub('/status/acme-status');
  assert.match(p.text, /protetta da una password/);
  assert.equal(p.text.includes('Sito'), false);
  assert.match(p.headers.get('cache-control'), /no-store/);
  assert.equal((await pub('/status/acme-status.json')).status, 401);
  const wrong = await pub('/status/acme-status', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=sbagliata' });
  assert.equal(wrong.status, 401);
  assert.match(wrong.text, /Password errata/);
  const good = await pub('/status/acme-status', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=una-password-lunga' });
  assert.equal(good.status, 303);
  const cookie = good.headers.getSetCookie()[0].split(';')[0];
  assert.match(good.headers.getSetCookie()[0], /HttpOnly/);
  p = await pub('/status/acme-status', { headers: { cookie } });
  assert.match(p.text, /Tutti i servizi sono operativi/);
  assert.equal((await pub('/status/acme-status.json', { headers: { cookie } })).status, 200);
  assert.equal((await pub('/status/acme-status', { headers: { cookie: cookie.replace(/.$/, 'x') } })).text.includes('protetta'), true, 'a cookie that is not ours');
  // another password invalidates the cookies
  await ada.api('PUT', `statuspages/${page.id}`, { ...page, password: 'un-altra-password-1' });
  assert.match((await pub('/status/acme-status', { headers: { cookie } })).text, /protetta da una password/);
  // without a password and open to search engines
  r = await ada.api('PUT', `statuspages/${page.id}`, { ...page, clearPassword: true, noindex: false });
  assert.equal(r.data.hasPassword, false);
  p = await pub('/status/acme-status');
  assert.equal(p.headers.get('x-robots-tag'), null);
  assert.equal(p.text.includes('noindex'), false);

  // ---- the TV dashboard: a secret link that can be revoked (RF-PUB-05)
  r = await ada.api('POST', 'public-links', { kind: 'tv', name: 'Sala server', tags: ['cliente:acme'] });
  assert.equal(r.status, 201);
  const tv = r.data;
  assert.match(tv.url, /^https:\/\/monitor\.example\.com\/tv\/[\w-]{24}$/);
  siteMode = 'down';
  await ada.api('POST', `monitors/${shop.id}/check`, {});
  const tvPath = new URL(tv.url).pathname;
  let t = await pub(tvPath);
  assert.equal(t.status, 200);
  assert.match(t.text, /Sala server/);
  assert.match(t.text, /1 non risponde/);
  assert.ok(t.text.indexOf('Negozio') < t.text.indexOf('Sito vetrina'), 'the failure first');
  assert.equal(t.text.includes('Blog'), false, 'only the tags of the link');
  assert.match(t.headers.get('cache-control'), /no-store/);
  noLeaks('TV', t.text);
  const tj = JSON.parse((await pub(`${tvPath}.json`)).text);
  assert.deepEqual(tj.rows.map((x) => [x.name, x.status]), [['Negozio', 'outage'], ['Sito vetrina', 'operational']]);
  assert.equal((await pub('/tv/xxxxxxxxxxxxxxxxxxxxxxxx')).status, 404);
  await ada.api('DELETE', `public-links/${tv.token}`);
  assert.equal((await pub(tvPath)).status, 404, 'revoked');
  siteMode = 'ok';

  // ---- badges (RF-PUB-06): of a monitor and of a component
  r = await ada.api('POST', 'public-links', { kind: 'badge', monitorId: web.id });
  const badge = r.data;
  assert.match(badge.markdown, /^!\[stato\]\(https:\/\/monitor\.example\.com\/badge\/[\w-]{24}\.svg\)$/);
  let b = await pub(new URL(badge.url).pathname);
  assert.equal(b.status, 200);
  assert.match(b.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(b.text, /<svg /);
  assert.match(b.text, /su · \d+,\d\d%|su/);
  noLeaks('badge', b.text);
  assert.match(b.headers.get('cache-control'), /max-age=60/);
  assert.match((await pub(`${new URL(badge.url).pathname}?label=sito%20acme`)).text, /sito acme/);
  r = await ada.api('POST', 'public-links', { kind: 'badge', pageId: page.id, componentId: page.components[1].id });
  assert.match((await pub(new URL(r.data.url).pathname)).text, /su/);
  assert.equal((await ada.api('POST', 'public-links', { kind: 'badge', monitorId: 'non-esiste' })).status, 404);
  assert.equal((await ada.api('POST', 'public-links', { kind: 'altro' })).status, 400);
  assert.equal((await pub('/badge/xxxxxxxxxxxxxxxxxxxxxxxx.svg')).status, 404);
  assert.equal((await pub(new URL(tv.url).pathname.replace('/tv/', '/badge/') + '.svg')).status, 404, 'a TV token is not a badge');
  await ada.api('DELETE', `monitors/${web.id}`);
  assert.match((await pub(new URL(badge.url).pathname)).text, /n\/d/, 'a badge of a deleted monitor says there is no data, not an error');

  // ---- who can manage them (RF-TEAM): another workspace sees nothing of it, and a reader changes nothing
  assert.deepEqual((await eva.api('GET', 'statuspages')).data, []);
  assert.equal((await eva.api('PUT', `statuspages/${page.id}`, { ...page })).status, 404);
  assert.equal((await eva.api('DELETE', `public-links/${badge.token}`)).status, 404);
  assert.equal((await ada.api('GET', 'public-links')).data.length >= 2, true);

  // ---- the limit of the requests (RF-PUB / RNF), then deleting the page
  let limited = false;
  for (let i = 0; i < 130 && !limited; i++) limited = (await pub('/status/acme-status')).status === 429;
  assert.equal(limited, true, 'more than 120 requests a minute from one address are refused');
  assert.equal((await ada.api('DELETE', `statuspages/${page.id}`)).status, 200);
  assert.equal((await ada.api('GET', 'public-links')).data.some((l) => l.target && l.target.pageId === page.id), false, 'the badges of the page go with it');
});

test('a custom domain shows its page at the root (RF-PUB-04)', async () => {
  resetPublicLimits();
  const admin = client();
  await admin.api('POST', 'login', { username: 'admin', password: 'admin-definitiva-12' });
  const lia = await user(admin, 'lia');
  siteMode = 'ok';
  const m = (await lia.api('POST', 'monitors', { name: 'Sito', url: `${siteUrl}/x` })).data;
  const r = await lia.api('POST', 'statuspages', { slug: 'cliente-lia', name: 'Cliente Lia', customDomain: 'Status.Cliente.it', components: [{ name: 'Sito', monitorIds: [m.id] }] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.customUrl, 'https://status.cliente.it/');
  const viaHost = (host, p = '/') => new Promise((resolve, reject) => {
    const q = http.request({ host: '127.0.0.1', port: server.address().port, path: p, method: 'GET', headers: { host } }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t, headers: res.headers })); });
    q.on('error', reject); q.end();
  });
  let d = await viaHost('status.cliente.it');
  assert.equal(d.status, 200);
  assert.match(d.text, /Cliente Lia/);
  assert.match(d.text, /Tutti i servizi sono operativi/);
  d = await viaHost('status.cliente.it', '/status.json');
  assert.equal(JSON.parse(d.text).name, 'Cliente Lia');
  d = await viaHost('altro.cliente.it');
  assert.equal(d.status, 302, 'another host: the app, with its login');
  assert.equal((await lia.api('POST', 'statuspages', { slug: 'altra-pag', name: 'Altra', customDomain: 'status.cliente.it', components: [{ name: 'Sito', monitorIds: [m.id] }] })).status, 400, 'a domain is used by one page');
});
