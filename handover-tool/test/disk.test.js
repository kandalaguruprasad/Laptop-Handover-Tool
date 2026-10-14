'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { tmpSandbox, cleanup } = require('./helpers');
const { start } = require('../server/index');
const { buildEnv, explain } = require('../server/diskknow');

function call(app, method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: app.port, path: url, method, headers: { 'x-token': app.token, 'content-type': 'application/json' } }, (res) => {
      let buf = ''; res.on('data', (c) => (buf += c)); res.on('end', () => { let j; try { j = JSON.parse(buf); } catch { j = buf; } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
async function clean(app, paths, permanent) {
  const r = await call(app, 'POST', '/api/disk/delete', { word: 'DELETE', permanent, paths });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const job = await waitFor(async () => { const j = (await call(app, 'GET', '/api/disk/clean')).body.job; return j && j.phase !== 'running' && j; });
  return job;
}
const waitFor = async (fn, ms = 30000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)); } };
function walkSize(dir) { let n = 0; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isSymbolicLink()) continue; n += e.isDirectory() ? walkSize(p) : fs.statSync(p).size; } return n; }

test('knowledge: verdicts and deletable flags', () => {
  const env = buildEnv({ sandbox: '/tmp/sb' });
  const x = (p, d = true) => explain(p, d, env);
  assert.deepStrictEqual([x('/tmp/sb/Windows/System32').verdict, x('/tmp/sb/Windows/System32').deletable], ['system', false]);
  assert.strictEqual(x('/tmp/sb/Windows/WinSxS').verdict, 'system');
  assert.ok(x('/tmp/sb/Windows/Temp/a.tmp', false).deletable && x('/tmp/sb/Windows/Temp/a.tmp', false).verdict === 'safe');
  assert.ok(!x('/tmp/sb/Windows/Temp').deletable, 'the Temp folder itself stays; its contents go');
  assert.strictEqual(x('/tmp/sb/hiberfil.sys', false).verdict, 'system');
  assert.strictEqual(x('/tmp/sb/Program Files/App').verdict, 'keep');
  assert.ok(!x('/tmp/sb/Program Files/App').deletable && !x('/tmp/sb/ProgramData/Foo').deletable);
  assert.strictEqual(x('/tmp/sb/profile/AppData/Local/Google/Chrome/User Data/Default/Cache').group, 'browser');
  assert.strictEqual(x('/tmp/sb/profile/Documents/work/app/node_modules').group, 'node_modules');
  assert.ok(!x('/tmp/sb/profile/.ssh').deletable && !x('/tmp/sb/profile').deletable && !x('/tmp/sb/profile/AppData').deletable && !x('/tmp/sb/profile/Documents').deletable);
  assert.ok(x('/tmp/sb/profile/Documents/cv.pdf', false).deletable);
  assert.ok(!x('/tmp/sb/profile/AppData/Local/Microsoft/Windows/stuff').deletable);
  assert.strictEqual(x('/tmp/sb/Projects/webapp').verdict, 'review');
  assert.strictEqual(x('/tmp/sb/profile/Downloads/big.iso', false).verdict, 'review');
  assert.strictEqual(x('/tmp/sb/.recycle/foo').special, 'recycle');
  const envC = buildEnv({ sandbox: '/tmp/sb', companyFolder: '/tmp/sb/Company_Handover', appRoot: '/tmp/sb/tool' });
  const c = explain('/tmp/sb/Company_Handover/Frontend/src/assets/img.jpg', false, envC);
  assert.deepStrictEqual([c.verdict, c.deletable], ['keep', false], 'handover files are protected from select-all');
  assert.ok(!explain('/tmp/sb/tool/data/tags.json', false, envC).deletable);
  // AppData: never deletable as a whole, but known caches inside it are safe
  assert.ok(!x('/tmp/sb/profile/AppData').deletable && !x('/tmp/sb/profile/AppData/Local').deletable && !x('/tmp/sb/profile/AppData/Roaming').deletable);
  assert.strictEqual(x('/tmp/sb/profile/AppData/Roaming/Code/CachedData').group, 'appcache');
  assert.strictEqual(x('/tmp/sb/profile/AppData/Local/Slack/Cache').group, 'appcache');
  assert.strictEqual(x('/tmp/sb/profile/AppData/Roaming/Microsoft/Teams/Cache').group, 'appcache');
  assert.ok(!x('/tmp/sb/profile/AppData/Roaming/Code/User').deletable, 'settings/sign-in data is not a cache');
  assert.ok(!x('/tmp/sb/profile/.m2').deletable && /Maven/.test(x('/tmp/sb/profile/.m2').title) && x('/tmp/sb/profile/.m2/repository/org').deletable);
  assert.ok(!x('/tmp/sb/profile/.cursor').deletable && x('/tmp/sb/profile/.rustup').verdict === 'review');
});

test('C Drive: scan totals, browse with explanations, quick wins, guarded cleanup', async (t) => {
  const { base, root } = tmpSandbox({ nm: 5 });
  const app = await start({ sandbox: root, data: path.join(base, 'data'), port: 0 });
  t.after(() => { app.server.close(); cleanup(base); });

  assert.strictEqual((await call(app, 'GET', '/api/disk/list')).status, 400, 'must scan first');
  await call(app, 'POST', '/api/disk/scan', {});
  const st = await waitFor(async () => { const s = (await call(app, 'GET', '/api/disk')).body; return s.scanned && !s.scan.running && s; });
  assert.ok(st.drive.total > 0 && st.drive.used > 0);
  const real = walkSize(root) - walkSize(path.join(root, 'profile', 'OneDrive - Acme')); // cloud folders are listed, not counted
  assert.ok(Math.abs(st.scannedBytes - real) < 1, `scanned ${st.scannedBytes} vs real ${real}`); // OneDrive-like folder is listed, not counted
  assert.ok(st.cloud.some((c) => /OneDrive - Acme/.test(c)), 'cloud folders are listed separately');

  const top = (await call(app, 'GET', '/api/disk/list')).body;
  const byName = Object.fromEntries(top.dirs.map((d) => [d.name, d]));
  assert.strictEqual(byName.Windows.verdict, 'system');
  assert.strictEqual(byName['Program Files'].verdict, 'keep');
  assert.ok(byName.profile.size > 0 && top.dirs[0].size >= top.dirs[top.dirs.length - 1].size, 'largest first');
  assert.deepStrictEqual(top.files.map((f) => f.name).sort(), ['_apps.json', 'hiberfil.sys', 'pagefile.sys']);
  assert.strictEqual(top.files.find((f) => f.name === 'hiberfil.sys').verdict, 'system');
  const win = (await call(app, 'GET', `/api/disk/list?path=${encodeURIComponent(path.join(root, 'Windows'))}`)).body;
  assert.ok(win.crumbs.length === 2 && win.dirs.some((d) => d.name === 'WinSxS' && d.verdict === 'system'));
  const cats = (await call(app, 'GET', '/api/disk/categories')).body.categories;
  assert.ok(cats.find((c) => c.name === 'Programs & system files').bytes > 100000);
  assert.ok((await call(app, 'GET', '/api/disk/top')).body.files[0].size >= 6 * 1024 * 1024, 'biggest file first (iso)');

  // file-type groups can be opened: extension breakdown + the files themselves
  const img = (await call(app, 'GET', '/api/disk/category?name=' + encodeURIComponent('Disk images & virtual machines'))).body;
  assert.ok(img.exts.some((e) => e.ext === 'iso') && img.items[0].name === 'big-image.iso' && img.items[0].verdict === 'review');
  const sysCat = (await call(app, 'GET', '/api/disk/category?name=' + encodeURIComponent('Programs & system files'))).body;
  assert.ok(sysCat.items.some((i) => i.name === 'kernel.dll' && i.verdict === 'system' && !i.deletable), 'system files are listed but protected');
  const onlyDll = (await call(app, 'GET', '/api/disk/category?name=' + encodeURIComponent('Programs & system files') + '&ext=dll')).body;
  assert.ok(onlyDll.items.length > 0 && onlyDll.items.every((i) => i.name.endsWith('.dll')));
  assert.ok((await call(app, 'GET', '/api/disk/category?name=Nope')).status === 400);
  const other = (await call(app, 'GET', '/api/disk/category?name=' + encodeURIComponent('Other files'))).body;
  assert.ok(other.exts.length > 0 && other.bytes > 0);

  // quick wins
  const quick = (await call(app, 'GET', '/api/disk/quick')).body.items;
  const g = Object.fromEntries(quick.map((q) => [q.group, q]));
  assert.ok(g.temp && g.browser && g.node_modules && g.winupdate && g.thumb, Object.keys(g).join());
  assert.ok(g.node_modules.paths.some((p) => /Projects[\\/]webapp[\\/]node_modules$/.test(p.path)));

  // deletion gates
  const tmpFile = path.join(root, 'Windows', 'Temp', 'installer.tmp');
  const sys32 = path.join(root, 'Windows', 'System32', 'kernel.dll');
  assert.strictEqual((await call(app, 'POST', '/api/disk/delete', { paths: [tmpFile] })).status, 400, 'needs DELETE word');
  const job1 = await clean(app, [tmpFile, sys32, path.join(root, 'Windows'), path.join(root, 'profile', '.ssh', 'id_rsa'), path.join(base, 'outside'), root], true);
  assert.deepStrictEqual([job1.total, job1.done, job1.ok, job1.failed], [6, 6, 1, 5], JSON.stringify(job1));
  assert.strictEqual(job1.freed, 30000);
  assert.ok(!fs.existsSync(tmpFile) && fs.existsSync(sys32) && fs.existsSync(path.join(root, 'profile', '.ssh', 'id_rsa')));
  // totals shrink without a rescan
  const after = (await call(app, 'GET', '/api/disk')).body;
  assert.strictEqual(before(st.scannedBytes) - after.scannedBytes, 30000);
  // clean a quick-win group (browser cache, permanent) and a user file (to the fake recycle bin)
  const cache = g.browser.paths[0].path;
  const cj = await clean(app, [cache], true); assert.strictEqual(cj.ok, 1, JSON.stringify(cj));
  assert.ok(!fs.existsSync(cache));
  const iso = path.join(root, 'profile', 'Downloads', 'big-image.iso');
  assert.strictEqual((await clean(app, [iso], false)).ok, 1);
  assert.ok(fs.readdirSync(path.join(root, '.recycle')).some((n) => n.endsWith('big-image.iso')));
  // empty recycle bin needs EMPTY
  assert.strictEqual((await call(app, 'POST', '/api/disk/empty-bin', {})).status, 400);
  const eb = await call(app, 'POST', '/api/disk/empty-bin', { word: 'EMPTY' });
  assert.strictEqual(eb.status, 200);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, '.recycle')), []);
});
const before = (x) => x;
