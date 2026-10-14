'use strict';
// "C Drive" tab backend: whole-drive size analysis, explanations, quick wins, guarded cleanup.
const { Worker } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { norm, key, isInside, isWin, isRootPath } = require('./platform');
const { buildEnv, explain, GROUP_TITLES } = require('./diskknow');
const { freeBytes, listDrives } = require('./drives');
const { readDirents, classify, Limiter } = require('./projwalk');
const { FsOps } = require('./fsops');
const { GuardError } = require('./guard');

const TYPE_GROUPS = [
  ['Videos', 'mp4 mkv mov avi wmv flv webm m4v mpg mpeg 3gp'], ['Pictures', 'jpg jpeg png gif bmp webp svg heic tif tiff raw cr2 nef psd ico'], ['Music', 'mp3 wav flac aac m4a ogg wma'],
  ['Documents', 'pdf doc docx xls xlsx ppt pptx txt md csv rtf odt'], ['Archives', 'zip rar 7z tar gz tgz bz2 xz cab'],
  ['Disk images & virtual machines', 'iso img vhd vhdx vmdk vdi ova qcow2 wim esd'], ['Programs & system files', 'exe dll sys msi mui msix appx drv ocx cat manifest mum nls'],
  ['Code & project files', 'js ts tsx jsx json py java class jar c cpp h cs go rs rb php html css map lock'], ['Logs, dumps & temp', 'log etl dmp mdmp tmp temp bak old'],
];
const TYPE_OF = new Map(); for (const [g, list] of TYPE_GROUPS) for (const e of list.split(' ')) TYPE_OF.set(e, g);
const QUICK_NAMES = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.next', '.pytest_cache', '.parcel-cache', '.turbo', '.gradle', 'cache', 'code cache', 'gpucache', 'cache2', 'temp', 'crashdumps', 'inetcache',
  'minidump', 'livekernelreports', 'download', '_cacache', 'caches', 'explorer', 'npm-cache', '.cache', 'store', 'media cache', 'cachestorage', '$recycle.bin', '.recycle', 'cacheddata', 'cachedextensions', 'cachedextensionvsixs', 'crashpad', 'dawncache', 'grshadercache', 'shadercache', 'blob_storage', 'component_crx_cache', 'logs', 'log', 'registry']);

function createDiskService(app) {
  const st = { running: false, stats: null, current: '', startedAt: 0, error: null, scannedAt: 0, tree: null, worker: null };
  const env = () => buildEnv({ sandbox: app.sandbox, profileRoot: app.settings.profileRoot });
  const diskGuard = {
    get destructiveEnabled() { return app.guard.destructiveEnabled; },
    assertWritable(p) {
      const e = env(); const r = norm(p);
      if (isRootPath(r) || !isInside(r, e.root)) throw new GuardError(`Outside the drive being cleaned: ${r}`);
      if (app.sandbox && !isInside(r, norm(app.sandbox))) throw new GuardError(`Sandbox: refusing path outside ${app.sandbox}`);
      let isDir = false; try { isDir = fs.lstatSync(r).isDirectory(); } catch { /* gone */ }
      const x = explain(r, isDir, e);
      if (!x.deletable) throw new GuardError(`Not deletable here (${x.title}): ${r}`);
      return r;
    },
    assertRecycleDest(p) { if (!app.sandbox || !isInside(norm(p), norm(app.sandbox))) throw new GuardError('Bad recycle destination'); },
    assertNotSymlink: (p) => app.guard.assertNotSymlink(p),
  };
  const fsops = new FsOps({ guard: diskGuard, dataDir: app.dataDir, sandbox: app.sandbox });

  // ---------------- tree helpers ----------------
  const T = () => st.tree;
  function idxOf(p) {
    const t = T(); if (!t) return -1;
    const rel = path.relative(t.rootPath, norm(p));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return -1;
    let cur = 0;
    for (const seg of rel.split(path.sep).filter(Boolean)) {
      let found = -1;
      for (let c = t.first[cur]; c !== -1; c = t.next[c]) if (!t.gone[c] && t.names[c].toLowerCase() === seg.toLowerCase()) { found = c; break; }
      if (found === -1) return -1; cur = found;
    }
    return cur;
  }
  function pathOf(i) { const t = T(); const parts = []; for (let c = i; c > 0; c = t.parents[c]) parts.push(t.names[c]); return path.join(t.rootPath, ...parts.reverse()); }
  function subtract(idx, bytes, files) { const t = T(); for (let c = idx; c !== -1; c = t.parents[c]) { t.total[c] -= bytes; t.totalFiles[c] -= files; if (t.total[c] < 0) t.total[c] = 0; if (t.totalFiles[c] < 0) t.totalFiles[c] = 0; } }

  function build(m) {
    const n = m.names.length; const parents = m.parents; const total = Float64Array.from(m.own); const totalFiles = Float64Array.from(m.ownFiles);
    for (let i = n - 1; i > 0; i--) { total[parents[i]] += total[i]; totalFiles[parents[i]] += totalFiles[i]; }
    const first = new Int32Array(n).fill(-1); const next = new Int32Array(n).fill(-1);
    for (let i = n - 1; i > 0; i--) { next[i] = first[parents[i]]; first[parents[i]] = i; }
    st.tree = { names: m.names, parents, own: m.own, ownFiles: m.ownFiles, total, totalFiles, first, next, gone: new Uint8Array(n), top: m.top, ext: m.ext, cloud: m.cloud, errors: m.stats.errors, errorSamples: m.errorSamples, rootPath: env().root };
  }

  function start() {
    if (st.running) return false;
    Object.assign(st, { running: true, error: null, stats: null, current: '', startedAt: Date.now() });
    const w = new Worker(path.join(__dirname, 'disk-worker.js'), { workerData: { root: env().root, profileRoot: norm(app.settings.profileRoot) } });
    st.worker = w;
    const push = () => app.broadcast({ type: 'disk', state: scanView() });
    w.on('message', (m) => {
      try {
        if (m.type === 'progress') { st.stats = m.stats; st.current = m.current; push(); }
        else if (m.type === 'done') { if (!m.cancelled) { build(m); st.scannedAt = Date.now(); } st.stats = m.stats; st.running = false; w.terminate(); push(); }
        else if (m.type === 'error') { st.error = m.message; st.running = false; w.terminate(); push(); }
      } catch (e) { st.error = String(e.stack || e); st.running = false; w.terminate(); push(); }
    });
    w.on('error', (e) => { st.error = String(e); st.running = false; push(); });
    return true;
  }
  const cancel = () => { if (st.worker && st.running) st.worker.postMessage({ type: 'cancel' }); };
  const scanView = () => ({ running: st.running, stats: st.stats, current: st.current, startedAt: st.startedAt, error: st.error, scannedAt: st.scannedAt });

  async function drive() {
    const e = env(); const f = freeBytes(e.root);
    let fsName = '';
    try { const d = await listDrives(); const hit = d.filter((x) => key(e.root).startsWith(key(norm(x.path)))).sort((a, b) => b.path.length - a.path.length)[0]; if (hit) { fsName = hit.fs; if (!f) return { path: e.root, total: hit.total, free: hit.free, used: hit.used, fs: fsName }; } } catch { /* ignore */ }
    return { path: e.root, total: f ? f.total : 0, free: f ? f.free : 0, used: f ? f.total - f.free : 0, fs: fsName };
  }

  async function state() {
    const t = T(); const d = await drive();
    const scanned = t ? t.total[0] : 0;
    return { drive: d, scan: scanView(), scanned: !!t, scannedBytes: scanned, unaccounted: t ? d.used - scanned : 0,
      cloud: t ? t.cloud : [], unreadable: t ? t.errors : 0, unreadableSamples: t ? t.errorSamples : [], sandbox: !!app.sandbox };
  }

  const view = (p, isDir, size, extra = {}) => { const x = explain(p, isDir, env()); return { name: path.basename(p), path: p, isDir, size, verdict: x.verdict, title: x.title, why: x.why, deletable: x.deletable, special: x.special || null, group: x.group || null, ...extra }; };

  async function list(p) {
    const t = T(); if (!t) throw new Error('Scan the drive first.');
    const target = p ? norm(p) : t.rootPath; const idx = idxOf(target);
    if (idx === -1) throw new Error('Folder not in the scan (it may have been deleted).');
    const dirs = []; for (let c = t.first[idx]; c !== -1; c = t.next[c]) if (!t.gone[c]) dirs.push(c);
    dirs.sort((a, b) => t.total[b] - t.total[a]);
    const total = t.total[idx];
    const dirRows = dirs.slice(0, 400).map((c) => view(path.join(target, t.names[c]), true, t.total[c], { files: t.totalFiles[c], pct: total ? t.total[c] / total : 0 }));
    // files directly in this folder: read live, so the list reflects what is on disk now
    const files = [];
    try {
      const lim = new Limiter(16);
      const items = (await classify(target, await readDirents(target), lim)).filter((e) => e.isFile).slice(0, 5000);
      await Promise.all(items.map((e) => lim.run(async () => { try { const s = await fs.promises.lstat(path.join(target, e.name)); files.push(view(path.join(target, e.name), false, s.size, { m: s.mtimeMs, pct: total ? s.size / total : 0 })); } catch { /* gone */ } })));
    } catch { /* unreadable */ }
    files.sort((a, b) => b.size - a.size);
    const crumbs = []; const rel = path.relative(t.rootPath, target).split(path.sep).filter(Boolean); let acc = t.rootPath;
    crumbs.push({ name: t.rootPath, path: t.rootPath }); for (const s of rel) { acc = path.join(acc, s); crumbs.push({ name: s, path: acc }); }
    return { path: target, crumbs, total, ownBytes: t.own[idx], here: view(target, true, total, { files: t.totalFiles[idx] }), dirs: dirRows, files: files.slice(0, 150), moreFiles: Math.max(0, files.length - 150), moreDirs: Math.max(0, dirs.length - 400) };
  }

  function topFiles() {
    const t = T(); if (!t) throw new Error('Scan the drive first.');
    return t.top.filter((f) => fs.existsSync(f.p)).slice(0, 150).map((f) => view(f.p, false, f.s, { m: f.m }));
  }

  function categories() {
    const t = T(); if (!t) throw new Error('Scan the drive first.');
    const by = new Map();
    for (const [e, bytes, count] of t.ext) { const g = TYPE_OF.get(e) || 'Other files'; const c = by.get(g) || { name: g, bytes: 0, files: 0 }; c.bytes += bytes; c.files += count; by.set(g, c); }
    return [...by.values()].sort((a, b) => b.bytes - a.bytes);
  }

  function quickWins() {
    const t = T(); if (!t) throw new Error('Scan the drive first.');
    const e = env(); const found = new Map(); const keep = [];
    const consider = (i) => {
      const p = pathOf(i); const x = explain(p, true, e);
      if (!x.group) return;
      if (keep.some((k) => k.group === x.group && isInside(p, k.p))) return; // outermost only
      keep.push({ p, group: x.group, bytes: t.total[i], deletable: x.deletable, special: x.special });
    };
    for (let i = 1; i < t.names.length; i++) if (!t.gone[i] && QUICK_NAMES.has(t.names[i].toLowerCase()) && t.total[i] > 0) consider(i);
    keep.sort((a, b) => a.p.length - b.p.length);
    const filtered = [];
    for (const k of keep) if (!filtered.some((f) => f.group === k.group && isInside(k.p, f.p))) filtered.push(k);
    for (const k of filtered) { const g = found.get(k.group) || { group: k.group, title: GROUP_TITLES[k.group] || k.group, bytes: 0, paths: [], special: null }; g.bytes += k.bytes; g.paths.push({ path: k.p, bytes: k.bytes, deletable: k.deletable }); if (k.special) g.special = k.special; found.set(k.group, g); }
    const sample = { recycle: 'safe' };
    return [...found.values()].filter((g) => g.bytes > 0).map((g) => {
      const x = explain(g.paths[0].path, true, e);
      g.paths.sort((a, b) => b.bytes - a.bytes);
      return { ...g, verdict: sample[g.group] || x.verdict, why: x.why, deletableCount: g.paths.filter((p) => p.deletable).length };
    }).sort((a, b) => b.bytes - a.bytes);
  }

  async function remove(paths, { permanent }) {
    const t = T(); const e = env(); const results = [];
    for (const raw of paths) {
      const p = norm(String(raw));
      try {
        if (!app.guard.destructiveEnabled) throw new GuardError('Read-only mode: restart with --live (or --sandbox).');
        const s = fs.lstatSync(p); const isDir = s.isDirectory();
        diskGuard.assertWritable(p);
        if (s.isSymbolicLink()) throw new GuardError('Refusing a symlink/junction');
        const before = isDir ? (() => { const i = idxOf(p); return i >= 0 ? { i, bytes: t.total[i], files: t.totalFiles[i] } : null; })() : { i: -1, bytes: s.size, files: 1 };
        if (permanent && isDir) await fsops.purgeDir(p);
        else { const [r] = await fsops.recycle([{ p, isDir }], { permanent: !!permanent }); if (!r.ok) throw new Error(r.error); }
        if (t) {
          if (isDir && before && before.i >= 0) { subtract(t.parents[before.i], before.bytes, before.files); t.gone[before.i] = 1; }
          else if (!isDir) { const pi = idxOf(path.dirname(p)); if (pi >= 0) { t.own[pi] -= s.size; subtract(pi, s.size, 1); } t.top = t.top.filter((f) => key(f.p) !== key(p)); }
        }
        results.push({ path: p, ok: true, bytes: before ? before.bytes : 0 });
      } catch (err) { results.push({ path: p, ok: false, error: String(err.message || err) }); }
    }
    void e;
    return results;
  }

  // ---- background cleanup job (long deletes must not block an HTTP request or hide their progress) ----
  let job = null;
  const jobView = () => job && { phase: job.phase, total: job.total, done: job.done, ok: job.ok, failed: job.failed, freed: job.freed, current: job.current, startedAt: job.startedAt, finishedAt: job.finishedAt || 0,
    permanent: job.permanent, errors: job.errors.slice(0, 50), cancelled: job.cancelled };
  function startClean(paths, { permanent }) {
    if (job && job.phase === 'running') throw new Error('A cleanup is already running.');
    job = { phase: 'running', total: paths.length, done: 0, ok: 0, failed: 0, freed: 0, current: '', startedAt: Date.now(), permanent: !!permanent, errors: [], cancelled: false };
    const j = job; let last = 0; let next = 0;
    const push = (force) => { const now = Date.now(); if (!force && now - last < 300) return; last = now; app.broadcast({ type: 'disk-clean', state: jobView() }); };
    const worker = async () => {
      while (next < paths.length && !j.cancelled) {
        const p = paths[next++]; j.current = p; push();
        const [r] = await remove([p], { permanent });
        j.done++;
        if (r.ok) { j.ok++; j.freed += r.bytes || 0; } else { j.failed++; j.errors.push({ path: r.path, error: r.error }); }
        push();
      }
    };
    Promise.all([worker(), worker(), worker()]).catch((e) => { j.errors.push({ path: '', error: String(e.message || e) }); })
      .finally(() => { j.phase = j.cancelled ? 'cancelled' : 'finished'; j.current = ''; j.finishedAt = Date.now(); push(true); app.broadcast({ type: 'disk-changed' }); });
    push(true);
    return true;
  }

  async function emptyRecycleBin() {
    if (!app.guard.destructiveEnabled) throw new GuardError('Read-only mode: restart with --live (or --sandbox).');
    const e = env(); const t = T(); const idx = t ? idxOf(e.recycle) : -1; const bytes = idx >= 0 ? t.total[idx] : 0;
    if (e.sandbox) {
      if (!isInside(e.recycle, norm(app.sandbox))) throw new GuardError('Sandbox: bad recycle path');
      if (fs.existsSync(e.recycle)) for (const n of fs.readdirSync(e.recycle)) fs.rmSync(path.join(e.recycle, n), { recursive: true, force: true });
    } else if (isWin) {
      await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Clear-RecycleBin -Force -ErrorAction Stop'], { windowsHide: true, timeout: 20 * 60 * 1000 }, (err) => (err && !/empty/i.test(String(err.message)) ? reject(err) : resolve())));
    } else throw new Error('Recycle Bin is only available on Windows');
    if (idx >= 0) { subtract(t.parents[idx], bytes, t.totalFiles[idx]); t.total[idx] = 0; t.totalFiles[idx] = 0; for (let c = t.first[idx]; c !== -1; c = t.next[c]) t.gone[c] = 1; }
    return { freed: bytes };
  }

  return { start, cancel, state, list, topFiles, categories, quickWins, remove, startClean, cleanView: jobView, cancelClean: () => { if (job) job.cancelled = true; }, emptyRecycleBin, scanView, isScanned: () => !!st.tree };
}

module.exports = { createDiskService, TYPE_GROUPS };
