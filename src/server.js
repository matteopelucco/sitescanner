import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { rootDir } from './config.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
};

/** Serves <root>/report and <root>/data under /report/ and /data/, so the report's relative links resolve. */
export function serve({ port = 4173, host = '127.0.0.1' } = {}) {
  const root = rootDir();
  const allowed = ['report', 'data'].map((d) => path.join(root, d));
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (pathname === '/' || pathname === '/report') {
      res.writeHead(302, { location: '/report/' }).end();
      return;
    }
    let file = path.join(root, path.normalize(pathname));
    if (!allowed.some((a) => file === a || file.startsWith(a + path.sep))) {
      res.writeHead(404).end('Not found');
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-cache' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
