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
