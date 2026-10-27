import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage, chromiumAvailable } from './helpers/ui.js';

// Webhook, Teams and Discord channels and recurring maintenance, in a real browser (spec §13.14).

let app, browser, skip = false;

before(async () => {
  if (!(await chromiumAvailable())) {
    skip = 'Chromium non disponibile (npx playwright install chromium)';
    return;
  }
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  app = await startApp({ env: { SITESCANNER_TEAMS_WEBHOOK_PREFIX: 'http://127.0.0.1:9/teams/', SITESCANNER_DISCORD_WEBHOOK_PREFIX: 'http://127.0.0.1:9/discord/' } });
});

after(async () => {
  if (browser) await browser.close();
  if (app) await app.stop();
});

test('notifications: adding Teams, Discord and a webhook (the secret is shown once)', async (t) => {
  if (skip) return t.skip(skip);
  const { page, context, problems } = await openPage(browser, app.base);
  try {
    await page.goto(`${app.base}/#/notifications`);
    await page.waitForSelector('#addTeams');
    await page.fill('#addTeams [name=webhookUrl]', 'http://127.0.0.1:9/teams/abc123');
    await page.click('#addTeams button');
    await page.waitForSelector('text=Microsoft Teams');
    await page.fill('#addDiscord [name=webhookUrl]', 'http://127.0.0.1:9/discord/xyz789');
    await page.click('#addDiscord button');
    await page.waitForSelector('td .small.muted:text-is("Discord")', { timeout: 5000 });
    await page.fill('#addHook [name=url]', 'http://127.0.0.1:9/hook');
    await page.click('#addHook button');
    await page.waitForSelector('dialog[open] #whSecret');
    const secret = (await page.locator('#whSecret').textContent()).trim();
    assert.match(secret, /^whsec_/);
    await page.click('dialog[open] button.primary');
    await page.waitForSelector('dialog', { state: 'detached' });
    const list = await page.locator('main').textContent();
    assert.ok(list.includes('Webhook') && list.includes('Teams') && list.includes('Discord'));
    assert.equal(list.includes(secret), false, 'the secret is not shown again');
    assert.deepEqual(problems.filter((p) => !/status of (400|403|404)/.test(p)), []);
  } finally { await context.close(); }
});

test('maintenance: a window that repeats every two weeks', async (t) => {
  if (skip) return t.skip(skip);
  const { page, context, problems } = await openPage(browser, app.base);
  try {
    await page.request.post(`${app.base}/api/monitors`, { data: { name: 'Sito', url: app.site.url } });
    const mon = (await (await page.request.get(`${app.base}/api/monitoring`)).json()).monitors[0];
    await page.goto(`${app.base}/#/maintenance`);
    await page.click('#wNew');
    await page.waitForSelector('dialog[open]');
    await page.fill('dialog [name=name]', 'Rilascio');
    await page.selectOption('dialog [name=type]', 'repeat');
    const tomorrow = new Date(Date.now() + 86400000);
    const pad = (n) => String(n).padStart(2, '0');
    await page.fill('dialog [name=start]', `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T22:00`);
    await page.fill('dialog [name=every]', '2');
    await page.selectOption('dialog [name=unit]', 'week');
    await page.selectOption('dialog [name=monitorIds]', mon.id);
    await page.click('dialog button.primary');
    await page.waitForSelector('dialog', { state: 'detached' });
    await page.waitForSelector('text=ogni 2 settimane');
    assert.match(await page.locator('main').textContent(), /dal .+, ogni 2 settimane/);
    assert.deepEqual(problems.filter((p) => !/status of (400|403|404)/.test(p)), []);
  } finally { await context.close(); }
});
