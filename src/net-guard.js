import dns from 'node:dns';
import net from 'node:net';

// RF-SEC-01: in multi-user mode crawls and screenshots must not reach the server's own network
// (loopback, private ranges, link-local and so cloud metadata endpoints, CGNAT, reserved).
// The check runs on the address actually connected, inside the DNS lookup of each connection,
// so a name that resolves to a public address first and a private one later (DNS rebinding) is caught too.

const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

const v4num = (ip) => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0);

function v4Blocked(ip) {
  const n = v4num(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const b = v4num(base);
    return n >= b && n < b + size;
  });
}

function expandV6(ip) {
  let s = ip.toLowerCase().split('%')[0];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = v4num(v4[1]);
    s = s.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail = ''] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = s.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = s.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return groups.map((g) => parseInt(g || '0', 16));
}

/** True if the address must not be reached from a private area. */
export function isBlockedAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return v4Blocked(ip);
  if (kind !== 6) return true;
  const g = expandV6(ip);
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d): judge the embedded IPv4 address
  if ((g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) || (g[0] === 0x64 && g[1] === 0xff9b)) {
    return v4Blocked(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

/** Whether the check applies: private areas, unless allowed locally (never on Vercel). */
export function networkGuardEnabled(isolated) {
  if (!isolated) return false;
  if (process.env.VERCEL === '1') return true;
  return process.env.SITESCANNER_ALLOW_PRIVATE_NETWORKS !== '1';
}

export class BlockedDestinationError extends Error {
  code = 'EBLOCKED';
  blocked = true;
  constructor(host) {
    super(`destinazione non ammessa: ${host}`);
  }
}

/** True if an error (or its cause, as thrown by fetch) comes from the guard. */
export const blockedError = (e) => !!(e && (e.blocked || (e.cause && (e.cause.blocked || (e.cause.cause && e.cause.cause.blocked)))));

// dns.lookup with the same signature, refusing blocked addresses.
export function guardedLookup(hostname, options, callback) {
  if (typeof options === 'function') [callback, options] = [options, {}];
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
    if (!list.length || list.some((a) => isBlockedAddress(a.address))) return callback(new BlockedDestinationError(hostname));
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

/** Throws if the host of a URL is a blocked IP literal (no DNS lookup happens for those). */
export function assertUrlAllowed(url) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedAddress(host)) throw new TypeError('fetch failed', { cause: new BlockedDestinationError(host) });
}

/** Resolves a host and tells whether it is blocked (for the browser, which resolves on its own). */
export async function hostBlocked(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return isBlockedAddress(host);
  try {
    const list = await dns.promises.lookup(host, { all: true });
    return !list.length || list.some((a) => isBlockedAddress(a.address));
  } catch {
    return false; // unresolvable: the request fails anyway
  }
}

let agent = null;

/**
 * fetch for a crawl: the global one, or (guarded) undici's fetch with a dispatcher whose
 * connections go through guardedLookup.
 */
export async function crawlFetch(guarded) {
  if (!guarded) return fetch;
  const undici = await import('undici');
  agent ||= new undici.Agent({ connect: { lookup: guardedLookup } });
  // Redirects are followed here, so that every hop (IP literals included) is checked.
  return async function guardedFetch(url, opts = {}) {
    let current = String(url);
    for (let hop = 0; ; hop++) {
      assertUrlAllowed(current);
      const res = await undici.fetch(current, { ...opts, redirect: 'manual', dispatcher: agent });
      const loc = res.headers.get('location');
      if (opts.redirect === 'manual' || res.status < 300 || res.status >= 400 || !loc) return res;
      if (hop >= 10) throw new TypeError('fetch failed', { cause: new Error('troppi redirect') });
      await res.body?.cancel();
      current = new URL(loc, current).href;
    }
  };
}
