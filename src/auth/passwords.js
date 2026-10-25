import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// Current parameters (ADR-0016): N=2^15, r=8, p=1 → 32 MB of memory per hash.
const PARAMS = { N: 2 ** 15, r: 8, p: 1, keylen: 32 };
const maxmem = (N, r) => 256 * N * r;

/** Hash in a self-describing format: scrypt$N$r$p$salt$hash (base64url). */
export async function hashPassword(password, params = PARAMS) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password).normalize('NFKC'), salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: maxmem(params.N, params.r) });
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

function parse(stored) {
  const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return null;
  return { N: Number(N), r: Number(r), p: Number(p), salt: Buffer.from(salt, 'base64url'), hash: Buffer.from(hash, 'base64url') };
}

/** Compares in constant time. A missing or malformed hash never matches (but still costs a hash). */
export async function verifyPassword(password, stored) {
  const h = parse(stored);
  const params = h || { ...PARAMS, salt: Buffer.alloc(16), hash: Buffer.alloc(PARAMS.keylen) };
  const key = await scrypt(String(password).normalize('NFKC'), params.salt, params.hash.length, { N: params.N, r: params.r, p: params.p, maxmem: maxmem(params.N, params.r) });
  return !!h && crypto.timingSafeEqual(key, params.hash);
}

/** True if the hash was made with weaker parameters than the current ones (RF-USR-04). */
export function needsRehash(stored) {
  const h = parse(stored);
  return !h || h.N < PARAMS.N || h.r < PARAMS.r || h.p < PARAMS.p || h.hash.length < PARAMS.keylen;
}

/** RF-USR-03: 12–128 characters, different from the username. Returns an error message or null. */
export function passwordProblem(password, username = '') {
  const p = String(password ?? '');
  if (p.length < 12) return 'La password deve avere almeno 12 caratteri';
  if (p.length > 128) return 'La password può avere al massimo 128 caratteri';
  if (username && p.toLowerCase() === String(username).toLowerCase()) return 'La password non può coincidere con lo username';
  return null;
}

// No look-alike characters (0/O, 1/l/I): the password is shown once and often copied by hand.
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Random temporary password (RF-ADM-01), 20 characters. */
export function generatePassword(length = 20) {
  let out = '';
  while (out.length < length) {
    const b = crypto.randomBytes(1)[0];
    if (b < 256 - (256 % ALPHABET.length)) out += ALPHABET[b % ALPHABET.length];
  }
  return out;
}

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
