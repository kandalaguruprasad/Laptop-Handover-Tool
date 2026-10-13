'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { scanned, find, cleanup } = require('./helpers');
const { DB } = require('../server/db');

test('tagging: folder cascade, per-file override, persistence, rescan keeps tags', async (t) => {
  const { app, base, root } = await scanned();
  t.after(() => cleanup(base));
  const db = app.db;
  const holiday = path.join(root, 'profile', 'Pictures', '2023', 'Holiday');
  const n = db.tagFolder(holiday, 'mine');
  assert.strictEqual(n, 12);
  assert.ok(db.items.filter((i) => i.d === holiday).every((i) => i.tag === 'mine'));
  db.applyTag([find(app, 'img3.jpg').id], 'ignore'); // per-file override after cascade
  assert.strictEqual(find(app, 'img3.jpg').tag, 'ignore');
  assert.strictEqual(find(app, 'img4.jpg').tag, 'mine');
  db.saveTagsNow();

  const db2 = new DB(app.dataDir); // simulate restart
  db2.load();
  assert.strictEqual(db2.items.find((i) => i.n === 'img3.jpg').tag, 'ignore');
  assert.strictEqual(db2.items.find((i) => i.n === 'img4.jpg').tag, 'mine');
  assert.strictEqual(db2.items.find((i) => i.n === 'cv.pdf').tag, null);

  app.scanner.start();
  while (app.scanner.state().running) await new Promise((r) => setTimeout(r, 25));
  assert.strictEqual(find(app, 'img4.jpg').tag, 'mine', 're-scan must preserve tags');
});

test('suggestions: git patterns and file rules; nothing applied until accepted', async (t) => {
  const { app, base } = await scanned();
  t.after(() => cleanup(base));
  app.settings.companyPatterns = ['github.com/acme-corp'];
  app.settings.minePatterns = ['github.com/mrkgp'];
  app.db.recomputeSuggestions(app.settings);
  const s = (n) => find(app, n).sug;
  assert.strictEqual(s('acme-portal'), 'company');
  assert.strictEqual(s('acme-api'), 'company'); // scp-style git@github.com:acme-corp/api.git
  assert.strictEqual(s('my-blog'), 'mine');
  assert.strictEqual(s('random-app'), null); // no remote => no suggestion
  assert.strictEqual(s('setup.exe'), 'ignore');
  assert.strictEqual(s('debug.log'), 'ignore');
  assert.strictEqual(s('old-report.pdf'), 'ignore'); // old file in Downloads
  assert.strictEqual(s('fresh.pdf'), null);
  assert.strictEqual(s('trip.mp4'), 'mine');
  assert.strictEqual(s('cv.pdf'), 'mine');
  assert.ok(app.db.items.every((i) => i.tag === null), 'suggestions must not be applied automatically');
  const accepted = app.db.acceptSuggestions('images');
  assert.ok(accepted > 0);
  assert.ok(app.db.items.filter((i) => i.tag).every((i) => i.c === 'images'));
});

test('filters, grouping and paging', async (t) => {
  const { app, base } = await scanned();
  t.after(() => cleanup(base));
  const all = app.db.page({ tab: 'all' }, 0, 1000);
  assert.strictEqual(all.count, app.db.items.length);
  assert.strictEqual(app.db.page({ tab: 'videos' }, 0, 10).count, 2);
  assert.strictEqual(app.db.page({ tab: 'all', q: 'holiday' }, 0, 100).count, 12);
  assert.strictEqual(app.db.page({ tab: 'all', ext: '.PDF' }, 0, 100).count, 3);
  const g = app.db.page({ tab: 'images', group: true }, 0, 100);
  assert.ok(g.rows.some((r) => r.t === 'g' && r.count === 12));
  assert.strictEqual(app.db.page({ tab: 'all', tag: 'undecided' }, 0, 1).count, app.db.items.length);
});

test('undo / reset: every bulk tag action can be undone; reset clears tags (undoable) and resetAll forgets the scan', async (t) => {
  const { app, base } = await scanned();
  t.after(() => cleanup(base));
  const db = app.db;
  const tagged = () => db.items.filter((i) => i.tag).length;
  assert.strictEqual(db.undo(), null);
  db.applyTag(db.idsRange({ tab: 'all' }), 'mine'); // the "select all by mistake" case
  assert.strictEqual(tagged(), db.items.length);
  db.applyTag([find(app, 'cv.pdf').id], 'ignore');
  assert.deepStrictEqual(db.undoInfo().count, 1);
  db.undo();
  assert.strictEqual(find(app, 'cv.pdf').tag, 'mine', 'undo restores the previous tag, not just null');
  db.undo();
  assert.strictEqual(tagged(), 0);
  assert.strictEqual(db.undoInfo(), null);
  db.acceptSuggestions(); const n = tagged(); assert.ok(n > 0);
  db.resetTags(); assert.strictEqual(tagged(), 0); assert.deepStrictEqual(db.tags, {});
  db.undo(); assert.strictEqual(tagged(), n, 'reset itself is undoable');
  db.saveTagsNow();
  db.resetAll();
  assert.strictEqual(db.items.length, 0);
  assert.ok(!require('fs').existsSync(db.scanFile));
  assert.ok(require('fs').existsSync(path.join(base, 'sandbox', 'profile', 'Documents', 'cv.pdf')), 'files untouched');
});
