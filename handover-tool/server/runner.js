'use strict';
const { Worker } = require('worker_threads');
const path = require('path');
const { writeReports } = require('./report');
const { isDone } = require('./executor');

function createRunner(app) {
  const st = { phase: 'idle', startedAt: 0, pausedReason: '', error: null, active: [], emptyDirsRemoved: 0, reports: [] };
  let worker = null;
  let lastBroadcast = 0;

  const byId = () => new Map(app.plan.ops.map((o) => [o.id, o]));

  function view() {
    const plan = app.plan;
    const counts = {}; let doneBytes = 0; let totalBytes = 0; let doneOps = 0; const errors = [];
    if (plan) for (const o of plan.ops) {
      counts[o.status] = (counts[o.status] || 0) + 1; totalBytes += o.bytes;
      if (isDone(o) && o.status !== 'failed') { doneBytes += o.bytes; doneOps++; }
      if (o.status === 'failed' && errors.length < 300) errors.push({ id: o.id, name: o.name, tag: o.tag, src: o.src, dst: o.dst, error: o.error, attempts: o.attempts || 0 });
    }
    const elapsed = st.startedAt ? Date.now() - st.startedAt : 0;
    const eta = st.phase === 'running' && doneBytes > 0 && elapsed > 3000 ? Math.round((elapsed / doneBytes) * (totalBytes - doneBytes)) : null;
    return {
      phase: st.phase, pausedReason: st.pausedReason, startedAt: st.startedAt, error: st.error, active: st.active,
      totalOps: plan ? plan.ops.length : 0, doneOps, totalBytes, doneBytes, counts, errors,
      errorCount: counts.failed || 0, eta, emptyDirsRemoved: st.emptyDirsRemoved, reports: st.reports,
      interrupted: st.phase === 'idle' && !!plan && plan.ops.some((o) => o.status !== 'pending' && !isDone(o)),
    };
  }

  function push(force) {
    const now = Date.now();
    if (!force && now - lastBroadcast < 400) return;
    lastBroadcast = now;
    app.broadcast({ type: 'run', state: view() });
  }

  function start() {
    if (worker) return false;
    st.phase = 'running'; st.startedAt = Date.now(); st.error = null; st.pausedReason = ''; st.reports = [];
    const ids = byId();
    worker = new Worker(path.join(__dirname, 'executor-worker.js'), {
      workerData: { plan: app.plan, sandbox: app.sandbox, live: app.guard.live, dataDir: app.dataDir },
    });
    worker.on('message', (m) => {
      if (m.type === 'op') { const op = ids.get(m.id); if (op) Object.assign(op, m.patch); push(); }
      else if (m.type === 'tick') { st.active = m.active; push(); }
      else if (m.type === 'ctl') { st.phase = m.paused ? 'paused' : 'running'; st.pausedReason = m.reason; push(true); }
      else if (m.type === 'done') finish(m.cancelled ? 'cancelled' : 'finished', m);
      else if (m.type === 'error') { st.error = m.message; finish('error', m); }
    });
    worker.on('error', (e) => { st.error = String(e); finish('error', {}); });
    push(true);
    return true;
  }

  function finish(phase, m) {
    const w = worker; worker = null;
    if (w) w.terminate();
    st.phase = phase; st.active = []; st.emptyDirsRemoved = m.emptyDirsRemoved || 0;
    try { st.reports = writeReports(app.plan, app.dataDir, { emptyDirsRemoved: st.emptyDirsRemoved }); } catch { /* ignore */ }
    // drop items that no longer exist from the review DB (a re-scan would do the same)
    const gone = new Set(app.plan.ops.filter((o) => o.status === 'source-removed').map((o) => o.src));
    if (gone.size) app.db.removePaths(gone);
    app.broadcast({ type: 'db-changed' });
    push(true);
  }

  function retryFailed() {
    for (const o of app.plan.ops) if (o.status === 'failed') {
      const patch = { status: o.verified ? 'verified' : 'pending', error: null };
      Object.assign(o, patch); app.journal.append({ id: o.id, ...patch });
    }
  }

  return {
    start, view, retryFailed,
    active: () => !!worker,
    send: (m) => { if (worker) worker.postMessage(m); },
    forcePush: () => push(true),
  };
}

module.exports = { createRunner };
