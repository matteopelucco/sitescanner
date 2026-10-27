import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseListQuery, formatListQuery, matchesQuery, sortRows, statusCounts } from '../src/core/listquery.js';

// The list of the monitors: search, filters, sorting, counts (spec §13.8). Pure.

const row = (name, extra = {}) => ({ id: name, name, url: `https://${name}.it/`, tags: [], status: 'up', health: { level: 'buona' }, type: 'http', availability: 100, avgMs: 200, p95Ms: 400, lastAt: 1000, muted: false, ...extra });

test('the search is parsed: keys, quotes, negation, free text', () => {
  const q = parseListQuery('tag:cliente:acme stato:giù stato:degradato tipo:dns salute:critica -tag:prod negozio "carrello nuovo"');
  assert.deepEqual([q.tags, q.status, q.types, q.health], [['cliente:acme'], ['down', 'degraded'], ['dns'], ['critica']]);
  assert.deepEqual(q.not.tags, ['prod']);
  assert.deepEqual(q.text, ['negozio', 'carrello nuovo']);
  assert.deepEqual(q.errors, []);
  assert.deepEqual(parseListQuery('tag:"cliente x"').tags, ['cliente x']);
  assert.equal(parseListQuery('silenziato:sì').muted, true);
  assert.equal(parseListQuery('-silenziato:sì').muted, false);
  assert.equal(parseListQuery('').muted, null);
  assert.deepEqual(parseListQuery('https://sito.it').text, ['https://sito.it'], 'a URL is text, not a key');
  assert.deepEqual(parseListQuery('stato:boh tipo:xyz salute:mah').errors, ['stato sconosciuto: boh', 'tipo sconosciuto: xyz', 'salute sconosciuta: mah']);
  assert.deepEqual(parseListQuery('stato:GIÙ stato:giu tipo:Sito').status, ['down', 'down'], 'capitals and missing accents do not matter');
  assert.deepEqual(parseListQuery('tipo:sito').types, ['http']);
});

test('a parsed search is written back the same', () => {
  for (const text of ['tag:cliente:acme stato:down', 'tipo:dns -stato:paused testo', 'tag:"cliente x" salute:critica silenziato:sì']) {
    assert.equal(formatListQuery(parseListQuery(text)), text.replace('stato:down', 'stato:down'));
  }
  assert.equal(formatListQuery(parseListQuery('stato:giù')), 'stato:down');
});

test('rows are filtered: AND between keys, OR inside one, namespaces of tags', () => {
  const rows = [
    row('acme', { tags: ['cliente:acme', 'prod'], status: 'down', health: { level: 'critica' } }),
    row('acme-test', { tags: ['cliente:acme', 'test'], type: 'api' }),
    row('zeta', { tags: ['cliente:zeta'], status: 'degraded', muted: true }),
    row('dns-zeta', { tags: ['cliente:zeta'], type: 'dns', status: 'paused' }),
  ];
  const names = (text, opts) => rows.filter((r) => matchesQuery(r, parseListQuery(text), opts)).map((r) => r.name);
  assert.deepEqual(names(''), ['acme', 'acme-test', 'zeta', 'dns-zeta']);
  assert.deepEqual(names('tag:cliente'), ['acme', 'acme-test', 'zeta', 'dns-zeta'], 'a namespace matches all its tags');
  assert.deepEqual(names('tag:cliente:acme'), ['acme', 'acme-test']);
  assert.deepEqual(names('tag:cliente: -tag:prod'), ['acme-test', 'zeta', 'dns-zeta']);
  assert.deepEqual(names('tag:cliente:acme stato:giù'), ['acme']);
  assert.deepEqual(names('stato:giù stato:degradato'), ['acme', 'zeta']);
  assert.deepEqual(names('-stato:su'), ['acme', 'zeta', 'dns-zeta']);
  assert.deepEqual(names('tipo:api'), ['acme-test']);
  assert.deepEqual(names('tipo:dns tag:cliente:zeta'), ['dns-zeta']);
  assert.deepEqual(names('salute:critica'), ['acme']);
  assert.deepEqual(names('silenziato:sì'), ['zeta']);
  assert.deepEqual(names('ACME'), ['acme', 'acme-test'], 'text: name, URL and tags, any case');
  assert.deepEqual(names('acme test'), ['acme-test'], 'every word must be there');
  assert.deepEqual(names('stato:giù', { skip: ['status'] }), ['acme', 'acme-test', 'zeta', 'dns-zeta'], 'the tabs count without the status filter');
});

test('sorting: columns, direction, nulls last, the default puts problems first', () => {
  const rows = [
    row('b', { availability: 99.5, avgMs: 300, lastAt: 3 }), row('a', { availability: 100, avgMs: 100, lastAt: 1 }),
    row('c', { availability: null, avgMs: null, lastAt: null, status: 'pending' }), row('d', { availability: 90, avgMs: 900, status: 'down', health: { level: 'critica' }, lastAt: 2 }),
    row('e', { availability: 98, health: { level: 'attenzione' }, p95Ms: 50 }),
  ];
  const order = (sort, dir) => sortRows(rows, sort, dir).map((r) => r.name).join('');
  assert.equal(order('name'), 'abcde');
  assert.equal(order('name', 'desc'), 'edcba');
  assert.equal(order('availability'), 'debac', 'ascending, no data last');
  assert.equal(order('availability', 'desc'), 'abedc', 'descending, no data still last');
  assert.equal(order('avg'), 'aebdc');
  assert.equal(order('status'), 'dcabe');
  assert.equal(order('health'), 'deabc');
  assert.equal(order('last', 'desc'), 'ebdac');
  assert.equal(order('p95'), 'eabcd');
  assert.equal(order('default'), 'debac', 'down first, then by availability');
  assert.equal(order(), order('default'));
  assert.equal(rows[0].name, 'b', 'the input is not changed');
});

test('counts per status for the tabs', () => {
  const rows = [row('a'), row('b', { status: 'down' }), row('c', { status: 'down' }), row('d', { status: 'paused' }), row('e', { status: 'degraded' })];
  assert.deepEqual(statusCounts(rows), { all: 5, up: 1, degraded: 1, down: 2, paused: 1, maintenance: 0, pending: 0 });
  assert.deepEqual(statusCounts([]), { all: 0, up: 0, degraded: 0, down: 0, paused: 0, maintenance: 0, pending: 0 });
});
