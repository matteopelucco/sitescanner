import crypto from 'node:crypto';

// Variables and secrets of a workspace (spec §13.9, RF-SEG-01..04): AES-256-GCM encryption with a key of the
// deployment (SITESCANNER_SECRETS_KEY, rotation with SITESCANNER_SECRETS_KEY_OLD), `{{NAME}}` in the
// monitors, substitution only when a run is made, masking of the values in what is stored.

export const NAME_RE = /^[A-Z0-9_]{1,64}$/;
export const MAX_VALUE = 4096;
export const MAX_PER_AREA = 200;
export const MIN_SECRET = 4; // a shorter value could not be masked without destroying the text around it
const REF_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

// ---------------- keys ----------------

/** A 32-byte key from what the operator gave: 64 hex, a base64 of 32 bytes, or a passphrase (hashed). */
export function deriveKey(material) {
  const s = String(material || '').trim();
  if (!s) return null;
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  const b = Buffer.from(s, 'base64');
  if (b.length === 32 && /^[A-Za-z0-9+/=_-]+$/.test(s)) return b;
  if (s.length < 16) throw new Error('SITESCANNER_SECRETS_KEY: usa una chiave di almeno 16 caratteri (meglio: openssl rand -base64 32)');
  return crypto.createHash('sha256').update(s).digest();
}

const keyId = (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);

/** The keys of the deployment: the current one encrypts, the old ones (comma separated) still decrypt. */
export function secretsKeys(env = process.env) {
  const current = deriveKey(env.SITESCANNER_SECRETS_KEY);
  const old = String(env.SITESCANNER_SECRETS_KEY_OLD || '').split(',').map((x) => x.trim()).filter(Boolean).map(deriveKey);
  const all = [current, ...old].filter(Boolean).map((key) => ({ id: keyId(key), key }));
  return { current: current ? { id: keyId(current), key: current } : null, all };
}

export const secretsAvailable = (env = process.env) => !!secretsKeys(env).current;

// ---------------- encryption ----------------

/** `v1.<keyId>.<iv>.<tag>.<ciphertext>`, the name of the secret as authenticated data: a value cannot be moved to another name. */
export function encrypt(value, name, keys = secretsKeys()) {
  if (!keys.current) throw new Error('I segreti non sono disponibili: il deploy non ha SITESCANNER_SECRETS_KEY');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keys.current.key, iv);
  c.setAAD(Buffer.from(String(name)));
  const ct = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
  return ['v1', keys.current.id, iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(blob, name, keys = secretsKeys()) {
  const [v, id, iv, tag, ct] = String(blob).split('.');
  if (v !== 'v1' || !ct) throw new Error('Segreto in un formato sconosciuto');
  const k = keys.all.find((x) => x.id === id);
  if (!k) throw new Error('Il segreto è cifrato con una chiave che il deploy non ha più (SITESCANNER_SECRETS_KEY_OLD)');
  const d = crypto.createDecipheriv('aes-256-gcm', k.key, Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(String(name)));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  try {
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch {
    throw new Error('Segreto alterato o con un nome diverso da quello con cui è stato cifrato');
  }
}

/** True if the blob was encrypted with the current key. */
export const isCurrent = (blob, keys = secretsKeys()) => !!(keys.current && String(blob).split('.')[1] === keys.current.id);

// ---------------- validation ----------------

/** Validates what a person enters for a variable or a secret (RF-SEG-01); returns the clean record fields. */
export function validateEntry({ name, kind, value }) {
  const n = String(name ?? '').trim().toUpperCase();
  if (!NAME_RE.test(n)) throw new Error('Il nome può avere solo lettere, cifre e trattino basso (A-Z, 0-9, _), fino a 64 caratteri');
  if (!['var', 'secret'].includes(kind)) throw new Error('Una variabile è visibile, un segreto no: scegli il tipo');
  const v = String(value ?? '');
  if (Buffer.byteLength(v) > MAX_VALUE) throw new Error('Il valore può essere lungo al massimo 4 KB');
  if (!v) throw new Error('Il valore è vuoto');
  if (kind === 'secret' && v.length < MIN_SECRET) throw new Error(`Un segreto deve avere almeno ${MIN_SECRET} caratteri: uno più corto non si potrebbe mascherare nei dati salvati`);
  return { name: n, kind, value: v };
}

// ---------------- references and substitution ----------------

/** The names referenced as {{NAME}} in a text or in any string of a structure. */
export function refsOf(x, out = new Set()) {
  if (typeof x === 'string') for (const m of x.matchAll(REF_RE)) out.add(m[1].toUpperCase());
  else if (Array.isArray(x)) for (const v of x) refsOf(v, out);
  else if (x && typeof x === 'object') for (const v of Object.values(x)) refsOf(v, out);
  return out;
}

const SKIP = new Set(['state', 'id', 'name', 'tags', 'description', 'alertPolicy', 'vars', 'channels', 'hbToken', 'createdAt', 'source', 'muted']);

/** The same text with a placeholder in the place of each reference: to validate what must look like a URL, a JSON, … */
export const withoutRefs = (s, filler = 'x') => String(s ?? '').replace(REF_RE, filler);

/**
 * The monitor as it is run: every `{{NAME}}` replaced by the value of the monitor (`vars`) or of the workspace
 * (`scope`: name → { kind, value }). `state` is shared, not copied, so that what a check learns (the certificate)
 * stays in the monitor. Returns the copy, the values of the secrets used (to mask them in what is stored) and the
 * names that could not be resolved (RF-SEG-03).
 */
export function substitute(m, scope = {}) {
  const used = new Set(), missing = new Set(), secretValues = new Set();
  const own = Object.fromEntries(Object.entries(m.vars || {}).map(([k, v]) => [k.toUpperCase(), String(v)]));
  const lookup = (name) => {
    const n = name.toUpperCase();
    if (n in own) return own[n];
    if (scope[n]) {
      if (scope[n].kind === 'secret') secretValues.add(scope[n].value);
      return scope[n].value;
    }
    missing.add(n);
    return null;
  };
  const walk = (x, key) => {
    if (typeof x === 'string') {
      return x.replace(REF_RE, (whole, name) => { used.add(name.toUpperCase()); const v = lookup(name); return v == null ? whole : v; });
    }
    if (Array.isArray(x)) return x.map((v) => walk(v));
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, SKIP.has(k) && !key ? v : walk(v, k)]));
    return x;
  };
  const monitor = {};
  for (const [k, v] of Object.entries(m)) monitor[k] = SKIP.has(k) ? v : walk(v, k);
  return { monitor, used: [...used], missing: [...missing], secretValues: [...secretValues] };
}

export const MASK = '••••';

/** A structure with every value of a secret replaced by `••••` (RF-SEG-02), also in its keys' values, deeply. */
export function maskValues(x, values) {
  const list = [...values].filter((v) => v && String(v).length >= MIN_SECRET).sort((a, b) => b.length - a.length);
  if (!list.length) return x;
  const mask = (s) => list.reduce((t, v) => t.split(v).join(MASK), s);
  const walk = (y) => {
    if (typeof y === 'string') return mask(y);
    if (Array.isArray(y)) return y.map(walk);
    if (y && typeof y === 'object') return Object.fromEntries(Object.entries(y).map(([k, v]) => [k, walk(v)]));
    return y;
  };
  return walk(x);
}
