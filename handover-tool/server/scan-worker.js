'use strict';
// Runs in a worker thread. Metadata only: never opens file contents.
const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const { isWin, key, isInsideOrSame, PROTECTED_DIR_NAMES, norm } = require('./platform');
const { extOf, categoryOf, isProjectRoot, detectStack, DEFAULT_REGEN } = require('./categories');
const { walkTree, Limiter, readDirents, classify } = require('./projwalk');
const { gitInfo } = require('./git');

const { roots, includeAppData, regenDirs, excludePaths } = workerData;
let cancelled = false;
parentPort.on('message', (m) => { if (m && m.type === 'cancel') cancelled = true; });

const limiter = new Limiter(24);
const excludeKeys = excludePaths.map((p) => key(norm(p)));
const stats = { files: 0, dirs: 0, projects: 0, bytes: 0, skippedRegen: 0, skippedExcluded: 0, errors: 0, errorSamples: [] };
// One unreadable/vanishing path must never abort a multi-hour scan: count it, keep a few samples, carry on.
function noteError(e, where) {
  stats.errors++;
  if (stats.errorSamples.length < 15) stats.errorSamples.push(`${where}: ${String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')}`);
}
process.on('uncaughtException', (e) => noteError(e, 'uncaught'));
process.on('unhandledRejection', (e) => noteError(e, 'unhandled'));
let batch = [];
let lastProgress = 0;

function flush() {
  if (batch.length) { parentPort.postMessage({ type: 'items', items: batch }); batch = []; }
}
function progress(current, force) {
  const now = Date.now();
  if (!force && now - lastProgress < 400) return;
  lastProgress = now;
  parentPort.postMessage({ type: 'progress', stats: { ...stats }, current });
}

function isExcludedDir(full, name) {
  const lname = name.toLowerCase();
  if (PROTECTED_DIR_NAMES.has(lname)) return true;
  if (lname === 'node_modules') { stats.skippedRegen++; return true; } // never walk node_modules, even outside projects
  if (lname === 'appdata') return true; // always excluded: caches/SDKs/app data, never worth sorting
  if (lname.startsWith('.')) return true; // hidden tool folders (.npm, .nuget, .vscode, ...); a project's own .git is a marker, not walked
  const k = key(full);
  for (const ex of excludeKeys) if (k === ex || k.startsWith(ex + path.sep)) return true;
  return false;
}

function isHiddenFile(name) {
  if (name.startsWith('.') || name.startsWith('~$')) return true;
  const l = name.toLowerCase();
  return l === 'desktop.ini' || l === 'thumbs.db' || l.startsWith('ntuser.');
}

const projects = [];

async function handleProject(dir, names) {
  const res = await walkTree(dir, { regen: regenDirs, limiter, isCancelled: () => cancelled });
  stats.projects++; stats.bytes += res.bytes; stats.skippedRegen += res.regenDirs.length;
  let m = res.maxMtime;
  if (!m) { try { m = fs.statSync(dir).mtimeMs; } catch { m = 0; } }
  const item = ['p', {
    p: dir, s: res.bytes, m, fc: res.files, stack: detectStack(names), regen: res.regenDirs,
    hasGit: names.some((n) => n === '.git'),
  }];
  projects.push(item[1]);
  batch.push(item);
}

const visited = new Set();
async function processDir(dir) {
  if (cancelled) return [];
  const k = key(dir);
  if (visited.has(k)) return [];
  visited.add(k);
  let entries;
  try { entries = await limiter.run(() => readDirents(dir)); } catch (e) { noteError(e, 'readdir ' + dir); return []; }
  stats.dirs++;
  const names = entries.map((e) => e.name);
  if (isProjectRoot(names)) { await handleProject(dir, names); progress(dir); return []; }
  const subdirs = [];
  const jobs = [];
  for (const e of await classify(dir, entries, limiter)) {
    const full = path.join(dir, e.name);
    if (e.isDir) {
      if (isExcludedDir(full, e.name)) { stats.skippedExcluded++; continue; }
      subdirs.push(full);
    } else if (e.isFile) {
      if (isHiddenFile(e.name)) continue;
      jobs.push(limiter.run(async () => {
        try {
          const st = await fs.promises.lstat(full);
          stats.files++; stats.bytes += st.size;
          batch.push(['f', full, st.size, st.mtimeMs]);
        } catch (e) { noteError(e, 'stat ' + full); }
      }));
    }
  }
  await Promise.all(jobs);
  if (batch.length >= 2000) flush();
  progress(dir);
  return subdirs;
}

async function main() {
  // drop roots nested inside other roots
  const uniq = [...new Set(roots.map(norm))].filter((r) => fs.existsSync(r) && !/[\\/]appdata([\\/]|$)/i.test(r));
  // nested roots are kept on purpose: an explicit root (e.g. OneDrive inside C:\\Users) is scanned directly even if the parent walk
  // skips it; the `visited` set prevents any folder being scanned twice. Shorter paths first so parents claim their children.
  const queue = uniq.sort((a, b) => a.length - b.length);
  let active = 0;
  await new Promise((resolve) => {
    const pump = () => {
      while (active < 8 && queue.length && !cancelled) {
        const d = queue.shift();
        active++;
        processDir(d).then((subs) => { queue.push(...subs); }).catch((e) => { noteError(e, 'dir ' + d); })
          .finally(() => { active--; pump(); });
      }
      if (active === 0 && (queue.length === 0 || cancelled)) resolve();
    };
    pump();
  });
  flush();
  if (!cancelled) {
    // git status for projects (bounded)
    const withGit = projects.filter((p) => p.hasGit);
    let done = 0;
    const gl = new Limiter(4);
    await Promise.all(withGit.map((p) => gl.run(async () => {
      if (cancelled) return;
      let g = null;
      try { g = await gitInfo(p.p); } catch (e) { noteError(e, 'git ' + p.p); }
      parentPort.postMessage({ type: 'git', path: p.p, git: g });
      done++;
      progress(`git ${done}/${withGit.length}`, done === withGit.length);
    })));
  }
  progress('', true);
  parentPort.postMessage({ type: 'done', cancelled, stats });
}
main().catch((e) => parentPort.postMessage({ type: 'error', message: String(e && e.stack || e) }));
