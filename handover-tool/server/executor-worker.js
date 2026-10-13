'use strict';
// Worker thread host for runPlan: keeps copy/verify/delete off the HTTP thread.
const { parentPort, workerData } = require('worker_threads');
const { createGuard } = require('./guard');
const { FsOps } = require('./fsops');
const { Journal } = require('./journal');
const { runPlan, makeControl } = require('./executor');
const fs = require('fs');
const path = require('path');

const { plan, sandbox, live, dataDir } = workerData;
const guard = createGuard({ sandbox, live });
const fsops = new FsOps({ guard, dataDir, sandbox });
const journal = new Journal(dataDir);
const ctl = makeControl();
const active = new Map();
const logDir = path.join(dataDir, 'logs');
fs.mkdirSync(logDir, { recursive: true });

ctl.onChange = () => parentPort.postMessage({ type: 'ctl', paused: ctl.paused, reason: ctl.reason });
parentPort.on('message', (m) => {
  if (m.type === 'pause') ctl.pause(m.reason || 'Paused by user');
  else if (m.type === 'resume') ctl.resume();
  else if (m.type === 'cancel') { ctl.cancel(); fsops.killAll(); }
});

let lastTick = 0;
const emit = (m) => {
  if (m.type === 'op') parentPort.postMessage(m);
  else {
    const now = Date.now();
    if (now - lastTick < 250) return;
    lastTick = now;
    parentPort.postMessage({ type: 'tick', active: [...active].map(([id, a]) => ({ id, ...a })) });
  }
};

runPlan(plan, { fsops, journal, emit, ctl, active, logDir })
  .then((res) => {
    try { journal.compact(plan); } catch { /* keep journal */ }
    parentPort.postMessage({ type: 'done', cancelled: res.cancelled, emptyDirsRemoved: plan.emptyDirsRemoved || 0 });
  })
  .catch((e) => parentPort.postMessage({ type: 'error', message: String(e && e.stack || e) }));
