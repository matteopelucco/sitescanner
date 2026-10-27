import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, apiClient, openPage, chromiumAvailable } from './helpers/ui.js';

// Workspaces in a real browser (spec §13.10): the selector, creating and sharing a space, the reader's view, the tokens.

let app, browser, skip = false, admin;

before(async () => {
  if (!(await chromiumAvailable())) {
    skip = 'Chromium non disponibile (npx playwright install chromium)';
    return;
  }
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  app = await startApp({ multi: true });
  admin = apiClient(app.base);
  await admin('POST', 'login', { username: 'admin', password: 'admin-iniziale-123' });
  await admin('PUT', 'me/password', { current: 'admin-iniziale-123', password: 'admin-definitiva-12' });
});

after(async () => {
  if (browser) await browser.close();
  if (app) await app.stop();
});

async function person(name) {
  const c = apiClient(app.base);
  await admin('POST', 'users', { username: name, password: `${name}-temporanea-1` });
  await c('POST', 'login', { username: name, password: `${name}-temporanea-1` });
  await c('PUT', 'me/password', { current: `${name}-temporanea-1`, password: `${name}-definitiva-12` });
  return c;
}

test('workspaces (v2.9): create, invite, switch, the reader sees but does not touch, tokens', async (t) => {
  if (skip) return t.skip(skip);
  const anna = await person('anna'), bruno = await person('bruno');
  const a = await openPage(browser, app.base, { cookie: anna.cookie() });
  const b = await openPage(browser, app.base, { cookie: bruno.cookie() });
  try {
    // anna creates a space from the page and invites bruno as a reader
    await a.page.goto(`${app.base}/#/workspaces`);
    await a.page.waitForSelector('text=Spazi di lavoro');
    assert.match(await a.page.locator('.panel').first().textContent(), /Spazio personale/);
    await a.page.click('#wsNew');
    await a.page.waitForSelector('dialog[open]');
    await a.page.fill('dialog [name=name]', 'Agenzia Rossi');
    await a.page.click('dialog button.primary');
    await a.page.waitForSelector('dialog', { state: 'detached' });
    const panel = a.page.locator('.panel', { hasText: 'Agenzia Rossi' });
    await panel.waitFor();
    await panel.locator('[name=username]').fill('bruno');
    await panel.locator('[name=role]').selectOption('viewer');
    await panel.locator('.inviteform button').click();
    await panel.locator('tr', { hasText: 'bruno' }).waitFor();
    assert.match(await panel.locator('tr', { hasText: 'bruno' }).textContent(), /Lettore|viewer/);
    // an account that does not exist is refused with a clear message
    await panel.locator('[name=username]').fill('nessuno');
    await panel.locator('.inviteform button').click();
    await a.page.waitForSelector('.toast:has-text("Nessun account attivo")');

    // she works in it: the selector now offers it
    await panel.locator('[data-wsopen]').click();
    await a.page.waitForFunction(() => document.querySelector('#wsSel')?.selectedOptions[0]?.textContent === 'Agenzia Rossi');
    assert.equal(await a.page.locator('#account .tag').first().textContent(), 'Proprietario');
    await a.page.goto(`${app.base}/#/monitoring`);
    await a.page.waitForSelector('text=Monitoraggio');
    await a.page.click('#monAdd');
    await a.page.waitForSelector('dialog[open]');
    await a.page.fill('dialog [name=url]', `${app.site.url}team`);
    await a.page.fill('dialog [name=name]', 'Del team');
    await a.page.click('dialog button.primary');
    await a.page.waitForSelector('dialog', { state: 'detached' });
    await a.page.waitForSelector('.montable');

    // bruno switches to it: he is a reader
    await b.page.goto(`${app.base}/#/workspaces`);
    await b.page.waitForSelector('.panel:has-text("Agenzia Rossi")');
    await b.page.locator('.panel', { hasText: 'Agenzia Rossi' }).locator('[data-wsopen]').click();
    await b.page.waitForFunction(() => document.querySelector('#wsSel')?.selectedOptions[0]?.textContent === 'Agenzia Rossi');
    assert.equal(await b.page.locator('#account .tag').first().textContent(), 'Lettore');
    await b.page.goto(`${app.base}/#/monitoring`);
    await b.page.waitForSelector('.montable');
    assert.match(await b.page.locator('.montable').textContent(), /Del team/, 'he sees the monitor');
    assert.equal(await b.page.locator('#monAdd').isHidden(), true, 'and has no button to add');
    assert.equal(await b.page.evaluate(() => document.body.classList.contains('readonly')), true);
    const denied = await b.page.evaluate(async () => { const r = await fetch('/api/monitors', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"url":"https://x.it/"}' }); return [r.status, (await r.json()).error]; });
    assert.deepEqual([denied[0], /sola lettura/.test(denied[1])], [403, true], 'and the server refuses what the page hides');

    // anna makes a token, shown once; it opens /api/v1
    await a.page.goto(`${app.base}/#/workspaces`);
    await a.page.waitForSelector('.panel:has-text("Agenzia Rossi")');
    await a.page.locator('.panel', { hasText: 'Agenzia Rossi' }).locator('[data-tnew]').click();
    await a.page.waitForSelector('dialog[open]');
    await a.page.fill('dialog [name=name]', 'GitHub Actions');
    await a.page.selectOption('dialog [name=scope]', 'write');
    await a.page.click('dialog button.primary');
    await a.page.waitForSelector('dialog[open] :text("sst_")');
    const token = (await a.page.locator('dialog[open] .secret').textContent()).trim();
    await a.page.click('dialog[open] button');
    await a.page.waitForSelector('.panel:has-text("GitHub Actions")');
    assert.equal((await a.page.locator('.panel', { hasText: 'Agenzia Rossi' }).textContent()).includes(token), false, 'never shown again');
    const me = await fetch(`${app.base}/api/v1/me`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
    assert.deepEqual([me.workspace.name, me.scope, me.role], ['Agenzia Rossi', 'write', 'editor']);

    for (const x of [a, b]) assert.deepEqual(x.problems.filter((p) => !/status of (400|403|404)/.test(p)), []);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
