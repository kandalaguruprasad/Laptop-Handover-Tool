'use strict';
// Plan on disk + append-only journal of per-operation status changes.
// A crash can lose at most the status line being written; every step is idempotent on resume.
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic, readJson } = require('./jsonfile');

const TERMINAL = new Set(['source-removed', 'failed']);

class Journal {
  constructor(dir) {
    this.dir = dir;
    this.planFile = path.join(dir, 'plan.json');
    this.file = path.join(dir, 'journal.ndjson');
  }

  savePlan(plan) {
    writeJsonAtomic(this.planFile, plan);
    fs.writeFileSync(this.file, '');
  }

  /** Append one status change (sync + flushed so it survives a crash). */
  append(entry) {
    const fd = fs.openSync(this.file, 'a');
    try { fs.writeSync(fd, JSON.stringify({ ...entry, t: Date.now() }) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  /** Load plan.json and replay the journal over it. */
  load() {
    const plan = readJson(this.planFile, null);
    if (!plan) return null;
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { /* none */ }
    const byId = new Map(plan.ops.map((o) => [o.id, o]));
    for (const line of text.split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; } // torn last line after a crash
      const op = byId.get(e.id);
      if (!op) continue;
      for (const k of ['status', 'error', 'dst', 'attempts', 'finishedAt', 'note', 'action', 'removeSource', 'verified']) if (e[k] !== undefined) op[k] = e[k];
    }
    return plan;
  }

  /** Fold the journal into plan.json and start a fresh journal. */
  compact(plan) {
    writeJsonAtomic(this.planFile, plan);
    fs.writeFileSync(this.file, '');
  }

  /** Move a finished/abandoned plan aside so a new plan can be created. */
  archive() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const f of [this.planFile, this.file]) if (fs.existsSync(f)) fs.renameSync(f, path.join(this.dir, `old-${stamp}-${path.basename(f)}`));
  }
}

module.exports = { Journal, TERMINAL };
