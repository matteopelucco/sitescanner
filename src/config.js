import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';

export function rootDir() {
  return path.resolve(process.env.SITESCANNER_HOME || process.cwd());
}

export const dirs = {
  get sites() { return path.join(rootDir(), 'sites'); },
  get data() { return path.join(rootDir(), 'data'); },
  get report() { return path.join(rootDir(), 'report'); },
};

export class UserError extends Error {}

const DEFAULTS = {
  start: ['/'],
  sitemap: true,
  maxPages: 200,
  maxDepth: 10,
  concurrency: 4,
  delayMs: 0,
  timeoutMs: 15000,
  respectRobots: true,
  include: [],
  exclude: [],
  ignoreQuery: false,
  userAgent: 'sitescanner/0.1 (+regression-scan)',
  headers: {},
  screenshots: { enabled: true, width: 1366, height: 900, fullPage: true, maxHeight: 10000, waitMs: 300, concurrency: 2, hide: [] },
  storeText: true,
  compare: { ignore: [], thresholds: {} },
};

// Replaces ${VAR} with environment values so credentials stay out of the YAML.
function interpolate(value) {
  if (typeof value === 'string') return value.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? '');
  if (Array.isArray(value)) return value.map(interpolate);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v)]));
  return value;
}

export function listSiteIds() {
  if (!fs.existsSync(dirs.sites)) return [];
  return fs.readdirSync(dirs.sites)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => f.replace(/\.ya?ml$/, ''))
    .sort();
}

export function siteFile(id) {
  for (const ext of ['yml', 'yaml']) {
    const f = path.join(dirs.sites, `${id}.${ext}`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

export function loadSite(id) {
  if (!/^[\w.-]+$/.test(id)) throw new UserError(`Id sito non valido: ${id}`);
  const file = siteFile(id);
  if (!file) throw new UserError(`Sito "${id}" non trovato in ${dirs.sites} (siti disponibili: ${listSiteIds().join(', ') || 'nessuno'})`);
  const raw = fs.readFileSync(file, 'utf8');
  let doc;
  try {
    doc = YAML.parse(raw) || {};
  } catch (e) {
    throw new UserError(`YAML non valido in ${file}: ${e.message}`);
  }
  const cfg = {
    ...DEFAULTS,
    ...doc,
    screenshots: { ...DEFAULTS.screenshots, ...(doc.screenshots || {}) },
    compare: { ...DEFAULTS.compare, ...(doc.compare || {}) },
  };
  cfg.id = id;
  cfg.name = doc.name || id;
  if (!cfg.envs || typeof cfg.envs !== 'object' || !Object.keys(cfg.envs).length) {
    throw new UserError(`${file}: serve almeno un ambiente in "envs" (es. envs: { prod: { baseUrl: https://… } })`);
  }
  for (const [env, e] of Object.entries(cfg.envs)) {
    if (!e || !e.baseUrl) throw new UserError(`${file}: envs.${env}.baseUrl mancante`);
    try { new URL(e.baseUrl); } catch { throw new UserError(`${file}: envs.${env}.baseUrl non è un URL valido: ${e.baseUrl}`); }
  }
  if (!Array.isArray(cfg.start)) cfg.start = [cfg.start];
  cfg.configHash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return cfg;
}

// Resolves an env block (with ${VAR} interpolation) for a scan.
export function resolveEnv(cfg, env) {
  const e = cfg.envs[env];
  if (!e) throw new UserError(`Ambiente "${env}" non definito per il sito "${cfg.id}" (disponibili: ${Object.keys(cfg.envs).join(', ')})`);
  const r = interpolate(e);
  return { name: env, baseUrl: r.baseUrl, auth: r.auth || null, headers: { ...cfg.headers, ...(r.headers || {}) } };
}

// Snapshot of the configuration stored inside the scan, with secrets removed.
export function redactedConfig(cfg) {
  const copy = JSON.parse(JSON.stringify(cfg));
  for (const e of Object.values(copy.envs || {})) {
    if (e.auth) e.auth = { username: e.auth.username ? '***' : undefined, password: '***' };
    if (e.headers) for (const k of Object.keys(e.headers)) if (/auth|cookie|token|key/i.test(k)) e.headers[k] = '***';
  }
  for (const k of Object.keys(copy.headers || {})) if (/auth|cookie|token|key/i.test(k)) copy.headers[k] = '***';
  return copy;
}

export const EXAMPLE_SITE = `# Configurazione di un sito per sitescanner.
# Il nome del file (senza estensione) è l'id del sito: sitescanner scan --site example --env prod
name: Example
envs:
  prod:
    baseUrl: https://example.com/
  # stage:
  #   baseUrl: https://stage.example.com/
  #   auth: { username: \${STAGE_USER}, password: \${STAGE_PASS} }   # variabili d'ambiente
  #   headers: { X-Preview: "1" }

start: ["/"]            # URL di partenza (relativi a baseUrl)
sitemap: true           # aggiunge gli URL di /sitemap.xml (o una lista di URL di sitemap)
maxPages: 200
maxDepth: 10
concurrency: 4
delayMs: 0              # pausa tra richieste per worker
timeoutMs: 15000
respectRobots: true
include: []             # regex sul path: se presenti, solo i path che ne soddisfano almeno una
exclude:                # regex sul path da escludere
  - "^/wp-admin"
  - "\\\\.(pdf|zip|jpg|jpeg|png|gif|svg|webp)$"
ignoreQuery: false      # true = tratta /a?x=1 e /a come la stessa pagina
storeText: true         # salva il testo estratto (abilita il diff testuale nel report)

screenshots:
  enabled: true
  width: 1366
  height: 900
  fullPage: true
  maxHeight: 10000
  waitMs: 300
  hide: []              # selettori CSS da nascondere (cookie banner, contenuti dinamici)

compare:
  ignore: []            # tipi di differenza da ignorare, es. [content-changed, perf-regression]
  thresholds: {}        # es. { contentWarnRatio: 0.3, visualWarn: 0.005 }
`;
