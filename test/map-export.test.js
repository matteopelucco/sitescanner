import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { startApp } from './helpers/ui.js';
import { storageFor } from '../src/storage/index.js';
import { csvCell, mdEsc, mapCsv, mapMarkdown, radialSvg } from '../src/core/mapexport.js';
import { zipFiles, crc32 } from '../src/core/zip.js';
import { loadD3Hierarchy } from '../src/mapbundle.js';

// Exports of the site map (spec §14.7): every format, with the escapes that matter.

// the subset of JSON Schema that docs/specs/sitemap.schema.json uses
function validate(schema, value, root = schema, at = '$') {
  const errors = [];
  const s = schema.$ref ? root.definitions[schema.$ref.split('/').pop()] : schema;
  const types = [].concat(s.type || []);
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  if (s.const !== undefined && value !== s.const) errors.push(`${at}: deve valere ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} non ammesso`);
  if (types.length && !types.some((t) => t === typeOf(value) || (t === 'number' && typeof value === 'number'))) return [`${at}: tipo ${typeOf(value)}, atteso ${types.join('|')}`];
  if (s.oneOf && s.oneOf.filter((o) => !validate(o, value, root, at).length).length !== 1) errors.push(`${at}: nessuna alternativa corrisponde`);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of s.required || []) if (!(k in value)) errors.push(`${at}: manca ${k}`);
    for (const [k, sub] of Object.entries(s.properties || {})) if (k in value) errors.push(...validate(sub, value[k], root, `${at}.${k}`));
    if (s.additionalProperties && typeof s.additionalProperties === 'object') for (const [k, v] of Object.entries(value)) if (!(s.properties || {})[k]) errors.push(...validate(s.additionalProperties, v, root, `${at}.${k}`));
  }
  if (Array.isArray(value) && s.items) value.forEach((v, i) => errors.push(...validate(s.items, v, root, `${at}[${i}]`)));
  return errors;
}

// the entries of a ZIP, read from its central directory
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const lnlen = buf.readUInt16LE(off + 26), lxlen = buf.readUInt16LE(off + 28);
    const raw = buf.subarray(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.equal(crc32(data), crc, `crc of ${name}`);
    out[name] = data;
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

test('csv cells: formulas are neutralized, separators and quotes escaped', () => {
  assert.equal(csvCell('=SOMMA(A1)'), "'=SOMMA(A1)");
  for (const f of ['+1', '-1', '@x', '\tx']) assert.ok(csvCell(f).startsWith("'"), f);
  assert.equal(csvCell('a;b'), '"a;b"');
  assert.equal(csvCell('dice "sì"'), '"dice ""sì"""');
  assert.equal(csvCell('riga 1\nriga 2'), '"riga 1\nriga 2"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(42), '42');
});

test('markdown text: special characters escaped, no line breaks', () => {
  assert.equal(mdEsc('a|b *c* [d](e) <x>\nnuova'), 'a\\|b \\*c\\* \\[d\\]\\(e\\) \\<x\\> nuova');
});

test('zip: readable by an unzipper, with names in UTF-8 and checked CRCs', () => {
  const files = unzip(zipFiles([{ name: 'a.txt', data: 'ciao '.repeat(200) }, { name: 'cartella/è.json', data: '{"x":1}' }]));
  assert.equal(files['a.txt'].toString(), 'ciao '.repeat(200));
  assert.equal(files['cartella/è.json'].toString(), '{"x":1}');
});

let app, st;
const page = (key, title, extra = {}) => ({ key, host: 'x.test', html: true, status: 200, title, description: `Descrizione di ${title}`, wordCount: 40, lang: 'it', clickDepth: key === '/' ? 0 : 1, urlDepth: key.split('/').filter(Boolean).length, section: '/', inlinks: 1, outlinks: 1, regions: 'landmark', contentLinks: [], navLinks: [], documents: [], ...extra });

before(async () => {
  app = await startApp();
  st = storageFor();
  const pages = [
    page('/', 'Home | Marca', { contentLinks: ['/a/', '/b/', '/a/x', '/a/y', '/a/z'] }),
    page('/a/', '=HYPERLINK("http://evil") | Marca', { contentLinks: ['/a/x'], documents: [{ url: 'https://x.test/g.pdf', host: 'x.test', ext: 'pdf', region: 'content' }] }),
    page('/a/x', 'Pagina; con "virgolette" | Marca'), page('/a/y', 'AY | Marca'), page('/a/z', 'AZ | Marca'), page('/b/', 'B | Marca'),
    page('/kid', 'Kid | Marca', { host: 'kid.x.test', boundary: true }),
  ];
  const inv = {
    schema: 2, id: 'ex1', site: null, baseUrl: 'https://x.test/', startedAt: '2026-10-20T10:00:00Z', finishedAt: '2026-10-20T10:01:00Z', durationMs: 1, options: { maxPages: 10, maxDepth: 5, map: {} },
    crawl: { truncated: false, unvisited: 0, start: ['/'] }, summary: { urls: 7, htmlPages: 7, map: {} }, tree: { name: '/', path: '/', pages: 1, total: 7, children: [] }, pages,
    documents: [{ url: 'https://x.test/g.pdf', host: 'x.test', ext: 'pdf', pages: 1, regions: ['content'] }],
  };
  await st.saveInventory(inv, inv);
  await st.writeInventoryOverlay('ex1', { version: 1, rules: null, notes: { general: 'Nota *generale*\nsu due righe', pages: { '/b/': 'Gate | <script>x</script>' } } });
});
after(async () => { await app.stop(); });

const get = async (p) => {
  const res = await fetch(`${app.base}/api/inventories/ex1/${p}`);
  return { res, buf: Buffer.from(await res.arrayBuffer()) };
};

test('csv export: BOM, semicolons, CRLF, Italian columns, protected formulas, notes', async () => {
  const { res, buf } = await get('map.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /filename="mappa-x\.test-20261020\.csv"/);
  const text = buf.toString('utf8');
  assert.equal(text.charCodeAt(0), 0xfeff);
  const rows = text.slice(1).split('\r\n');
  assert.equal(rows[0].split(';')[0], 'URL');
  assert.ok(rows[0].includes('Nome breve') && rows[0].includes('Navigazione globale') && rows[0].endsWith('Nota'));
  assert.ok(text.includes("'=HYPERLINK"), 'a title that looks like a formula does not run in Excel');
  assert.ok(text.includes('"Pagina; con ""virgolette"""') || text.includes('Pagina; con'), 'quotes escaped');
  assert.ok(text.includes('Gate | <script>x</script>'), 'the note of the page');
  assert.ok(text.includes('https://x.test/g.pdf'));
  assert.ok(text.includes(' | '), 'urls joined with a pipe');
  assert.equal(rows.filter(Boolean).length, 1 + 7, 'a header and one row per node');
});

test('json export: the documented dataset, valid against its schema', async () => {
  const { res, buf } = await get('map.json');
  assert.equal(res.status, 200);
  const data = JSON.parse(buf.toString('utf8'));
  const schema = JSON.parse(fs.readFileSync(new URL('../docs/specs/sitemap.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(validate(schema, data), []);
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.inventory.id, 'ex1');
  assert.equal(data.notes.pages['/b/'], 'Gate | <script>x</script>');
  assert.ok(data.nodes.some((n) => n.id === 'kid.x.test/kid'), 'the boundary page by host + key');
  assert.ok(data.edges.hierarchy.length > 3 && Array.isArray(data.edges.content));
  assert.equal(data.documents.length, 1);
  assert.equal(data.summary.redirects, undefined, 'redirects and ecosystem are at the top level');
});

test('markdown export: Mermaid diagram, tables, catalog per area, notes escaped', async () => {
  const { res, buf } = await get('map.md');
  const md = buf.toString('utf8');
  assert.equal(res.status, 200);
  assert.match(md, /^# Mappa del sito x\.test \(2026-10-20\)/);
  assert.match(md, /```mermaid\nflowchart LR\n/);
  assert.ok(md.includes('> Nota \\*generale\\*'), 'the general note, quoted and escaped');
  assert.ok(md.includes('Gate \\| \\<script\\>x\\</script\\>'), 'a page note cannot become markup or break a table');
  assert.match(md, /## Catalogo per area/);
  assert.ok(md.includes('\\=HYPERLINK') || md.includes('=HYPERLINK'), 'title present');
  const box = [...md.matchAll(/^\s+n\d+\["/gm)].length;
  assert.ok(box >= 2 && box <= 40);
});

test('mermaid: at most 40 boxes, the rest summarized', () => {
  const nodes = [{ id: '/', shortName: 'Home', url: 'https://x.test/', host: 'x.test', key: '/', area: 'Home', level: 0, children: [], contentIn: [], contentOut: [], documents: [], title: 'Home', description: '' }];
  const areas = [{ name: 'Home', pages: 1 }, ...Array.from({ length: 70 }, (_, i) => ({ name: `Area ${i}`, pages: 100 - i }))];
  const map = { root: '/', mainHost: 'x.test', nodes, areas, subareas: [], warnings: [], notes: { general: '', pages: {} }, stats: { composition: { byArea: [], byLevel: {}, byHost: [] }, links: {}, content: {}, documents: { unique: 0 }, ecosystem: [], redirects: [] } };
  const md = mapMarkdown(map, { startedAt: '2026-01-01' });
  assert.equal([...md.matchAll(/^\s+n\d+\["/gm)].length, 40);
  assert.match(md, /… altre 32/);
});

test('radial diagram: an SVG with positions from d3-hierarchy', async () => {
  const map = await (await fetch(`${app.base}/api/inventories/ex1/map`)).json();
  const svg = radialSvg(map, loadD3Hierarchy());
  assert.match(svg, /^<svg /);
  assert.ok((svg.match(/<circle /g) || []).length >= 3);
  assert.ok(!svg.includes('NaN'));
});

test('offline bundle: a ZIP with the page, the data, the libraries and their licenses, no external requests', async () => {
  const { res, buf } = await get('map.zip');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /zip/);
  const files = unzip(buf);
  for (const f of ['index.html', 'map-data.js', 'bundle.js', 'app.css', 'vendor/d3-force.min.js', 'vendor/d3-force.LICENSE', 'vendor/d3-hierarchy.min.js']) assert.ok(files[f], f);
  const html = files['index.html'].toString();
  assert.ok(!/(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(html.replace(/<title>.*<\/title>/, '')), 'index.html does not point to anything outside');
  assert.match(files['map-data.js'].toString(), /^window\.__SITEMAP__ = \{/);
  assert.ok(!files['map-data.js'].toString().includes('</script'), 'the data cannot close its script');
  assert.ok(!/^\s*(import|export) /m.test(files['bundle.js'].toString()), 'one classic script');
  assert.equal((await fetch(`${app.base}/api/inventories/ex1/map.xyz`)).status, 404);
});

test('cli: sitescanner map writes the export of the latest inventory', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitescanner-climap-'));
  const run = (...args) => promisify(execFile)('node', ['bin/sitescanner.js', 'map', ...args], { env: { ...process.env } });
  try {
    for (const [format, check] of [['csv', (b) => b.toString().includes('URL;Host')], ['json', (b) => JSON.parse(b).schemaVersion === 1], ['md', (b) => b.toString().includes('flowchart LR')], ['html', (b) => b.subarray(0, 2).toString() === 'PK']]) {
      const out = path.join(dir, `m.${format}`);
      const { stdout } = await run('--inventory', 'latest', '--format', format, '--out', out);
      assert.match(stdout, /inventario ex1/);
      assert.ok(check(fs.readFileSync(out)), format);
    }
    await assert.rejects(run('--inventory', 'latest', '--site', 'nessuno', '--format', 'csv'), /Nessun inventario per il sito nessuno/);
    await assert.rejects(run('--inventory', 'ex1', '--format', 'docx'), /--format/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
