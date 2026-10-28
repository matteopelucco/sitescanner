import YAML from 'yaml';

// The file of the monitors (spec §13.13, RF-MAC-01): `sitescanner.monitors.yml`, kept with the site in git. Pure: reading,
// the structure with errors that tell file, line and field, and writing back (RF-MAC-03).

export const FILE_VERSION = 1;
export const CODE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The fields of a monitor that the file may contain (the same names as the API). Credentials and tokens are not among them. */
export const MONITOR_FIELDS = new Set([
  'id', 'type', 'name', 'url', 'method', 'assertions', 'bodyType', 'body', 'contentType', 'headers', 'intervalMin', 'timeoutS', 'degradedMs', 'failedMs', 'notifyDegraded', 'followRedirects',
  'skipSsl', 'shouldFail', 'ipVersion', 'description', 'sslDays', 'slaPct', 'tags', 'retry', 'locations', 'locStrategy', 'alertPolicy', 'vars', 'channels',
  'expectedMin', 'toleranceMin', 'host', 'port', 'tcpSend', 'tcpExpect', 'minTls', 'checkDomain', 'domainDays', 'dnsName', 'recordType', 'resolver', 'dnsAssertions',
  'waitSelector', 'waitText', 'failOnJsErrors',
]);
export const WINDOW_FIELDS = new Set(['id', 'name', 'type', 'start', 'days', 'time', 'dayOfMonth', 'every', 'unit', 'until', 'durationMin', 'monitors', 'tags']);

const FORBIDDEN = {
  auth: 'le credenziali non vanno nel file: usa un header con un segreto, per esempio «Authorization: Basic {{SEGRETO}}» (pagina Variabili)',
  hbToken: "l'indirizzo segreto di un heartbeat lo genera il servizio: non si scrive nel file",
  state: 'lo stato è del servizio', managedBy: 'è impostato da sitescanner', codeId: 'è impostato da sitescanner', createdAt: 'è impostato da sitescanner',
};

/**
 * Reads a file of monitors. Returns { monitors: [{ id, line, fields, lines }], maintenance: [...], errors: [{ line, path, message }] }:
 * every problem has the line and the field, so that a CI log leads to it.
 */
export function parseMonitorsFile(text, { file = 'sitescanner.monitors.yml' } = {}) {
  const errors = [];
  const lineCounter = new YAML.LineCounter();
  let doc;
  try {
    doc = YAML.parseDocument(String(text ?? ''), { lineCounter, prettyErrors: false });
  } catch (e) {
    return { monitors: [], maintenance: [], errors: [{ line: 1, path: '', message: `YAML non valido: ${e.message}` }], file };
  }
  const lineOf = (node) => (node && node.range ? lineCounter.linePos(node.range[0]).line : 1);
  for (const e of doc.errors) errors.push({ line: e.linePos ? e.linePos[0].line : 1, path: '', message: `YAML non valido: ${e.message.split('\n')[0]}` });
  if (errors.length) return { monitors: [], maintenance: [], errors, file };
  const root = doc.contents;
  if (!YAML.isMap(root)) return { monitors: [], maintenance: [], errors: [{ line: 1, path: '', message: 'Il file deve essere una mappa con «monitors» (e, se serve, «maintenance»)' }], file };
  const get = (map, key) => map.items.find((p) => p.key && p.key.value === key);
  for (const p of root.items) if (!['version', 'monitors', 'maintenance'].includes(p.key && p.key.value)) errors.push({ line: lineOf(p.key), path: String(p.key && p.key.value), message: `campo sconosciuto «${p.key && p.key.value}» (ammessi: version, monitors, maintenance)` });
  const ver = get(root, 'version');
  if (ver && ver.value && Number(ver.value.value) !== FILE_VERSION) errors.push({ line: lineOf(ver.value), path: 'version', message: `versione ${ver.value.value} non supportata (questa è la ${FILE_VERSION})` });

  const read = (section, allowed, label) => {
    const out = [];
    const node = get(root, section);
    if (!node) return out;
    if (!YAML.isSeq(node.value)) { errors.push({ line: lineOf(node.key), path: section, message: `«${section}» deve essere un elenco` }); return out; }
    const seen = new Set();
    node.value.items.forEach((item, i) => {
      const at = `${section}[${i}]`;
      if (!YAML.isMap(item)) { errors.push({ line: lineOf(item), path: at, message: `${label} ${i + 1}: deve essere una mappa di campi` }); return; }
      const fields = item.toJS(doc);
      const lines = Object.fromEntries(item.items.map((p) => [p.key.value, lineOf(p.key)]));
      const id = fields.id == null ? '' : String(fields.id);
      if (!CODE_ID.test(id)) errors.push({ line: lines.id || lineOf(item), path: `${at}.id`, message: `${label} ${i + 1}: serve un «id» stabile (minuscole, cifre, - e _; è la chiave con cui il file ritrova ${label === 'monitor' ? 'il monitor' : 'la finestra'} a ogni applicazione)` });
      else if (seen.has(id)) errors.push({ line: lines.id, path: `${at}.id`, message: `l'id «${id}» è usato due volte` });
      seen.add(id);
      for (const k of Object.keys(fields)) {
        if (FORBIDDEN[k]) errors.push({ line: lines[k], path: `${at}.${k}`, message: `${k}: ${FORBIDDEN[k]}` });
        else if (!allowed.has(k)) errors.push({ line: lines[k], path: `${at}.${k}`, message: `campo sconosciuto «${k}»` });
      }
      if (fields.channels != null && (!Array.isArray(fields.channels) || fields.channels.some((c) => typeof c !== 'string'))) errors.push({ line: lines.channels, path: `${at}.channels`, message: 'channels è un elenco di nomi di canali' });
      if (fields.monitors != null && (!Array.isArray(fields.monitors) || fields.monitors.some((c) => typeof c !== 'string'))) errors.push({ line: lines.monitors, path: `${at}.monitors`, message: 'monitors è un elenco di id di monitor del file' });
      out.push({ id, index: i, line: lineOf(item), fields, lines });
    });
    return out;
  };
  const monitors = read('monitors', MONITOR_FIELDS, 'monitor');
  const maintenance = read('maintenance', WINDOW_FIELDS, 'finestra');
  const ids = new Set(monitors.map((m) => m.id));
  for (const w of maintenance) for (const x of w.fields.monitors || []) if (!ids.has(x)) errors.push({ line: w.lines.monitors, path: `maintenance.${w.id}.monitors`, message: `il monitor «${x}» non è nel file` });
  if (!monitors.length && !errors.length) errors.push({ line: 1, path: 'monitors', message: 'Il file non descrive nessun monitor' });
  return { monitors, maintenance, errors, file };
}

/** An error as one line for a log: `file:riga: campo: messaggio`. */
export const formatFileError = (file, e) => `${file}:${e.line}: ${e.path ? `${e.path}: ` : ''}${e.message}`;

/**
 * The file for a set of monitors (RF-MAC-03): `items` are `{ id, fields }` where fields are the ones that differ from the defaults,
 * in a stable order. Comments say what is generated.
 */
export function monitorsToYaml({ monitors = [], maintenance = [] }) {
  const doc = new YAML.Document({ version: FILE_VERSION, monitors: monitors.map((m) => ({ id: m.id, ...m.fields })), ...(maintenance.length ? { maintenance: maintenance.map((w) => ({ id: w.id, ...w.fields })) } : {}) });
  doc.commentBefore = ' sitescanner.monitors.yml — monitoring as code. `sitescanner monitor apply` allinea lo spazio di lavoro a questo file.';
  return doc.toString({ lineWidth: 0 });
}

/** A readable id for a monitor from its name: «Shop Acme» → «shop-acme». */
export function codeIdFrom(name, taken = new Set()) {
  const base = String(name || 'monitor').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'monitor';
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

/** The URL of a monitor on a preview: its path and query on the origin (and base path) of the preview (RF-MAC-04). */
export function rebaseUrl(url, baseUrl) {
  const u = new URL(url), b = new URL(baseUrl);
  return `${b.origin}${b.pathname.replace(/\/$/, '')}${u.pathname}${u.search}`;
}
