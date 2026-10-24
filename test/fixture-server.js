import http from 'node:http';

// Tiny two-version website used by the tests. Call setVersion(2) to "deploy" the changes.
const page = ({ title, h1, body = '', robots = '', links = [], extra = '' }) => `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${title}</title><meta name="description" content="Descrizione di ${title}">
${robots ? `<meta name="robots" content="${robots}">` : ''}
<link rel="canonical" href="${'__ORIGIN__'}${'__PATH__'}">
</head><body><h1>${h1}</h1><nav>${links.map((l) => `<a href="${l}">${l}</a>`).join(' ')}</nav>
<main><p>${body}</p>${extra}</main></body></html>`;

function routes(v) {
  const nav = ['/', '/about', '/products', v === 1 ? '/old-page' : '/new-page', '/contact', '/private/x'];
  const r = {
    '/': page({ title: 'Home', h1: 'Benvenuti', body: 'Pagina principale del sito di test.', links: nav }),
    '/about': page({ title: v === 1 ? 'Chi siamo' : 'Chi siamo — nuovo', h1: 'Chi siamo', body: 'Siamo una azienda di test.', links: nav }),
    '/products': page({ title: 'Prodotti', h1: 'Prodotti', body: 'Elenco prodotti.', links: [...nav, '/products/a', '/products/b'] }),
    '/products/a': page({ title: 'Prodotto A', h1: 'A', body: v === 1 ? 'Il prodotto A.' : 'Il prodotto A, ora con molte più parole descrittive aggiunte nel rilascio due per il test.', links: nav, extra: v === 2 ? '<img src="/x.png">' : '' }),
    '/products/b': page({ title: 'Prodotto B', h1: 'B', body: 'Il prodotto B.', links: nav }),
    '/contact': page({ title: 'Contatti', h1: 'Contatti', body: 'Scrivici.', robots: v === 2 ? 'noindex' : '', links: nav }),
    '/private/x': page({ title: 'Privata', h1: 'Privata', links: nav }),
  };
  if (v === 1) r['/old-page'] = page({ title: 'Vecchia', h1: 'Vecchia', body: 'Contenuto storico.', links: nav });
  else r['/new-page'] = page({ title: 'Vecchia', h1: 'Vecchia', body: 'Contenuto storico.', links: nav });
  return r;
}

export async function startFixture() {
  let version = 1;
  let delayMs = 0;
  const server = http.createServer(async (req, res) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const url = new URL(req.url, 'http://x');
    const origin = `http://${req.headers.host}`;
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow: /private/\n');
      return;
    }
    if (url.pathname === '/sitemap.xml') {
      const locs = ['/', '/about', '/contact', '/hidden'].map((p) => `<url><loc>https://production.example${p}</loc></url>`).join('');
      res.writeHead(200, { 'content-type': 'application/xml' }).end(`<?xml version="1.0"?><urlset>${locs}</urlset>`);
      return;
    }
    if (version === 2 && url.pathname === '/old-page') {
      res.writeHead(301, { location: '/new-page' }).end();
      return;
    }
    if (version === 2 && url.pathname === '/products/b') {
      res.writeHead(500, { 'content-type': 'text/html' }).end('<h1>Errore</h1>');
      return;
    }
    if (url.pathname === '/hidden') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(page({ title: 'Nascosta', h1: 'Nascosta', links: ['/'] }).replace('__ORIGIN__', origin).replace('__PATH__', '/hidden'));
      return;
    }
    const body = routes(version)[url.pathname];
    if (!body) {
      res.writeHead(404, { 'content-type': 'text/html' }).end('<title>404</title><h1>Non trovato</h1>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body.replace('__ORIGIN__', origin).replace('__PATH__', url.pathname));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    setVersion: (v) => { version = v; },
    // slows every response down, to keep a crawl running during a test
    setDelay: (ms) => { delayMs = ms; },
    close: () => new Promise((r) => server.close(r)),
  };
}
