import crypto from 'node:crypto';
import { dirs, UserError } from './config.js';
import { scanSite } from './scan.js';
import { runInventory } from './inventory.js';
import { buildReport } from './report/build.js';

// Scans and inventories started from the web app run in this process, in background.
// Jobs live in memory only: what lasts is what they write (scans in data/, inventories in inventory/).

const MAX_JOBS = 50;
const MAX_LOG = 300;
const PROGRESS_EVERY_MS = 250;

const jobs = new Map();
const listeners = new Set();

/** Public view of a job; the log is included only on request because it can be long. */
export function jobView(job, { withLog = false } = {}) {
  const { controller, lastEmit, timer, log, ...rest } = job;
  return withLog ? { ...rest, log } : { ...rest, logTail: log.slice(-5) };
}

// `seq` grows at every change sent, so clients can drop views older than the one they have
// (the POST response that starts a job can arrive after its first SSE events).
function emit(job) {
  job.seq++;
  job.lastEmit = Date.now();
  clearTimeout(job.timer);
  job.timer = null;
  const view = jobView(job);
  for (const fn of listeners) fn(view);
}

// Progress events arrive per page: forward at most a few per second.
function emitThrottled(job) {
  const wait = PROGRESS_EVERY_MS - (Date.now() - (job.lastEmit || 0));
  if (wait <= 0) emit(job);
  else if (!job.timer) job.timer = setTimeout(() => emit(job), wait);
}

/** Subscribes to every job change; returns the unsubscribe function. */
export function onJobChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function listJobs() {
  return [...jobs.values()].reverse().map((j) => jobView(j));
}

export function getJob(id) {
  const j = jobs.get(id);
  if (!j) throw new UserError(`Job ${id} non trovato`);
  return j;
}

export function cancelJob(id) {
  const j = getJob(id);
  if (j.status !== 'running') throw new UserError(`Il job ${id} non è in esecuzione`);
  j.controller.abort();
  j.cancelling = true;
  emit(j);
  return jobView(j);
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

/**
 * Starts a job and returns it immediately.
 * scan:      { type: 'scan', site, env, label?, note?, noScreenshots?, maxPages? }
 * inventory: { type: 'inventory', url } or { type: 'inventory', site, env }, plus maxPages?, maxDepth?, concurrency?
 */
export function startJob(params) {
  const p = params || {};
  let run, lock, title;
  if (p.type === 'scan') {
    if (!p.site || !p.env) throw new UserError('Per una scan servono sito e ambiente');
    const opts = { label: p.label || undefined, note: p.note || undefined, noScreenshots: !!p.noScreenshots, keepHtml: !!p.keepHtml, maxPages: positive(p.maxPages, 'maxPages') };
    lock = `site:${p.site}`;
    title = `Scan ${p.site} [${p.env}]${p.label ? ` «${p.label}»` : ''}`;
    run = async (job, hooks) => {
      const s = await scanSite(p.site, p.env, { ...opts, ...hooks }, hooks.log);
      job.result = { scanId: s.id, site: s.site, stats: s.stats, truncated: s.crawl.truncated, screenshots: s.options.screenshots, screenshotsSkipped: s.options.screenshotsSkipped || null };
      hooks.onProgress({ phase: 'report' });
      try {
        buildReport({ outDir: dirs.report });
      } catch (e) {
        hooks.log(`Report non aggiornato: ${e.message}`);
      }
    };
  } else if (p.type === 'inventory') {
    const o = { maxPages: positive(p.maxPages, 'maxPages'), maxDepth: positive(p.maxDepth, 'maxDepth'), concurrency: positive(p.concurrency, 'concurrency') };
    if (p.url) Object.assign(o, { url: String(p.url).trim() });
    else if (p.site && p.env) Object.assign(o, { site: p.site, env: p.env });
    else throw new UserError('Per un inventario serve un URL oppure sito e ambiente');
    lock = o.site ? `site:${o.site}` : null;
    title = `Inventario ${o.url || `${o.site} [${o.env}]`}`;
    run = async (job, hooks) => {
      const inv = await runInventory(o, hooks);
      job.result = { inventoryId: inv.id, baseUrl: inv.baseUrl, urls: inv.summary.urls, htmlPages: inv.summary.htmlPages, maxClickDepth: inv.summary.clickDepth.max, truncated: inv.crawl.truncated };
    };
  } else {
    throw new UserError(`Tipo di job sconosciuto: ${p.type}`);
  }

  if (lock) {
    const busy = [...jobs.values()].find((j) => j.status === 'running' && j.lock === lock);
    if (busy) throw new UserError(`C'è già un job in corso su questo sito: ${busy.title}`);
  }

  const job = {
    id: crypto.randomBytes(4).toString('hex'),
    type: p.type,
    title,
    lock,
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
  };
  jobs.set(job.id, job);
  prune();

  const hooks = {
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
  emit(job);
  run(job, hooks).then(
    () => { job.status = 'done'; },
    (e) => {
      if (job.controller.signal.aborted) job.status = 'cancelled';
      else {
        job.status = 'failed';
        job.error = e instanceof UserError ? e.message : e.message || String(e);
        if (!(e instanceof UserError)) hooks.log(e.stack || String(e));
      }
    },
  ).finally(() => {
    job.finishedAt = new Date().toISOString();
    delete job.cancelling;
    emit(job);
  });
  return job;
}
