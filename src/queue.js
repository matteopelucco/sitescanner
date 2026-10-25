// Transport of the step messages of jobs (ADR-0018): Vercel Queues on Vercel, none locally
// (steps run in process), a function given by the tests. Everything about @vercel/queue stays here.

export const STEP_TOPIC = 'sitescanner-steps';

let custom = null;

/** Replaces the transport (tests): fn(message) delivers or stores the message. null restores the default. */
export function setQueueTransport(fn) {
  custom = fn;
}

/** The function that sends a step message, or null when steps run in this process. */
export async function queueTransport(env = process.env) {
  if (custom) return custom;
  if (env.VERCEL !== '1') return null;
  const { send } = await import('@vercel/queue');
  // The key drops a message sent twice (e.g. a step retried after sending it); delivery stays at-least-once.
  return (msg) => send(STEP_TOPIC, msg, { idempotencyKey: `${msg.area}:${msg.jobId}:${msg.step}` });
}

/** Consumer of the step messages for the Vercel Function (req, res); `handle(message)` processes one. */
export async function queueConsumer(handle) {
  const { QueueClient } = await import('@vercel/queue');
  return new QueueClient().handleNodeCallback((message) => handle(message));
}
