import { createHandler } from './server.js';
import { initStorage } from './storage/index.js';
import { missingVercelConfig } from './storage/vercel/backend.js';

/**
 * Request handler of the Vercel Function (spec §11.1): the web app in multi-user mode, with accounts
 * and areas on Postgres + Blob. Without the required configuration every request gets 503 with the
 * names of the missing variables (RF-VER-04). `backend` replaces the one from the environment (tests).
 */
export function createVercelHandler({ env = process.env, backend = null } = {}) {
  const missing = backend ? [] : missingVercelConfig(env);
  if (missing.length) {
    return (req, res) => {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: `sitescanner non è configurato: mancano ${missing.join(', ')}`, missing }));
    };
  }
  return createHandler({ multi: true, trustProxy: true, authStore: initStorage({ env: { ...env, VERCEL: '1' }, backend }) });
}

/**
 * Consumer of the step messages (Vercel Queues, ADR-0018): runs one step of a job in the area of the
 * message. Errors of the step itself end the job (processStep); only infrastructure errors are thrown,
 * so that the queue delivers the message again.
 */
export function createStepConsumer({ env = process.env } = {}) {
  let consumer = null;
  const ready = (async () => {
    const [{ queueConsumer }, { processStep }, { VercelStorage }, { vercelBackendFromEnv }] = await Promise.all([
      import('./queue.js'), import('./jobs.js'), import('./storage/vercel/storage.js'), import('./storage/vercel/backend.js'),
    ]);
    const backend = await initStorage({ env: { ...env, VERCEL: '1' } }).then(() => vercelBackendFromEnv(env));
    consumer = await queueConsumer((msg) => processStep(msg, { storage: new VercelStorage(backend, msg.area) }));
  })();
  ready.catch(() => {}); // reported to each request below
  return async (req, res) => {
    try {
      await ready;
    } catch (e) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: `Consumer non disponibile: ${e.message}` }));
    }
    return consumer(req, res);
  };
}

/**
 * Function of a region that runs the checks asked by the main one (spec §13.6, RF-LOC-02): `POST /api/check/<location>`,
 * signed with the internal secret. There is one entry per region in vercel.json, because a Function has one region.
 */
export function createCheckHandler({ env = process.env } = {}) {
  // a start that failed (the database not reachable at that moment) is tried again by the next request
  let ready = null;
  const start = () => (ready ||= initStorage({ env: { ...env, VERCEL: '1' } }).catch((e) => { ready = null; throw e; }));
  return async (req, res) => {
    try {
      await start();
      const { handleInternalCheck } = await import('./monitor/api.js');
      if (await handleInternalCheck(req, res, new URL(req.url, 'http://x'))) return;
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (e) {
      res.writeHead(e.status || 503, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: `Controllo non disponibile: ${e.message}` }));
    }
  };
}
