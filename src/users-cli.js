import fs from 'node:fs';
import path from 'node:path';
import { rootDir, saveSite, UserError } from './config.js';
import { storageFor } from './storage/index.js';
import { FsStorage } from './storage/fs.js';
import { allSiteIds } from './store.js';
import { Auth } from './auth/index.js';
import { initStorage } from './storage/index.js';

// `sitescanner user …` (spec §10.7): accounts of multi-user mode, from the terminal.

/** Accounts of the configured backend: the working folder, or Postgres with SITESCANNER_STORAGE=vercel. */
export async function authFor(root = rootDir()) {
  return new Auth(await initStorage({ root }));
}

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p));
  }
  return out;
}

/**
 * Copies sites, scans (unchanged snapshots, files and labels) and inventories of a single-user folder
 * into the area of an account. Sites whose id already exists in the area are skipped.
 * @returns {{sites: string[], skipped: {id: string, reason: string}[], scans: number, inventories: number}}
 */
export async function importArea(user, fromDir, log = () => {}) {
  const src = new FsStorage(fromDir);
  const dst = storageFor(user);
  const existing = new Set(await allSiteIds(dst));
  const result = { sites: [], skipped: [], scans: 0, inventories: 0 };
  for (const id of await allSiteIds(src)) {
    if (existing.has(id)) {
      result.skipped.push({ id, reason: "esiste già nell'area dell'utente" });
      continue;
    }
    const raw = await src.readSiteRaw(id);
    if (raw !== null) {
      try {
        await saveSite(dst, id, raw, { create: true });
      } catch (e) {
        // the history is imported anyway; the configuration must be fixed by hand (e.g. ${VAR}, RF-SEC-02)
        log(`${id}: configurazione non importata (${e.message})`);
      }
    }
    const labels = await src.readLabels(id);
    for (const meta of await src.listScans(id)) {
      const dir = src.localScanDir(id, meta.id);
      const staging = await dst.stageScan(id, meta.id);
      for (const rel of walk(dir)) {
        if (rel === 'scan.json') continue;
        fs.mkdirSync(path.dirname(path.join(staging, rel)), { recursive: true });
        fs.copyFileSync(path.join(dir, rel), path.join(staging, rel));
        fs.chmodSync(path.join(staging, rel), 0o644);
      }
      await dst.commitScan(id, meta.id, staging, JSON.parse(fs.readFileSync(path.join(dir, 'scan.json'), 'utf8')));
      if (labels[meta.id]) await dst.writeLabel(id, meta.id, labels[meta.id]);
      result.scans++;
    }
    result.sites.push(id);
    log(`${id}: importato`);
  }
  for (const meta of await src.listInventories()) {
    const inv = await src.loadInventory(meta.id);
    await dst.saveInventory(inv, meta);
    result.inventories++;
  }
  return result;
}

export async function cmdUser(positionals, o, out = console.log) {
  const [sub, username] = positionals;
  const auth = await authFor();
  const need = () => {
    if (!username) throw new UserError(`Uso: sitescanner user ${sub} <username>`);
  };
  if (sub === 'list') {
    const users = await auth.listUsers();
    if (!users.length) out('Nessun utente. Crea il primo admin: sitescanner user add <username> --admin');
    for (const u of users) out(`${u.username.padEnd(24)} ${u.role.padEnd(6)} ${u.active ? 'attivo     ' : 'disattivato'} ${u.lastLoginAt ? `ultimo accesso ${u.lastLoginAt}` : 'mai entrato'}${u.name ? `  (${u.name})` : ''}`);
    return 0;
  }
  if (sub === 'add') {
    need();
    // Never from an argument: it would stay in the shell history.
    const { user, password } = await auth.createUser({ username, name: o.name || '', role: o.admin ? 'admin' : 'user', password: process.env.SITESCANNER_PASSWORD || null }, { actor: 'cli' });
    out(`Creato ${user.role} ${user.username}.`);
    if (password) out(`Password temporanea (da cambiare al primo accesso): ${password}`);
    else out('Password temporanea: quella di SITESCANNER_PASSWORD (da cambiare al primo accesso).');
    return 0;
  }
  if (sub === 'reset-password') {
    need();
    const { password } = await auth.resetPassword(username, { password: process.env.SITESCANNER_PASSWORD || null, actor: 'cli' });
    out(`Password di ${username} reimpostata, sessioni chiuse.`);
    out(password ? `Password temporanea: ${password}` : 'Password temporanea: quella di SITESCANNER_PASSWORD.');
    return 0;
  }
  if (sub === 'set') {
    need();
    if (!o.role && o.active === undefined) throw new UserError('Indica --role admin|user e/o --active true|false');
    if (o.active !== undefined && !['true', 'false'].includes(o.active)) throw new UserError('--active accetta true o false');
    const u = await auth.setUser(username, { role: o.role, active: o.active === undefined ? undefined : o.active === 'true' }, { actor: 'cli' });
    out(`${u.username}: ${u.role}, ${u.active ? 'attivo' : 'disattivato'}`);
    return 0;
  }
  if (sub === 'import') {
    need();
    const user = await auth.target(username);
    const from = path.resolve(o.from || rootDir());
    if (!fs.existsSync(from)) throw new UserError(`Cartella non trovata: ${from}`);
    const r = await importArea(user, from, (m) => out(`  ${m}`));
    out(`Importati in ${user.username}: ${r.sites.length} siti, ${r.scans} scan, ${r.inventories} inventari.`);
    for (const s of r.skipped) out(`  saltato ${s.id}: ${s.reason}`);
    return 0;
  }
  throw new UserError('Uso: sitescanner user list | add <username> [--admin] [--name <nome>] | reset-password <username> | set <username> [--role admin|user] [--active true|false] | import <username> [--from <cartella>]');
}
