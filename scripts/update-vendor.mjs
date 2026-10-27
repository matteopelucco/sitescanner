#!/usr/bin/env node
// Downloads the pinned versions of d3-force and d3-hierarchy (ADR-0021) from the npm registry into
// src/web/vendor/, with their licenses, and records the SHA-256 of every file in vendor/VERSIONS.json.
//   node scripts/update-vendor.mjs          download and write
//   node scripts/update-vendor.mjs --check  verify the files in the repository (no network)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'vendor');
// load order matters: the UMD builds find their dependencies on the global `d3`
export const PACKAGES = [
  ['d3-dispatch', '3.0.1'],
  ['d3-quadtree', '3.0.1'],
  ['d3-timer', '3.0.1'],
  ['d3-force', '3.0.0'],
  ['d3-hierarchy', '3.1.2'],
];
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// the files of a tar archive: { name, data }
function untar(buf) {
  const files = [];
  for (let off = 0; off + 512 <= buf.length;) {
    const name = buf.toString('utf8', off, off + 100).replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(buf.toString('utf8', off + 124, off + 136).replace(/\0.*$/, '').trim() || '0', 8);
    const type = buf[off + 156];
    if (type === 0 || type === 0x30) files.push({ name, data: buf.subarray(off + 512, off + 512 + size) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

if (process.argv.includes('--check')) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'VERSIONS.json'), 'utf8'));
  let bad = 0;
  for (const [file, hash] of Object.entries(manifest.files)) {
    const ok = fs.existsSync(path.join(dir, file)) && sha(fs.readFileSync(path.join(dir, file))) === hash;
    if (!ok) { console.error(`✗ ${file}`); bad++; }
  }
  console.log(bad ? `${bad} file non corrispondono` : `✓ ${Object.keys(manifest.files).length} file verificati`);
  process.exit(bad ? 1 : 0);
}

fs.mkdirSync(dir, { recursive: true });
const manifest = { packages: Object.fromEntries(PACKAGES), files: {} };
for (const [name, version] of PACKAGES) {
  const res = await fetch(`https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`);
  if (!res.ok) throw new Error(`${name}@${version}: HTTP ${res.status}`);
  const files = untar(zlib.gunzipSync(Buffer.from(await res.arrayBuffer())));
  const find = (p) => files.find((f) => f.name === `package/${p}`);
  const min = find(`dist/${name}.min.js`);
  const lic = find('LICENSE');
  if (!min || !lic) throw new Error(`${name}@${version}: files not found in the package`);
  fs.writeFileSync(path.join(dir, `${name}.min.js`), min.data);
  fs.writeFileSync(path.join(dir, `${name}.LICENSE`), lic.data);
  manifest.files[`${name}.min.js`] = sha(min.data);
  manifest.files[`${name}.LICENSE`] = sha(lic.data);
  console.log(`✓ ${name}@${version}`);
}
fs.writeFileSync(path.join(dir, 'VERSIONS.json'), JSON.stringify(manifest, null, 2) + '\n');
