import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PG_JSON_TYPES, postgresDb } from '../src/storage/vercel/backend.js';

// postgres.js is not run here (it needs a server): the pieces that make it behave like PGlite are checked on their own

test('jsonb: the text built by the stores is saved as it is, an object is written, what was saved twice is read once', () => {
  const j = PG_JSON_TYPES.jsonb;
  assert.equal(j.serialize('{"a":1}'), '{"a":1}');
  assert.equal(j.serialize({ a: 1 }), '{"a":1}');
  assert.deepEqual(j.parse('{"a":1}'), { a: 1 });
  assert.deepEqual(j.parse(JSON.stringify('{"a":1}')), { a: 1 }, 'a row saved double-encoded');
  assert.equal(j.parse('"just text"'), 'just text');
  assert.deepEqual(j.parse('[1,2]'), [1, 2]);
});

test('postgres adapter: undefined is NULL and dates are text', async () => {
  let got;
  const db = postgresDb({ unsafe: async (text, params) => { got = params; return []; } });
  await db.query('x', [undefined, new Date(0), 'a', 0]);
  assert.deepEqual(got, [null, '1970-01-01T00:00:00.000Z', 'a', 0]);
});
