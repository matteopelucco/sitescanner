import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { runInventory } from '../src/inventory.js';
import { buildSitemap } from '../src/core/sitemap.js';
import { parseSite } from '../src/config.js';

// Sibling hosts (spec §14.2.2): a main site on localhost and two sibling hosts (kid.localhost, jobs.localhost)
// on other ports. *.localhost resolves to the loopback address, and the port does not tell sites apart.
const page = (title, body = '') => `<!doctype html><html lang="it"><head><title>${title}</title></head><body><header><a href="/">Home</a></header><main><h1>${title}</h1>${body}</main></body></html>`;

let main, kid, jobs, cdn, home, seen;
const listen = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler);
  s.listen(0, '127.0.0.1', () => resolve(s));
});
const port = (s) => s.address().port;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-sib-'));
  process.env.SITESCANNER_HOME = home;
  seen = { kid: [], jobs: [], cdn: [] };
  const html = (res, body) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  kid = await listen((req, res) => {
    seen.kid.push({ url: req.url, auth: req.headers.authorization, custom: req.headers['x-env'] });
    if (req.url === '/robots.txt') return res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow: /private');
    if (req.url === '/') return html(res, page('Kid', `<a href="/deeper">Più giù</a> <a href="http://localhost:${port(main)}/a">Torna</a> <a href="/private/x">Privato</a>`));
    if (req.url === '/landing') return html(res, page('Landing', '<a href="/never">mai</a>'));
    if (req.url === '/deeper' || req.url === '/never') return html(res, page('Deeper'));
    res.writeHead(404, { 'content-type': 'text/plain' }).end('no');
  });
  jobs = await listen((req, res) => {
    seen.jobs.push({ url: req.url });
    html(res, page(`Jobs ${req.url}`));
  });
  cdn = await listen((req, res) => {
    seen.cdn.push({ url: req.url });
    html(res, page('Cdn'));
  });
  main = await listen((req, res) => {
    const u = new URL(req.url, 'http://x').pathname;
    if (u === '/go') return res.writeHead(301, { location: `http://kid.localhost:${port(kid)}/landing` }).end();
    const jobsLinks = [1, 2, 3, 4, 5].map((n) => `<a href="http://jobs.localhost:${port(jobs)}/j${n}">j${n}</a>`).join(' ');
    if (u === '/') return html(res, page('Home', `<a href="/a">A</a> <a href="/go">Vai</a> <a href="http://kid.localhost:${port(kid)}/">Kid</a> ${jobsLinks} <a href="http://cdn.localhost:${port(cdn)}/">cdn</a> <a href="http://estraneo.example/x">fuori</a>`));
    if (u === '/a') return html(res, page('A'));
    res.writeHead(404, { 'content-type': 'text/plain' }).end('no');
  });
});

after(async () => {
  for (const s of [main, kid, jobs, cdn]) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const run = (map = {}, extra = {}) => runInventory({ url: `http://localhost:${port(main)}/`, map, ...extra });
const byId = (inv, host, key) => inv.pages.find((p) => (p.host || '') === host && p.key === key);

test('sibling hosts: boundary pages are visited one level, their links are recorded but not followed', async () => {
  seen.kid.length = seen.jobs.length = seen.cdn.length = 0;
  const inv = await run({ siblingExclude: [`cdn.localhost:${port(cdn)}`] });
  const kidHost = `kid.localhost:${port(kid)}`;
  assert.ok(byId(inv, kidHost, '/'), 'kid home is a boundary page');
  assert.ok(byId(inv, kidHost, '/landing'), 'the redirect destination too');
  assert.equal(byId(inv, kidHost, '/').boundary, true);
  assert.equal(byId(inv, kidHost, '/deeper'), undefined, 'links of a boundary page are not followed');
  assert.equal(byId(inv, kidHost, '/never'), undefined);
  assert.ok(byId(inv, kidHost, '/').contentLinks.includes(`${kidHost}/deeper`));
  assert.ok(byId(inv, kidHost, '/').contentLinks.includes('/a'), 'a link back to the main host is an edge');
  assert.equal(seen.cdn.length, 0, 'excluded host is never requested');
  const main = inv.pages.filter((p) => !p.boundary);
  assert.deepEqual(main.map((p) => p.key).sort(), ['/', '/a', '/go']);
  assert.equal(inv.summary.htmlPages, 2, 'the numbers of the site do not include the sibling pages');
  assert.equal(inv.summary.map.siblings.hosts.length, 2);
  assert.ok(inv.pages.find((p) => !p.boundary && p.key === '/').contentLinks.includes(`${kidHost}/`), 'edge from the main page to the sibling');
  assert.equal(inv.pages.find((p) => p.key === '/go').redirectKind, 'sibling');
});

test('sibling hosts: no credentials of the environment, robots.txt of the sibling, limits', async () => {
  seen.kid.length = seen.jobs.length = 0;
  const inv = await run({ siblingHosts: [`kid.localhost:${port(kid)}`] });
  assert.ok(seen.kid.length > 0);
  for (const r of seen.kid) assert.equal(r.auth, undefined);
  assert.equal(seen.jobs.length, 0, 'jobs is not in siblingHosts');
  const kidHost = `kid.localhost:${port(kid)}`;
  assert.equal(byId(inv, kidHost, '/private/x'), undefined, 'not linked as boundary: the link is a content link only');
  // a limit on boundary pages: the rest is counted as not visited, per host
  const limited = await run({ maxSiblingPages: 2 });
  const boundary = limited.pages.filter((p) => p.boundary);
  assert.equal(boundary.length, 2);
  const skipped = limited.summary.map.siblings.notVisited;
  assert.ok(Object.values(skipped).reduce((a, b) => a + b, 0) >= 4);
});

test('sibling hosts can be switched off', async () => {
  const inv = await run({ siblings: false });
  assert.equal(inv.pages.filter((p) => p.boundary).length, 0);
  assert.equal(inv.summary.map.siblings, undefined);
});

test('the sitemap puts boundary pages under their host', async () => {
  const inv = await run({});
  const m = buildSitemap(inv, {});
  const ids = m.nodes.map((n) => n.id);
  const kidHost = `kid.localhost:${port(kid)}`;
  assert.ok(ids.includes(`${kidHost}/`));
  assert.ok(ids.includes('/'));
  const kidNode = m.nodes.find((n) => n.id === `${kidHost}/`);
  assert.equal(kidNode.host, kidHost);
});

test('map: siblings config is validated', () => {
  const env = 'envs: { p: { baseUrl: "https://a.it/" } }\n';
  for (const bad of ['map: { siblings: "si" }', 'map: { siblingHosts: ["a b"] }', 'map: { maxSiblingPages: -1 }', 'map: { render: always }', 'map: { maxRendered: 1.5 }']) {
    assert.throws(() => parseSite('x', env + bad), /map/, bad);
  }
  assert.equal(parseSite('x', env + 'map: { render: never, siblingExclude: [cdn.a.it] }').map.render, 'never');
});

// Client-side pages (RF-MAP-20..23): a shell is detected, and rendered with the browser when there is one.
const hasBrowser = await (async () => {
  try {
    const { loadPlaywright, launchChromium } = await import('../src/screenshots.js');
    const pw = await loadPlaywright();
    if (!pw) return false;
    const b = await launchChromium(pw);
    await b.close();
    return true;
  } catch {
    return false;
  }
})();

test('SPA shells: detected from the HTML, rendered with the browser when allowed', { skip: hasBrowser ? false : 'Chromium non disponibile' }, async (t) => {
  const { analyzeHtml } = await import('../src/analyze.js');
  const shell = '<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script>1</script></body></html>';
  assert.equal(analyzeHtml(shell, 'http://a.it/').spaShell, true);
  assert.equal(analyzeHtml('<body><div id="root"><h1>Ciao</h1></div></body>', 'http://a.it/').spaShell, false);
  assert.equal(analyzeHtml('<body><script src="/x.js"></script></body>', 'http://a.it/').spaShell, true);
  assert.equal(analyzeHtml('<body><p>Articolo semplice</p></body>', 'http://a.it/').spaShell, false);

  const words = Array.from({ length: 40 }, (_, i) => `parola${i}`).join(' ');
  const spa = await listen((req, res) => {
    const u = new URL(req.url, 'http://x').pathname;
    const send = (b) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(b);
    if (u === '/') return send('<!doctype html><html><head><title>Shell</title></head><body><a href="/app">App</a></body></html>');
    if (u === '/app') {
      return send(`<!doctype html><html><head><title>Shell</title></head><body><div id="root"></div><script>
        setTimeout(function () {
          document.title = 'Rendered app';
          document.getElementById('root').innerHTML = '<nav><a href="/menu">Menu</a></nav><h1>Titolo generato</h1><p>${words}</p><a href="/child">Figlia</a>';
        }, 50);
      </script></body></html>`);
    }
    if (u === '/child' || u === '/menu') return send('<!doctype html><html><head><title>Child</title></head><body><h1>Figlia</h1></body></html>');
    res.writeHead(404).end();
  });
  t.after(async () => {
    spa.closeAllConnections();
    await new Promise((r) => spa.close(r));
  });
  const url = `http://localhost:${port(spa)}/`;

  const rendered = await runInventory({ url, map: { render: 'auto' } });
  const app = rendered.pages.find((p) => p.key === '/app');
  assert.equal(app.spaShell, true);
  assert.equal(app.rendered, true);
  assert.equal(app.title, 'Rendered app');
  assert.equal(app.h1, 'Titolo generato');
  assert.ok(app.wordCount >= 40);
  assert.ok(app.navLinks.includes('/menu'));
  assert.ok(app.contentLinks.includes('/child'));
  assert.ok(rendered.pages.some((p) => p.key === '/child'), 'links found only in the generated DOM are queued (RF-MAP-22)');
  assert.deepEqual(rendered.summary.map.spa, { shells: 1, rendered: 1, errors: 0 });

  const never = await runInventory({ url, map: { render: 'never' } });
  const plain = never.pages.find((p) => p.key === '/app');
  assert.equal(plain.spaShell, true);
  assert.equal(plain.rendered, undefined);
  assert.equal(plain.title, 'Shell');
  assert.equal(never.pages.some((p) => p.key === '/child'), false);

  const capped = await runInventory({ url, map: { render: 'auto', maxRendered: 0 } });
  assert.equal(capped.pages.find((p) => p.key === '/app').rendered, undefined);
});
