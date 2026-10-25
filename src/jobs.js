import crypto from 'node:crypto';
import { dirs, UserError } from './config.js';
import { storageFor } from './storage/index.js';
import { scanJob, scanState } from './scan.js';
import { inventoryJob, inventoryState } from './inventory.js';
import { buildReport } from './report/build.js';
import { runLocal, stepBudgetMs } from './steps.js';
import { queueTransport } from './queue.js';

// Scans and inventories started from the web app are jobs in steps (src/steps.js, ADR-0018).
// Locally they run in this process, in background; jobs live in memory only: what lasts is what they
// write (scans in data/, inventories in inventory/).
// When the storage persists jobs and a queue is available (Vercel), each step is a queue message,
// handled by processStep() in any function instance: the job's view, state and step number are in the
// storage, so every instance can list jobs, show their progress and ask to cancel them.

const MAX_JOBS = 50;
const MAX_LOG = 300;
const PROGRESS_EVERY_MS = 250;
const SAVE_EVERY_MS = 1000;
const CANCEL_CHECK_MS = 2000;

const jobs = new Map();
const listeners = new Set();

/** Public view of a job; the log is included only on request because it can be long. */
export function jobView(job, { withLog = false } = {}) {
  const { controller, lastEmit, timer, log, storage, lastSave, saving, lastCancelCheck, ...rest } = job;
  return withLog ? { ...rest, log } : { ...rest, logTail: log.slice(-5) };
}

// Saves the job where other instances can see it (throttled; the final state always).
function persist(job, final = false) {
  const st = job.storage;
  if (!st || !st.persistsJobs) return;
  const now = Date.now();
  if (!final && now - (job.lastSave || 0) < SAVE_EVERY_MS) return;
  job.lastSave = now;
  const view = jobView(job, { withLog: true });
  view.log = view.log.slice(-MAX_LOG);
  job.saving = (job.saving || Promise.resolve()).then(() => st.saveJob(view)).catch((e) => console.error(`Job ${job.id} non salvato: ${e.message}`));
  // A cancel requested from another instance arrives through the storage.
  if (!final && job.status === 'running' && now - (job.lastCancelCheck || 0) > CANCEL_CHECK_MS) {
    job.lastCancelCheck = now;
    st.cancelRequested(job.id).then((yes) => {
      if (yes && job.status === 'running') {
        job.cancelling = true;
        job.controller.abort();
      }
    }, () => {});
  }
}

// `seq` grows at every change sent, so clients can drop views older than the one they have
// (the POST response that starts a job can arrive after its first SSE events).
function emit(job) {
  job.seq++;
  job.lastEmit = Date.now();
  clearTimeout(job.timer);
  job.timer = null;
  const view = jobView(job);
  for (const fn of listeners) fn(view, job.area);
  persist(job, job.status !== 'running' || job.seq === 1);
}

// Progress events arrive per page: forward at most a few per second.
function emitThrottled(job) {
  const wait = PROGRESS_EVERY_MS - (Date.now() - (job.lastEmit || 0));
  if (wait <= 0) emit(job);
  else if (!job.timer) job.timer = setTimeout(() => emit(job), wait);
}

/** Subscribes to every job change, as fn(view, area); returns the unsubscribe function. */
export function onJobChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Jobs belong to the storage area that started them; `st` null means every area.
const inArea = (j, st) => !st || j.area === st.key;

export function listJobs(st = null) {
  return [...jobs.values()].reverse().filter((j) => inArea(j, st)).map((j) => jobView(j));
}

/** Jobs of an area, including those of other instances when the storage persists them. */
export async function listJobsOf(st) {
  const local = listJobs(st);
  if (!st.persistsJobs) return local;
  const seen = new Set(local.map((j) => j.id));
  const stored = (await st.listJobs(MAX_JOBS)).filter((v) => !seen.has(v.id)).map(({ log, ...v }) => ({ ...v, logTail: (log || []).slice(-5) }));
  return [...local, ...stored].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export function getJob(id, st = null) {
  const j = jobs.get(id);
  if (!j || !inArea(j, st)) throw Object.assign(new UserError(`Job ${id} non trovato`), { status: 404 });
  return j;
}

/** Detail of a job, with its log, from this instance or from the storage. */
export async function jobDetail(id, st) {
  const j = jobs.get(id);
  if (j && inArea(j, st)) return jobView(j, { withLog: true });
  const v = st.persistsJobs ? await st.getJob(id) : null;
  if (!v) throw Object.assign(new UserError(`Job ${id} non trovato`), { status: 404 });
  return { ...v, log: v.log || [] };
}

export function cancelJob(id, st = null) {
  const j = getJob(id, st);
  if (j.status !== 'running') throw new UserError(`Il job ${id} non è in esecuzione`);
  j.controller.abort();
  j.cancelling = true;
  emit(j);
  return jobView(j);
}

/** Cancels a job running here or, through the storage, in another instance or between two steps. */
export async function cancelJobOf(id, st) {
  const j = jobs.get(id);
  if ((j && inArea(j, st) && j.status === 'running') || !st.persistsJobs) return cancelJob(id, st);
  const v = await st.getJob(id);
  if (!v) throw Object.assign(new UserError(`Job ${id} non trovato`), { status: 404 });
  if (v.status !== 'running' || !(await st.requestCancel(id))) throw new UserError(`Il job ${id} non è in esecuzione`);
  return { ...v, cancelling: true, log: undefined };
}

function prune() {
  for (const [id, j] of jobs) {
    if (jobs.size <= MAX_JOBS) break;
    if (j.status !== 'running') jobs.delete(id);
  }
}

const positive = (v, name) => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new UserError(`${name} deve essere un intero positivo`);
  return n;
};

/** The job running on a site (scan or inventory) of an area, if any. */
export function siteJob(site, st = storageFor()) {
  return [...jobs.values()].find((j) => j.status === 'running' && j.area === st.key && j.lock === `site:${site}`) || null;
}

/** Jobs running in an area (in this process). */
export function runningJobs(st) {
  return [...jobs.values()].filter((j) => j.status === 'running' && inArea(j, st));
}

/** Jobs running in an area, in any instance. */
export async function runningJobsOf(st) {
  if (!st.persistsJobs) return listJobs(st).filter((j) => j.status === 'running');
  return (await listJobsOf(st)).filter((j) => j.status === 'running');
}

// On Vercel the function must stay alive until the work it started ends, within its maxDuration.
async function keepAlive(promise) {
  if (process.env.VERCEL !== '1') return;
  try {
    const { waitUntil } = await import('@vercel/functions');
    waitUntil(promise);
  } catch { /* outside a request context */ }
}

/**
 * What a job does, from its parameters (validated here):
 * scan:      { type: 'scan', site, env, label?, note?, noScreenshots?, keepHtml?, maxPages? }
 * inventory: { type: 'inventory', url } or { type: 'inventory', site, env }, plus maxPages?, maxDepth?, concurrency?
 */
function defineJob(p) {
  if (p.type === 'scan') {
    if (!p.site || !p.env) throw new UserError('Per una scan servono sito e ambiente');
    const opts = { label: p.label || undefined, note: p.note || undefined, noScreenshots: !!p.noScreenshots, keepHtml: !!p.keepHtml, maxPages: positive(p.maxPages, 'maxPages') };
    return {
      def: scanJob,
      initial: () => scanState(p.site, p.env, opts),
      lock: `site:${p.site}`,
      title: `Scan ${p.site} [${p.env}]${p.label ? ` «${p.label}»` : ''}`,
      result: (s) => ({ scanId: s.id, site: s.site, stats: s.stats, truncated: s.crawl.truncated, screenshots: s.options.screenshots, screenshotsSkipped: s.options.screenshotsSkipped || null }),
    };
  }
  if (p.type === 'inventory') {
    const o = { maxPages: positive(p.maxPages, 'maxPages'), maxDepth: positive(p.maxDepth, 'maxDepth'), concurrency: positive(p.concurrency, 'concurrency') };
    if (p.url) Object.assign(o, { url: String(p.url).trim() });
    else if (p.site && p.env) Object.assign(o, { site: p.site, env: p.env });
    else throw new UserError('Per un inventario serve un URL oppure sito e ambiente');
    return {
      def: inventoryJob,
      initial: () => inventoryState(o),
      lock: o.site ? `site:${o.site}` : null,
      title: `Inventario ${o.url || `${o.site} [${o.env}]`}`,
      result: (inv) => ({ inventoryId: inv.id, baseUrl: inv.baseUrl, urls: inv.summary.urls, htmlPages: inv.summary.htmlPages, maxClickDepth: inv.summary.clickDepth.max, truncated: inv.crawl.truncated }),
    };
  }
  throw new UserError(`Tipo di job sconosciuto: ${p.type}`);
}

function hooksFor(job) {
  return {
    signal: job.controller.signal,
    log: (m) => {
      job.log.push(m);
      if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
    },
    onProgress: (pr) => {
      job.progress = { ...job.progress, ...pr };
      if (!pr.current) delete job.progress.current;
      if (pr.phase !== 'crawl' && pr.phase !== 'screenshots') emit(job);
      else emitThrottled(job);
    },
  };
}

function settle(job, hooks, e) {
  if (job.controller.signal.aborted) job.status = 'cancelled';
  else {
    job.status = 'failed';
    job.error = e instanceof UserError ? e.message : e.message || String(e);
    if (!(e instanceof UserError)) hooks.log(e.stack || String(e));
  }
}

async function afterScan(job, st, hooks) {
  if (job.type !== 'scan' || st.kind !== 'fs' || st.root !== storageFor().root) return;
  hooks.onProgress({ phase: 'report' });
  try {
    await buildReport({ outDir: dirs.report, storage: st });
  } catch (e) {
    hooks.log(`Report non aggiornato: ${e.message}`);
  }
}

/** Starts a job and returns it immediately. */
export async function startJob(params, { storage: st = storageFor(), maxRunning = Infinity } = {}) {
  const p = params || {};
  const spec = defineJob(p);
  const running = await runningJobsOf(st);
  if (running.length >= maxRunning) throw Object.assign(new UserError(`Hai già ${maxRunning} job in corso: attendi la fine di uno di essi`), { status: 429 });
  if (spec.lock) {
    const busy = running.find((j) => j.lock === spec.lock);
    if (busy) throw new UserError(`C'è già un job in corso su questo sito: ${busy.title}`);
  }
  const send = st.persistsJobs ? await queueTransport() : null;

  const job = {
    id: crypto.randomBytes(4).toString('hex'),
    type: p.type,
    title: spec.title,
    lock: spec.lock,
    area: st.key,
    params: { ...p },
    status: 'running',
    seq: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    progress: { phase: 'start' },
    result: null,
    error: null,
    log: [],
    controller: new AbortController(),
    storage: st,
  };
  const hooks = hooksFor(job);

  if (send) {
    // In steps through the queue: the view and the state go to the storage, the first step to the
    // queue. The job is not kept in memory: from now on the storage is its only source.
    job.queued = true;
    emit(job);
    await job.saving;
    await st.saveJobState(job.id, spec.initial());
    await send({ area: st.area, jobId: job.id, step: 0 });
    return job;
  }

  jobs.set(job.id, job);
  prune();
  emit(job);
  const done = runLocal(spec.def, spec.initial(), { st, ...hooks })
    .then(async (value) => {
      job.result = spec.result(value);
      await afterScan(job, st, hooks);
      job.status = 'done';
    }, (e) => settle(job, hooks, e))
    .finally(() => {
      job.finishedAt = new Date().toISOString();
      delete job.cancelling;
      emit(job);
      return job.saving;
    });
  keepAlive(done);
  return job;
}

/**
 * Handles one step message { area, jobId, step } (Vercel Queues consumer, ADR-0018). Idempotent:
 * a step already done, out of order or running elsewhere (lease) is ignored, so a message delivered
 * twice changes nothing. `storage` is the storage of the message's area.
 */
export async function processStep(msg, { storage: st, budgetMs = stepBudgetMs(), send = null } = {}) {
  const step = Number(msg.step);
  if (!(await st.claimStep(msg.jobId, step, budgetMs + 60000))) return { ignored: true };
  const view = await st.getJob(msg.jobId);
  const state = await st.loadJobState(msg.jobId);
  const job = { ...view, log: view.log || [], controller: new AbortController(), storage: st, area: st.key };
  delete job.logTail;
  const hooks = hooksFor(job);
  const spec = defineJob(job.params);
  const end = async () => {
    job.finishedAt = new Date().toISOString();
    delete job.cancelling;
    emit(job);
    await job.saving;
    await st.deleteJobState(job.id).catch(() => {});
    await st.finishStep(job.id, step);
    return { status: job.status };
  };

  if (!state || (await st.cancelRequested(job.id))) {
    if (state) await spec.def.discard(state, { st }).catch(() => {});
    job.status = state ? 'cancelled' : 'failed';
    if (!state) job.error = 'stato del job non trovato';
    return end();
  }
  let r;
  try {
    r = await spec.def.step(state, { st, ...hooks, deadline: Date.now() + budgetMs });
  } catch (e) {
    await spec.def.discard(state, { st }).catch(() => {});
    settle(job, hooks, e);
    return end();
  }
  if (r.done) {
    job.result = spec.result(r.value);
    job.status = 'done';
    return end();
  }
  await st.saveJobState(job.id, state);
  emit(job);
  await job.saving;
  await st.finishStep(job.id, step);
  const deliver = send || (await queueTransport());
  await deliver({ area: msg.area, jobId: msg.jobId, step: step + 1 });
  return { status: 'running', step: step + 1 };
}
