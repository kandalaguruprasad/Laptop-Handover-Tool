'use strict';
// Worker thread: walks the whole drive (metadata only) and builds a folder tree with sizes.
// Only folders are kept in memory; files are summed into their folder, and the largest 300 files are remembered.
const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const { readDirents, Limiter, classify } = require('./projwalk');
const { CLOUD_RE } = require('./diskknow');
const { lp } = require('./platform');

const { root, profileRoot, minListBytes = 256 * 1024 } = workerData;
const usersDirNames = new Set(['users', 'home']);
const limiter = new Limiter(32);
let cancelled = false;
parentPort.on('message', (m) => { if (m && m.type === 'cancel') cancelled = true; });

const names = [path.basename(root) || root]; const parents = [-1]; const own = [0]; const ownFiles = [0];
const stats = { files: 0, dirs: 1, bytes: 0, errors: 0 };
const errorSamples = []; const cloud = []; const ext = new Map(); let top = []; let topMin = 0;
const seenLinks = new Set();
const extTop = new Map(); // ext -> largest files with that extension (so a file type can be opened and cleaned)
let lastProgress = 0; let current = root;

function progress(force) {
  const now = Date.now();
  if (!force && now - lastProgress < 400) return;
  lastProgress = now;
  parentPort.postMessage({ type: 'progress', stats: { ...stats }, current });
}
function noteError(e, where) { stats.errors++; if (errorSamples.length < 20) errorSamples.push(`${where}: ${String(e && e.code || e).slice(0, 80)}`); }

function addTop(p, size, m) {
  if (top.length >= 300 && size <= topMin) return;
  top.push({ p, s: size, m });
  if (top.length > 600) { top.sort((a, b) => b.s - a.s); top = top.slice(0, 300); }
  if (top.length >= 300) topMin = top.length > 300 ? 0 : Math.min(...top.map((t) => t.s));
}

async function processDir(idx, dir) {
  current = dir;
  let entries;
  try { entries = await limiter.run(() => readDirents(dir)); } catch (e) { noteError(e, dir); return []; }
  const items = await classify(dir, entries, limiter);
  const subs = []; const jobs = [];
  for (const e of items) {
    const full = path.join(dir, e.name);
    if (e.isDir) {
      // cloud-synced folders hold online-only files that do not use disk space: list them, do not count them
      if (CLOUD_RE.test(e.name) && (dir === profileRoot || usersDirNames.has(path.basename(path.dirname(dir)).toLowerCase()))) { cloud.push(full); continue; }
      const ci = names.length; names.push(e.name); parents.push(idx); own.push(0); ownFiles.push(0); stats.dirs++;
      subs.push([ci, full]);
    } else if (e.isFile) {
      jobs.push(limiter.run(async () => {
        try {
          const st = await fs.promises.lstat(lp(full));
          if (st.nlink > 1) { // hard links (WinSxS, git objects…) must be counted once
            const b = await fs.promises.lstat(lp(full), { bigint: true });
            const k = `${b.dev}:${b.ino}`;
            if (seenLinks.has(k)) return;
            seenLinks.add(k);
          }
          own[idx] += st.size; ownFiles[idx]++; stats.files++; stats.bytes += st.size;
          const x = path.extname(e.name).slice(1).toLowerCase();
          const c = ext.get(x) || [0, 0]; c[0] += st.size; c[1]++; ext.set(x, c);
          if (st.size > 5 * 1024 * 1024) addTop(full, st.size, st.mtimeMs);
          if (st.size >= minListBytes) {
            let arr = extTop.get(x); if (!arr) extTop.set(x, (arr = []));
            arr.push({ p: full, s: st.size, m: st.mtimeMs });
            if (arr.length > 400) { arr.sort((a, b) => b.s - a.s); arr.length = 200; }
          }
        } catch (er) { noteError(er, full); }
      }));
    }
  }
  await Promise.all(jobs);
  progress();
  return subs;
}

async function main() {
  const queue = [[0, root]];
  let active = 0;
  await new Promise((resolve) => {
    const pump = () => {
      while (active < 12 && queue.length && !cancelled) {
        const [i, d] = queue.pop(); // depth-first keeps the queue small
        active++;
        processDir(i, d).then((subs) => { for (const s of subs) queue.push(s); }).catch((e) => noteError(e, d)).finally(() => { active--; pump(); });
      }
      if (active === 0 && (queue.length === 0 || cancelled)) resolve();
    };
    pump();
  });
  top.sort((a, b) => b.s - a.s); top = top.slice(0, 300);
  const out = {
    type: 'done', cancelled, names, parents: Int32Array.from(parents), own: Float64Array.from(own), ownFiles: Int32Array.from(ownFiles),
    top, ext: [...ext].map(([k, v]) => [k, v[0], v[1]]), extTop: [...extTop].map(([k, a]) => [k, a.sort((x, y) => y.s - x.s).slice(0, 200)]), cloud, stats, errorSamples,
  };
  parentPort.postMessage(out, [out.parents.buffer, out.own.buffer, out.ownFiles.buffer]);
}
main().catch((e) => parentPort.postMessage({ type: 'error', message: String(e && e.stack || e) }));
