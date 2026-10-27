// The local agent (spec §13.14, RF-AGT-01, ADR-0025): a private location that runs the checks from a machine inside the
// network of the customer. Pure.

export const AGENT_TOKEN_PREFIX = 'ssa_';
export const POLL_S = 30;
/** Jobs the agent may take in one poll. */
export const MAX_JOBS_PER_POLL = 10;

/** The location id of an agent: «p-» and the 10 hex digits of its id (it fits the 2–12 characters of a location). */
export const agentLocationId = (agent) => `p-${agent.id}`;
export const isPrivateLocation = (loc) => /^p-[0-9a-f]{10}$/.test(String(loc || ''));
export const agentIdOf = (loc) => String(loc).slice(2);
export const locationLabel = (agent) => `Privata · ${agent.name}`;

/** How long without a poll before an agent counts as stopped: three polls, never less than two minutes. */
export const offlineAfterMs = (pollS = POLL_S) => Math.max(120000, 3 * pollS * 1000);

/** `waiting` (never connected), `online` or `offline`. */
export function agentStatus(agent, now) {
  if (!agent.lastSeenAt) return 'waiting';
  return now - agent.lastSeenAt > offlineAfterMs(agent.pollS || POLL_S) ? 'offline' : 'online';
}

/**
 * What the beat of an agent says (RF-AGT-01, like RF-MON-19): `missed` once when it stops (a connected agent that no
 * longer polls), `back` once when it returns; null otherwise. `agent.alerted` remembers that the alert went out.
 */
export function agentTransition(agent, now) {
  const s = agentStatus(agent, now);
  if (s === 'offline' && !agent.alerted) return 'missed';
  if (s === 'online' && agent.alerted) return 'back';
  return null;
}

export function normalizeAgentName(name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('Dai un nome all\'agente (per esempio la sede o la rete)');
  if (n.length > 40) throw new Error('Il nome può avere al massimo 40 caratteri');
  return n;
}
