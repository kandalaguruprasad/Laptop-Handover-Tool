'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeFixtures } = require('../scripts/make-fixtures');
const { createApp } = require('../server/index');

function tmpSandbox(opts = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-test-'));
  const root = path.join(base, 'sandbox');
  makeFixtures(root, { nm: 300, ...opts });
  return { base, root };
}

async function scanned(opts = {}) {
  const { base, root } = tmpSandbox(opts);
  const app = createApp({ sandbox: root, data: path.join(base, 'data') });
  app.scanner.start();
  while (app.scanner.state().running) await new Promise((r) => setTimeout(r, 25));
  if (app.scanner.state().error) throw new Error(app.scanner.state().error);
  return { app, base, root };
}

const find = (app, name) => app.db.items.find((i) => i.n === name);
const cleanup = (base) => fs.rmSync(base, { recursive: true, force: true });

module.exports = { tmpSandbox, scanned, find, cleanup };
