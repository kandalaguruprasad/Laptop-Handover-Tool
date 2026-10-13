'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const { norm, isWin } = require('./platform');
const settingsMod = require('./settings');
const { DB } = require('./db');
const { createGuard } = require('./guard');
const { createScanner } = require('./scanner');
const { createApi } = require('./api');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json' };

function parseArgs(argv) {
  const a = { sandbox: null, live: false, port: 0, open: true, data: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sandbox') a.sandbox = argv[++i];
    else if (argv[i] === '--live') a.live = true;
    else if (argv[i] === '--port') a.port = +argv[++i];
    else if (argv[i] === '--no-open') a.open = false;
    else if (argv[i] === '--data') a.data = argv[++i];
  }
  return a;
}

function createApp(opts) {
  const appRoot = path.resolve(__dirname, '..');
  const sandbox = opts.sandbox ? norm(opts.sandbox) : null;
  if (sandbox && opts.live) throw new Error('Use either --sandbox or --live, not both');
  const dataDir = norm(opts.data || (sandbox ? path.join(sandbox, '..', 'handover-data-sandbox') : path.join(appRoot, 'data')));
  fs.mkdirSync(dataDir, { recursive: true });
  const app = {
    appRoot, dataDir, sandbox,
    token: crypto.randomBytes(24).toString('hex'),
    guard: createGuard({ sandbox, live: opts.live }),
    clients: new Set(),
  };
  app.settingsFile = path.join(dataDir, 'settings.json');
  app.settings = settingsMod.load(app.settingsFile, sandbox);
  app.db = new DB(dataDir);
  app.db.load();
  app.db.recomputeSuggestions(app.settings);
  app.broadcast = (msg) => {
    const line = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of app.clients) { try { res.write(line); } catch { app.clients.delete(res); } }
  };
  app.scanner = createScanner(app);
  app.api = createApi(app);
  return app;
}

function serveStatic(req, res, urlPath) {
  const pub = path.join(__dirname, '..', 'public');
  let rel = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
  const file = path.normalize(path.join(pub, rel));
  if (!file.startsWith(pub)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) {
      if (rel !== '/index.html') return serveStatic(req, res, '/');
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('UI not built. Run: npm run build:ui');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}

function createServer(app) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      // DNS-rebinding guard: only accept loopback Host headers
      const host = (req.headers.host || '').replace(/:\d+$/, '');
      if (host !== '127.0.0.1' && host !== 'localhost') { res.writeHead(403); return res.end('bad host'); }
      if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
      const tok = req.headers['x-token'] || url.searchParams.get('token');
      if (tok !== app.token) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"bad token"}'); }
      await app.api.handle(req, res, url);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e && e.message || e) }));
    }
  });
}

function start(opts) {
  const app = createApp(opts);
  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(opts.port || 0, '127.0.0.1', () => {
      app.port = server.address().port;
      app.url = `http://127.0.0.1:${app.port}/?token=${app.token}`;
      app.server = server;
      resolve(app);
    });
  });
}

module.exports = { start, createApp, createServer, parseArgs };

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  start(opts).then((app) => {
    console.log(`Laptop Handover Tool — mode: ${app.guard.mode.toUpperCase()}`);
    if (app.guard.mode === 'readonly') console.log('Read-only: no destructive operations (start with --live or --sandbox <dir> to enable them).');
    console.log(`Data folder: ${app.dataDir}`);
    console.log(`Open: ${app.url}`);
    if (opts.open) {
      const cmd = isWin ? `start "" "${app.url}"` : process.platform === 'darwin' ? `open "${app.url}"` : `xdg-open "${app.url}"`;
      exec(cmd, () => {});
    }
  });
}
