import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateAssertions, normalizeAssertions, parseJsonPath, queryJson, parseStatusList, assertionsFromLegacy, describeAssertion, comparisonsFor,
} from '../src/core/assertions.js';

// Assertions on the response (spec §13.3, RF-AST-01..05): every source, every comparison.

const ctx = (extra = {}) => ({
  status: 200,
  headers: { 'content-type': 'application/json; charset=utf-8', 'x-cache': 'HIT', server: 'nginx' },
  body: JSON.stringify({ status: 'ok', count: 3, items: [{ id: 1, tag: 'a' }, { id: 2, tag: 'bb' }], empty: [], nothing: null, text: 'Ciao Mondo' }),
  ms: 120,
  url: 'https://www.esempio.it/api/stato',
  ...extra,
});
const check = (a, c = ctx()) => evaluateAssertions(normalizeAssertions([a]), c);
const ok = (a, c) => assert.equal(check(a, c).ok, true, JSON.stringify(a));
const ko = (a, c) => assert.equal(check(a, c).ok, false, JSON.stringify(a));
const msg = (a, c) => check(a, c).results[0].message;

test('status', () => {
  ok({ source: 'status', comparison: 'in', target: '200-299' });
  ok({ source: 'status', comparison: 'in', target: '301, 200' });
  ko({ source: 'status', comparison: 'in', target: '300-399' }, ctx({ status: 503 }));
  ok({ source: 'status', comparison: 'equals', target: '200' });
  ok({ source: 'status', comparison: 'notEquals', target: '404' });
  ok({ source: 'status', comparison: 'lt', target: '400' });
  ko({ source: 'status', comparison: 'gt', target: '399' });
  assert.equal(msg({ source: 'status', comparison: 'in', target: '200-399' }, ctx({ status: 503 })), 'Status 503, atteso 200-399');
  assert.equal(check({ source: 'status', comparison: 'in', target: '200-399' }, ctx({ status: 503 })).results[0].errorClass, 'http');
  assert.equal(parseStatusList('200-399')(404), false);
  assert.equal(parseStatusList('99'), null);
});

test('header: any case, missing header, comparisons', () => {
  ok({ source: 'header', property: 'Content-Type', comparison: 'contains', target: 'json' });
  ok({ source: 'header', property: 'x-cache', comparison: 'equals', target: 'hit', ci: true });
  ko({ source: 'header', property: 'x-cache', comparison: 'equals', target: 'hit' });
  ok({ source: 'header', property: 'server', comparison: 'matches', target: '^ng' });
  ok({ source: 'header', property: 'x-assente', comparison: 'empty' });
  ok({ source: 'header', property: 'server', comparison: 'notEmpty' });
  ok({ source: 'header', property: 'server', comparison: 'notContains', target: 'apache' });
  ok({ source: 'header', property: 'server', comparison: 'notEquals', target: 'apache' });
  assert.equal(msg({ source: 'header', property: 'x-cache', comparison: 'equals', target: 'MISS' }), 'Header x-cache = "HIT", atteso "MISS"');
  assert.equal(msg({ source: 'header', property: 'x-nuovo', comparison: 'notEmpty' }), 'Header x-nuovo = assente, atteso non vuoto');
});

test('body: text, regular expression, emptiness', () => {
  ok({ source: 'body', comparison: 'contains', target: 'Ciao Mondo' });
  ok({ source: 'body', comparison: 'contains', target: 'ciao mondo', ci: true });
  ko({ source: 'body', comparison: 'contains', target: 'ciao mondo' });
  ok({ source: 'body', comparison: 'notContains', target: 'errore fatale' });
  ok({ source: 'body', comparison: 'matches', target: '"count":\\s*3' });
  ok({ source: 'body', comparison: 'notEmpty' });
  ok({ source: 'body', comparison: 'empty' }, ctx({ body: '' }));
  ok({ source: 'body', comparison: 'equals', target: 'x' }, ctx({ body: 'x' }));
  // the messages of the first version's keyword, and its error class
  assert.equal(msg({ source: 'body', comparison: 'contains', target: 'Carrello' }), 'Parola «Carrello» non trovata');
  assert.equal(msg({ source: 'body', comparison: 'notContains', target: 'Ciao' }), 'Parola «Ciao» presente');
  assert.equal(check({ source: 'body', comparison: 'contains', target: 'Carrello' }).results[0].errorClass, 'keyword');
});

test('JSON: paths, types, wildcard, invalid JSON', () => {
  const j = (property, comparison, target, c) => check({ source: 'json', property, comparison, target }, c);
  assert.equal(j('$.status', 'equals', 'ok').ok, true);
  assert.equal(j('$.count', 'equals', '3').ok, true, 'a number against «3»');
  assert.equal(j('$.count', 'gt', '2').ok, true);
  assert.equal(j('$.count', 'lt', '3').ok, false);
  assert.equal(j('$.items[1].tag', 'equals', 'bb').ok, true);
  assert.equal(j("$['status']", 'equals', 'ok').ok, true);
  assert.equal(j('$.text', 'matches', '^Ciao').ok, true);
  assert.equal(j('$.empty', 'empty').ok, true);
  assert.equal(j('$.nothing', 'empty').ok, true);
  assert.equal(j('$.assente', 'empty').ok, true);
  assert.equal(j('$.items', 'notEmpty').ok, true);
  assert.equal(j('$.count', 'notEmpty').ok, true);
  // a wildcard: «contains» is true if any element matches
  assert.equal(j('$.items[*].tag', 'contains', 'bb').ok, true);
  assert.equal(j('$.items[*].tag', 'contains', 'zz').ok, false);
  assert.equal(j('$.items[*].tag', 'notContains', 'zz').ok, true);
  assert.equal(j('$.items[*].id', 'notEmpty').ok, true);
  assert.equal(j('$.empty[*]', 'empty').ok, true);
  assert.equal(j('$.items[*].id', 'contains', '2').ok, true);
  // messages
  assert.equal(j('$.status', 'equals', 'down', ctx({ body: '{"status":"ok"}' })).results[0].message, 'JSON $.status = "ok", atteso "down"');
  assert.equal(j('$.count', 'gt', '5').results[0].message, 'JSON $.count = 3, atteso maggiore di "5"');
  assert.equal(j('$.manca', 'equals', 'x').results[0].message, 'JSON $.manca = assente, atteso "x"');
  assert.equal(j('$.status', 'equals', 'ok', ctx({ body: '<html>non json' })).results[0].message, 'La risposta non è JSON valido');
  // the parsed JSON is shared by the assertions of one run
  const both = evaluateAssertions(normalizeAssertions([{ source: 'json', property: '$.status', comparison: 'equals', target: 'ok' }, { source: 'json', property: '$.count', comparison: 'gt', target: '1' }]), ctx());
  assert.equal(both.ok, true);
});

test('time and URL', () => {
  ok({ source: 'time', comparison: 'lt', target: '500' });
  ko({ source: 'time', comparison: 'lt', target: '100' });
  ok({ source: 'url', comparison: 'contains', target: '/api/' });
  ok({ source: 'url', comparison: 'matches', target: '^https://www\\.' });
  ko({ source: 'url', comparison: 'equals', target: 'https://altro.it/' });
  assert.equal(msg({ source: 'time', comparison: 'lt', target: '100' }), 'Tempo di risposta = 120, atteso minore di "100"');
});

test('all the assertions must hold; the first failure is reported; default when none', () => {
  const r = evaluateAssertions(normalizeAssertions([
    { source: 'status', comparison: 'in', target: '200' },
    { source: 'json', property: '$.status', comparison: 'equals', target: 'down' },
    { source: 'body', comparison: 'contains', target: 'Carrello' },
  ]), ctx());
  assert.deepEqual(r.results.map((x) => x.ok), [true, false, false]);
  assert.equal(evaluateAssertions([], ctx({ status: 503 })).ok, false, 'default: 200–399');
  assert.equal(evaluateAssertions(null, ctx({ status: 301 })).ok, true);
  // long values are cut (RF-AST-03)
  const long = evaluateAssertions(normalizeAssertions([{ source: 'header', property: 'x-lungo', comparison: 'equals', target: 'a'.repeat(300) }]), ctx({ headers: { 'x-lungo': 'b'.repeat(500) } }));
  assert.ok(long.results[0].message.length <= 200);
});

test('validation of an assertion list', () => {
  const bad = (a, re) => assert.throws(() => normalizeAssertions([a]), re);
  bad({ source: 'cookie', comparison: 'equals', target: 'x' }, /sorgente non valida/);
  bad({ source: 'status', comparison: 'contains', target: '2' }, /non vale per «status»/);
  bad({ source: 'body', comparison: 'contains' }, /manca il valore atteso/);
  bad({ source: 'header', comparison: 'equals', target: 'x' }, /manca il nome dell'header/);
  bad({ source: 'json', comparison: 'equals', target: 'x' }, /manca il percorso JSON/);
  bad({ source: 'json', property: 'status', comparison: 'equals', target: 'x' }, /percorso JSON non valido/);
  bad({ source: 'json', property: '$.a[*].b', comparison: 'equals', target: 'x' }, /con \[\*\] si usano/);
  bad({ source: 'status', comparison: 'in', target: '2xx' }, /status non validi/);
  bad({ source: 'time', comparison: 'lt', target: 'veloce' }, /deve essere un numero/);
  bad({ source: 'body', comparison: 'matches', target: '(' }, /espressione regolare non valida/);
  bad({ source: 'body', comparison: 'contains', target: 'x'.repeat(501) }, /troppo lungo/);
  // clean output: unknown fields dropped, ci only where it means something
  assert.deepEqual(normalizeAssertions([{ source: 'body', comparison: 'contains', target: 'x', ci: true, extra: 1 }, { source: 'body', comparison: 'matches', target: 'x', ci: true }]), [{ source: 'body', comparison: 'contains', target: 'x', ci: true }, { source: 'body', comparison: 'matches', target: 'x' }]);
  assert.deepEqual(normalizeAssertions(undefined), []);
});

test('JSONPath subset', () => {
  assert.deepEqual(parseJsonPath('$.a.b[0]["c d"][*]'), [{ key: 'a' }, { key: 'b' }, { index: 0 }, { key: 'c d' }, { all: true }]);
  for (const bad of ['a.b', '$.', '$..a', '$.a[', '$.a[x]', '$.a[-1]', '']) assert.equal(parseJsonPath(bad), null, bad);
  assert.deepEqual(queryJson({ a: [1, 2] }, parseJsonPath('$.a[*]')), [1, 2]);
  assert.deepEqual(queryJson({ a: [1] }, parseJsonPath('$.a[3]')), []);
  assert.deepEqual(queryJson([5], parseJsonPath('$[0]')), [5]);
  assert.deepEqual(queryJson({ a: { b: 1 } }, parseJsonPath('$.a.b.c')), []);
});

test('the first version\'s status list and keyword become assertions', () => {
  assert.deepEqual(assertionsFromLegacy({ expect: '200, 301' }), [{ source: 'status', comparison: 'in', target: '200,301' }]);
  assert.deepEqual(assertionsFromLegacy({}), [{ source: 'status', comparison: 'in', target: '200-399' }]);
  assert.deepEqual(assertionsFromLegacy({ expect: '200-299', keyword: { text: 'Ciao', mode: 'absent', caseInsensitive: true } }), [
    { source: 'status', comparison: 'in', target: '200-299' },
    { source: 'body', comparison: 'notContains', target: 'Ciao', ci: true },
  ]);
  assert.equal(describeAssertion({ source: 'json', property: '$.a', comparison: 'gt', target: '3' }), 'JSON $.a maggiore di 3');
  assert.deepEqual(comparisonsFor('time'), ['lt', 'gt', 'equals']);
});
