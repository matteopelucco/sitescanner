import os from 'node:os';
import { performCheck } from './check.js';
import { POLL_S, MAX_JOBS_PER_POLL } from '../core/agent.js';

// The local agent, on the machine of the customer (spec §13.14, RF-AGT-01, ADR-0025): `sitescanner monitor agent`.
// It only makes requests out: it asks the deployment for runs (poll), runs them with the network it is in, and hands
// back the results. No port is opened.

const VERSION = '1';
const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

export class AgentAuthError extends Error {}

/**
 * Polls until `signal` aborts (or once, with `once`). `log(line)` reports what happens. Returns the number of runs done.
 * A token that is refused ends the agent with AgentAuthError: asking again would not help.
 */
export async function runAgent({ url, token, pollS = POLL_S, concurrency = 4, once = false, signal = null, log = () => {}, fetcher = fetch }) {
  const base = String(url).replace(/\/$/, '');
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const post = async (p, body) => {
    const res = await fetcher(`${base}${p}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (res.status === 401) throw new AgentAuthError('Token dell\'agente non valido o agente eliminato');
    return res;
  };
  let done = 0;
  let announced = false, name = 'agente';
  while (!signal?.aborted) {
    try {
      const res = await post('/api/agent/poll', { version: VERSION, host: os.hostname(), pollS, max: Math.min(concurrency, MAX_JOBS_PER_POLL) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      name = data.name;
      if (!announced) { log(`Collegato come «${name}» a ${base}`); announced = true; }
      const queue = [...data.jobs];
      const worker = async () => {
        while (queue.length) {
          const job = queue.shift();
          const result = await performCheck(job.monitor, { guard: false, detail: true, location: `privata-${name.replace(/[^\w.-]+/g, '-')}` }).catch((e) => ({ at: Date.now(), outcome: 'error', errorClass: 'agente', error: e.message }));
          const sent = await post('/api/agent/result', { id: job.id, result });
          log(`${result.outcome === 'error' ? '✖' : '✔'} ${job.monitor.name}${result.error ? ` — ${result.error}` : ''}${sent.ok ? '' : ` (consegna: HTTP ${sent.status})`}`);
          done++;
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    } catch (e) {
      if (e instanceof AgentAuthError) throw e;
      log(`Il servizio non risponde (${e.message}): riprovo tra ${pollS} s`);
    }
    if (once) break;
    await sleep(pollS * 1000, signal);
  }
  return done;
}
