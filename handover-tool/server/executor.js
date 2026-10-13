'use strict';
// Runs a plan. Invariants:
//  * A source is removed only after that op's copy was verified (status 'verified' is journaled first).
//  * Every status change is journaled before the next step, and every step is idempotent, so a crash
//    or restart resumes safely and never repeats a destructive step.
const fs = require('fs');
const path = require('path');
const { VerifyError } = require('./fsops');
const { walkTree } = require('./projwalk');
const { isInside, norm, lp } = require('./platform');

class CancelError extends Error {}
class OpError extends Error {}

function makeControl() {
  const c = {
    paused: false, cancelled: false, reason: '', waiters: [], onChange: null,
    pause(reason) { c.paused = true; c.reason = reason || ''; c.onChange && c.onChange(); },
    resume() { c.paused = false; c.reason = ''; c.waiters.splice(0).forEach((r) => r()); c.onChange && c.onChange(); },
    cancel() { c.cancelled = true; c.waiters.splice(0).forEach((r) => r()); c.onChange && c.onChange(); },
    async gate() {
      while (c.paused && !c.cancelled) await new Promise((r) => c.waiters.push(r));
      if (c.cancelled) throw new CancelError('cancelled');
    },
  };
  return c;
}

const exists = (p) => fs.existsSync(lp(p));
const isDone = (op) => op.status === 'source-removed' || op.status === 'failed' || (op.status === 'verified' && !op.removeSource && op.action === 'copy');

function uniqueDst(dst, isDir) {
  for (let n = 2; n < 1000; n++) {
    let cand;
    if (isDir) cand = `${dst} (${n})`;
    else { const ext = path.extname(dst); cand = `${dst.slice(0, dst.length - ext.length)} (${n})${ext}`; }
    if (!exists(cand)) return cand;
  }
  throw new OpError('No free destination name');
}

/**
 * @param plan  loaded plan (ops carry journal-replayed statuses)
 * @param env   { fsops, journal, emit, ctl, active:Map, logDir, concurrency?, hooks? }
 */
async function runPlan(plan, env) {
  const { fsops, journal, emit, ctl } = env;
  const S = plan.settings;
  const hooks = env.hooks || {};
  const active = env.active || new Map();
  const concurrency = env.concurrency || 8;
  const logFile = (op) => (env.logDir ? path.join(env.logDir, `robocopy-${op.id}.log`) : null);
  const tick = () => emit({ type: 'tick' });

  const setStatus = (op, patch) => {
    Object.assign(op, patch);
    journal.append({ id: op.id, ...patch });
    emit({ type: 'op', id: op.id, patch });
  };
  const assertInsideRoots = (p) => {
    if (!plan.scanRoots.some((r) => isInside(p, r))) throw new OpError(`Refusing to remove ${p}: not inside a scanned root`);
  };
  const regenOf = async (dir) => (await walkTree(dir, { regen: S.regenDirs })).regenDirs;
  const verify = async (op) => {
    if (hooks.verify) return hooks.verify(op, fsops);
    if (op.kind === 'project') return fsops.verifyTree(op.src, op.dst, S.regenDirs, S.paranoidHash);
    return fsops.verifyFile(op.src, op.dst, S.paranoidHash);
  };

  async function removeSource(op) {
    assertInsideRoots(op.src);
    if (!exists(op.src)) return;
    if (op.kind === 'project') await fsops.purgeAll(await regenOf(op.src));
    const [r] = await fsops.recycle([{ p: op.src, isDir: op.kind === 'project' }], { permanent: S.permanentDelete });
    if (!r.ok) throw new OpError(`Could not remove source: ${r.error}`);
  }

  async function processCopy(op) {
    const isProj = op.kind === 'project';
    let justVerified = false;
    if (op.status === 'pending' || op.status === 'copying') {
      if (!exists(op.src)) throw new OpError('Source no longer exists');
      if (op.status === 'pending' && !op.reuse && exists(op.dst)) setStatus(op, { dst: uniqueDst(op.dst, isProj) });
      setStatus(op, { status: 'copying', error: null });
      if (hooks.beforeCopy) await hooks.beforeCopy(op);
      if (isProj) {
        const w = await walkTree(op.src, { regen: S.regenDirs });
        await fsops.copyTree(op.src, op.dst, { regenDirs: S.regenDirs, xdPaths: w.regenDirs, logFile: logFile(op) });
      } else await fsops.copyFile(op.src, op.dst);
      if (hooks.afterCopy) await hooks.afterCopy(op);
      await verify(op);
      setStatus(op, { status: 'verified', verified: true });
      justVerified = true;
    }
    if (op.status === 'verified' && op.removeSource) {
      if (!exists(op.src)) { setStatus(op, { status: 'source-removed', finishedAt: Date.now() }); return; }
      if (!justVerified) await verify(op); // resumed run: re-check before deleting anything
      await removeSource(op);
      setStatus(op, { status: 'source-removed', finishedAt: Date.now() });
    }
  }

  async function processMove(op) {
    const isProj = op.kind === 'project';
    if (op.status !== 'pending' && op.status !== 'copying') return;
    const srcThere = exists(op.src); const dstThere = exists(op.dst);
    if (srcThere && dstThere && op.reuse) { setStatus(op, { action: 'copy', removeSource: true }); return processCopy(op); }
    if (!(op.status === 'copying' && !srcThere && dstThere)) {
      if (!srcThere) throw new OpError('Source no longer exists');
      if (op.status === 'pending' && dstThere) setStatus(op, { dst: uniqueDst(op.dst, isProj) });
      setStatus(op, { status: 'copying', error: null });
      if (hooks.beforeCopy) await hooks.beforeCopy(op);
      try { await fsops.move(op.src, op.dst); } catch (e) {
        // Rename can fail for reasons a copy does not hit: other volume (EXDEV), OneDrive/Dropbox placeholder folders
        // (UNKNOWN), AV/indexer locks (EPERM/EBUSY/EACCES). Fall back to copy -> verify -> remove, never to anything riskier.
        if (e.code !== 'ENOENT' && exists(op.src) && !exists(op.dst)) { setStatus(op, { action: 'copy', removeSource: true, note: `rename failed (${e.code || e.message}); using verified copy instead` }); return processCopy(op); }
        throw e;
      }
    }
    if (isProj && op.removeRegen) await fsops.purgeAll(await regenOf(op.dst));
    setStatus(op, { status: 'source-removed', verified: true, finishedAt: Date.now() });
  }

  async function processRecycleBatch(ops) {
    const items = []; const live = [];
    for (const op of ops) {
      if (isDone(op)) continue;
      if (!exists(op.src)) { setStatus(op, { status: 'source-removed', finishedAt: Date.now(), note: 'already gone' }); continue; }
      try {
        assertInsideRoots(op.src);
        if (op.kind === 'project') await fsops.purgeAll(await regenOf(op.src));
        items.push({ p: op.src, isDir: op.kind === 'project' }); live.push(op);
      } catch (e) { setStatus(op, { status: 'failed', error: String(e.message || e) }); }
    }
    if (!items.length) return;
    let results;
    try { results = await fsops.recycle(items, { permanent: S.permanentDelete }); } catch (e) { results = items.map((it) => ({ p: it.p, ok: false, error: e.message })); }
    results.forEach((r, i) => {
      if (r.ok) setStatus(live[i], { status: 'source-removed', finishedAt: Date.now() });
      else setStatus(live[i], { status: 'failed', error: r.error || 'failed' });
    });
  }

  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  const diskGone = (op) => op.dst && plan.destDisk && op.dst.startsWith(plan.destRoot || '\0') && !isDir(plan.destDisk);

  async function guarded(op, fn) {
    for (;;) {
      await ctl.gate();
      try {
        if (diskGone(op)) throw Object.assign(new Error('destination disk missing'), { diskGone: true });
        active.set(op.id, { name: op.name, since: Date.now() }); tick();
        await fn(op);
        return;
      } catch (e) {
        if (e instanceof CancelError || ctl.cancelled) throw new CancelError('cancelled');
        if (e.diskGone || diskGone(op)) {
          ctl.pause(`Destination disk not available (${plan.destDisk}). Reconnect it, then press Resume.`);
          continue; // status stays 'copying' → resume redoes the copy
        }
        setStatus(op, { status: 'failed', error: String(e && e.message || e), attempts: (op.attempts || 0) + 1 });
        return;
      } finally { active.delete(op.id); tick(); }
    }
  }

  async function pool(list, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
      while (i < list.length) { const op = list[i++]; await guarded(op, fn); }
    }));
  }

  const handler = (op) => (op.action === 'move' ? processMove(op) : processCopy(op));
  let cancelled = false;
  try {
    for (const tag of ['company', 'mine', 'ignore']) {
      const todo = plan.ops.filter((o) => o.tag === tag && !isDone(o));
      const projects = todo.filter((o) => o.kind === 'project');
      const files = todo.filter((o) => o.kind === 'file');
      if (tag === 'ignore') {
        const chunks = [];
        const all = [...projects, ...files];
        // projects in small batches (each does a fast purge first), files in big batches (PowerShell start-up cost)
        for (let i = 0; i < projects.length; i += 5) chunks.push(projects.slice(i, i + 5));
        for (let i = 0; i < files.length; i += 200) chunks.push(files.slice(i, i + 200));
        void all;
        for (const chunk of chunks) {
          await ctl.gate();
          for (const op of chunk) active.set(op.id, { name: op.name, since: Date.now() });
          tick();
          try { await processRecycleBatch(chunk); } finally { for (const op of chunk) active.delete(op.id); tick(); }
        }
      } else {
        await pool(projects, 1, handler);          // robocopy already runs 16 threads
        await pool(files, concurrency, handler);
      }
    }
  } catch (e) { if (e instanceof CancelError) { cancelled = true; fsops.killAll(); } else throw e; }

  if (!cancelled && S.cleanEmptyDirs) cleanEmptyDirs(plan, fsops);
  return { cancelled };
}

/** Remove folders that became empty because we moved/deleted their contents. Never removes a scan root. */
function cleanEmptyDirs(plan, fsops) {
  const dirs = new Set();
  for (const op of plan.ops) if (op.status === 'source-removed') dirs.add(path.dirname(norm(op.src)));
  let removed = 0;
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    let cur = d;
    while (plan.scanRoots.some((r) => isInside(cur, r)) && fsops.rmdirIfEmpty(cur)) { removed++; cur = path.dirname(cur); }
  }
  plan.emptyDirsRemoved = removed;
  return removed;
}

module.exports = { runPlan, makeControl, CancelError, OpError, isDone, cleanEmptyDirs, VerifyError };
