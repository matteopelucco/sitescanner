import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { dirs, loadSite, UserError, EXAMPLE_SITE } from './config.js';
import { resolveScanRef, allSiteIds } from './store.js';
import { storageFor } from './storage/index.js';
import { scanSite, activeStaging } from './scan.js';
import { compareScans, exceedsThreshold, parseRedirectMap, FINDING_TYPES } from './core/compare.js';
import { healthScore } from './core/diagnose.js';
import { buildReport } from './report/build.js';
import { serve, multiUserMode } from './server.js';
import { runInventory } from './inventory.js';
import { buildSitemap } from './core/sitemap.js';
import { exportMap, EXPORT_FORMATS } from './mapservice.js';
import { TOOL } from './version.js';


const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const red = c('31'), yellow = c('33'), blue = c('34'), green = c('32'), dim = c('2'), bold = c('1');
const sevColor = { error: red, warn: yellow, info: blue };

const HELP = `sitescanner ${TOOL.version} — scansioni as-is, storico e report di regressione

Uso:
  sitescanner init
  sitescanner scan    --site <id> --env <env> [--label <txt>] [--note <txt>] [--no-screenshots] [--keep-html] [--max-pages N]
  sitescanner scan    --all --env <env> [--label <txt>] [--note <txt>] [--no-screenshots] [--keep-html] [--max-pages N]
  sitescanner list    [--site <id>]
  sitescanner label   --site <id> --scan <id> --label <txt> [--note <txt>]
  sitescanner report  [--site <id>] [--out report/]
  sitescanner ui      [--port 4173] [--host 127.0.0.1] [--open]      (alias: serve)
  sitescanner inventory --url <url> | --site <id> --env <env> [--max-pages N] [--max-depth N] [--concurrency N] [--documents pdf,docx] [--check-documents] [--no-siblings] [--render auto|never] [--import-notes] [--json out.json]
  sitescanner map     --inventory <id|latest> [--site <id>] --format csv|json|md|html|pdf [--out file]
  sitescanner export  --site <id> --base <x> [--head <y>] --out bundle/
  sitescanner pdf     --site <id> --base <x> [--head <y>] [--out file.pdf] [--redirect-map f.csv]
  sitescanner compare --site <id> --base <x> --head <y> [--redirect-map f.csv] [--fail-on error|warn] [--json out.json] [--visual]
  sitescanner user    list | add <username> [--admin] [--name <nome>] | reset-password <username>
                      | set <username> [--role admin|user] [--active true|false] | import <username> [--from <cartella>]
                      (account della modalità multi-utente, SITESCANNER_AUTH=1; password da SITESCANNER_PASSWORD o generata)
  sitescanner monitor run   un giro dei controlli di disponibilità (sviluppo: SITESCANNER_MONITOR_DEV=1)
  sitescanner monitor apply [file] [--dry-run] [--url <app>] [--token <t>]   allinea lo spazio di lavoro al file dei monitor
  sitescanner monitor test  [file] --base-url <anteprima> [--tag x] [--url <app>] [--token <t>]   prova i monitor del file su un'anteprima (exit 1 se falliscono)
  sitescanner monitor export [--out file] [--url <app>] [--token <t>]   il file dei monitor esistenti
                            (--url e --token si leggono anche da SITESCANNER_URL e SITESCANNER_TOKEN; file: sitescanner.monitors.yml)
  sitescanner monitor telegram-webhook [<url pubblico>]   registra il webhook del bot Telegram

Riferimenti a una scan (--scan, --base, --head): id completo, prefisso univoco, label, "latest", "latest~N".
Exit code: 0 ok · 1 soglia --fail-on superata o scan fallite · 2 errore d'uso/configurazione.
`;

const COMMON = { help: { type: 'boolean', short: 'h' } };
const SPECS = {
  init: {},
  scan: {
    site: { type: 'string' }, all: { type: 'boolean' }, env: { type: 'string' }, label: { type: 'string' }, note: { type: 'string' },
    'no-screenshots': { type: 'boolean' }, 'keep-html': { type: 'boolean' }, 'max-pages': { type: 'string' }, quiet: { type: 'boolean', short: 'q' },
  },
  list: { site: { type: 'string' } },
  label: { site: { type: 'string' }, scan: { type: 'string' }, label: { type: 'string' }, note: { type: 'string' } },
  report: { site: { type: 'string' }, out: { type: 'string' } },
  ui: { port: { type: 'string' }, host: { type: 'string' }, open: { type: 'boolean' } },
  inventory: {
    url: { type: 'string' }, site: { type: 'string' }, env: { type: 'string' }, 'max-pages': { type: 'string' }, 'max-depth': { type: 'string' },
    concurrency: { type: 'string' }, json: { type: 'string' }, quiet: { type: 'boolean', short: 'q' },
    documents: { type: 'string' }, 'check-documents': { type: 'boolean' }, 'no-siblings': { type: 'boolean' }, render: { type: 'string' }, 'import-notes': { type: 'boolean' },
  },
  map: { inventory: { type: 'string' }, site: { type: 'string' }, format: { type: 'string' }, out: { type: 'string' } },
  export: { site: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, out: { type: 'string' } },
  pdf: { site: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, out: { type: 'string' }, 'redirect-map': { type: 'string' } },
  compare: {
    site: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, 'redirect-map': { type: 'string' },
    'fail-on': { type: 'string' }, json: { type: 'string' }, visual: { type: 'boolean' }, limit: { type: 'string' },
  },
  user: { admin: { type: 'boolean' }, name: { type: 'string' }, role: { type: 'string' }, active: { type: 'string' }, from: { type: 'string' } },
  monitor: { url: { type: 'string' }, token: { type: 'string' }, interval: { type: 'string' }, once: { type: 'boolean' }, concurrency: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'base-url': { type: 'string' }, tag: { type: 'string', multiple: true }, branch: { type: 'string' }, commit: { type: 'string' }, out: { type: 'string' } },
};
const POSITIONALS = new Set(['user', 'monitor']);

function need(opts, ...names) {
  for (const n of names) if (opts[n] === undefined || opts[n] === '') throw new UserError(`Opzione obbligatoria mancante: --${n}`);
}

function positiveInt(v, name) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new UserError(`--${name} deve essere un intero positivo`);
  return n;
}

function pad(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s + ' '.repeat(n - s.length);
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------------- commands ----------------

function cmdInit() {
  for (const d of [dirs.sites, dirs.data, dirs.report, dirs.inventory]) fs.mkdirSync(d, { recursive: true });
  const ex = path.join(dirs.sites, 'example.yml');
  if (fs.existsSync(ex)) console.log(dim(`${ex} esiste già: non modificato`));
  else {
    fs.writeFileSync(ex, EXAMPLE_SITE);
    console.log(`Creato ${ex}`);
  }
  const gi = path.join(path.dirname(dirs.data), '.gitignore');
  // auth/ holds password hashes and sessions of multi-user mode: never in version control
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'report/\nbundle/\ninventory/\nauth/\n');
  console.log(`Cartelle pronte: sites/ data/ report/ inventory/\nProssimo passo: sitescanner ui (web app) oppure sitescanner scan --site example --env prod`);
  return 0;
}

async function cmdScan(o) {
  need(o, 'env');
  if (!o.site && !o.all) throw new UserError('Specifica --site <id> oppure --all');
  if (o.site && o.all) throw new UserError('--site e --all sono alternativi');
  const opts = {
    label: o.label, note: o.note, noScreenshots: o['no-screenshots'], keepHtml: o['keep-html'],
    maxPages: positiveInt(o['max-pages'], 'max-pages'),
  };
  const log = o.quiet ? () => {} : (m) => console.log(dim(m));
  const summarize = (s) => {
    const st = s.stats;
    return `${s.site} ${bold(s.id)}: ${st.pages} pagine, health ${bold(st.healthScore ?? '-')}, ${red(st.issues.error + ' E')} ${yellow(st.issues.warn + ' W')} ${blue(st.issues.info + ' I')}` +
      `${s.options.screenshots ? `, ${st.screenshots} screenshot` : ''}${s.crawl.truncated ? dim(` (troncata a ${s.options.maxPages} pagine)`) : ''}`;
  };

  if (o.site) {
    const s = await scanSite(o.site, o.env, opts, log);
    console.log(green('✓ ') + summarize(s));
    return 0;
  }

  const st = storageFor();
  const ids = await st.listSiteIds();
  if (!ids.length) throw new UserError(`Nessun sito in ${dirs.sites}`);
  const results = [];
  for (const id of ids) {
    let cfg;
    try {
      cfg = await loadSite(st, id);
    } catch (e) {
      results.push({ id, status: 'failed', error: e.message });
      console.error(red(`✗ ${id}: ${e.message}`));
      continue;
    }
    if (!cfg.envs[o.env]) {
      results.push({ id, status: 'skipped', error: `ambiente "${o.env}" non definito` });
      console.log(dim(`- ${id}: ambiente "${o.env}" non definito, saltato`));
      continue;
    }
    try {
      const s = await scanSite(id, o.env, opts, log);
      results.push({ id, status: 'ok', scan: s.id });
      console.log(green('✓ ') + summarize(s));
    } catch (e) {
      results.push({ id, status: 'failed', error: e.message });
      console.error(red(`✗ ${id}: ${e.message}`));
    }
  }
  const failed = results.filter((r) => r.status === 'failed');
  const ok = results.filter((r) => r.status === 'ok');
  const skipped = results.filter((r) => r.status === 'skipped');
  console.log(`\n${bold('Riepilogo')}: ${green(ok.length + ' ok')}, ${failed.length ? red(failed.length + ' falliti') : '0 falliti'}, ${skipped.length} saltati`);
  for (const r of failed) console.log(red(`  ✗ ${r.id}: ${r.error}`));
  return failed.length ? 1 : 0;
}

async function cmdList(o) {
  const st = storageFor();
  const known = await allSiteIds(st);
  const sites = o.site ? [o.site] : known;
  if (o.site && !known.includes(o.site)) throw new UserError(`Sito "${o.site}" sconosciuto`);
  let any = false;
  for (const site of sites) {
    const scans = await st.listScans(site);
    console.log(bold(`\n${site}`) + dim(` (${scans.length} scan)`));
    if (!scans.length) continue;
    any = true;
    console.log(dim(`  ${pad('ID', 24)} ${pad('LABEL', 18)} ${pad('ENV', 8)} ${pad('DATA', 16)} ${pad('PAGINE', 7)} ${pad('HEALTH', 7)} ISSUE (E/W/I)`));
    for (const s of [...scans].reverse()) {
      const i = s.stats.issues;
      console.log(`  ${pad(s.id, 24)} ${pad(s.label || '-', 18)} ${pad(s.env, 8)} ${pad(fmtDate(s.startedAt), 16)} ${pad(s.stats.pages, 7)} ${pad(s.stats.healthScore ?? '-', 7)} ${red(i.error)}/${yellow(i.warn)}/${blue(i.info)}${s.note ? dim('  ' + s.note) : ''}`);
    }
  }
  if (!any && !sites.length) console.log('Nessun sito configurato. Esegui: sitescanner init');
  return 0;
}

async function cmdLabel(o) {
  need(o, 'site', 'scan', 'label');
  const st = storageFor();
  const id = await resolveScanRef(st, o.site, o.scan);
  await st.writeLabel(o.site, id, { label: o.label, note: o.note });
  console.log(`${o.site} ${id}: label «${o.label}»${o.note !== undefined ? `, nota «${o.note}»` : ''}`);
  return 0;
}

async function cmdReport(o) {
  const out = o.out || dirs.report;
  if (o.site && !(await storageFor().listDataSites()).includes(o.site)) throw new UserError(`Nessuna scan per il sito "${o.site}"`);
  const r = await buildReport({ outDir: out, sites: o.site ? [o.site] : null });
  console.log(`Report generato in ${r.outDir} (${r.sites} siti, ${r.scans} scan)`);
  console.log(dim(`Apri ${path.join(r.outDir, 'index.html')} oppure: sitescanner serve`));
  return 0;
}

async function cmdUi(o) {
  const port = positiveInt(o.port, 'port') || 4173;
  const host = o.host || '127.0.0.1';
  // the static report is for the working folder; with accounts the report is generated per user
  if (!multiUserMode() && !fs.existsSync(path.join(dirs.report, 'index.html'))) {
    console.log(dim('report/ non trovato: lo genero ora…'));
    await buildReport({ outDir: dirs.report });
  }
  try {
    await serve({ port, host });
  } catch (e) {
    if (e.code === 'EADDRINUSE') throw new UserError(`La porta ${port} è già in uso: scegline un'altra con --port`);
    throw e;
  }
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}/`;
  console.log(`${bold('sitescanner')} su ${url}  ·  report: ${url}report/  (Ctrl+C per uscire)`);
  console.log(dim(`Cartella di lavoro: ${path.dirname(dirs.data)}`));
  const multi = multiUserMode();
  await startMonitorLoop();
  if (multi) console.log(`Modalità multi-utente: accesso con username e password (${url}login)`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    // RF-SEC-08: without HTTPS the session cookie travels in clear
    console.log(yellow(multi
      ? `Attenzione: in ascolto su ${host} senza HTTPS: password e cookie di sessione viaggiano in chiaro sulla rete.`
      : `Attenzione: in ascolto su ${host}, la web app è raggiungibile da altre macchine senza autenticazione.`));
  }
  if (o.open) {
    const { spawn } = await import('node:child_process');
    const opener = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
    spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
  return new Promise(() => {});
}

// RF-MON-18: locally the rounds run in the server process, every 5 minutes, only for development.
async function startMonitorLoop() {
  const { runRound, monitoringEnabled } = await import('./monitor/engine.js');
  if (!monitoringEnabled()) return;
  console.log(yellow('Monitoraggio in modalità sviluppo (SITESCANNER_MONITOR_DEV=1): giri ogni 5 minuti finché il server è attivo; i dati non sono affidabili.'));
  const round = async () => {
    try {
      let areas = [''];
      if (multiUserMode()) {
        const [{ adminAreas }, { authFor }] = await Promise.all([import('./server.js'), import('./users-cli.js')]);
        areas = await adminAreas(await authFor());
      }
      await runRound({ adminAreas: areas });
    } catch (e) {
      console.error(red(`Giro di controllo fallito: ${e.message}`));
    }
  };
  setTimeout(round, 5000).unref();
  setInterval(round, 5 * 60000).unref();
}

async function cmdInventory(o) {
  if (!o.url && !o.site) throw new UserError('Specifica --url <url> oppure --site <id> --env <env>');
  if (o.url && o.site) throw new UserError('--url e --site sono alternativi');
  if (o.site) need(o, 'env');
  const opts = {
    url: o.url, site: o.site, env: o.env,
    maxPages: positiveInt(o['max-pages'], 'max-pages'), maxDepth: positiveInt(o['max-depth'], 'max-depth'), concurrency: positiveInt(o.concurrency, 'concurrency'),
  };
  const map = {};
  if (o.documents) map.documentTypes = o.documents.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (o['check-documents']) map.checkDocuments = true;
  if (o['no-siblings']) map.siblings = false;
  if (o.render) {
    if (o.render !== 'auto' && o.render !== 'never') throw new UserError('--render: auto oppure never');
    map.render = o.render;
  }
  if (Object.keys(map).length) opts.map = map;
  if (o['import-notes']) opts.importNotes = true;
  const log = o.quiet ? () => {} : (m) => console.log(dim(m));
  const inv = await runInventory(opts, { log });
  const s = inv.summary;
  const hist = (h) => Object.entries(h).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`\n${green('✓ ')}${bold('Inventario')} ${inv.baseUrl} ${dim(inv.id)}`);
  console.log(`URL visitati ${bold(s.urls)} · pagine HTML ${bold(s.htmlPages)} · 2xx ${s.byStatus['2xx']} · 3xx ${s.byStatus['3xx']} · 4xx ${s.byStatus['4xx']} · 5xx ${s.byStatus['5xx']} · errori ${s.byStatus.fail}`);
  console.log(`Profondità di click: max ${bold(s.clickDepth.max ?? '-')} · media ${s.clickDepth.avg ?? '-'} · ${dim(hist(s.clickDepth.histogram))}`);
  console.log(`Profondità URL:      max ${bold(s.urlDepth.max ?? '-')} · ${dim(hist(s.urlDepth.histogram))}`);
  console.log(`Non collegate dalla home ${s.clickDepth.notLinked} · sitemap: ${s.sitemap.listed} URL, ${s.sitemap.notLinked} non collegati, ${s.sitemap.missing} pagine assenti dalla sitemap`);
  console.log(bold('\nSezioni'));
  for (const x of s.sections.slice(0, 15)) console.log(`  ${pad(x.section, 30)} ${pad(x.pages, 7)} ${dim(`click max ${x.maxClickDepth ?? '-'} · media ${x.avgClickDepth ?? '-'}`)}`);
  if (s.sections.length > 15) console.log(dim(`  … altre ${s.sections.length - 15}`));
  printMapSummary(inv);
  if (inv.crawl.truncated) console.log(yellow(`\nTroncato a ${inv.options.maxPages} URL: ${inv.crawl.unvisited} scoperti e non visitati (aumenta --max-pages)`));
  if (o.json) {
    fs.mkdirSync(path.dirname(path.resolve(o.json)), { recursive: true });
    fs.writeFileSync(o.json, JSON.stringify(inv, null, 2));
    console.log(dim(`\nRisultato JSON: ${path.resolve(o.json)}`));
  }
  return 0;
}

/** What the site map shows at a glance (RF-MAP-182): nodes per host, areas, global navigation, documents, siblings, rendering. */
function printMapSummary(inv) {
  if (!inv.summary.map) return;
  let m;
  try {
    m = buildSitemap(inv, {});
  } catch {
    return;
  }
  if (!m.nodes.length) return;
  const st = m.stats;
  console.log(bold('\nMappa del sito'));
  console.log(`  Nodi per host: ${st.composition.byHost.map((h) => `${h.host} ${h.pages}`).join(' · ')}`);
  if (m.areas.length) console.log(`  Aree: ${m.areas.slice(0, 10).map((a) => `${a.name} ${a.pages}`).join(' · ')}${m.areas.length > 10 ? dim(` … altre ${m.areas.length - 10}`) : ''}`);
  if (m.support.links) console.log(`  Navigazione globale: ${st.links.globalNavPages} voci · raggiungibili solo dai menu: ${st.links.onlyFromMenus}`);
  console.log(`  Documenti unici: ${st.documents.unique}`);
  const sib = inv.summary.map.siblings;
  if (sib) console.log(`  Host fratelli visitati: ${sib.hosts.join(', ')} (${sib.visited} pagine di confine)${Object.keys(sib.notVisited).length ? yellow(` · non visitate: ${Object.entries(sib.notVisited).map(([h, n]) => `${h} ${n}`).join(', ')}`) : ''}`);
  const spa = inv.summary.map.spa;
  if (spa) console.log(`  Pagine SPA: ${spa.shells} · renderizzate ${spa.rendered}${spa.errors ? yellow(` · senza rendering ${spa.errors} (browser non disponibile o errore)`) : ''}`);
  for (const w of m.warnings) console.log(yellow(`  Avviso: ${w}`));
}

/** `map`: an export of the site map of an inventory (spec §14.9, RF-MAP-181). */
async function cmdMap(o) {
  need(o, 'inventory', 'format');
  if (!EXPORT_FORMATS[o.format]) throw new UserError(`--format: ${Object.keys(EXPORT_FORMATS).join(', ')}`);
  const st = storageFor();
  let id = o.inventory;
  if (id === 'latest') {
    const list = (await st.listInventories()).filter((i) => !o.site || i.site === o.site);
    if (!list.length) throw new UserError(o.site ? `Nessun inventario per il sito ${o.site}` : 'Nessun inventario salvato');
    id = list[0].id;
  }
  const out = await exportMap(st, id, o.format);
  const file = path.resolve(o.out || out.fileName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.body);
  console.log(`${green('✓ ')}${file} ${dim(`(inventario ${id})`)}`);
  return 0;
}

async function cmdExport(o) {
  need(o, 'site', 'base', 'out');
  const st = storageFor();
  const base = await resolveScanRef(st, o.site, o.base);
  // without --head the bundle opens on the diagnostic view of Base
  const head = o.head ? await resolveScanRef(st, o.site, o.head) : null;
  const out = path.resolve(o.out);
  if (fs.existsSync(out) && fs.readdirSync(out).length && !fs.existsSync(path.join(out, 'index.html'))) {
    throw new UserError(`${out} esiste e non sembra un bundle sitescanner: scegli una cartella vuota`);
  }
  fs.rmSync(path.join(out, 'data'), { recursive: true, force: true });
  fs.rmSync(path.join(out, 'assets'), { recursive: true, force: true });
  const r = await buildReport({ outDir: out, sites: [o.site], onlyScans: { [o.site]: [...new Set([base, head].filter(Boolean))] }, copyAssets: true, preselect: { site: o.site, base, head } });
  console.log(`Bundle creato in ${r.outDir} (Base ${base}${head ? `, Head ${head}` : ', diagnostica'}). Apri index.html o condividi la cartella.`);
  return 0;
}

function readRedirectMap(file) {
  if (!file) return {};
  const f = path.resolve(file);
  if (!fs.existsSync(f)) throw new UserError(`Redirect map non trovata: ${f}`);
  return parseRedirectMap(fs.readFileSync(f, 'utf8'));
}

async function cmdPdf(o) {
  need(o, 'site', 'base');
  const { renderPdf } = await import('./pdf.js');
  const r = await renderPdf({ site: o.site, base: o.base, head: o.head || null, redirectMap: readRedirectMap(o['redirect-map']) });
  const out = path.resolve(o.out || r.fileName);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, r.buffer);
  console.log(`PDF ${r.headId ? `di confronto (Base ${r.baseId}, Head ${r.headId})` : `di diagnostica (${r.baseId})`}: ${out}`);
  return 0;
}

async function cmdCompare(o) {
  need(o, 'site', 'base', 'head');
  if (o['fail-on'] && !['error', 'warn'].includes(o['fail-on'])) throw new UserError('--fail-on accetta error o warn');
  const st = storageFor();
  const baseId = await resolveScanRef(st, o.site, o.base);
  const headId = await resolveScanRef(st, o.site, o.head);
  const base = await st.loadScan(o.site, baseId);
  const head = await st.loadScan(o.site, headId);
  let cfgCompare = { ignore: [], thresholds: {} };
  try { cfgCompare = (await loadSite(st, o.site)).compare; } catch { /* config removed: defaults */ }

  const redirectMap = readRedirectMap(o['redirect-map']);
  const opts = { redirectMap, ignore: cfgCompare.ignore, thresholds: cfgCompare.thresholds };
  let result = compareScans(base, head, opts);
  if (o.visual) {
    if (!base.options.screenshots || !head.options.screenshots) {
      console.error(yellow('--visual: una delle due scan non ha screenshot, confronto visivo parziale o assente'));
    }
    const { visualDiffs } = await import('./visual.js');
    const visual = await visualDiffs(result, base, head, st, (m) => console.error(dim(m)));
    result = compareScans(base, head, { ...opts, visual });
    result.visual = visual;
  }
  const failed = exceedsThreshold(result, o['fail-on']);

  const s = result.summary;
  const tag = (x) => `${x.id}${x.label ? ` «${x.label}»` : ''} [${x.env}]`;
  console.log(`${bold('Confronto')} ${o.site}\n  Base ${tag(result.base)}  ${dim(fmtDate(result.base.startedAt))}\n  Head ${tag(result.head)}  ${dim(fmtDate(result.head.startedAt))}`);
  console.log(`Health score ${healthScore(base) ?? '-'} → ${healthScore(head) ?? '-'}`);
  console.log(`Pagine ${result.base.pages} → ${result.head.pages} · cambiate ${s.changed} · aggiunte ${s.added} · rimosse ${s.removed} · invariate ${s.unchanged}`);
  console.log(`Differenze: ${red(s.error + ' error')} · ${yellow(s.warn + ' warn')} · ${blue(s.info + ' info')}\n`);

  const limit = positiveInt(o.limit, 'limit') || 50;
  const important = result.findings.filter((f) => f.severity !== 'info');
  for (const f of important.slice(0, limit)) {
    console.log(`  ${sevColor[f.severity](pad(f.severity.toUpperCase(), 6))} ${pad(f.type, 20)} ${f.key}  ${dim(f.message)}`);
  }
  if (important.length > limit) console.log(dim(`  … altre ${important.length - limit} (usa --json o il report)`));
  const infoByType = {};
  for (const f of result.findings) if (f.severity === 'info') infoByType[f.type] = (infoByType[f.type] || 0) + 1;
  const infos = Object.entries(infoByType);
  if (infos.length) console.log(dim(`  info: ${infos.map(([t, n]) => `${FINDING_TYPES[t] || t} ${n}`).join(' · ')}`));

  if (o.json) {
    const out = { site: o.site, generatedAt: new Date().toISOString(), tool: TOOL, failOn: o['fail-on'] || null, passed: !failed, redirectMapEntries: Object.keys(redirectMap).length, ...result, healthScore: { base: healthScore(base), head: healthScore(head) } };
    fs.mkdirSync(path.dirname(path.resolve(o.json)), { recursive: true });
    fs.writeFileSync(o.json, JSON.stringify(out, null, 2));
    console.log(dim(`\nRisultato JSON: ${path.resolve(o.json)}`));
  }
  if (o['fail-on']) console.log(failed ? red(`\n✗ FAIL: trovate differenze di livello ≥ ${o['fail-on']}`) : green(`\n✓ PASS (fail-on ${o['fail-on']})`));
  return failed ? 1 : 0;
}

/** `monitor apply|test|export`: they talk to the service with the token of a workspace (spec §13.13). */
async function cmdMonitorCode(o, positionals) {
  const [sub, fileArg] = positionals;
  const base = String(o.url || process.env.SITESCANNER_URL || '').replace(/\/$/, '');
  const token = o.token || process.env.SITESCANNER_TOKEN;
  if (!base) throw new UserError("Manca l'indirizzo del servizio: --url https://… oppure SITESCANNER_URL");
  if (!token) throw new UserError('Manca il token API: --token sst_… oppure SITESCANNER_TOKEN (si crea nella pagina «Spazi di lavoro»)');
  const call = async (method, p, body) => {
    let res;
    try {
      res = await fetch(`${base}/api/v1/${p}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(300000) });
    } catch (e) {
      throw new UserError(`Il servizio ${base} non risponde: ${(e.cause && e.cause.code) || e.message}`);
    }
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* yaml */ }
    if (!res.ok) {
      if (data && data.errors) {
        for (const e of data.errors) console.error(red(e.text));
        throw new UserError(data.error);
      }
      throw new UserError(`${(data && data.error) || `HTTP ${res.status}`}`);
    }
    return data;
  };
  const read = (file) => {
    const f = file || 'sitescanner.monitors.yml';
    if (!fs.existsSync(f)) throw new UserError(`File non trovato: ${f}`);
    return { name: path.basename(f), file: fs.readFileSync(f, 'utf8') };
  };
  if (sub === 'export') {
    const yaml = await call('GET', 'export');
    if (o.out) { fs.writeFileSync(o.out, yaml); console.log(`Scritto ${o.out}`); } else process.stdout.write(yaml);
    return 0;
  }
  if (sub === 'apply') {
    const f = read(fileArg);
    const r = await call('POST', 'apply', { ...f, dryRun: !!o['dry-run'] });
    const p = r.plan;
    const w = p.windows;
    for (const x of p.create) console.log(`${green('+')} ${x.id}  ${dim(`crea «${x.name}» (${x.type})`)}`);
    for (const x of p.update) console.log(`${yellow('~')} ${x.id}  ${dim(`modifica: ${x.changes.map((c) => `${c.field} ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`).join(', ')}`)}`);
    for (const x of p.delete) console.log(`${red('-')} ${x.id}  ${dim(`elimina «${x.name}»`)}`);
    for (const x of w.create) console.log(`${green('+')} manutenzione ${x.id}`);
    for (const x of w.update) console.log(`${yellow('~')} manutenzione ${x.id}  ${dim(x.changes.map((c) => c.field).join(', '))}`);
    for (const x of w.delete) console.log(`${red('-')} manutenzione ${x.id}`);
    const changed = p.create.length + p.update.length + p.delete.length + w.create.length + w.update.length + w.delete.length;
    console.log(`${r.applied ? 'Applicato' : 'Piano (nessuna modifica fatta)'}: ${p.create.length} da creare, ${p.update.length} da modificare, ${p.delete.length} da eliminare, ${p.unchanged} invariati${changed ? '' : ' — niente da fare'}`);
    return 0;
  }
  if (sub === 'test') {
    if (!o['base-url']) throw new UserError("Serve l'indirizzo dell'anteprima: --base-url https://…");
    const f = read(fileArg);
    const r = await call('POST', 'test', { ...f, baseUrl: o['base-url'], tags: o.tag || [], branch: o.branch || process.env.GITHUB_REF_NAME || process.env.CI_COMMIT_REF_NAME || null, commit: o.commit || process.env.GITHUB_SHA || process.env.CI_COMMIT_SHA || null });
    for (const x of r.results) {
      const mark = x.outcome === 'ok' ? green('✔') : x.outcome === 'degraded' ? yellow('✔') : x.outcome === 'skipped' ? dim('–') : red('✖');
      console.log(`${mark} ${x.name}  ${dim(x.url || '')}${x.ms != null ? dim(` ${x.ms} ms`) : ''}`);
      if (x.message) console.log(`    ${x.outcome === 'error' ? red(x.message) : dim(x.message)}`);
      for (const a of x.assertions || []) if (!a.ok) console.log(`    ${red('✖')} ${a.text} — ${a.message}`);
    }
    console.log(`${r.ok ? green('Tutto a posto') : red('Falliti')}: ${r.passed} riusciti, ${r.failed} falliti${r.skipped ? `, ${r.skipped} saltati` : ''} (${r.durationMs} ms)`);
    return r.ok ? 0 : 1;
  }
  throw new UserError('Uso: sitescanner monitor run | apply | test | export | telegram-webhook');
}

/** `sitescanner monitor agent --url … --token ssa_…`: a private location in this network (RF-AGT-01, ADR-0025). */
async function cmdMonitorAgent(o) {
  const url = String(o.url || process.env.SITESCANNER_URL || '').replace(/\/$/, '');
  const token = o.token || process.env.SITESCANNER_AGENT_TOKEN;
  if (!url) throw new UserError("Manca l'indirizzo del servizio: --url https://… oppure SITESCANNER_URL");
  if (!token) throw new UserError("Manca il token dell'agente: --token ssa_… oppure SITESCANNER_AGENT_TOKEN (si crea nella pagina «Agenti»)");
  const { runAgent, AgentAuthError } = await import('./monitor/agent-client.js');
  const ac = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => ac.abort());
  const stamp = () => new Date().toTimeString().slice(0, 8);
  console.log(dim(`Agente locale: chiedo i controlli a ${url} ogni ${positiveInt(o.interval, 'interval') ?? 30} s (Ctrl+C per fermarlo)`));
  try {
    await runAgent({ url, token, pollS: positiveInt(o.interval, 'interval') ?? 30, concurrency: positiveInt(o.concurrency, 'concurrency') ?? 4, once: !!o.once, signal: ac.signal, log: (line) => console.log(`${dim(stamp())} ${line}`) });
  } catch (e) {
    if (e instanceof AgentAuthError) throw new UserError(e.message);
    throw e;
  }
  return 0;
}

async function cmdMonitor(o, positionals) {
  if (['apply', 'test', 'export'].includes(positionals[0])) return cmdMonitorCode(o, positionals);
  if (positionals[0] === 'telegram-webhook') {
    // registers the webhook of the deploy's bot (spec §12.5): Telegram calls it with the secret token
    const { publicBaseUrl, telegramApi } = await import('./monitor/channels.js');
    const token = process.env.SITESCANNER_TELEGRAM_BOT_TOKEN, secret = process.env.SITESCANNER_TELEGRAM_WEBHOOK_SECRET;
    if (!token || !secret) throw new UserError('Servono SITESCANNER_TELEGRAM_BOT_TOKEN e SITESCANNER_TELEGRAM_WEBHOOK_SECRET (e SITESCANNER_PUBLIC_URL)');
    const url = `${positionals[1] || publicBaseUrl()}/api/telegram/webhook`;
    const r = await fetch(`${telegramApi()}/bot${token}/setWebhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, secret_token: secret, allowed_updates: ['message', 'channel_post'] }) }).then((x) => x.json());
    if (!r.ok) throw new UserError(`Telegram ha rifiutato il webhook: ${r.description || 'errore sconosciuto'}`);
    console.log(`Webhook del bot impostato: ${url}`);
    return 0;
  }
  if (positionals[0] === 'agent') return cmdMonitorAgent(o);
  if (positionals[0] !== 'run') throw new UserError('Uso: sitescanner monitor run | apply | test | export | agent | telegram-webhook [<url pubblico>]');
  const { runRound, monitoringEnabled } = await import('./monitor/engine.js');
  if (!monitoringEnabled()) throw new UserError('Il monitoraggio gira su Vercel; in locale, solo per sviluppo, con SITESCANNER_MONITOR_DEV=1');
  const { initStorage } = await import('./storage/index.js');
  const authStore = await initStorage();
  let adminAreas = [''];
  if (multiUserMode()) {
    const [{ adminAreas: areasOf }, { Auth }] = await Promise.all([import('./server.js'), import('./auth/index.js')]);
    adminAreas = await areasOf(new Auth(authStore));
  }
  const r = await runRound({ adminAreas });
  console.log(`Giro di controllo: ${r.checked} monitor, ${r.failed} in errore${r.unreliable ? ' — scartato: rete del monitor non affidabile' : ''}, ${r.events.length} eventi (${r.durationMs} ms)`);
  return 0;
}

async function cmdUserCommand(o, positionals) {
  const { cmdUser } = await import('./users-cli.js');
  return cmdUser(positionals, o);
}

const COMMANDS = { init: cmdInit, scan: cmdScan, list: cmdList, label: cmdLabel, report: cmdReport, ui: cmdUi, inventory: cmdInventory, map: cmdMap, export: cmdExport, pdf: cmdPdf, compare: cmdCompare, user: cmdUserCommand, monitor: cmdMonitor };
const ALIASES = { serve: 'ui' };

export async function main(argv) {
  let [cmd, ...rest] = argv;
  cmd = ALIASES[cmd] || cmd;
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === '-v' || cmd === '--version') {
    console.log(TOOL.version);
    return 0;
  }
  if (!COMMANDS[cmd]) {
    console.error(`Comando sconosciuto: ${cmd}\n`);
    process.stderr.write(HELP);
    return 2;
  }
  const onSignal = () => {
    for (const d of activeStaging) fs.rmSync(d, { recursive: true, force: true });
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const { values, positionals } = parseArgs({ args: rest, options: { ...COMMON, ...SPECS[cmd] }, allowPositionals: POSITIONALS.has(cmd), strict: true });
    if (values.help) {
      process.stdout.write(HELP);
      return 0;
    }
    return await COMMANDS[cmd](values, positionals);
  } catch (e) {
    if (e instanceof UserError || e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' || e.code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') {
      console.error(red(`Errore: ${e.message}`));
      return 2;
    }
    console.error(red(`Errore inatteso: ${e.stack || e.message}`));
    return 2;
  }
}
