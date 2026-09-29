import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { handleApi } from './api.js';

const server = createServer(async (req,res) => {
  let path;
  try { path = new URL(req.url, 'http://localhost').pathname; }
  catch { res.writeHead(400).end(); return; }
  if (path === '/health') { res.writeHead(200,{'Cache-Control':'no-store'}).end('ok'); return; }
  if (path === '/nen-config') {
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(JSON.stringify({anilistClientId:process.env.ANILIST_CLIENT_ID || ''})); return;
  }
  if (path.startsWith('/nen-api/')) {
    req.url = req.url.slice('/nen-api'.length);
    await handleApi(req,res); return;
  }
  if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405,{'Allow':'GET, HEAD'}).end(); return; }
  const file = path === '/' ? '/index.html' : path === '/anilist-callback' ? '/anilist-callback.html' : path;
  // Serve only build assets and known public files, never source files or arbitrary paths.
  if (!/^\/(?:index\.html|n\.png|version\.json|anilist-callback\.(?:html|js)|assets\/[a-zA-Z0-9_-]+\.(?:js|css))$/.test(file)) {
    res.writeHead(404).end(); return;
  }
  try {
    const body = await readFile(join(__dirname, 'dist', file));
    const type = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.json':'application/json'}[extname(file)];
    res.writeHead(200,{'Content-Type':type,'X-Content-Type-Options':'nosniff','Cache-Control':file.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-store'});
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404).end(); }
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.listen(Number(process.env.PORT || 8091),'0.0.0.0');
