import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

function pad(png, w, h) {
  if (png.width === w && png.height === h) return png.data;
  const out = Buffer.alloc(w * h * 4, 255);
  for (let y = 0; y < png.height; y++) png.data.copy(out, y * w * 4, y * png.width * 4, (y + 1) * png.width * 4);
  return out;
}

/** Pixel diff of two PNG files. Images of different size are padded with white before comparing. */
export function diffImages(fileA, fileB, diffOut = null) {
  const a = PNG.sync.read(fs.readFileSync(fileA));
  const b = PNG.sync.read(fs.readFileSync(fileB));
  const w = Math.max(a.width, b.width), h = Math.max(a.height, b.height);
  const diff = diffOut ? new PNG({ width: w, height: h }) : null;
  const n = pixelmatch(pad(a, w, h), pad(b, w, h), diff ? diff.data : null, w, h, { threshold: 0.1 });
  if (diff) fs.writeFileSync(diffOut, PNG.sync.write(diff));
  return { ratio: n / (w * h), pixels: n, baseSize: [a.width, a.height], headSize: [b.width, b.height] };
}

/** Computes visual diffs for every matched pair with a screenshot on both sides. */
export function visualDiffs(result, base, head, baseDir, headDir, log = () => {}) {
  const bp = new Map(base.pages.map((p) => [p.key, p]));
  const hp = new Map(head.pages.map((p) => [p.key, p]));
  const out = {};
  for (const pair of result.pairs) {
    const b = pair.baseKey && bp.get(pair.baseKey);
    const h = pair.headKey && hp.get(pair.headKey);
    if (!b || !h || !b.screenshot || !h.screenshot) continue;
    try {
      out[pair.key] = diffImages(path.join(baseDir, b.screenshot), path.join(headDir, h.screenshot));
    } catch (e) {
      log(`diff visivo fallito per ${pair.key}: ${e.message}`);
    }
  }
  return out;
}
