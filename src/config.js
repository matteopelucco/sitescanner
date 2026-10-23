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
  get inventory() { return path.join(rootDir(), 'inventory'); },
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
  ignoreParams: [],
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

export const validSiteId = (id) => /^[\w.-]+$/.test(String(id || '')) && !/^\.+$/.test(id);

export function loadSite(id) {
  if (!validSiteId(id)) throw new UserError(`Id sito non valido: ${id}`);
  const file = siteFile(id);
  if (!file) throw new UserError(`Sito "${id}" non trovato in ${dirs.sites} (siti disponibili: ${listSiteIds().join(', ') || 'nessuno'})`);
  return parseSite(id, fs.readFileSync(file, 'utf8'), file);
}

/** Parses and validates the YAML source of a site; `where` names it in error messages. */
export function parseSite(id, raw, where = `${id}.yml`) {
  let doc;
  try {
    doc = YAML.parse(raw) || {};
  } catch (e) {
    throw new UserError(`YAML non valido in ${where}: ${e.message}`);
  }
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new UserError(`${where}: il file deve contenere un oggetto YAML`);
  const cfg = {
    ...DEFAULTS,
    ...doc,
    screenshots: { ...DEFAULTS.screenshots, ...(doc.screenshots || {}) },
    compare: { ...DEFAULTS.compare, ...(doc.compare || {}) },
  };
  cfg.id = id;
  cfg.name = doc.name || id;
  if (!cfg.envs || typeof cfg.envs !== 'object' || !Object.keys(cfg.envs).length) {
    throw new UserError(`${where}: serve almeno un ambiente in "envs" (es. envs: { prod: { baseUrl: https://… } })`);
  }
  for (const [env, e] of Object.entries(cfg.envs)) {
    if (!e || !e.baseUrl) throw new UserError(`${where}: envs.${env}.baseUrl mancante`);
    try { new URL(e.baseUrl); } catch { throw new UserError(`${where}: envs.${env}.baseUrl non è un URL valido: ${e.baseUrl}`); }
  }
  if (!Array.isArray(cfg.start)) cfg.start = [cfg.start];
  for (const field of ['include', 'exclude']) {
    for (const r of cfg[field] || []) {
      try { new RegExp(r); } catch (e) { throw new UserError(`${where}: regex non valida in "${field}": ${r} (${e.message})`); }
    }
  }
  cfg.configHash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return cfg;
}

/** Configuration for a site that is not configured: defaults, one env, no screenshots. */
export function adhocSite(baseUrl, overrides = {}) {
  try { new URL(baseUrl); } catch { throw new UserError(`URL non valido: ${baseUrl}`); }
  const u = new URL(baseUrl);
  if (!/^https?:$/.test(u.protocol)) throw new UserError(`Solo URL http(s): ${baseUrl}`);
  return { ...DEFAULTS, id: u.host, name: u.host, envs: { web: { baseUrl } }, screenshots: { ...DEFAULTS.screenshots, enabled: false }, ...overrides };
}

export const siteDefaults = () => JSON.parse(JSON.stringify(DEFAULTS));

/**
 * Writes sites/<id>.yml after validating it. Returns the parsed configuration.
 * `create` refuses to overwrite an existing site.
 */
export function saveSite(id, raw, { create = false } = {}) {
  if (!validSiteId(id)) throw new UserError(`Id sito non valido: ${id} (ammessi lettere, cifre, "_", "-", ".")`);
  const existing = siteFile(id);
  if (create && existing) throw new UserError(`Il sito "${id}" esiste già`);
  const cfg = parseSite(id, raw);
  fs.mkdirSync(dirs.sites, { recursive: true });
  const file = existing || path.join(dirs.sites, `${id}.yml`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, raw);
  fs.renameSync(tmp, file);
  return cfg;
}

/** Removes only the configuration: the history in data/ stays reportable. */
export function deleteSite(id) {
  const file = validSiteId(id) && siteFile(id);
  if (!file) throw new UserError(`Sito "${id}" non trovato`);
  fs.rmSync(file);
}

/**
 * Applies the fields edited in the web form onto the YAML source, keeping comments and
 * every key the form does not manage. `form` has the same shape as the configuration;
 * `envs` lists every environment (missing ones are removed). Keys set to their default
 * are left out when the file did not have them.
 */
export function applySiteForm(raw, form) {
  const doc = YAML.parseDocument(raw || '');
  if (doc.errors.length) throw new UserError(`YAML non valido: ${doc.errors[0].message}`);
  if (!doc.contents || !YAML.isMap(doc.contents)) doc.contents = doc.createNode({});
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const put = (keys, value) => {
    const def = keys.reduce((o, k) => (o == null ? undefined : o[k]), DEFAULTS);
    if (value === undefined || value === null || value === '') {
      if (doc.hasIn(keys)) doc.deleteIn(keys);
      return;
    }
    if (!doc.hasIn(keys) && same(value, def)) return;
    if (same(doc.getIn(keys)?.toJSON?.() ?? doc.getIn(keys), value)) return;
    const node = doc.createNode(value, { flow: Array.isArray(value) && value.length <= 3 && value.every((v) => String(v).length < 30) });
    const prev = doc.getIn(keys, true);
    if (prev && prev.comment) node.comment = prev.comment;
    doc.setIn(keys, node);
  };
  const scalar = ['name', 'start', 'sitemap', 'maxPages', 'maxDepth', 'concurrency', 'delayMs', 'timeoutMs', 'respectRobots', 'include', 'exclude', 'ignoreQuery', 'ignoreParams', 'storeText', 'userAgent'];
  for (const k of scalar) if (k in form) put([k], form[k]);
  if (form.screenshots) for (const [k, v] of Object.entries(form.screenshots)) put(['screenshots', k], v);
  if (form.compare && 'ignore' in form.compare) put(['compare', 'ignore'], form.compare.ignore);
  if (form.envs) {
    const names = Object.keys(form.envs);
    const cur = doc.get('envs');
    if (YAML.isMap(cur)) for (const k of cur.items.map((i) => String(i.key?.value ?? i.key))) if (!names.includes(k)) doc.deleteIn(['envs', k]);
    for (const [name, e] of Object.entries(form.envs)) {
      if (!/^[\w.-]+$/.test(name)) throw new UserError(`Nome ambiente non valido: ${name}`);
      doc.setIn(['envs', name, 'baseUrl'], e.baseUrl);
      if (e.auth && e.auth.username) doc.setIn(['envs', name, 'auth'], doc.createNode({ username: e.auth.username, password: e.auth.password || '' }, { flow: true }));
      else if (doc.hasIn(['envs', name, 'auth'])) doc.deleteIn(['envs', name, 'auth']);
    }
  }
  return doc.toString();
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
ignoreParams: []        # parametri di query da ignorare oltre a quelli di tracciamento noti
                        # (utm_*, gclid, fbclid, intcmp, …); "*" finale = qualsiasi suffisso
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
