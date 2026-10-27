import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveKey, secretsKeys, secretsAvailable, encrypt, decrypt, isCurrent, validateEntry, refsOf, substitute, maskValues, withoutRefs, MASK,
} from '../src/monitor/secrets.js';

// Variables and secrets (spec §13.9, RF-SEG-01..04): encryption, rotation, substitution, masking. Pure.

const env = (current, old = '') => ({ SITESCANNER_SECRETS_KEY: current, SITESCANNER_SECRETS_KEY_OLD: old });
const K1 = 'a'.repeat(64), K2 = 'b'.repeat(64);

test('keys: hex, base64, passphrase; too short is refused', () => {
  assert.equal(deriveKey(K1).length, 32);
  assert.equal(deriveKey(Buffer.alloc(32, 7).toString('base64')).length, 32);
  assert.equal(deriveKey('una frase lunga a sufficienza').length, 32);
  assert.deepEqual(deriveKey('una frase lunga a sufficienza'), deriveKey('una frase lunga a sufficienza'));
  assert.throws(() => deriveKey('corta'), /almeno 16 caratteri/);
  assert.equal(deriveKey(''), null);
  assert.equal(secretsAvailable(env('')), false);
  assert.equal(secretsAvailable(env(K1)), true);
  assert.equal(secretsKeys(env(K1, `${K2}, `)).all.length, 2);
});

test('encryption: round trip, different every time, bound to the name, tamper-proof', () => {
  const keys = secretsKeys(env(K1));
  const a = encrypt('la password', 'DB_PASSWORD', keys), b = encrypt('la password', 'DB_PASSWORD', keys);
  assert.notEqual(a, b, 'a new IV every time');
  assert.match(a, /^v1\.[0-9a-f]{8}\.[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.equal(a.includes('password'), false);
  assert.equal(decrypt(a, 'DB_PASSWORD', keys), 'la password');
  assert.equal(decrypt(encrypt('è ✓ ünïcode', 'X', keys), 'X', keys), 'è ✓ ünïcode');
  assert.throws(() => decrypt(a, 'ALTRO_NOME', keys), /alterato o con un nome diverso/, 'moved to another name');
  const parts = a.split('.');
  parts[4] = Buffer.from('xxxxxxxxxxxx').toString('base64url');
  assert.throws(() => decrypt(parts.join('.'), 'DB_PASSWORD', keys), /alterato/);
  assert.throws(() => decrypt('boh', 'X', keys), /formato sconosciuto/);
  assert.throws(() => encrypt('x', 'X', secretsKeys(env(''))), /non sono disponibili/);
});

test('rotation: old keys still decrypt, the current one encrypts', () => {
  const before = encrypt('valore', 'NOME', secretsKeys(env(K1)));
  const rotated = secretsKeys(env(K2, K1));
  assert.equal(decrypt(before, 'NOME', rotated), 'valore', 'the old key is kept for reading');
  assert.equal(isCurrent(before, rotated), false);
  const again = encrypt(decrypt(before, 'NOME', rotated), 'NOME', rotated);
  assert.equal(isCurrent(again, rotated), true);
  assert.equal(decrypt(again, 'NOME', secretsKeys(env(K2))), 'valore', 'works without the old key once re-encrypted');
  assert.throws(() => decrypt(before, 'NOME', secretsKeys(env(K2))), /chiave che il deploy non ha più/);
});

test('entries are validated (RF-SEG-01)', () => {
  assert.deepEqual(validateEntry({ name: ' api_key ', kind: 'secret', value: 'abcd1234' }), { name: 'API_KEY', kind: 'secret', value: 'abcd1234' });
  assert.deepEqual(validateEntry({ name: 'HOST_1', kind: 'var', value: 'x' }), { name: 'HOST_1', kind: 'var', value: 'x' });
  assert.throws(() => validateEntry({ name: 'con spazio', kind: 'var', value: 'x' }), /solo lettere, cifre e trattino basso/);
  assert.throws(() => validateEntry({ name: '', kind: 'var', value: 'x' }), /solo lettere/);
  assert.throws(() => validateEntry({ name: 'A-B', kind: 'var', value: 'x' }), /solo lettere/);
  assert.throws(() => validateEntry({ name: 'A', kind: 'boh', value: 'x' }), /scegli il tipo/);
  assert.throws(() => validateEntry({ name: 'A', kind: 'var', value: '' }), /vuoto/);
  assert.throws(() => validateEntry({ name: 'A', kind: 'secret', value: 'abc' }), /almeno 4 caratteri/);
  assert.equal(validateEntry({ name: 'A', kind: 'var', value: 'x'.repeat(4096) }).value.length, 4096);
  assert.throws(() => validateEntry({ name: 'A', kind: 'var', value: 'x'.repeat(4097) }), /al massimo 4 KB/);
});

test('references: found anywhere, case and spaces tolerated', () => {
  const m = { url: 'https://{{HOST}}/api?k={{ api_key }}', headers: { Authorization: 'Bearer {{TOKEN}}' }, assertions: [{ target: '{{ATTESO}}' }], name: 'Con {{NOME}}', n: 3 };
  assert.deepEqual([...refsOf(m)].sort(), ['API_KEY', 'ATTESO', 'HOST', 'NOME', 'TOKEN']);
  assert.deepEqual([...refsOf('niente')], []);
  assert.equal(withoutRefs('https://{{HOST}}/{{P}}'), 'https://x/x');
  assert.equal(withoutRefs('{"a": {{N}}}', '0'), '{"a": 0}');
});

test('substitution: workspace values, own values win, nothing else is touched (RF-SEG-02/03)', () => {
  const scope = { HOST: { kind: 'var', value: 'www.esempio.it' }, TOKEN: { kind: 'secret', value: 'segretissimo-123' }, PASSW: { kind: 'secret', value: 'p4ssw0rd!' } };
  const m = {
    id: 'm1', name: 'Per {{HOST}}', tags: ['{{HOST}}'], description: 'usa {{TOKEN}}', url: 'https://{{HOST}}/x', headers: { Authorization: 'Bearer {{TOKEN}}', 'X-Host': '{{ host }}' },
    auth: { username: 'admin', password: '{{PASSW}}' }, body: '{"k":"{{TOKEN}}"}', assertions: [{ source: 'body', comparison: 'contains', target: 'ciao {{HOST}}' }], state: { cert: { a: 1 } }, vars: { HOST: 'altro.esempio.it' }, timeoutS: 30,
  };
  const r = substitute(m, scope);
  assert.equal(r.monitor.url, 'https://altro.esempio.it/x', 'the variable of the monitor overrides the workspace one (RF-SEG-03)');
  assert.deepEqual(r.monitor.headers, { Authorization: 'Bearer segretissimo-123', 'X-Host': 'altro.esempio.it' });
  assert.deepEqual(r.monitor.auth, { username: 'admin', password: 'p4ssw0rd!' });
  assert.equal(r.monitor.body, '{"k":"segretissimo-123"}');
  assert.equal(r.monitor.assertions[0].target, 'ciao altro.esempio.it');
  assert.equal(r.monitor.name, 'Per {{HOST}}', 'name, tags and description are shown, never substituted');
  assert.equal(r.monitor.description, 'usa {{TOKEN}}');
  assert.deepEqual(r.monitor.tags, ['{{HOST}}']);
  assert.equal(r.monitor.state, m.state, 'the state is shared, not copied');
  assert.equal(m.url, 'https://{{HOST}}/x', 'the original is not changed');
  assert.deepEqual(r.secretValues.sort(), ['p4ssw0rd!', 'segretissimo-123']);
  assert.deepEqual([r.missing, r.used.sort()], [[], ['HOST', 'PASSW', 'TOKEN']]);
  // a reference with no value: reported, and left as it is
  const x = substitute({ url: 'https://{{MANCA}}/{{HOST}}', vars: {} }, scope);
  assert.deepEqual(x.missing, ['MANCA']);
  assert.equal(x.monitor.url, 'https://{{MANCA}}/www.esempio.it');
  assert.deepEqual(substitute({ url: 'https://a.it/' }, scope).used, []);
});

test('masking: the values of the secrets never remain in what is stored (RF-SEG-02)', () => {
  const stored = {
    url: 'https://a.it/?k=segretissimo-123', headers: { authorization: 'Bearer segretissimo-123', server: 'nginx' }, excerpt: '{"token":"segretissimo-123","ok":true}',
    chain: [{ url: 'https://a.it/x?p=p4ssw0rd!', status: 302 }], error: 'Nessuna parola «p4ssw0rd!»', n: 5, nothing: null,
  };
  const out = maskValues(stored, ['segretissimo-123', 'p4ssw0rd!']);
  assert.equal(JSON.stringify(out).includes('segretissimo'), false);
  assert.equal(JSON.stringify(out).includes('p4ssw0rd'), false);
  assert.equal(out.headers.authorization, `Bearer ${MASK}`);
  assert.equal(out.headers.server, 'nginx');
  assert.equal(out.excerpt, `{"token":"${MASK}","ok":true}`);
  assert.equal(out.chain[0].url, `https://a.it/x?p=${MASK}`);
  assert.equal(out.n, 5);
  assert.equal(stored.headers.authorization, 'Bearer segretissimo-123', 'a copy');
  // the longest first, so that a value inside another does not leave a piece of it
  assert.equal(maskValues('abcd-abcd-efgh', ['abcd', 'abcd-abcd']), `${MASK}-efgh`);
  assert.equal(maskValues('niente', []), 'niente');
  assert.equal(maskValues('ab ab', ['ab']), 'ab ab', 'too short to mask without destroying the text');
});
