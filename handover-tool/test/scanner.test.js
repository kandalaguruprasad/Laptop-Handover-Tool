'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { scanned, find, cleanup } = require('./helpers');

test('scanner: project detection, skip rules, categories', async (t) => {
  const { app, base, root } = await scanned();
  t.after(() => cleanup(base));
  const items = app.db.items;
  const projects = items.filter((i) => i.kind === 'p').map((i) => i.n).sort();
  assert.deepStrictEqual(projects, ['acme-api', 'acme-portal', 'cloud-proj', 'dirty-repo', 'my-blog', 'random-app', 'rust-thing']);

  // nothing inside node_modules / dist / target is listed, and no file lies under a project
  for (const it of items) {
    assert.ok(!/node_modules/.test(it.p), 'node_modules leaked: ' + it.p);
    if (it.kind === 'f') for (const p of projects) assert.ok(!it.p.includes(path.sep + p + path.sep), `file inside project ${p}: ${it.p}`);
  }
  // project size excludes regenerable dirs, file count too
  const portal = find(app, 'acme-portal');
  assert.ok(portal.regen.some((r) => r.endsWith('node_modules')));
  assert.ok(portal.regen.some((r) => r.endsWith('dist')));
  assert.ok(portal.fc < 100, 'node_modules must not be counted, got ' + portal.fc);
  // conditional dirs: target next to Cargo.toml is skipped; bin without build file is a normal folder
  assert.ok(find(app, 'rust-thing').regen.some((r) => r.endsWith('target')));
  assert.ok(find(app, 'tool.dll'), 'bin/ without sibling build file must be scanned as ordinary files');
  // hidden / system files, symlink loop and stray node_modules are skipped
  assert.ok(!find(app, '.hidden-file') && !find(app, 'desktop.ini'));
  assert.ok(!items.some((i) => i.p.includes(path.join('stray', 'node_modules'))));
  assert.ok(items.filter((i) => i.n === 'cv.pdf').length === 1, 'symlink loop must not duplicate files');
  // categories
  assert.strictEqual(find(app, 'trip.mp4').c, 'videos');
  assert.strictEqual(find(app, 'img0.jpg').c, 'images');
  assert.strictEqual(find(app, 'cv.pdf').c, 'documents');
  assert.strictEqual(find(app, 'setup.exe').c, 'installers');
  assert.strictEqual(find(app, 'bundle.zip').c, 'archives');
  assert.strictEqual(find(app, 'song.mp3').c, 'audio');
  // long path file found (when FS allowed creating it)
  assert.ok(find(app, 'long-file.txt'));
  // cloud flag
  assert.ok(find(app, 'notes.txt').cloud && find(app, 'cloud-proj').cloud && !find(app, 'cv.pdf').cloud);
});

test('scanner: git info (remote, branch, dirty, unpushed)', async (t) => {
  const { app, base } = await scanned();
  t.after(() => cleanup(base));
  const portal = find(app, 'acme-portal');
  assert.match(portal.git.remote, /acme-corp\/portal/);
  assert.ok(portal.git.branch);
  const dirty = find(app, 'dirty-repo');
  if (dirty.git.dirty !== null) {
    assert.ok(dirty.git.dirty >= 2, 'dirty count ' + dirty.git.dirty);
    assert.ok(dirty.git.unpushed >= 1);
  }
  assert.strictEqual(find(app, 'random-app').git.remote, null);
});

test('scanner: excludes destination disk and company folder', async (t) => {
  const { app, base, root } = await scanned();
  t.after(() => cleanup(base));
  assert.ok(!app.db.items.some((i) => i.p.startsWith(path.join(root, 'external'))));
});

test('scanner: nested roots are scanned once, explicit nested root works', async (t) => {
  const { tmpSandbox, cleanup: cl } = require('./helpers');
  const { createApp } = require('../server/index');
  const { base, root } = tmpSandbox({ nm: 5 });
  t.after(() => cl(base));
  const app = createApp({ sandbox: root, data: path.join(base, 'data') });
  app.settings.scanRoots = [path.join(root, 'profile'), path.join(root, 'profile', 'OneDrive - Acme')];
  app.scanner.start();
  while (app.scanner.state().running) await new Promise((r) => setTimeout(r, 25));
  const paths = app.db.items.map((i) => i.p);
  assert.strictEqual(new Set(paths).size, paths.length, 'no item may appear twice');
  assert.ok(paths.some((p) => p.includes('OneDrive - Acme')));
});

test('scanner: AppData is always excluded (even as a root, even if saved settings say include)', async (t) => {
  const { tmpSandbox, cleanup: cl } = require('./helpers');
  const { createApp } = require('../server/index');
  const { DB } = require('../server/db');
  const { base, root } = tmpSandbox({ nm: 5 });
  t.after(() => cl(base));
  require('fs').writeFileSync(path.join(base, 'data-settings.json'), '{}');
  const app = createApp({ sandbox: root, data: path.join(base, 'data') });
  app.settings.includeAppData = true;
  app.settings.scanRoots = [path.join(root, 'profile'), path.join(root, 'profile', 'AppData')];
  app.scanner.start();
  while (app.scanner.state().running) await new Promise((r) => setTimeout(r, 25));
  assert.ok(app.db.items.length > 10);
  assert.ok(!app.db.items.some((i) => /appdata/i.test(i.p)), 'AppData leaked into the scan');
  // an old scan file that still contains AppData rows is cleaned on load
  const lines = require('fs').readFileSync(app.db.scanFile, 'utf8').split('\n');
  lines.push(JSON.stringify(['f', path.join(root, 'profile', 'AppData', 'Local', 'old.bin'), 5, 1]));
  require('fs').writeFileSync(app.db.scanFile, lines.join('\n'));
  const d2 = new DB(app.dataDir); d2.load();
  assert.ok(!d2.items.some((i) => /appdata/i.test(i.p)));
});
