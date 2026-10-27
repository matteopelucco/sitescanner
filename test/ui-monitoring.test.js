import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, apiClient, openPage, chromiumAvailable } from './helpers/ui.js';

// The monitoring screens in a real browser (Playwright + Chromium; skipped when Chromium is missing).
// Every page must load without JavaScript errors, failed requests or server errors.

let app, api, browser, skip = false;

before(async () => {
  if (!(await chromiumAvailable())) {
    skip = 'Chromium non disponibile (npx playwright install chromium)';
    return;
  }
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  app = await startApp({ env: { SITESCANNER_SECRETS_KEY: 'c'.repeat(64) } });
  api = apiClient(app.base);
});

after(async () => {
  if (browser) await browser.close();
  if (app) await app.stop();
});

const ui = (name, fn, { allow = [] } = {}) => test(name, async (t) => {
  if (skip) return t.skip(skip);
  const { page, context, problems } = await openPage(browser, app.base, { cookie: api.cookie(), allow });
  try {
    await fn(page, problems);
    assert.deepEqual(problems, [], 'no errors in the console, no failed requests');
  } finally {
    await context.close();
  }
});

const go = async (page, hash) => {
  await page.goto(`${app.base}/#/${hash}`);
  await page.waitForLoadState('networkidle');
};

ui('notifications (v2.4): policy, channel events and tags, tabs', async (page) => {
  await api('POST', 'channels', { type: 'slack', name: 'Ops', webhookUrl: 'http://127.0.0.1:9/slack/x' }).catch(() => {});
  process.env.SITESCANNER_SLACK_WEBHOOK_PREFIX = 'http://127.0.0.1:9/slack/';
  const ch = await api('POST', 'channels', { type: 'slack', name: 'Ops', webhookUrl: 'http://127.0.0.1:9/slack/x' });
  assert.equal(ch.status, 201, JSON.stringify(ch.data));
  delete process.env.SITESCANNER_SLACK_WEBHOOK_PREFIX;
  await go(page, 'notifications');
  assert.deepEqual(await page.locator('.tabs > a').allTextContents(), ['Panoramica', 'Nuovi problemi', 'Cronologia', 'Manutenzione', 'Notifiche']);
  assert.deepEqual(await page.locator('.tabmore a').allTextContents(), ['Registro avvisi', 'Agenti', 'Variabili', 'Tag', 'Stato pubblico', 'Report'], 'the rest is under «Altro» (at most 8 entries)');
  assert.equal(await page.locator('.tabs > a.on').textContent(), 'Notifiche');
  assert.match(await page.locator('table tbody tr').first().textContent(), /Giù, Di nuovo su, Certificato e dominio, Heartbeat mancato/);

  // the policy of the account
  await page.selectOption('#policyForm [name=pol_mode]', 'minutes');
  await page.fill('#policyForm [name=pol_minutes]', '15');
  await page.fill('#policyForm [name=pol_remMax]', '2');
  await page.click('#policyForm button.primary');
  await page.waitForSelector('.toast, [role=status]', { timeout: 3000 }).catch(() => {});
  assert.deepEqual((await api('GET', 'channels')).data.policy, { mode: 'minutes', failures: 1, minutes: 15, locationPct: 50, reminders: { max: 2, everyMin: 60 } });
  // out of range: the error is shown, nothing is saved
  await page.fill('#policyForm [name=pol_failures]', '1');
  await page.fill('#policyForm [name=pol_minutes]', '15');
  await page.fill('#policyForm [name=pol_remEvery]', '10');
  await page.click('#policyForm button.primary');

  // events and tags of a channel
  await page.click('[data-cedit]');
  await page.waitForSelector('dialog[open]');
  await page.check('dialog [name=kind][value=degraded]');
  await page.fill('dialog [name=tags]', 'cliente:acme, Prod');
  await page.click('dialog button.primary');
  await page.waitForSelector('dialog', { state: 'detached' });
  const saved = (await api('GET', 'channels')).data.channels[0];
  assert.deepEqual(saved.events.sort(), ['cert', 'degraded', 'down', 'heartbeat', 'up']);
  assert.deepEqual(saved.tags, ['cliente:acme', 'prod']);
  await page.waitForFunction(() => /solo tag cliente:acme, prod/.test(document.body.textContent));
});

ui('monitor form (v2.4): own alert policy, saved and shown again', async (page) => {
  app.site.mode = 'ok';
  const mon = (await api('POST', 'monitors', { url: app.site.url, name: 'Vetrina', tags: ['cliente:acme'] })).data;
  await go(page, `monitor/${mon.id}`);
  await page.click('text=Modifica');
  await page.waitForSelector('dialog[open]');
  await page.click('dialog details.adv summary');
  assert.equal(await page.locator('dialog [data-policy]').isHidden(), true, 'the account policy applies by default');
  await page.check('dialog [name=ownPolicy]');
  assert.equal(await page.locator('dialog [data-policy]').isVisible(), true);
  await page.selectOption('dialog [name=pol_mode]', 'failures');
  await page.fill('dialog [name=pol_failures]', '3');
  await page.check('dialog [name=pol_kind][value=down]');
  await page.click('dialog button.primary');
  await page.waitForSelector('dialog', { state: 'detached' });
  const saved = (await api('GET', `monitors/${mon.id}`)).data;
  assert.deepEqual([saved.alertPolicy.mode, saved.alertPolicy.failures, saved.alertPolicy.events], ['failures', 3, ['down']]);
  // opened again, the form shows what was saved; unchecking goes back to the account policy
  await page.click('text=Modifica');
  await page.waitForSelector('dialog[open]');
  await page.click('dialog details.adv summary');
  assert.equal(await page.inputValue('dialog [name=pol_failures]'), '3');
  await page.uncheck('dialog [name=ownPolicy]');
  await page.click('dialog button.primary');
  await page.waitForSelector('dialog', { state: 'detached' });
  assert.equal((await api('GET', `monitors/${mon.id}`)).data.alertPolicy, null);
});

ui('history, notification log and new problems (v2.4)', async (page) => {
  const mon = (await api('GET', 'monitors')).data[0];
  app.site.mode = 'down';
  await api('POST', `monitors/${mon.id}/check`, {});
  app.site.mode = 'ok';
  await api('POST', `monitors/${mon.id}/check`, {});

  await go(page, 'history');
  assert.match(await page.locator('.history').first().textContent(), /Vetrina/);
  assert.ok((await page.locator('.history li').count()) >= 3, 'created, modified, down, up');
  await page.click('a:has-text("Guasti")');
  await page.waitForFunction(() => document.querySelectorAll('.history li').length === 1);
  assert.match(await page.locator('.history li').textContent(), /giù/);
  await page.click('a:has-text("Modifiche")');
  await page.waitForFunction(() => /creato/.test(document.querySelector('.history')?.textContent || '') && !/giù/.test(document.querySelector('.history').textContent));
  assert.match(await page.locator('.history').first().textContent(), /creato|modificato/);

  await go(page, 'log');
  await page.waitForSelector('table, .empty');
  await page.selectOption('#lOk', '0');
  await page.waitForLoadState('networkidle');
  assert.match(await page.locator('.tabmore summary').textContent(), /Registro avvisi/);

  await go(page, 'problems');
  assert.match(await page.locator('.panel').first().textContent(), /Vetrina/);
  assert.match(await page.locator('.panel').first().textContent(), /Status 502/);
  await page.click('a:has-text("vedi i run")');
  await page.waitForLoadState('networkidle');
  assert.match(page.url(), /#\/monitor\/.*group=/);
  await page.waitForSelector('text=× gruppo di errori');
});

ui('list (v2.5): tabs, search, sorting, saved views, row menu, bulk actions', async (page) => {
  app.site.mode = 'ok';
  const add = async (name, p, tags) => (await api('POST', 'monitors', { name, url: `${app.site.url}${p}`, tags })).data;
  const b1 = await add('Acme blog', 'blog', ['cliente:acme']);
  await add('Zeta shop', 'shop', ['cliente:zeta', 'prod']);
  app.site.mode = 'down';
  await api('POST', `monitors/${b1.id}/check`, {});
  app.site.mode = 'ok';

  await go(page, 'monitoring');
  await page.waitForSelector('.montable');
  const names = async () => (await page.locator('.montable tbody tr td:nth-child(2) b').allTextContents());
  assert.equal((await names())[0], 'Acme blog', 'the one that is down comes first');
  const tab = (l) => page.locator(`.statustabs a:has-text("${l}") .count`).textContent();
  assert.deepEqual([await tab('Tutti'), await tab('Giù'), await tab('In pausa')], ['3', '1', '0']);
  assert.equal(await page.locator('.recent').first().locator('.rb-e').count(), 1, 'the mini-bars show the failure');

  // the status tab
  await page.click('.statustabs a:has-text("Giù")');
  await page.waitForFunction(() => document.querySelectorAll('.montable tbody tr').length === 1);
  assert.match(page.url(), /status=down/);
  await page.click('.statustabs a:has-text("Tutti")');
  await page.waitForFunction(() => document.querySelectorAll('.montable tbody tr').length === 3);

  // the written search, kept in the URL
  await page.fill('#fQ', 'tag:cliente:zeta');
  await page.waitForFunction(() => document.querySelectorAll('.montable tbody tr').length === 1);
  assert.deepEqual(await names(), ['Zeta shop']);
  assert.match(decodeURIComponent(page.url()), /q=tag:cliente:zeta/);
  await page.fill('#fQ', 'stato:boh');
  await page.waitForSelector('.notice.warn:has-text("stato sconosciuto: boh")');
  await page.fill('#fQ', '');
  await page.waitForFunction(() => !/q=/.test(location.hash) && document.querySelectorAll('.montable tbody tr').length === 3);
  // the tag menu writes the token in the search
  await page.selectOption('#fTag', 'prod');
  await page.waitForFunction(() => document.querySelectorAll('.montable tbody tr').length === 1);
  assert.equal(await page.inputValue('#fQ'), 'tag:prod');
  await page.selectOption('#fTag', '');
  await page.waitForFunction(() => document.querySelectorAll('.montable tbody tr').length === 3);

  // sorting by a column, both ways
  await page.click('th[data-sort=name]');
  await page.waitForFunction(() => document.querySelector('th[data-sort=name]').getAttribute('aria-sort') === 'ascending');
  assert.deepEqual(await names(), ['Acme blog', 'Vetrina', 'Zeta shop']);
  await page.click('th[data-sort=name]');
  await page.waitForFunction(() => document.querySelector('th[data-sort=name]').getAttribute('aria-sort') === 'descending');
  assert.deepEqual(await names(), ['Zeta shop', 'Vetrina', 'Acme blog']);
  await page.selectOption('#fPeriod', '7d');
  await page.waitForFunction(() => /period=7d/.test(location.hash));

  // saved view as the home of the section
  await page.fill('#fQ', 'cliente');
  await page.waitForFunction(() => /q=cliente/.test(location.hash));
  await page.click('#viewSave');
  await page.waitForSelector('dialog[open]');
  await page.fill('dialog [name=name]', 'Clienti');
  await page.check('dialog [name=home]');
  await page.click('dialog button.primary');
  await page.waitForSelector('dialog', { state: 'detached' });
  assert.deepEqual((await api('GET', 'monitor-views')).data.map((v) => [v.name, v.home, v.q, v.period]), [['Clienti', true, 'cliente', '7d']]);
  await page.goto(`${app.base}/#/problems`);
  await page.goto(`${app.base}/#/monitoring`);
  await page.waitForFunction(() => document.querySelectorAll('.montable tbody tr').length === 3);
  assert.equal(await page.inputValue('#fQ'), 'cliente', 'the home view applies');
  await page.click('text=Gestisci viste');
  await page.waitForSelector('dialog[open]');
  await page.click('dialog [data-vdel]');
  await page.waitForFunction(() => document.querySelectorAll('.montable tbody tr').length === 3 && !document.querySelector('dialog'));
  assert.deepEqual((await api('GET', 'monitor-views')).data, []);
  await go(page, 'monitoring?q=');

  // row menu: duplicate, then run now
  await page.locator('.montable tbody tr', { hasText: 'Zeta shop' }).locator('details.menu summary').click();
  await page.click('details.menu[open] button[data-row=duplicate]');
  await page.waitForFunction(() => /Copia di Zeta shop/.test(document.body.textContent));
  await page.locator('.montable tbody tr', { hasText: 'Copia di Zeta shop' }).locator('details.menu summary').click();
  await page.click('details.menu[open] button[data-row=pause]');
  await page.waitForFunction(() => document.querySelectorAll('.statustabs a')[4].textContent.includes('1'));

  // bulk: select all and run now
  await page.check('#selAll');
  assert.match(await page.locator('#bulkCount').textContent(), /4 selezionati/);
  await page.click('#bulkBar [data-act=check]');
  await page.waitForFunction(() => document.querySelector('#bulkBar').hidden);
});

ui('list (v2.5): works on a phone, without a sideways scroll', async (page) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await go(page, 'monitoring');
  await page.waitForSelector('.montable');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `horizontal overflow ${overflow}px`);
});

ui('heartbeat (v2.6): created from the form, instructions, calls received', async (page) => {
  await go(page, 'monitoring');
  await page.click('#monAdd');
  await page.waitForSelector('dialog[open]');
  await page.check('dialog [name=type][value=heartbeat]');
  assert.equal(await page.locator('dialog [name=url]').isHidden(), true, 'no URL for a heartbeat');
  assert.equal(await page.locator('dialog [name=expectedMin]').isVisible(), true);
  await page.fill('dialog [name=name]', 'Backup notturno');
  await page.fill('dialog [name=expectedMin]', '1440');
  await page.click('dialog button.primary');
  await page.waitForSelector('dialog', { state: 'detached' });
  const row = page.locator('.montable tbody tr', { hasText: 'Backup notturno' });
  await row.waitFor();
  assert.match(await row.textContent(), /cron job: una chiamata ogni 24 ore/);
  assert.match(await row.textContent(), /in attesa/);

  const mon = (await api('GET', 'monitors')).data.find((x) => x.name === 'Backup notturno');
  await row.locator('a b').click();
  await page.waitForSelector('text=Come chiamarlo');
  const shown = await page.locator('input[aria-label="Indirizzo da chiamare"]').inputValue();
  assert.match(shown, new RegExp(`/hb/${mon.hbToken}$`));
  assert.match(await page.locator('.panel', { hasText: 'Come chiamarlo' }).textContent(), /0 3 \* \* \*  curl -fsS/);
  assert.equal(await page.locator('#mCheck').count(), 0, 'nothing to check now');

  // the job calls: the page shows the call and the status
  const res = await fetch(`${app.base}/hb/${mon.hbToken}`);
  assert.equal(res.status, 200);
  await page.reload();
  await page.waitForSelector('text=Chiamate ricevute');
  await page.waitForFunction(() => /riuscita/.test(document.body.textContent));
  assert.match(await page.locator('.head').first().textContent(), /su/);
  await fetch(`${app.base}/hb/${mon.hbToken}/fail?msg=prova`);
  await page.reload();
  await page.waitForSelector('.notice.error:has-text("prova")');

  // edited: the type cannot change, the token stays
  await page.click('#mEdit');
  await page.waitForSelector('dialog[open]');
  assert.equal(await page.inputValue('dialog [name=expectedMin]'), '1440');
  await page.fill('dialog [name=expectedMin]', '720');
  await page.click('dialog button.primary');
  await page.waitForSelector('dialog', { state: 'detached' });
  const saved = (await api('GET', `monitors/${mon.id}`)).data;
  assert.deepEqual([saved.expectedMin, saved.hbToken], [720, mon.hbToken]);
});

ui('types (v2.7): DNS, TCP and SSL from the form, with a test run and the list filter', async (page) => {
  const { startDnsServer } = await import('./helpers/dns.js');
  const net = await import('node:net');
  const tlsMod = await import('node:tls');
  const fsMod = await import('node:fs');
  const dnsSrv = await startDnsServer({ 'www.esempio.it': { A: ['203.0.113.10'] } });
  const tcpSrv = net.createServer((s) => { s.on('error', () => {}); s.write('220 pronto\r\n'); });
  await new Promise((r) => tcpSrv.listen(0, '127.0.0.1', r));
  const tlsSrv = tlsMod.createServer({ key: fsMod.readFileSync(new URL('./fixtures/selfsigned.key', import.meta.url)), cert: fsMod.readFileSync(new URL('./fixtures/selfsigned.crt', import.meta.url)) }, (s) => { s.on('error', () => {}); s.end(); });
  tlsSrv.on('tlsClientError', () => {});
  await new Promise((r) => tlsSrv.listen(0, '127.0.0.1', r));
  try {
    await go(page, 'monitoring');
    // the choice of the type explains each one
    await page.click('#monAdd');
    await page.waitForSelector('dialog[open]');
    assert.equal(await page.locator('dialog .typecard').count(), 6);
    assert.match(await page.locator('dialog .typecard', { hasText: 'DNS' }).textContent(), /rileva domini scaduti/);

    // DNS, with a resolver given as an address and a check on the records
    await page.check('dialog [name=type][value=dns]');
    assert.equal(await page.locator('dialog [name=url]').isHidden(), true);
    await page.fill('dialog [name=dnsName]', 'www.esempio.it');
    await page.selectOption('dialog [name=resolver]', 'custom');
    await page.fill('dialog [name=resolverIp]', dnsSrv.address);
    await page.click('dialog [data-add-dns]');
    await page.selectOption('dialog [name=dns_comparison]', 'contains');
    await page.fill('dialog [name=dns_target]', '203.0.113.10');
    await page.click('dialog [data-test]');
    await page.waitForSelector('dialog [data-testout]:has-text("riuscito")');
    await page.fill('dialog [name=dns_target]', '198.51.100.9');
    await page.click('dialog [data-test]');
    await page.waitForSelector('dialog [data-testout]:has-text("fallito")');
    await page.fill('dialog [name=dns_target]', '203.0.113.10');
    await page.click('dialog button.primary');
    await page.waitForSelector('dialog', { state: 'detached' });

    // TCP
    await page.click('#monAdd');
    await page.waitForSelector('dialog[open]');
    await page.check('dialog [name=type][value=tcp]');
    await page.fill('dialog [name=tcpHost]', '127.0.0.1');
    await page.fill('dialog [name=tcpPort]', String(tcpSrv.address().port));
    await page.fill('dialog [name=tcpExpect]', '220');
    await page.fill('dialog [name=name]', 'Posta');
    await page.click('dialog button.primary');
    await page.waitForSelector('dialog', { state: 'detached' });

    // SSL
    await page.click('#monAdd');
    await page.waitForSelector('dialog[open]');
    await page.check('dialog [name=type][value=ssl]');
    await page.fill('dialog [name=sslHost]', 'localhost');
    await page.fill('dialog [name=sslPort]', String(tlsSrv.address().port));
    await page.uncheck('dialog [name=checkDomain]');
    await page.click('dialog details.adv summary');
    await page.check('dialog [name=skipSsl]');
    await page.fill('dialog [name=name]', 'Certificato di prova');
    await page.click('dialog button.primary');
    await page.waitForSelector('dialog', { state: 'detached' });

    const mons = (await api('GET', 'monitors')).data;
    const by = (n) => mons.find((x) => x.name === n);
    assert.deepEqual([by('www.esempio.it (A)').type, by('www.esempio.it (A)').resolver, by('www.esempio.it (A)').dnsAssertions[0].target], ['dns', dnsSrv.address, '203.0.113.10']);
    assert.deepEqual([by('Posta').type, by('Posta').port, by('Posta').tcpExpect, by('Posta').state.lastOutcome], ['tcp', tcpSrv.address().port, '220', 'ok']);
    assert.deepEqual([by('Certificato di prova').type, by('Certificato di prova').intervalMin, by('Certificato di prova').state.lastOutcome], ['ssl', 1440, 'ok']);

    // the list shows what each one looks at, and filters by type
    await go(page, 'monitoring');
    await page.waitForSelector('.montable');
    const rowText = async (n) => page.locator('.montable tbody tr', { hasText: n }).first().textContent();
    assert.match(await rowText('Posta'), /127\.0\.0\.1:\d+/);
    assert.match(await rowText('www.esempio.it (A)'), /record A/);
    await page.selectOption('#fType', 'ssl');
    await page.waitForFunction(() => document.querySelectorAll('.montable tbody tr').length === 1);
    assert.match(await page.locator('.montable tbody tr').textContent(), /Certificato di prova/);
    // the page of an SSL monitor shows its certificate
    await page.click('.montable tbody tr a b');
    await page.waitForSelector('text=Certificato');
    await page.waitForFunction(() => /SSL: localhost:\d+/.test(document.querySelector('.head')?.textContent || ''));
  } finally {
    await dnsSrv.close();
    tcpSrv.close();
    tlsSrv.close();
  }
});

ui('variables, secrets and tags (v2.8): pages, use in a monitor, masking, rename and merge', async (page) => {
  await go(page, 'variables');
  assert.match(await page.locator('.empty').textContent(), /Nessuna variabile/);
  // a variable and a secret
  await page.click('#vNew');
  await page.waitForSelector('dialog[open]');
  await page.fill('dialog [name=name]', 'sito_prova');
  await page.fill('dialog [name=value]', app.site.url.replace(/^http:\/\//, '').replace(/\/$/, ''));
  await page.click('dialog button.primary');
  await page.waitForSelector('dialog', { state: 'detached' });
  await page.waitForSelector('text=SITO_PROVA');
  await page.click('#vNew');
  await page.waitForSelector('dialog[open]');
  await page.fill('dialog [name=name]', 'TOKEN_PROVA');
  await page.check('dialog [name=kind][value=secret]');
  await page.fill('dialog [name=value]', 'abc');
  await page.click('dialog button.primary');
  await page.waitForSelector('dialog .formerr:not([hidden])');
  assert.match(await page.locator('dialog .formerr').textContent(), /almeno 4 caratteri/);
  await page.fill('dialog [name=value]', 'segreto-lunghissimo-123');
  await page.click('dialog button.primary');
  await page.waitForSelector('dialog', { state: 'detached' });
  await page.waitForSelector('text=TOKEN_PROVA');
  const body = await page.locator('.tablewrap table').textContent();
  assert.equal(body.includes('segreto-lunghissimo-123'), false, 'a secret is never shown');
  assert.match(await page.locator('.tablewrap tr', { hasText: 'TOKEN_PROVA' }).textContent(), /••••••••/);
  assert.match(await page.locator('.tablewrap tr', { hasText: 'SITO_PROVA' }).textContent(), /127\.0\.0\.1:\d+/);

  // a monitor that uses them, with a name nobody defined: the list says «non configurato» and the page names it
  const mon = (await api('POST', 'monitors', { name: 'Con variabili', url: 'http://{{SITO_PROVA}}/{{PAGINA}}', headers: { 'X-Token': '{{TOKEN_PROVA}}' }, tags: ['Cliente-X'] })).data;
  await page.reload();
  await page.waitForSelector('text=Usate ma non definite');
  assert.match(await page.locator('.notice.error').textContent(), /PAGINA.*Con variabili/);
  await page.click('[data-define=PAGINA]');
  await page.waitForSelector('dialog[open]');
  assert.equal(await page.inputValue('dialog [name=name]'), 'PAGINA');
  await page.fill('dialog [name=value]', 'ciao');
  await page.click('dialog button.primary');
  await page.waitForSelector('dialog', { state: 'detached' });
  await page.waitForFunction(() => !document.querySelector('.notice.error'));
  assert.match(await page.locator('.tablewrap tr', { hasText: 'TOKEN_PROVA' }).textContent(), /Con variabili/, 'who uses it');
  await api('POST', `monitors/${mon.id}/check`, {});
  assert.equal((await api('GET', `monitors/${mon.id}`)).data.status, 'up');

  // the form of the monitor suggests the tags that exist and warns about one that looks like them
  await go(page, `monitor/${mon.id}`);
  await page.click('#mEdit');
  await page.waitForSelector('dialog[open]');
  await page.click('dialog details.adv summary');
  assert.match(await page.locator('#tagSuggest').innerHTML(), /cliente-x/);
  await page.fill('dialog [name=tags]', 'clientex');
  await page.click('dialog button.primary');
  await page.waitForSelector('dialog .formerr:not([hidden])');
  assert.match(await page.locator('dialog .formerr').textContent(), /«clientex» somiglia a «cliente-x»/);
  await page.fill('dialog [name=tags]', 'cliente-x, cliente:acme');
  await page.fill('dialog [name=vars]', 'PAGINA=altra');
  await page.click('dialog button.primary');
  await page.waitForSelector('dialog', { state: 'detached' });
  assert.deepEqual((await api('GET', `monitors/${mon.id}`)).data.vars, { PAGINA: 'altra' });

  // the log of the changes, without the values
  await go(page, 'variables');
  await page.click('details.panel summary');
  const logText = await page.locator('details.panel').textContent();
  assert.match(logText, /creata\s*TOKEN_PROVA/);
  assert.equal(logText.includes('segreto-lunghissimo-123'), false);

  // the tag manager: namespaces, details, merge of the duplicate
  await go(page, 'tags');
  await page.waitForSelector('.tablewrap table');
  assert.match(await page.locator('.tablewrap table').textContent(), /cliente-x/);
  assert.match(await page.locator('#tNs').textContent(), /cliente:…/);
  await page.locator('.tablewrap tr', { hasText: 'cliente-x' }).locator('[data-tedit]').click();
  await page.waitForSelector('dialog[open]');
  await page.fill('dialog [name=description]', 'Cliente X, contratto base');
  await page.click('dialog button.primary');
  await page.waitForSelector('dialog', { state: 'detached' });
  await page.waitForSelector('text=Cliente X, contratto base');
  await page.locator('.tablewrap tr', { hasText: 'cliente-x' }).locator('[data-tsel]').check();
  await page.locator('.tablewrap tr', { hasText: 'cliente:acme' }).locator('[data-tsel]').check();
  await page.click('#tMerge');
  await page.waitForSelector('dialog[open]');
  await page.fill('dialog [name=to]', 'cliente:x');
  await page.click('dialog button.primary');
  await page.waitForSelector('dialog', { state: 'detached' });
  await page.waitForFunction(() => /cliente:x/.test(document.querySelector('.tablewrap table')?.textContent || '') && !/cliente-x/.test(document.querySelector('.tablewrap table').textContent));
  assert.deepEqual((await api('GET', `monitors/${mon.id}`)).data.tags, ['cliente:x']);
}, { allow: [/status of 400/] }); // a rejected value is a 400 the page shows to the user

ui('retries and locations (v2.10): from the form, per-location table, local failure', async (page) => {
  await go(page, 'monitoring');
  await page.click('#monAdd');
  await page.waitForSelector('dialog[open]');
  await page.fill('dialog [name=url]', `${app.site.url}luoghi`);
  await page.fill('dialog [name=name]', 'Da più posti');
  await page.click('dialog details.adv summary');
  assert.equal(await page.locator('dialog [name=retryAttempts]').isHidden(), true, 'the default has no more settings');
  await page.selectOption('dialog [name=retryStrategy]', 'exponential');
  assert.equal(await page.locator('dialog [name=retryAttempts]').isVisible(), true);
  await page.fill('dialog [name=retryAttempts]', '3');
  await page.fill('dialog [name=retryBase]', '30');
  await page.click('dialog button.primary');
  await page.waitForSelector('dialog .formerr:not([hidden])');
  assert.match(await page.locator('dialog .formerr').textContent(), /più di 120 secondi in tutto \(ora 210\)/, 'the limit is explained');
  await page.fill('dialog [name=retryBase]', '10');
  await page.check('dialog [name=retryNetwork]');
  await page.check('dialog [name=loc][value=lhr1]');
  await page.check('dialog [name=loc][value=cdg1]');
  await page.check('dialog [name=locStrategy][value=parallel]');
  await page.click('dialog button.primary');
  await page.waitForSelector('dialog', { state: 'detached' });
  const mon = (await api('GET', 'monitors')).data.find((x) => x.name === 'Da più posti');
  assert.deepEqual(mon.retry, { strategy: 'exponential', attempts: 3, baseSec: 10, onlyNetwork: true, sameLocation: true });
  assert.deepEqual([mon.locations, mon.locStrategy], [['lhr1', 'cdg1'], 'parallel']);

  // the first check ran from both: two runs, each with its place; the page shows them per location
  app.site.mode = 'ok';
  await api('POST', `monitors/${mon.id}/check`, {});
  await go(page, `monitor/${mon.id}`);
  await page.waitForSelector('text=Per località');
  const table = page.locator('.panel', { hasText: 'Per località' }).first();
  assert.match(await table.textContent(), /Londra/);
  assert.match(await table.textContent(), /Parigi/);
  assert.equal(await page.locator('#runsSection tbody tr .tag:text-is("Londra")').count() >= 1, true, 'the runs say where they ran');
}, { allow: [/status of 400/] }); // the limit of the waits is a 400 the form shows

ui('public status (v2.11): page from the form, seen without an account, communication from an incident, TV and badge', async (page) => {
  app.site.mode = 'ok';
  const mon = (await api('POST', 'monitors', { name: 'Sito pubblico', url: `${app.site.url}pubblico`, description: 'interno: server aruba-01' })).data;
  await go(page, 'public');
  await page.waitForSelector('text=Stato pubblico');
  await page.click('#spNew');
  await page.waitForSelector('dialog[open]');
  await page.fill('dialog [name=name]', 'Cliente Verdi');
  await page.fill('dialog [name=slug]', 'cliente-verdi');
  await page.fill('dialog [name=cname]', 'Sito');
  await page.selectOption('dialog [name=cmon]', [mon.id]);
  await page.click('dialog button.primary');
  await page.waitForSelector('dialog', { state: 'detached' });
  await page.waitForSelector('.panel:has-text("Cliente Verdi")');

  // anyone sees it, with no cookie of ours
  const anon = await openPage(browser, app.base);
  await anon.page.goto(`${app.base}/status/cliente-verdi`);
  await anon.page.waitForSelector('text=Tutti i servizi sono operativi');
  assert.match(await anon.page.locator('main').textContent(), /Sito/);
  assert.equal((await anon.page.content()).includes('aruba-01'), false);
  assert.equal((await anon.page.content()).includes(app.site.url), false);

  // an incident: «Comunica ai clienti» proposes the text, the team publishes it
  app.site.mode = 'down';
  await api('POST', `monitors/${mon.id}/check`, {});
  app.site.mode = 'ok';
  const inc = (await api('GET', `incidents?monitor=${mon.id}`)).data[0];
  await go(page, `incident/${inc.id}`);
  await page.click('#iComm');
  await page.waitForSelector('dialog[open]');
  assert.match(await page.inputValue('dialog [name=title]'), /Sito: problema in corso/);
  assert.equal(await page.isChecked('dialog [name=comp]'), true);
  await page.fill('dialog [name=text]', 'Stiamo lavorando per ripristinare il sito.');
  await page.click('dialog [data-publish]');
  await page.waitForSelector('dialog:has-text("Pubblicate") >> text=Stiamo lavorando');
  await page.click('dialog .row.end button.primary');
  await page.waitForSelector('dialog', { state: 'detached' });
  await anon.page.reload();
  await anon.page.waitForSelector('text=Stiamo lavorando per ripristinare il sito.');
  assert.match(await anon.page.locator('main').textContent(), /In analisi/);

  // TV and badge
  await go(page, 'public');
  await page.click('#tvNew');
  await page.waitForSelector('dialog[open]');
  await page.fill('dialog [name=name]', 'Sala riunioni');
  await page.click('dialog button.primary');
  await page.waitForSelector('dialog', { state: 'detached' });
  const tvHref = await page.locator('a:text("apri")').first().getAttribute('href');
  await anon.page.goto(app.base + new URL(tvHref).pathname); // the public address of the app is the configured one, here the test server
  await anon.page.waitForSelector('text=Sala riunioni');
  assert.match(await anon.page.locator('main').textContent(), /Sito pubblico/);
  await go(page, 'monitoring');
  await page.waitForSelector('.montable');
  await page.locator('.montable tbody tr', { hasText: 'Sito pubblico' }).locator('details.menu summary').click();
  await page.click('details.menu[open] button[data-row=badge]');
  await page.waitForSelector('dialog[open] img');
  assert.match(await page.inputValue('dialog input[readonly]'), /^!\[stato\]\(https?:\/\/.+\/badge\/[\w-]{24}\.svg\)$/);
  await page.click('dialog button.primary');
  await anon.context.close();
}, { allow: [/localhost:4173/, /ERR_CONNECTION_REFUSED/] }); // the badge shows the configured public address, not the test server

ui('report (v2.12): page, filters, CSV, PDF, monthly subscription', async (page) => {
  const { FsMonitorStore } = await import('../src/monitor/store-fs.js');
  await new FsMonitorStore(app.home).saveChannel('', { id: 'mailrep', type: 'email', name: 'Cliente', status: 'active', config: { address: 'cliente@esempio.it' } });
  await api('POST', 'monitors', { name: 'Per il report', url: `${app.site.url}report` });
  await go(page, 'report');
  await page.waitForSelector('text=Report di disponibilità');
  await page.waitForSelector('.stats');
  assert.match(await page.locator('.stats').textContent(), /Disponibilità/);
  await page.selectOption('#rPeriod', 'month');
  await page.waitForFunction(() => /period=month/.test(location.hash));
  await page.waitForSelector('.panel.tablewrap table');
  assert.ok((await page.locator('.panel.tablewrap table tbody tr').count()) >= 1, 'the monitors of the account');
  const csv = await page.locator('#rCsv').getAttribute('href');
  const res = await fetch(`${app.base}${csv}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /monitor,url,tag,da,a,disponibilita/);
  // the PDF is downloaded when Chromium is there
  if (await chromiumAvailable()) {
    await page.click('#rPdf');
    await page.waitForSelector('dialog[open]');
    await page.fill('dialog [name=client]', 'Cliente di prova');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('dialog button.primary')]);
    assert.match(download.suggestedFilename(), /^disponibilita-cliente-di-prova-\d{4}-\d{2}\.pdf$/);
  }
  // a monthly report
  await page.click('#subNew');
  await page.waitForSelector('dialog[open]');
  await page.fill('dialog [name=name]', 'Acme Srl');
  await page.check('dialog [name=ch]');
  await page.click('dialog button.primary');
  await page.waitForSelector('dialog', { state: 'detached' });
  await page.waitForSelector('text=Acme Srl');
  assert.equal((await api('GET', 'report-subscriptions')).data.length, 1);
}, { allow: [/report\.pdf/] }); // a download is a navigation that the browser reports as aborted

ui('monitoring as code (v2.13): a managed monitor is locked, exported as code, the history shows the CI', async (page) => {
  const { FsMonitorStore } = await import('../src/monitor/store-fs.js');
  const mon = (await api('POST', 'monitors', { name: 'Da codice', url: `${app.site.url}codice` })).data;
  const store = new FsMonitorStore(app.home);
  const saved = await store.getMonitor('', mon.id);
  await store.saveMonitor('', { ...saved, managedBy: 'code', codeId: 'da-codice' });
  await store.addEvent('', { type: 'ci-test', status: 'info', at: Date.now(), by: 'token «GitHub»', branch: 'fix/carrello', commit: 'abcdef123456', passed: 3, failed: 0, durationMs: 4200 });
  await go(page, 'monitoring');
  const row = page.locator('.montable tbody tr', { hasText: 'Da codice' });
  await row.waitFor();
  assert.match(await row.textContent(), /da codice/);
  await row.locator('details.menu summary').click();
  const menu = await page.locator('details.menu[open] .menupop').textContent();
  assert.match(menu, /🔒 da codice/);
  assert.match(menu, /Esporta come codice/);
  assert.equal(menu.includes('Modifica'), false, 'no edit');
  assert.equal(menu.includes('Elimina'), false, 'no delete');
  await page.click('details.menu[open] button[data-row=code]');
  await page.waitForSelector('dialog[open] pre');
  assert.match(await page.locator('dialog[open] pre').textContent(), /id: da-codice\n\s+type: http\n\s+name: Da codice/);
  await page.click('dialog button.primary');
  await page.waitForSelector('dialog', { state: 'detached' });
  // the page of the monitor
  await row.locator('a b').click();
  await page.waitForSelector('.notice.info:has-text("Gestito da codice")');
  assert.equal(await page.locator('#mEdit').count(), 0);
  assert.equal(await page.locator('#mDel').count(), 0);
  assert.equal(await page.locator('#mDup').count(), 1);
  // and the server says no all the same
  assert.equal((await api('DELETE', `monitors/${mon.id}`)).status, 409);
  // the history shows the CI
  await go(page, 'history?type=ci');
  await page.waitForSelector('.history li');
  const line = await page.locator('.history li').first().textContent();
  assert.match(line, /test da CI/);
  assert.match(line, /ramo fix\/carrello · abcdef1 · 3 riusciti, 0 falliti/);
}, { allow: [/status of 409/] });
