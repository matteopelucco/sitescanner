import { migrate } from './schema.js';

// Services of the Vercel backend (ADR-0017): Postgres for the data, private Vercel Blob for the files.
// Both are behind small adapters, so the same storage code runs on the real services and, in tests,
// on PGlite (Postgres in process) and an in-memory blob store.

/**
 * The jsonb of postgres.js. The driver knows from the server that a parameter is jsonb and serializes it again, so the text
 * that the stores already built with JSON.stringify would be saved as a JSON string: here a string is the JSON text as it is.
 * What was saved that way (a string that holds an object) is read back as the object.
 */
export const PG_JSON_TYPES = {
  json: { to: 114, from: [114], serialize: (x) => (typeof x === 'string' ? x : JSON.stringify(x)), parse: (x) => JSON.parse(x) },
  jsonb: {
    to: 3802, from: [3802], serialize: (x) => (typeof x === 'string' ? x : JSON.stringify(x)),
    parse: (x) => { const v = JSON.parse(x); return typeof v === 'string' && /^\s*[[{]/.test(v) ? JSON.parse(v) : v; },
  },
};

/** Adapter over postgres.js (`postgres` package). The driver refuses `undefined`: it is NULL, as in PGlite. */
export function postgresDb(sql) {
  const wrap = (s) => ({
    query: (text, params = []) => s.unsafe(text, params.map((p) => (p instanceof Date ? p.toISOString() : p === undefined ? null : p))),
    exec: (text) => s.unsafe(text),
  });
  return { ...wrap(sql), tx: (fn) => sql.begin((t) => fn(wrap(t))), close: () => sql.end({ timeout: 5 }) };
}

/** Adapter over PGlite (tests, local development without a server). */
export function pgliteDb(pg) {
  const wrap = (s) => ({
    query: async (text, params = []) => (await s.query(text, params)).rows,
    exec: (text) => s.exec(text),
  });
  return { ...wrap(pg), tx: (fn) => pg.transaction((t) => fn(wrap(t))), close: () => pg.close() };
}

export class BlobExistsError extends Error {
  code = 'BLOB_EXISTS';
}

/** Adapter over @vercel/blob, always with private access. */
export function vercelBlob(sdk) {
  return {
    async put(pathname, body, { contentType, overwrite = false } = {}) {
      try {
        await sdk.put(pathname, body, { access: 'private', addRandomSuffix: false, allowOverwrite: overwrite, contentType, cacheControlMaxAge: overwrite ? 60 : 31536000 });
      } catch (e) {
        if (!overwrite && /already exists/i.test(e.message)) throw new BlobExistsError(pathname);
        throw e;
      }
    },
    async get(pathname) {
      // useCache false: a consistent read, the CDN may still hold a deleted blob for a minute
      const r = await sdk.get(pathname, { access: 'private', useCache: false });
      if (!r || r.statusCode !== 200 || !r.stream) return null;
      return Buffer.from(await new Response(r.stream).arrayBuffer());
    },
    async list(prefix) {
      const out = [];
      let cursor;
      do {
        const r = await sdk.list({ prefix, cursor, limit: 1000 });
        for (const b of r.blobs) out.push({ pathname: b.pathname, uploadedAt: new Date(b.uploadedAt) });
        cursor = r.hasMore ? r.cursor : undefined;
      } while (cursor);
      return out;
    },
    async del(pathnames) {
      for (let i = 0; i < pathnames.length; i += 100) await sdk.del(pathnames.slice(i, i + 100));
    },
  };
}

/** In-memory blob store with the same behaviour (no overwrite unless asked). For tests. */
export class MemoryBlob {
  files = new Map();

  async put(pathname, body, { overwrite = false } = {}) {
    if (!overwrite && this.files.has(pathname)) throw new BlobExistsError(pathname);
    this.files.set(pathname, { data: Buffer.from(body), uploadedAt: new Date() });
  }

  async get(pathname) {
    const f = this.files.get(pathname);
    return f ? Buffer.from(f.data) : null;
  }

  async list(prefix) {
    return [...this.files].filter(([p]) => p.startsWith(prefix)).map(([pathname, f]) => ({ pathname, uploadedAt: f.uploadedAt })).sort((a, b) => a.pathname.localeCompare(b.pathname));
  }

  async del(pathnames) {
    for (const p of pathnames) this.files.delete(p);
  }
}

/** Database and blob store, with the schema migrated once before first use. */
export class VercelBackend {
  constructor({ db, blob }) {
    this.db = db;
    this.blob = blob;
    this.ready = null;
  }

  init() {
    this.ready ||= migrate(this.db).catch((e) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }
}

/** Environment variables the Vercel backend needs; the names of those missing (RF-VER-04). */
export function missingVercelConfig(env = process.env) {
  const missing = [];
  if (!env.DATABASE_URL && !env.POSTGRES_URL) missing.push('DATABASE_URL');
  if (!env.BLOB_READ_WRITE_TOKEN && !env.BLOB_STORE_ID) missing.push('BLOB_READ_WRITE_TOKEN (o BLOB_STORE_ID con OIDC)');
  return missing;
}

let backend = null;

/** The backend from the environment: postgres.js on DATABASE_URL, @vercel/blob with its own credentials. */
export async function vercelBackendFromEnv(env = process.env) {
  if (backend) return backend;
  const missing = missingVercelConfig(env);
  if (missing.length) throw new Error(`Configurazione mancante: ${missing.join(', ')}`);
  const [{ default: postgres }, sdk] = await Promise.all([import('postgres'), import('@vercel/blob')]);
  // One small pool per function instance; Neon's pooler handles the many instances.
  const sql = postgres(env.DATABASE_URL || env.POSTGRES_URL, { max: 5, idle_timeout: 20, prepare: false, onnotice: () => {}, types: PG_JSON_TYPES });
  backend = new VercelBackend({ db: postgresDb(sql), blob: vercelBlob(sdk) });
  return backend;
}

/** Uses a given backend (tests) instead of the one from the environment. */
export function setVercelBackend(b) {
  backend = b;
}

export const currentVercelBackend = () => backend;
