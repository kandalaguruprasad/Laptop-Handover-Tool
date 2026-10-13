'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { tmpSandbox, cleanup } = require('./helpers');
const { start } = require('../server/index');

function call(app, method, url, body, { token = app.token, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: app.port, path: url, method, headers: { ...(token ? { 'x-token': token } : {}), ...(host ? { host } : {}), 'content-type': 'application/json' } }, (res) => {
      let buf = ''; res.on('data', (c) => (buf += c)); res.on('end', () => { let j; try { j = JSON.parse(buf); } catch { j = buf; } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const waitFor = async (fn, ms = 20000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)); } };

test('HTTP: token required, loopback host only, confirm gates, full run via worker thread', async (t) => {
  const { base, root } = tmpSandbox({ nm: 200 });
  const app = await start({ sandbox: root, data: path.join(base, 'data'), port: 0 });
  t.after(() => { app.server.close(); cleanup(base); });

  assert.strictEqual((await call(app, 'GET', '/api/state', undefined, { token: '' })).status, 401);
  assert.strictEqual((await call(app, 'GET', '/api/state', undefined, { token: 'nope' })).status, 401);
  assert.strictEqual((await call(app, 'GET', '/api/state', undefined, { host: 'evil.example.com' })).status, 403);
  assert.strictEqual((await call(app, 'GET', '/api/state')).status, 200);
  assert.strictEqual(app.server.address().address, '127.0.0.1');

  await call(app, 'POST', '/api/scan/start', {});
  await waitFor(async () => { const s = (await call(app, 'GET', '/api/state')).body; return s.summary.scanned && !s.scan.running; });

  // thumbnails: only ids that exist in the DB; arbitrary paths impossible
  const imgs = (await call(app, 'GET', '/api/items?tab=images&limit=5')).body.rows;
  assert.strictEqual((await call(app, 'GET', `/api/thumb?id=${imgs[0].id}&token=${app.token}`, undefined, { token: '' })).status, 200);
  assert.strictEqual((await call(app, 'GET', '/api/thumb?id=99999999', undefined)).status, 404);
  assert.strictEqual((await call(app, 'GET', '/api/thumb?id=../../etc/passwd')).status, 404);

  // tag: folder cascade through the API
  const holiday = path.join(root, 'profile', 'Pictures', '2023', 'Holiday');
  assert.strictEqual((await call(app, 'POST', '/api/tag', { folder: holiday, tag: 'mine' })).body.changed, 12);
  const ign = (await call(app, 'GET', '/api/items?tab=installers')).body.rows.map((r) => r.id);
  await call(app, 'POST', '/api/tag', { ids: ign, tag: 'ignore' });
  const sel = await call(app, 'POST', '/api/tag', { filter: { tab: 'videos' }, except: [], tag: 'company' });
  assert.strictEqual(sel.body.changed, 2);

  const run = () => call(app, 'POST', '/api/run/start', { confirm: true, deleteWord: 'DELETE' });
  assert.strictEqual((await run()).status, 400, 'no plan yet');
  const plan = (await call(app, 'POST', '/api/plan/build', {})).body;
  assert.strictEqual(plan.sum.ignore.items, ign.length);
  assert.deepStrictEqual(plan.blockers, []);
  assert.strictEqual((await call(app, 'POST', '/api/run/start', {})).status, 400, 'confirm required');
  assert.strictEqual((await call(app, 'POST', '/api/run/start', { confirm: true })).status, 400, 'DELETE word required');
  assert.strictEqual((await call(app, 'POST', '/api/run/start', { confirm: true, deleteWord: 'delete' })).status, 400);
  assert.ok((await call(app, 'GET', '/api/plan/csv')).status === 200);

  // stale plan: retag something after previewing -> run refused
  const one = (await call(app, 'GET', '/api/items?tab=audio')).body.rows[0];
  await call(app, 'POST', '/api/tag', { ids: [one.id], tag: 'ignore' });
  assert.strictEqual((await call(app, 'POST', '/api/plan/build', {})).status, 200);
  await call(app, 'POST', '/api/tag', { ids: [one.id], tag: 'mine' });
  assert.strictEqual((await run()).status, 409, 'stale plan must be refused');
  await call(app, 'POST', '/api/plan/build', {});

  assert.strictEqual((await run()).status, 200);
  const final = await waitFor(async () => { const r = (await call(app, 'GET', '/api/run')).body; return ['finished', 'error', 'cancelled'].includes(r.phase) && r; });
  assert.strictEqual(final.phase, 'finished', JSON.stringify(final.error));
  assert.strictEqual(final.errorCount, 0);
  assert.ok(final.reports.length >= 1);
  assert.ok(fs.existsSync(path.join(root, 'external', 'Laptop_Backup', 'manifest.csv')));
  assert.ok(fs.existsSync(path.join(root, 'external', 'Laptop_Backup', 'report.html')));
  assert.ok(!fs.existsSync(path.join(holiday, 'img1.jpg')), 'mine source removed after verified copy');
  assert.ok(fs.existsSync(path.join(root, 'external', 'Laptop_Backup', 'Images', 'Pictures', '2023', 'Holiday', 'img1.jpg')));
  assert.ok(fs.existsSync(path.join(root, 'Company_Handover', 'Files', 'Videos', 'trip.mp4')));
  assert.ok(fs.existsSync(path.join(root, 'profile', 'Documents', 'cv.pdf')), 'untagged items are never touched');
  // review DB reconciled: moved items disappear, remaining tags preserved
  const st = (await call(app, 'GET', '/api/state')).body.summary;
  assert.deepStrictEqual([st.by.mine.n, st.by.company.n, st.by.ignore.n], [0, 0, 0], 'executed items leave the review DB');
  assert.ok(st.by.undecided.n > 0);
  assert.strictEqual((await call(app, 'GET', '/api/items?tab=installers')).body.count, 0);
});

test('HTTP: read-only mode refuses to run; --sandbox and --live are exclusive', async (t) => {
  const { base, root } = tmpSandbox({ nm: 10 });
  assert.throws(() => require('../server/index').createApp({ sandbox: root, live: true, data: path.join(base, 'd') }));
  const app = await start({ data: path.join(base, 'ro'), port: 0 });
  t.after(() => { app.server.close(); cleanup(base); });
  assert.strictEqual(app.guard.mode, 'readonly');
  app.plan = { ops: [], blockers: [], settings: {}, sum: {} };
  const r = await call(app, 'POST', '/api/run/start', { confirm: true, deleteWord: 'DELETE' });
  assert.strictEqual(r.status, 403);
});

test('HTTP: group-header tagging touches only that group (direct children within the current filter)', async (t) => {
  const { base, root } = tmpSandbox({ nm: 5 });
  const app = await start({ sandbox: root, data: path.join(base, 'data'), port: 0 });
  t.after(() => { app.server.close(); cleanup(base); });
  await call(app, 'POST', '/api/scan/start', {});
  await waitFor(async () => { const s = (await call(app, 'GET', '/api/state')).body; return s.summary.scanned && !s.scan.running; });
  const holiday = path.join(root, 'profile', 'Pictures', '2023', 'Holiday');
  const r = await call(app, 'POST', '/api/tag', { group: holiday, filter: { tab: 'images', group: true }, tag: 'ignore' });
  assert.strictEqual(r.body.changed, 12, 'only the 12 images of that folder');
  const all = (await call(app, 'GET', '/api/items?tab=all&tag=ignore&limit=100')).body;
  assert.strictEqual(all.count, 12, 'nothing else (other tabs, parent/sibling folders) was tagged');
  // a group header must not reach into other tabs even when they share the folder
  const g2 = await call(app, 'POST', '/api/tag', { group: path.join(root, 'profile', 'Downloads'), filter: { tab: 'installers' }, tag: 'mine' });
  assert.strictEqual(g2.body.changed, 3); // setup.exe, tool.msi, big-image.iso
  assert.strictEqual((await call(app, 'GET', '/api/items?tab=documents&tag=mine')).body.count, 0);
});
