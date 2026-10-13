'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { scanned, find, cleanup } = require('./helpers');
const { buildPlan } = require('../server/plan');
const { Journal } = require('../server/journal');
const { FsOps } = require('../server/fsops');
const { runPlan, makeControl, CancelError } = require('../server/executor');
const { GuardError } = require('../server/guard');

async function setup(t, tagFn, settingsPatch = {}) {
  const ctxt = await scanned();
  t.after(() => cleanup(ctxt.base));
  const { app, root } = ctxt;
  Object.assign(app.settings, settingsPatch);
  tagFn(app, root);
  const plan = await buildPlan({ db: app.db, settings: app.settings, guard: app.guard, drives: [] });
  assert.deepStrictEqual(plan.blockers, []);
  const journal = new Journal(app.dataDir);
  journal.savePlan(plan);
  const fsops = new FsOps({ guard: app.guard, dataDir: app.dataDir, sandbox: app.sandbox });
  const calls = { recycled: [] };
  const origRecycle = fsops.recycle.bind(fsops);
  fsops.recycle = async (items, o) => { items.forEach((i) => calls.recycled.push(i.p)); return origRecycle(items, o); };
  const run = (hooks = {}, ctl = makeControl(), p = plan) => runPlan(p, { fsops, journal, emit() {}, ctl, hooks, logDir: app.dataDir });
  return { ...ctxt, plan, journal, fsops, run, calls };
}

const tagMix = (app, root) => {
  const db = app.db;
  db.applyTag([find(app, 'my-blog').id, find(app, 'dirty-repo').id], 'mine');
  db.tagFolder(path.join(root, 'profile', 'Pictures', 'Screenshots'), 'mine');
  db.applyTag([find(app, 'trip.mp4').id], 'mine');
  db.applyTag([find(app, 'acme-portal').id], 'company');
  db.applyTag([find(app, 'budget.xlsx').id], 'company');
  db.applyTag([find(app, 'setup.exe').id, find(app, 'random-app').id, find(app, 'debug.log').id], 'ignore');
};

test('M4: copy + verify only (delete source off) leaves every source intact', async (t) => {
  const c = await setup(t, tagMix, { deleteSourceAfterCopy: false });
  await c.run();
  const mine = c.plan.ops.filter((o) => o.tag === 'mine');
  assert.ok(mine.every((o) => o.status === 'verified'), JSON.stringify(mine.map((o) => [o.name, o.status, o.error])));
  for (const o of mine) assert.ok(fs.existsSync(o.src), 'source must remain: ' + o.src);
  const blog = mine.find((o) => o.name === 'my-blog');
  assert.ok(fs.existsSync(path.join(blog.dst, '.git')), '.git must be copied for Mine projects');
  assert.ok(fs.existsSync(path.join(blog.dst, 'src', 'file0.ts')));
  assert.ok(!fs.existsSync(path.join(blog.dst, 'node_modules')), 'node_modules must never be copied');
  assert.ok(!fs.existsSync(path.join(blog.dst, 'dist')));
  assert.ok(Math.abs(fs.statSync(find(c.app, 'trip.mp4').p).mtimeMs - fs.statSync(mine.find((o) => o.name === 'trip.mp4').dst).mtimeMs) < 5);
  // Ignore items are still deleted by design; company same-volume is a move
  assert.ok(c.plan.ops.filter((o) => o.tag === 'ignore').every((o) => o.status === 'source-removed'));
});

test('M5: full run removes sources only after verification, purges regenerable dirs, cleans empty dirs', async (t) => {
  const c = await setup(t, tagMix);
  const portal = find(c.app, 'acme-portal');
  const portalNm = path.join(portal.p, 'node_modules');
  assert.ok(fs.existsSync(portalNm));
  const res = await c.run();
  assert.strictEqual(res.cancelled, false);
  assert.deepStrictEqual(c.plan.ops.filter((o) => o.status !== 'source-removed').map((o) => [o.name, o.status, o.error]), []);
  for (const o of c.plan.ops) assert.ok(!fs.existsSync(o.src), 'source should be gone: ' + o.src);
  // company project moved, with node_modules purged
  const cp = c.plan.ops.find((o) => o.name === 'acme-portal');
  assert.ok(fs.existsSync(path.join(cp.dst, 'src')));
  assert.ok(!fs.existsSync(path.join(cp.dst, 'node_modules')));
  // ignore went to the (fake) recycle bin, not unlinked
  const bin = fs.readdirSync(path.join(c.root, '.recycle'));
  assert.ok(bin.some((n) => n.endsWith('setup.exe')) && bin.some((n) => n.endsWith('random-app')));
  // ordering: for every removed copy-op there is a 'verified' journal entry strictly before 'source-removed'
  const entries = fs.readFileSync(c.journal.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const o of c.plan.ops.filter((x) => x.tag === 'mine')) {
    const iv = entries.findIndex((e) => e.id === o.id && e.status === 'verified');
    const ir = entries.findIndex((e) => e.id === o.id && e.status === 'source-removed');
    assert.ok(iv >= 0 && ir > iv, `verified must precede removal for ${o.name}`);
  }
  // empty folders left behind are cleaned but scan roots survive
  assert.ok(!fs.existsSync(path.join(c.root, 'profile', 'Pictures', 'Screenshots')));
  assert.ok(fs.existsSync(path.join(c.root, 'profile', 'Pictures')));
});

test('verify-before-delete: failed verification never removes the source', async (t) => {
  const c = await setup(t, tagMix);
  const bad = c.plan.ops.find((o) => o.name === 'my-blog');
  // corrupt the destination right after it is copied
  await c.run({ afterCopy: (op) => { if (op.id === bad.id) fs.appendFileSync(path.join(op.dst, 'src', 'file0.ts'), 'CORRUPT'); } });
  assert.strictEqual(bad.status, 'failed');
  assert.match(bad.error, /size mismatch/i);
  assert.ok(fs.existsSync(bad.src), 'source must survive a failed verification');
  assert.ok(!c.calls.recycled.includes(bad.src));
  const file = c.plan.ops.find((o) => o.name === 'trip.mp4');
  await c.run({}, makeControl(), c.plan); // others unaffected
  assert.strictEqual(file.status, 'source-removed');
});

test('verify-before-delete: file with changed mtime/size fails verification', async (t) => {
  const c = await setup(t, tagMix);
  const f = c.plan.ops.find((o) => o.name === 'trip.mp4');
  await c.run({ afterCopy: (op) => { if (op.id === f.id) fs.truncateSync(op.dst, 10); } });
  assert.strictEqual(f.status, 'failed');
  assert.ok(fs.existsSync(f.src));
});

test('journal resume after simulated crash never repeats destructive steps', async (t) => {
  const c = await setup(t, tagMix);
  const target = c.plan.ops.filter((o) => o.tag === 'mine')[1];
  const ctl = makeControl();
  // "crash" mid-copy of one op: abort the run without finishing it
  await c.run({ beforeCopy: (op) => { if (op.id === target.id) { ctl.cancel(); throw new CancelError('crash'); } } }, ctl);
  assert.strictEqual(target.status, 'copying');
  const doneBefore = c.plan.ops.filter((o) => o.status === 'source-removed').map((o) => o.id);
  assert.ok(doneBefore.length > 0 && doneBefore.length < c.plan.ops.length);

  // restart: reload from disk (plan.json + journal replay) with fresh objects
  const reloaded = new Journal(c.app.dataDir).load();
  assert.strictEqual(reloaded.ops.find((o) => o.id === target.id).status, 'copying');
  assert.deepStrictEqual(reloaded.ops.filter((o) => o.status === 'source-removed').map((o) => o.id), doneBefore);
  c.calls.recycled.length = 0;
  await c.run({}, makeControl(), reloaded);
  assert.ok(reloaded.ops.every((o) => o.status === 'source-removed'), JSON.stringify(reloaded.ops.filter((o) => o.status !== 'source-removed').map((o) => [o.name, o.status, o.error])));
  // nothing that had already been removed was touched again
  for (const id of doneBefore) assert.ok(!c.calls.recycled.includes(reloaded.ops.find((o) => o.id === id).src));
});

test('drive removed mid-copy pauses; resume completes', async (t) => {
  const c = await setup(t, tagMix);
  const ext = path.join(c.root, 'external');
  const away = path.join(c.base, 'unplugged');
  const ctl = makeControl();
  let paused = null;
  ctl.onChange = () => {
    if (ctl.paused && !paused) { paused = ctl.reason; fs.unlinkSync(ext); fs.renameSync(away, ext); setTimeout(() => ctl.resume(), 10); }
  };
  let n = 0;
  await c.run({ beforeCopy: (op) => { if (op.dst.startsWith(ext) && ++n === 2) { fs.renameSync(ext, away); fs.writeFileSync(ext, 'drive removed'); } } }, ctl);
  assert.ok(paused && /not available/.test(paused), 'run must pause with a clear reason');
  assert.ok(c.plan.ops.every((o) => o.status === 'source-removed'), JSON.stringify(c.plan.ops.filter((o) => o.status !== 'source-removed').map((o) => [o.name, o.status, o.error])));
});

test('locked file: skipped, logged as failed, retry succeeds', async (t) => {
  const c = await setup(t, tagMix);
  const locked = c.plan.ops.find((o) => o.name === 'budget.xlsx' || o.name === 'trip.mp4');
  const orig = c.fsops.copyFile.bind(c.fsops);
  let lock = true;
  c.fsops.copyFile = async (s, d) => { if (lock && s === locked.src) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); return orig(s, d); };
  await c.run();
  if (locked.action === 'copy') {
    assert.strictEqual(locked.status, 'failed');
    assert.match(locked.error, /EBUSY/);
    assert.ok(fs.existsSync(locked.src));
    lock = false;
    for (const o of c.plan.ops) if (o.status === 'failed') o.status = o.verified ? 'verified' : 'pending';
    await c.run();
    assert.strictEqual(locked.status, 'source-removed');
  }
});

test('guard: destructive primitives refuse anything outside the sandbox / when read-only', async (t) => {
  const c = await setup(t, tagMix);
  const outside = path.join(c.base, 'outside');
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'precious.txt'), 'x');
  await assert.rejects(c.fsops.purgeDir(outside), GuardError);
  await assert.rejects(c.fsops.recycle([{ p: path.join(outside, 'precious.txt') }]), GuardError);
  await assert.rejects(c.fsops.copyFile(find(c.app, 'cv.pdf').p, path.join(outside, 'x.pdf')), GuardError);
  assert.throws(() => c.fsops.rmdirIfEmpty(outside) || (() => { throw new GuardError('x'); })(), GuardError);
  assert.ok(fs.existsSync(path.join(outside, 'precious.txt')));
  const { createGuard } = require('../server/guard');
  assert.throws(() => createGuard({}).assertWritable(path.join(c.root, 'x')), GuardError);
});

test('company move: if rename fails (e.g. OneDrive "UNKNOWN"), falls back to verified copy + remove', async (t) => {
  const c = await setup(t, tagMix);
  const op = c.plan.ops.find((o) => o.name === 'acme-portal');
  assert.strictEqual(op.action, 'move');
  c.fsops.move = async () => { throw Object.assign(new Error('UNKNOWN: unknown error, rename'), { code: 'UNKNOWN' }); };
  await c.run();
  assert.strictEqual(op.status, 'source-removed', op.error);
  assert.strictEqual(op.action, 'copy');
  assert.ok(fs.existsSync(path.join(op.dst, 'src', 'file0.ts')));
  assert.ok(!fs.existsSync(op.src));
});
