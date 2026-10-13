'use strict';
const { Worker } = require('worker_threads');
const path = require('path');
const { protectedPaths } = require('./platform');

/** Starts/cancels the scan worker and folds results into the DB. */
function createScanner(app) {
  const st = { running: false, stats: null, current: '', startedAt: 0, error: null, lastDone: null };
  let worker = null;

  function start() {
    if (st.running) return false;
    const s = app.settings;
    const exclude = [...protectedPaths(), app.dataDir];
    if (!app.sandbox) exclude.push(app.appRoot);
    if (s.destDisk) exclude.push(s.destDisk);
    if (s.companyFolder) exclude.push(s.companyFolder);
    const rows = [];
    const gitByPath = new Map();
    st.running = true; st.error = null; st.startedAt = Date.now(); st.stats = null; st.current = '';
    worker = new Worker(path.join(__dirname, 'scan-worker.js'), {
      workerData: { roots: s.scanRoots, includeAppData: s.includeAppData, regenDirs: s.regenDirs, excludePaths: exclude },
    });
    worker.on('message', (m) => {
      if (m.type === 'items') {
        for (const r of m.items) rows.push(r);
      } else if (m.type === 'git') gitByPath.set(m.path, m.git);
      else if (m.type === 'progress') { st.stats = m.stats; st.current = m.current; app.broadcast({ type: 'scan', state: publicState() }); }
      else if (m.type === 'done') {
        if (!m.cancelled) {
          for (const r of rows) if (r[0] === 'p') r[1].git = gitByPath.get(r[1].p) || null;
          app.db.replaceScan(rows, { at: Date.now(), roots: s.scanRoots.slice(), stats: m.stats, durationMs: Date.now() - st.startedAt });
          app.db.recomputeSuggestions(app.settings);
        }
        st.stats = m.stats; st.running = false; st.lastDone = Date.now();
        worker.terminate();
        app.broadcast({ type: 'scan', state: publicState() }); app.broadcast({ type: 'db-changed' });
      } else if (m.type === 'error') { st.error = m.message; st.running = false; worker.terminate(); app.broadcast({ type: 'scan', state: publicState() }); }
    });
    worker.on('error', (e) => { st.error = String(e); st.running = false; app.broadcast({ type: 'scan', state: publicState() }); });
    return true;
  }
  function cancel() { if (worker && st.running) worker.postMessage({ type: 'cancel' }); }
  function publicState() { return { running: st.running, stats: st.stats, current: st.current, error: st.error, startedAt: st.startedAt, lastDone: st.lastDone }; }
  return { start, cancel, state: publicState };
}

module.exports = { createScanner };
