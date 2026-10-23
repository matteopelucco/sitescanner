import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { dirs, listSiteIds, loadSite, UserError, EXAMPLE_SITE } from './config.js';
import { listScans, listDataSites, loadScan, resolveScanRef, writeLabel, scanDir } from './store.js';
import { scanSite, activeStaging } from './scan.js';
import { compareScans, exceedsThreshold, parseRedirectMap, FINDING_TYPES } from './core/compare.js';
import { buildReport } from './report/build.js';
import { serve } from './server.js';
import { runInventory } from './inventory.js';
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
  sitescanner inventory --url <url> | --site <id> --env <env> [--max-pages N] [--max-depth N] [--concurrency N] [--json out.json]
  sitescanner export  --site <id> --base <x> --head <y> --out bundle/
  sitescanner compare --site <id> --base <x> --head <y> [--redirect-map f.csv] [--fail-on error|warn] [--json out.json] [--visual]

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
  },
  export: { site: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, out: { type: 'string' } },
  compare: {
    site: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, 'redirect-map': { type: 'string' },
    'fail-on': { type: 'string' }, json: { type: 'string' }, visual: { type: 'boolean' }, limit: { type: 'string' },
  },
};

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
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'report/\nbundle/\ninventory/\n');
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
    return `${s.site} ${bold(s.id)}: ${st.pages} pagine, ${red(st.issues.error + ' E')} ${yellow(st.issues.warn + ' W')} ${blue(st.issues.info + ' I')}` +
      `${s.options.screenshots ? `, ${st.screenshots} screenshot` : ''}${s.crawl.truncated ? dim(` (troncata a ${s.options.maxPages} pagine)`) : ''}`;
  };

  if (o.site) {
    const s = await scanSite(o.site, o.env, opts, log);
    console.log(green('✓ ') + summarize(s));
    return 0;
  }

  const ids = listSiteIds();
  if (!ids.length) throw new UserError(`Nessun sito in ${dirs.sites}`);
  const results = [];
  for (const id of ids) {
    let cfg;
    try {
      cfg = loadSite(id);
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

function cmdList(o) {
  const sites = o.site ? [o.site] : [...new Set([...listSiteIds(), ...listDataSites()])].sort();
  if (o.site && !listSiteIds().includes(o.site) && !listDataSites().includes(o.site)) throw new UserError(`Sito "${o.site}" sconosciuto`);
  let any = false;
  for (const site of sites) {
    const scans = listScans(site);
    console.log(bold(`\n${site}`) + dim(` (${scans.length} scan)`));
    if (!scans.length) continue;
    any = true;
    console.log(dim(`  ${pad('ID', 24)} ${pad('LABEL', 18)} ${pad('ENV', 8)} ${pad('DATA', 16)} ${pad('PAGINE', 7)} ISSUE (E/W/I)`));
    for (const s of [...scans].reverse()) {
      const i = s.stats.issues;
      console.log(`  ${pad(s.id, 24)} ${pad(s.label || '-', 18)} ${pad(s.env, 8)} ${pad(fmtDate(s.startedAt), 16)} ${pad(s.stats.pages, 7)} ${red(i.error)}/${yellow(i.warn)}/${blue(i.info)}${s.note ? dim('  ' + s.note) : ''}`);
    }
  }
  if (!any && !sites.length) console.log('Nessun sito configurato. Esegui: sitescanner init');
  return 0;
}

function cmdLabel(o) {
  need(o, 'site', 'scan', 'label');
  const id = resolveScanRef(o.site, o.scan);
  writeLabel(o.site, id, { label: o.label, note: o.note });
  console.log(`${o.site} ${id}: label «${o.label}»${o.note !== undefined ? `, nota «${o.note}»` : ''}`);
  return 0;
}

function cmdReport(o) {
  const out = o.out || dirs.report;
  if (o.site && !listDataSites().includes(o.site)) throw new UserError(`Nessuna scan per il sito "${o.site}"`);
  const r = buildReport({ outDir: out, sites: o.site ? [o.site] : null });
  console.log(`Report generato in ${r.outDir} (${r.sites} siti, ${r.scans} scan)`);
  console.log(dim(`Apri ${path.join(r.outDir, 'index.html')} oppure: sitescanner serve`));
  return 0;
}

async function cmdUi(o) {
  const port = positiveInt(o.port, 'port') || 4173;
  const host = o.host || '127.0.0.1';
  if (!fs.existsSync(path.join(dirs.report, 'index.html'))) {
    console.log(dim('report/ non trovato: lo genero ora…'));
    buildReport({ outDir: dirs.report });
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
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    console.log(yellow(`Attenzione: in ascolto su ${host}, la web app è raggiungibile da altre macchine senza autenticazione.`));
  }
  if (o.open) {
    const { spawn } = await import('node:child_process');
    const opener = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
    spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
  return new Promise(() => {});
}

async function cmdInventory(o) {
  if (!o.url && !o.site) throw new UserError('Specifica --url <url> oppure --site <id> --env <env>');
  if (o.url && o.site) throw new UserError('--url e --site sono alternativi');
  if (o.site) need(o, 'env');
  const opts = {
    url: o.url, site: o.site, env: o.env,
    maxPages: positiveInt(o['max-pages'], 'max-pages'), maxDepth: positiveInt(o['max-depth'], 'max-depth'), concurrency: positiveInt(o.concurrency, 'concurrency'),
  };
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
  if (inv.crawl.truncated) console.log(yellow(`\nTroncato a ${inv.options.maxPages} URL: ${inv.crawl.unvisited} scoperti e non visitati (aumenta --max-pages)`));
  if (o.json) {
    fs.mkdirSync(path.dirname(path.resolve(o.json)), { recursive: true });
    fs.writeFileSync(o.json, JSON.stringify(inv, null, 2));
    console.log(dim(`\nRisultato JSON: ${path.resolve(o.json)}`));
  }
  return 0;
}

function cmdExport(o) {
  need(o, 'site', 'base', 'head', 'out');
  const base = resolveScanRef(o.site, o.base);
  const head = resolveScanRef(o.site, o.head);
  const out = path.resolve(o.out);
  if (fs.existsSync(out) && fs.readdirSync(out).length && !fs.existsSync(path.join(out, 'index.html'))) {
    throw new UserError(`${out} esiste e non sembra un bundle sitescanner: scegli una cartella vuota`);
  }
  fs.rmSync(path.join(out, 'data'), { recursive: true, force: true });
  fs.rmSync(path.join(out, 'assets'), { recursive: true, force: true });
  const r = buildReport({ outDir: out, sites: [o.site], onlyScans: { [o.site]: [...new Set([base, head])] }, copyAssets: true, preselect: { site: o.site, base, head } });
  console.log(`Bundle creato in ${r.outDir} (Base ${base}, Head ${head}). Apri index.html o condividi la cartella.`);
  return 0;
}

async function cmdCompare(o) {
  need(o, 'site', 'base', 'head');
  if (o['fail-on'] && !['error', 'warn'].includes(o['fail-on'])) throw new UserError('--fail-on accetta error o warn');
  const baseId = resolveScanRef(o.site, o.base);
  const headId = resolveScanRef(o.site, o.head);
  const base = loadScan(o.site, baseId);
  const head = loadScan(o.site, headId);
  let cfgCompare = { ignore: [], thresholds: {} };
  try { cfgCompare = loadSite(o.site).compare; } catch { /* config removed: defaults */ }

  let redirectMap = {};
  if (o['redirect-map']) {
    const f = path.resolve(o['redirect-map']);
    if (!fs.existsSync(f)) throw new UserError(`Redirect map non trovata: ${f}`);
    redirectMap = parseRedirectMap(fs.readFileSync(f, 'utf8'));
  }
  const opts = { redirectMap, ignore: cfgCompare.ignore, thresholds: cfgCompare.thresholds };
  let result = compareScans(base, head, opts);
  if (o.visual) {
    if (!base.options.screenshots || !head.options.screenshots) {
      console.error(yellow('--visual: una delle due scan non ha screenshot, confronto visivo parziale o assente'));
    }
    const { visualDiffs } = await import('./visual.js');
    const visual = visualDiffs(result, base, head, scanDir(o.site, baseId), scanDir(o.site, headId), (m) => console.error(dim(m)));
    result = compareScans(base, head, { ...opts, visual });
    result.visual = visual;
  }
  const failed = exceedsThreshold(result, o['fail-on']);

  const s = result.summary;
  const tag = (x) => `${x.id}${x.label ? ` «${x.label}»` : ''} [${x.env}]`;
  console.log(`${bold('Confronto')} ${o.site}\n  Base ${tag(result.base)}  ${dim(fmtDate(result.base.startedAt))}\n  Head ${tag(result.head)}  ${dim(fmtDate(result.head.startedAt))}`);
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
    const out = { site: o.site, generatedAt: new Date().toISOString(), tool: TOOL, failOn: o['fail-on'] || null, passed: !failed, redirectMapEntries: Object.keys(redirectMap).length, ...result };
    fs.mkdirSync(path.dirname(path.resolve(o.json)), { recursive: true });
    fs.writeFileSync(o.json, JSON.stringify(out, null, 2));
    console.log(dim(`\nRisultato JSON: ${path.resolve(o.json)}`));
  }
  if (o['fail-on']) console.log(failed ? red(`\n✗ FAIL: trovate differenze di livello ≥ ${o['fail-on']}`) : green(`\n✓ PASS (fail-on ${o['fail-on']})`));
  return failed ? 1 : 0;
}

const COMMANDS = { init: cmdInit, scan: cmdScan, list: cmdList, label: cmdLabel, report: cmdReport, ui: cmdUi, inventory: cmdInventory, export: cmdExport, compare: cmdCompare };
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
    const { values } = parseArgs({ args: rest, options: { ...COMMON, ...SPECS[cmd] }, allowPositionals: false, strict: true });
    if (values.help) {
      process.stdout.write(HELP);
      return 0;
    }
    return await COMMANDS[cmd](values);
  } catch (e) {
    if (e instanceof UserError || e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' || e.code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') {
      console.error(red(`Errore: ${e.message}`));
      return 2;
    }
    console.error(red(`Errore inatteso: ${e.stack || e.message}`));
    return 2;
  }
}
