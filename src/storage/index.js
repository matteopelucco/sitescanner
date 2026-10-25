import path from 'node:path';
import { rootDir } from '../config.js';
import { FsStorage } from './fs.js';
import { VercelStorage } from './vercel/storage.js';
import { currentVercelBackend, setVercelBackend, vercelBackendFromEnv } from './vercel/backend.js';
import { FsAuthStore } from '../auth/store-fs.js';
import { PgAuthStore } from '../auth/store-pg.js';

/**
 * Storage of an area: the working folder in single-user mode (`area` null), or the private area
 * of an account ({ id, username }) in multi-user mode: users/<username>/ on the filesystem, or the
 * account's rows and blobs when the Vercel backend is active. See ADR-0017.
 */
export function storageFor(area = null, root = rootDir()) {
  if (!area) return new FsStorage(root);
  const backend = currentVercelBackend();
  return backend ? new VercelStorage(backend, area.id) : new FsStorage(path.join(root, 'users', area.username), { isolated: true });
}

/** Whether accounts and areas live on Postgres + Blob: always on Vercel, locally with SITESCANNER_STORAGE=vercel. */
export const vercelStorageWanted = (env = process.env) => env.VERCEL === '1' || env.SITESCANNER_STORAGE === 'vercel';

/**
 * Activates the storage backend chosen by the environment (once per process) and returns the store
 * of the accounts that goes with it.
 */
export async function initStorage({ root = rootDir(), env = process.env, backend = null } = {}) {
  if (backend) setVercelBackend(backend);
  else if (vercelStorageWanted(env)) setVercelBackend(await vercelBackendFromEnv(env));
  const b = currentVercelBackend();
  if (b) await b.init();
  return b ? new PgAuthStore(b) : new FsAuthStore(root);
}
