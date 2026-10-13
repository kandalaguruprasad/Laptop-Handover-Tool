'use strict';
// Walks one project (or any folder), skipping regenerable dirs and symlinks.
// Used by the scanner (sizes), the executor (pre/post copy verification) and purge.
const fs = require('fs');
const path = require('path');
const { isWin, lp } = require('./platform');
const { isRegenDir, makeRegenSet } = require('./categories');

class Limiter {
  constructor(n) { this.n = n; this.active = 0; this.q = []; }
  async run(fn) {
    if (this.active >= this.n) await new Promise((r) => this.q.push(r));
    this.active++;
    try { return await fn(); } finally { this.active--; const next = this.q.shift(); if (next) next(); }
  }
}

async function readDirents(dir) {
  const out = [];
  const d = await fs.promises.opendir(lp(dir));
  for await (const e of d) out.push(e);
  return out;
}

/**
 * @returns {{files:number, bytes:number, maxMtime:number, regenDirs:string[], errors:number}}
 * maxMtime ignores anything inside .git (git churns constantly).
 * opts.regen: array of names; opts.limiter: shared Limiter; opts.isCancelled: fn
 */
async function walkTree(root, opts = {}) {
  const regenSet = makeRegenSet(opts.regen || [], isWin);
  const limiter = opts.limiter || new Limiter(16);
  const useRegen = opts.regen && opts.regen.length > 0;
  const res = { files: 0, bytes: 0, maxMtime: 0, regenDirs: [], errors: 0 };

  async function visit(dir, inGit) {
    if (opts.isCancelled && opts.isCancelled()) return;
    let entries;
    try { entries = await limiter.run(() => readDirents(dir)); } catch { res.errors++; return; }
    const names = entries.map((e) => e.name);
    const subdirs = [];
    const statJobs = [];
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (useRegen && isRegenDir(e.name, regenSet, names, isWin)) { res.regenDirs.push(full); continue; }
        subdirs.push([full, inGit || e.name === '.git']);
      } else if (e.isFile()) {
        statJobs.push(limiter.run(async () => {
          try {
            const st = await fs.promises.lstat(lp(full));
            res.files++; res.bytes += st.size;
            if (!inGit && st.mtimeMs > res.maxMtime) res.maxMtime = st.mtimeMs;
          } catch { res.errors++; }
        }));
      }
    }
    await Promise.all([...statJobs, ...subdirs.map(([d, g]) => visit(d, g))]);
  }
  await visit(root, false);
  return res;
}

module.exports = { walkTree, Limiter, readDirents };
