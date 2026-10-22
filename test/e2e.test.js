import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFixture } from './fixture-server.js';

const BIN = fileURLToPath(new URL('../bin/sitescanner.js', import.meta.url));
let fixture, home;

// Async on purpose: the fixture server lives in this process and must keep answering.
function run(...args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { cwd: home, env: { ...process.env, NO_COLOR: '1' } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

before(async () => {
  fixture = await startFixture();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-test-'));
  assert.equal((await run('init')).code, 0);
  fs.writeFileSync(path.join(home, 'sites', 'demo.yml'), `name: Demo\nenvs:\n  local:\n    baseUrl: ${fixture.url}\nconcurrency: 2\nscreenshots: { enabled: false }\n`);
  fs.writeFileSync(path.join(home, 'sites', 'broken.yml'), `name: Broken\nenvs:\n  local:\n    baseUrl: http://127.0.0.1:1/\ntimeoutMs: 2000\n`);
});

after(async () => {
  await fixture.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('scan, history, compare, report, export', async () => {
  let r = await run('scan', '--site', 'demo', '--env', 'local', '--label', 'v1', '--note', 'prima release', '-q');
  assert.equal(r.code, 0, r.out);
  fixture.setVersion(2);

  // --all: the unreachable site fails without blocking the other ones
  r = await run('scan', '--all', '--env', 'local', '--label', 'v2', '-q');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /✓ demo/);
  assert.match(r.out, /✗ broken/);
  assert.match(r.out, /1 ok/);

  r = await run('list', '--site', 'demo');
  assert.equal(r.code, 0);
  assert.match(r.out, /v1/);
  assert.match(r.out, /v2/);

  // Snapshot is immutable: scan.json is read-only and the site's private area was respected
  const scansDir = path.join(home, 'data', 'demo', 'scans');
  const ids = fs.readdirSync(scansDir).filter((d) => !d.startsWith('.')).sort();
  assert.equal(ids.length, 2);
  const scan1 = JSON.parse(fs.readFileSync(path.join(scansDir, ids[0], 'scan.json'), 'utf8'));
  assert.equal(fs.statSync(path.join(scansDir, ids[0], 'scan.json')).mode & 0o222, 0);
  const keys = scan1.pages.map((p) => p.key);
  assert.ok(keys.includes('/hidden'), 'sitemap URLs rebased on the scanned env');
  assert.ok(!keys.includes('/private/x'), 'robots.txt Disallow respected');
  assert.equal(scan1.label, 'v1');

  r = await run('compare', '--site', 'demo', '--base', 'v1', '--head', 'v2', '--json', 'out.json', '--fail-on', 'error');
  assert.equal(r.code, 1, r.out);
  const res = JSON.parse(fs.readFileSync(path.join(home, 'out.json'), 'utf8'));
  const has = (type, key, sev) => res.findings.some((f) => f.type === type && f.key === key && (!sev || f.severity === sev));
  assert.ok(has('status-changed', '/products/b', 'error'));
  assert.ok(has('page-removed', '/old-page', 'error'), 'no longer linked in v2');
  assert.ok(has('title-changed', '/about', 'warn'));
  assert.ok(has('robots-changed', '/contact', 'error'));
  assert.ok(has('content-changed', '/products/a'));
  assert.ok(has('issue-new', '/products/a'), 'img alt missing is a new issue');
  assert.ok(has('page-added', '/new-page'));
  assert.equal(res.passed, false);

  // Redirect map pairs old → new URL
  fs.writeFileSync(path.join(home, 'map.csv'), 'from,to\n/old-page,/new-page\n');
  r = await run('compare', '--site', 'demo', '--base', 'latest~1', '--head', 'latest', '--redirect-map', 'map.csv', '--json', 'out2.json');
  assert.equal(r.code, 0, r.out);
  const res2 = JSON.parse(fs.readFileSync(path.join(home, 'out2.json'), 'utf8'));
  assert.ok(res2.findings.some((f) => f.type === 'page-mapped' && f.baseKey === '/old-page' && f.key === '/new-page'));
  assert.ok(!res2.findings.some((f) => f.type === 'page-added' && f.key === '/new-page'));

  // Label edits do not touch the snapshot
  r = await run('label', '--site', 'demo', '--scan', ids[1], '--label', 'release-2', '--note', 'rilascio');
  assert.equal(r.code, 0, r.out);
  assert.match((await run('list', '--site', 'demo')).out, /release-2/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(scansDir, ids[1], 'scan.json'), 'utf8')).label, 'v2');

  r = await run('report');
  assert.equal(r.code, 0, r.out);
  const html = fs.readFileSync(path.join(home, 'report', 'index.html'), 'utf8');
  assert.match(html, /function compareScans/);
  assert.doesNotMatch(html, /^export /m);
  const index = fs.readFileSync(path.join(home, 'report', 'data', 'index.js'), 'utf8');
  assert.match(index, /release-2/);
  assert.ok(fs.existsSync(path.join(home, 'report', 'data', 'demo', `${ids[0]}.js`)));

  r = await run('export', '--site', 'demo', '--base', 'v1', '--head', 'release-2', '--out', 'bundle');
  assert.equal(r.code, 0, r.out);
  const bundleIndex = fs.readFileSync(path.join(home, 'bundle', 'data', 'index.js'), 'utf8');
  assert.match(bundleIndex, /"preselect":\{"site":"demo"/);
  assert.equal(fs.readdirSync(path.join(home, 'bundle', 'data', 'demo')).filter((f) => !f.endsWith('.text.js')).length, 2);
  assert.ok(!bundleIndex.includes('"broken"'));
});

test('usage errors exit with code 2', async () => {
  assert.equal((await run('scan', '--site', 'demo')).code, 2);
  assert.equal((await run('scan', '--site', 'nope', '--env', 'local')).code, 2);
  assert.equal((await run('compare', '--site', 'demo', '--base', 'zzz', '--head', 'latest')).code, 2);
  assert.equal((await run('bogus')).code, 2);
});
