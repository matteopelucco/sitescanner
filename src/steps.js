// Jobs in steps (spec §11.4, ADR-0018). A job definition is
//   { step(state, ctx) → Promise<{ done, value? }>, discard(state, ctx) }
// where `state` is plain JSON, changed in place by each step, and ctx = { st, log, onProgress, signal, deadline }.
// A step works until ctx.deadline (ms since epoch) and stops at a safe point; the next step continues
// from the state. Locally the steps run one after another in this process; on Vercel each one is a
// message of Vercel Queues, possibly handled by another function instance (src/jobs.js).

/** Time a step may work: SITESCANNER_STEP_BUDGET_MS, by default 4 minutes on Vercel and unlimited locally. */
export function stepBudgetMs(env = process.env) {
  const v = Number(env.SITESCANNER_STEP_BUDGET_MS);
  if (env.SITESCANNER_STEP_BUDGET_MS !== undefined && env.SITESCANNER_STEP_BUDGET_MS !== '' && v >= 0) return v;
  return env.VERCEL === '1' ? 240000 : Infinity;
}

/**
 * Runs every step of a job in this process. Between steps the state goes through JSON, as it would
 * between two function instances, so local runs prove it is serializable. On error the job's
 * leftovers are discarded and the error is rethrown.
 * `onStep(state, n)` is called after each incomplete step (tests).
 */
export async function runLocal(def, state, ctx, { budgetMs = stepBudgetMs(), onStep = null } = {}) {
  let s = state;
  try {
    for (let n = 0; ; n++) {
      const r = await def.step(s, { ...ctx, deadline: Date.now() + budgetMs });
      if (r.done) return r.value;
      s = JSON.parse(JSON.stringify(s));
      if (onStep) s = (await onStep(s, n)) || s;
    }
  } catch (e) {
    await def.discard(s, ctx).catch(() => {});
    throw e;
  }
}
