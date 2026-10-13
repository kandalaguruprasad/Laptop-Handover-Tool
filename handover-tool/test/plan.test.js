'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { scanned, find, cleanup } = require('./helpers');
const { buildPlan, planToCsv } = require('../server/plan');

async function plan(app, drives = []) { return buildPlan({ db: app.db, settings: app.settings, guard: app.guard, drives }); }

test('plan: destinations, collisions, regen exclusion, per-action summary', async (t) => {
  const { app, base, root } = await scanned();
  t.after(() => cleanup(base));
  const db = app.db;
  db.applyTag([find(app, 'acme-portal').id], 'company');
  db.applyTag([find(app, 'my-blog').id, find(app, 'dirty-repo').id], 'mine');
  db.tagFolder(path.join(root, 'profile', 'Pictures', '2023'), 'mine');
  db.applyTag([find(app, 'setup.exe').id, find(app, 'random-app').id], 'ignore');
  db.applyTag([find(app, 'img0.jpg').id], 'company'); // loose company file

  const p = await plan(app);
  const by = (n) => p.ops.find((o) => o.name === n);
  assert.strictEqual(by('acme-portal').dst, path.join(root, 'Company_Handover', 'acme-portal'));
  assert.strictEqual(by('acme-portal').action, 'move'); // same volume
  assert.strictEqual(by('my-blog').dst, path.join(root, 'external', 'Laptop_Backup', 'Projects', 'my-blog'));
  assert.strictEqual(by('img1.jpg').dst, path.join(root, 'external', 'Laptop_Backup', 'Images', 'Pictures', '2023', 'Holiday', 'img1.jpg'));
  assert.strictEqual(by('img0.jpg').dst, path.join(root, 'Company_Handover', 'Files', 'Pictures', '2023', 'Holiday', 'img0.jpg'));
  assert.strictEqual(by('setup.exe').action, 'recycle');
  assert.strictEqual(by('random-app').action, 'recycle');
  assert.strictEqual(new Set(p.ops.map((o) => o.dst).filter(Boolean)).size, p.ops.filter((o) => o.dst).length, 'destinations unique');
  assert.strictEqual(p.sum.ignore.items, 2);
  assert.strictEqual(p.sum.mine.projects, 2);
  assert.ok(p.requiresDelete);
  assert.ok(p.undecided > 0);
  assert.ok(by('my-blog').bytes < 100000, 'project bytes exclude node_modules');
  assert.deepStrictEqual(p.blockers, []);
  assert.ok(p.warnings.some((w) => w.level === 'danger' && /dirty-repo/.test(w.text)), 'dirty Mine project must warn');
  assert.ok(p.warnings.some((w) => /Recycle Bin/.test(w.text)));
  // nothing touched on disk
  assert.ok(!fs.existsSync(path.join(root, 'Company_Handover', 'acme-portal')));
  assert.ok(!fs.existsSync(path.join(root, 'external', 'Laptop_Backup')));
  // csv
  const csv = planToCsv(p);
  assert.match(csv.split('\r\n')[0], /^item,tag,action,source,destination,size_bytes,status/);
  assert.strictEqual(csv.trim().split('\r\n').length, p.ops.length + 1);
});

test('plan: name collisions get " (2)"', async (t) => {
  const { app, base, root } = await scanned();
  t.after(() => cleanup(base));
  // two different files with the same name tagged Mine from different folders
  const a = path.join(root, 'profile', 'Documents', 'notes.md');
  fs.mkdirSync(path.join(root, 'profile', 'Desktop', 'sub'), { recursive: true });
  app.db.applyTag([find(app, 'notes.md').id], 'mine');
  // pre-existing destination file forces a suffix
  const dst = path.join(root, 'external', 'Laptop_Backup', 'Documents', 'Documents', 'notes.md');
  fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, 'different content here');
  const p = await plan(app);
  assert.strictEqual(p.ops[0].dst, path.join(path.dirname(dst), 'notes (2).md'));
  void a;
});

test('plan: blockers (no destination, insufficient space, read-only)', async (t) => {
  const { app, base } = await scanned();
  t.after(() => cleanup(base));
  app.db.applyTag([find(app, 'trip.mp4').id], 'mine');
  app.settings.destDisk = path.join(base, 'not-plugged-in');
  let p = await plan(app);
  assert.ok(p.blockers.some((b) => /not found/.test(b)));
  app.settings.destDisk = '';
  p = await plan(app);
  assert.ok(p.blockers.some((b) => /No destination/.test(b)));
});
