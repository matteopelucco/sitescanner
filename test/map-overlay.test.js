import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, apiClient } from './helpers/ui.js';
import { storageFor } from '../src/storage/index.js';
import { checkRules, normalizeOverlay, importNotes, withAreaRule, withParentRule, inventoryIds, NOTE_LIMITS } from '../src/core/mapoverlay.js';
import { parseSite } from '../src/config.js';

// Rules and notes of the site map (spec §14.5.6, §14.6): the pure part, then the API on a real storage.

test('rules: checked and normalized, with the problem named', () => {
  const ok = checkRules({ areas: [{ name: ' Prestiti ', match: ['/it/prestiti', 're:^/it/mutui/'], color: '#112233' }], parents: [{ match: ['/old'], parent: '/new' }], titleAffix: { 'www.a.ch': ' | A' }, subareaMin: 5, extra: 1 });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.rules.areas[0].name, 'Prestiti');
  assert.equal(ok.rules.extra, undefined);
  const bad = (rules) => checkRules(rules).errors.join(' ');
  assert.match(bad({ areas: [{ name: '', match: ['/a'] }] }), /nome/);
  assert.match(bad({ areas: [{ name: 'A', match: [] }] }), /prefissi/);
  assert.match(bad({ areas: [{ name: 'A', match: ['re:('] }] }), /regolare non valida/);
  assert.match(bad({ areas: [{ name: 'A', match: ['/a'], color: 'rosso' }] }), /esadecimale/);
  assert.match(bad({ parents: [{ match: ['/a'] }] }), /genitore/);
  assert.match(bad({ subareaMin: 0 }), /subareaMin/);
  assert.match(bad({ titleAffix: 3 }), /titleAffix/);
  assert.equal(checkRules({ titleAffix: false }).rules.titleAffix, false);
});

test('notes: limits, plain text kept as it is, empty notes dropped', () => {
  const o = normalizeOverlay({ notes: { general: 'riga 1\nriga 2 <b>x</b>', pages: { '/a': ' ', '/b': 'nota' } } });
  assert.equal(o.notes.general, 'riga 1\nriga 2 <b>x</b>');
  assert.deepEqual(o.notes.pages, { '/b': 'nota' });
  assert.throws(() => normalizeOverlay({ notes: { general: 'x'.repeat(NOTE_LIMITS.general + 1) } }), /20000/);
  assert.throws(() => normalizeOverlay({ notes: { pages: { '/a': 'x'.repeat(NOTE_LIMITS.page + 1) } } }), /2000/);
  assert.throws(() => normalizeOverlay({ rules: { areas: [{ name: 'A', match: [] }] } }), /areas/);
});

test('import: general note and notes of pages that still exist; the others are listed', () => {
  const prev = { notes: { general: 'contesto', pages: { '/a': 'A', '/gone': 'G', '/b': 'vecchia' } } };
  const next = { notes: { general: '', pages: { '/b': 'nuova' } } };
  const r = importNotes(prev, next, ['/', '/a', '/b']);
  assert.equal(r.overlay.notes.general, 'contesto');
  assert.deepEqual(r.overlay.notes.pages, { '/b': 'nuova', '/a': 'A' }, 'what is already there is not overwritten');
  assert.equal(r.copied, 1);
  assert.deepEqual(r.dropped, ['/gone']);
  assert.deepEqual(inventoryIds({ baseUrl: 'https://a.ch/', pages: [{ key: '/' }, { key: '/x', host: 'a.ch' }, { key: '/y', host: 'kid.a.ch' }] }), ['/', '/x', 'kid.a.ch/y']);
});

test('«Sposta in area» and «Imposta genitore» make an exact-path rule that wins over the others', () => {
  let r = withAreaRule({ areas: [{ name: 'Vecchia', match: ['/it/'] }] }, { key: '/it/a.b', name: 'Nuova' });
  assert.equal(r.areas[0].name, 'Nuova');
  const re = new RegExp(r.areas[0].match[0].slice(3));
  assert.ok(re.test('/it/a.b') && !re.test('/it/aXb') && !re.test('/it/a.b/c'));
  r = withAreaRule(r, { key: '/it/a.b', name: 'Altra' });
  assert.equal(r.areas.filter((a) => a.match[0] === r.areas[0].match[0]).length, 1, 'the same page does not pile up rules');
  r = withParentRule({}, { key: '/x', parent: '/y', host: 'kid.a.ch', mainHost: 'a.ch' });
  assert.equal(r.parents[0].host, 'kid.a.ch');
  assert.deepEqual(withParentRule(r, { key: '/x', parent: '', host: 'kid.a.ch', mainHost: 'a.ch' }).parents, []);
});

test('config: rules of the site are validated with the key and the reason', () => {
  const env = 'envs: { p: { baseUrl: "https://a.it/" } }\n';
  assert.deepEqual(parseSite('x', env).map.areas, []);
  assert.equal(parseSite('x', `${env}map: { areas: [{ name: A, match: [/a] }], subareaMin: 4 }`).map.subareaMin, 4);
  assert.throws(() => parseSite('x', `${env}map: { areas: [{ name: A, match: ["re:("] }] }`), /map\.areas\[1\].*regolare/);
  assert.throws(() => parseSite('x', `${env}map: { parents: [{ match: [/a] }] }`), /map\.parents/);
});

let app, api, st;
const page = (key, title, extra = {}) => ({ key, host: 'x.test', html: true, status: 200, title, wordCount: 40, clickDepth: key === '/' ? 0 : 1, urlDepth: key.split('/').filter(Boolean).length, section: '/', inlinks: 1, outlinks: 1, regions: 'landmark', contentLinks: [], navLinks: [], documents: [], ...extra });
function inventory(id, startedAt, site = 'demo') {
  const pages = [page('/', 'Home', { contentLinks: ['/a/', '/b/', '/a/x', '/a/y', '/a/z'] }), page('/a/', 'A'), page('/a/x', 'AX'), page('/a/y', 'AY'), page('/a/z', 'AZ'), page('/b/', 'B')];
  const meta = { schema: 2, id, site, env: 'p', baseUrl: 'https://x.test/', startedAt, finishedAt: startedAt, durationMs: 1, options: { maxPages: 10, maxDepth: 5, map: {} }, crawl: { truncated: false, unvisited: 0, start: ['/'] }, summary: { urls: 6, htmlPages: 6, map: {} } };
  return { ...meta, tree: { name: '/', path: '/', pages: 1, total: 6, children: [] }, pages, documents: [] };
}

before(async () => {
  app = await startApp();
  api = apiClient(app.base);
  st = storageFor();
  await st.writeSiteRaw('demo', '# il mio sito\nname: Demo\nstart: [/]\nenvs:\n  p: { baseUrl: "https://x.test/" } # produzione\n', { create: true });
  for (const [id, at] of [['inv1', '2026-10-01T10:00:00Z'], ['inv2', '2026-10-02T10:00:00Z']]) { const inv = inventory(id, at); await st.saveInventory(inv, inv); }
});
after(async () => { await app.stop(); });

test('API: the map carries the rules in force and the notes', async () => {
  const { status, data } = await api('GET', 'inventories/inv2/map');
  assert.equal(status, 200);
  assert.equal(data.rulesFrom, 'site');
  assert.deepEqual(data.notes, { general: '', pages: {} });
  assert.deepEqual(data.areas.map((a) => a.name).includes('Home'), true);
});

test('API: rules saved with the inventory change the map; invalid ones are refused', async () => {
  const bad = await api('PUT', 'inventories/inv2/overlay', { rules: { areas: [{ name: 'Rotta', match: ['re:('] }] } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /regolare non valida/);
  const prev = await api('POST', 'inventories/inv2/map', { rules: { areas: [{ name: 'Sezione B', match: ['/b/'] }] } });
  assert.ok(prev.data.areas.some((a) => a.name === 'Sezione B'), 'preview, nothing saved');
  assert.equal((await api('GET', 'inventories/inv2/overlay')).data.rules, null);
  const ok = await api('PUT', 'inventories/inv2/overlay', { rules: { areas: [{ name: 'Sezione B', match: ['/b/'] }], parents: [{ match: ['/a/z'], parent: '/b/' }] } });
  assert.equal(ok.status, 200);
  const map = (await api('GET', 'inventories/inv2/map')).data;
  assert.equal(map.rulesFrom, 'inventory');
  assert.equal(map.nodes.find((n) => n.id === '/b/').area, 'Sezione B');
  assert.equal(map.nodes.find((n) => n.id === '/a/z').parent, '/b/');
  assert.equal(map.nodes.find((n) => n.id === '/a/z').parentKind, 'rule');
  assert.equal((await api('GET', 'inventories/inv1/map')).data.rulesFrom, 'site', 'another inventory is not touched');
});

test('API: general note and notes of pages, merged and limited', async () => {
  let r = await api('PUT', 'inventories/inv2/overlay', { general: 'Contesto del sito', pages: { '/a/': 'Hub dei prodotti', '/b/': 'Gate' } });
  assert.equal(r.status, 200);
  r = await api('PUT', 'inventories/inv2/overlay', { pages: { '/b/': '' } });
  const notes = (await api('GET', 'inventories/inv2/map')).data.notes;
  assert.equal(notes.general, 'Contesto del sito');
  assert.deepEqual(notes.pages, { '/a/': 'Hub dei prodotti' }, 'an empty text removes a note');
  assert.equal((await api('GET', 'inventories/inv2/overlay')).data.rules.areas[0].name, 'Sezione B', 'notes do not touch the rules');
  r = await api('PUT', 'inventories/inv2/overlay', { pages: { '/a/': 'x'.repeat(NOTE_LIMITS.page + 1) } });
  assert.equal(r.status, 400);
  assert.equal((await api('GET', 'inventories/nope/overlay')).status, 400);
});

test('API: «use as the site rules» writes the site file keeping its comments, and the inventory follows the site', async () => {
  const r = await api('PUT', 'inventories/inv2/overlay', { toSite: true });
  assert.equal(r.status, 200);
  const raw = await st.readSiteRaw('demo');
  assert.match(raw, /# il mio sito/);
  assert.match(raw, /# produzione/);
  assert.match(raw, /Sezione B/);
  const map = (await api('GET', 'inventories/inv2/map')).data;
  assert.equal(map.rulesFrom, 'site');
  assert.equal(map.nodes.find((n) => n.id === '/b/').area, 'Sezione B', 'the same rules, now from the site');
  // an inventory of a free URL cannot write a site
  const free = inventory('free1', '2026-10-03T10:00:00Z', null);
  await st.saveInventory(free, free);
  assert.equal((await api('PUT', 'inventories/free1/overlay', { toSite: true })).status, 400);
  // from an inventory of a free URL into a configured site
  await api('PUT', 'inventories/free1/overlay', { rules: { areas: [{ name: 'Altra', match: ['/a/'] }] } });
  assert.equal((await api('POST', 'inventories/free1/rules-to-site', { site: 'demo' })).status, 200);
  assert.match(await st.readSiteRaw('demo'), /Altra/);
  assert.equal((await api('POST', 'inventories/free1/rules-to-site', { site: 'nope' })).status, 400);
});

test('API: notes are imported from the previous inventory of the same site', async () => {
  await api('PUT', 'inventories/inv1/overlay', { general: 'Vecchia nota generale', pages: { '/a/': 'Nota vecchia', '/scomparsa': 'Non più' } });
  await api('PUT', 'inventories/inv2/overlay', { general: '' });
  const r = await api('POST', 'inventories/inv2/import-notes', {});
  assert.equal(r.status, 200);
  assert.equal(r.data.from, 'inv1');
  assert.equal(r.data.copied, 0, '/a/ already has its note in inv2');
  assert.deepEqual(r.data.dropped, ['/scomparsa']);
  const notes = (await api('GET', 'inventories/inv2/map')).data.notes;
  assert.equal(notes.general, 'Vecchia nota generale');
  assert.equal(notes.pages['/a/'], 'Hub dei prodotti');
  assert.equal((await api('POST', 'inventories/free1/import-notes', {})).status, 400, 'a free URL has no previous inventory');
  assert.equal((await api('POST', 'inventories/inv1/import-notes', {})).data.from, null, 'the first inventory has none');
});
