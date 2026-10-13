'use strict';
const fs = require('fs');
const path = require('path');
const settingsMod = require('./settings');
const { listDrives } = require('./drives');
const { findDuplicates, markDuplicatesIgnore } = require('./dupes');
const { TAGS } = require('./db');
const { writeJsonAtomic } = require('./jsonfile');
const { norm, isInsideOrSame } = require('./platform');

const IMG_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon' };
const MAX_THUMB = 25 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 64 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function num(v) { if (v === undefined || v === null || v === '') return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined; }

function parseFilter(o) {
  const f = {};
  if (o.tab) f.tab = String(o.tab);
  if (o.q) f.q = String(o.q);
  if (o.tag) f.tag = String(o.tag);
  for (const k of ['minSize', 'maxSize', 'from', 'to']) { const n = num(o[k]); if (n !== undefined) f[k] = n; }
  if (o.ext) f.ext = String(o.ext);
  if (o.group === true || o.group === 'true' || o.group === '1') f.group = true;
  if (o.sort) f.sort = String(o.sort);
  if (o.dir) f.dir = String(o.dir);
  return f;
}

function createApi(app) {
  const routes = new Map();
  const route = (method, p, fn) => routes.set(method + ' ' + p, fn);
  const json = (res, data, code = 200) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
  const ctx = { app, route, json, readBody, parseFilter };

  route('GET', '/api/state', async (req, res) => json(res, {
    mode: app.guard.mode, sandbox: app.sandbox, settings: app.settings, scan: app.scanner.state(),
    summary: app.db.summary(), platform: process.platform, dataDir: app.dataDir,
  }));

  route('GET', '/api/profile-folders', async (req, res) => {
    let dirs = [];
    try { dirs = fs.readdirSync(app.settings.profileRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.') && e.name.toLowerCase() !== 'appdata').map((e) => path.join(app.settings.profileRoot, e.name)); } catch { /* none */ }
    json(res, { dirs });
  });

  // top-level folders of a drive/folder (names only) so Settings can offer one-click scan roots
  route('GET', '/api/dirs', async (req, res, url) => {
    const base = String(url.searchParams.get('path') || '');
    let dirs = [];
    try {
      const skip = new Set(['windows', 'program files', 'program files (x86)', 'programdata', '$recycle.bin', 'system volume information', 'recovery', 'perflogs', 'msocache', '$windows.~bt', '$winreagent']);
      dirs = fs.readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !skip.has(e.name.toLowerCase()) && !e.name.startsWith('$'))
        .map((e) => path.join(base, e.name));
    } catch { /* unreadable */ }
    json(res, { dirs });
  });

  // cloud-synced folders (Dropbox / OneDrive / Google Drive ...) living on the laptop
  route('GET', '/api/cloud-folders', async (req, res) => {
    const found = new Map();
    const add = (p, kind) => { if (p && fs.existsSync(p)) found.set(norm(p).toLowerCase(), { path: norm(p), kind }); };
    const prof = app.settings.profileRoot;
    try {
      for (const e of fs.readdirSync(prof, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const m = /^(onedrive|dropbox|google ?drive|icloud|box)/i.exec(e.name);
        if (m) add(path.join(prof, e.name), m[1].toLowerCase().startsWith('one') ? 'OneDrive' : m[1].toLowerCase().startsWith('drop') ? 'Dropbox' : m[1].toLowerCase().startsWith('google') ? 'Google Drive' : m[1]);
      }
    } catch { /* no profile */ }
    for (const k of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) add(process.env[k], 'OneDrive');
    for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA]) { // Dropbox may be in a custom location
      try { const j = JSON.parse(fs.readFileSync(path.join(base || '', 'Dropbox', 'info.json'), 'utf8')); for (const v of Object.values(j)) add(v && v.path, 'Dropbox'); } catch { /* not installed */ }
    }
    const roots = app.settings.scanRoots.map((r) => norm(r));
    const out = [...found.values()].map((f) => {
      let bytes = 0; let files = 0;
      for (const it of app.db.items) if (isInsideOrSame(it.p, f.path)) { bytes += it.s; files++; }
      const covered = roots.some((r) => isInsideOrSame(f.path, r));
      return { ...f, bytes, files, covered };
    });
    json(res, { folders: out });
  });

  route('GET', '/api/drives', async (req, res) => json(res, { drives: await listDrives() }));

  route('GET', '/api/settings', async (req, res) => json(res, app.settings));
  route('PUT', '/api/settings', async (req, res) => {
    const body = await readBody(req);
    app.settings = settingsMod.sanitize(body, app.settings);
    writeJsonAtomic(app.settingsFile, app.settings);
    app.db.recomputeSuggestions(app.settings);
    app.broadcast({ type: 'db-changed' });
    json(res, app.settings);
  });

  route('POST', '/api/scan/start', async (req, res) => json(res, { started: app.scanner.start() }));
  route('POST', '/api/scan/cancel', async (req, res) => { app.scanner.cancel(); json(res, { ok: true }); });

  route('GET', '/api/items', async (req, res, url) => {
    const q = Object.fromEntries(url.searchParams);
    const f = parseFilter(q);
    json(res, app.db.page(f, Math.max(0, num(q.offset) || 0), Math.min(500, num(q.limit) || 100)));
  });

  route('POST', '/api/ids', async (req, res) => {
    const b = await readBody(req);
    json(res, { ids: app.db.idsRange(parseFilter(b.filter || {}), num(b.from), num(b.to)) });
  });

  route('POST', '/api/tag', async (req, res) => {
    const b = await readBody(req);
    const tag = b.tag === null || b.tag === undefined ? null : String(b.tag);
    if (tag !== null && !TAGS.includes(tag)) return json(res, { error: 'bad tag' }, 400);
    let ids;
    let n;
    if (b.group !== undefined && b.filter) {
      // group header buttons: only the rows listed under that header (direct children of the folder, within the current filters)
      ids = app.db.idsRange(parseFilter(b.filter)).filter((id) => app.db.items[id].d === String(b.group));
      n = app.db.applyTag(ids, tag);
    } else if (b.folder) {
      n = app.db.tagFolder(String(b.folder), tag);
      ids = app.db.items.filter((it) => it.cloud && it.p.startsWith(String(b.folder))).map((i) => i.id);
    } else {
      if (Array.isArray(b.ids)) ids = b.ids;
      else if (b.filter) {
        const except = new Set(b.except || []);
        ids = app.db.idsRange(parseFilter(b.filter)).filter((id) => !except.has(id));
      } else return json(res, { error: 'no selection' }, 400);
      n = app.db.applyTag(ids, tag);
    }
    const cloud = tag === 'mine' || tag === 'ignore' ? ids.filter((id) => app.db.items[id] && app.db.items[id].cloud).length : 0;
    app.broadcast({ type: 'db-changed' });
    json(res, { changed: n, cloud });
  });

  route('POST', '/api/suggestions/accept', async (req, res) => {
    const b = await readBody(req);
    const n = app.db.acceptSuggestions(b.tab);
    app.broadcast({ type: 'db-changed' });
    json(res, { accepted: n });
  });

  route('GET', '/api/summary', async (req, res) => json(res, app.db.summary()));
  route('GET', '/api/storage', async (req, res) => json(res, app.db.storage()));

  // --- duplicates (lazy, user-triggered) ---
  let dupeJob = null;
  route('POST', '/api/dupes/find', async (req, res) => {
    if (dupeJob) return json(res, { running: true });
    dupeJob = findDuplicates(app.db, (done, total) => app.broadcast({ type: 'dupes', done, total }))
      .then((g) => { app.db.dupes = g; app.broadcast({ type: 'dupes', done: 1, total: 1, finished: true }); })
      .finally(() => { dupeJob = null; });
    json(res, { started: true });
  });
  route('GET', '/api/dupes', async (req, res) => {
    const g = app.db.dupes;
    if (!g) return json(res, { computed: false, running: !!dupeJob });
    const view = g.slice(0, 200).map((ids) => ({ size: app.db.items[ids[0]].s, items: ids.map((id) => app.db.itemView(app.db.items[id])) }));
    json(res, { computed: true, running: !!dupeJob, groups: g.length, wasted: g.reduce((a, ids) => a + app.db.items[ids[0]].s * (ids.length - 1), 0), view });
  });
  route('POST', '/api/dupes/mark', async (req, res) => {
    if (!app.db.dupes) return json(res, { error: 'run duplicate scan first' }, 400);
    const n = markDuplicatesIgnore(app.db, app.db.dupes);
    app.broadcast({ type: 'db-changed' });
    json(res, { marked: n });
  });

  // --- thumbnails: only paths that exist in the scan DB ---
  route('GET', '/api/thumb', async (req, res, url) => {
    const it = app.db.items[Number(url.searchParams.get('id'))];
    const mime = it && it.kind === 'f' ? IMG_MIME[it.e] : null;
    if (!it || !mime || it.s > MAX_THUMB || it.cloud) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': mime, 'cache-control': 'private, max-age=3600' });
    fs.createReadStream(it.p).on('error', () => res.end()).pipe(res);
  });

  route('GET', '/api/events', async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    app.clients.add(res);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* closed */ } }, 20000);
    req.on('close', () => { clearInterval(ka); app.clients.delete(res); });
  });

  try { require('./api-exec').register(ctx); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }

  return {
    async handle(req, res, url) {
      const fn = routes.get(req.method + ' ' + url.pathname);
      if (!fn) return json(res, { error: 'not found' }, 404);
      try { await fn(req, res, url); } catch (e) { if (!res.headersSent) json(res, { error: String(e.message || e) }, 500); else res.end(); }
    },
  };
}

module.exports = { createApi, parseFilter };
