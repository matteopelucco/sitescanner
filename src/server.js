import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootDir, UserError } from './config.js';
import { handleApi } from './api.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
};

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

function sendFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// Inside `root`, or null (path traversal, other folders).
function within(root, pathname) {
  const file = path.join(root, path.normalize(pathname));
  return file === root || file.startsWith(root + path.sep) ? file : null;
}

/**
 * Web app server:
 *   /            web app (src/web)
 *   /api/…       JSON API used by the web app (see api.js)
 *   /report/…    static report, /data/… scan data, as before
 * On a loopback address only requests addressed to localhost are accepted (DNS rebinding),
 * and writes must be same-origin JSON (CSRF from other sites open in the browser).
 */
export function serve({ port = 4173, host = '127.0.0.1' } = {}) {
  const root = rootDir();
  const allowed = ['report', 'data'].map((d) => path.join(root, d));
  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://x');
      url.pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const pathname = url.pathname;
    if (LOOPBACK.has(host)) {
      const h = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (!LOOPBACK.has(h)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Host non ammesso');
        return;
      }
    }

    if (pathname.startsWith('/api/')) {
      if (!['GET', 'HEAD'].includes(req.method)) {
        const origin = req.headers.origin;
        const json = /^application\/json\b/i.test(req.headers['content-type'] || '');
        if ((origin && origin !== `http://${req.headers.host}`) || (req.method !== 'DELETE' && !json)) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'Richiesta non ammessa' }));
          return;
        }
      }
      try {
        await handleApi(req, res, url);
      } catch (e) {
        const user = e instanceof UserError;
        if (!user) console.error(e);
        if (!res.headersSent) res.writeHead(e.status || (user ? 400 : 500), { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (pathname === '/report') {
      res.writeHead(302, { location: '/report/' }).end();
      return;
    }
    if (pathname === '/' || pathname.startsWith('/app/')) {
      const file = pathname === '/' ? path.join(webDir, 'index.html') : within(webDir, pathname.slice('/app'.length));
      if (!file) res.writeHead(404).end('Not found');
      else sendFile(req, res, file);
      return;
    }
    let file = within(root, pathname);
    if (!file || !allowed.some((a) => file === a || file.startsWith(a + path.sep))) {
      res.writeHead(404).end('Not found');
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    sendFile(req, res, file);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
