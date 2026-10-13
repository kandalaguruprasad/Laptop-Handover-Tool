'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { tmpSandbox, cleanup } = require('./helpers');
const { start } = require('../server/index');
const { createGuard, GuardError } = require('../server/guard');
const { normalizeName, clusterNames } = require('../server/groups');
const { uninstallMethod, leftoverCandidates, splitCommand } = require('../server/apps');

function call(app, method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: app.port, path: url, method, headers: { 'x-token': app.token, 'content-type': 'application/json' } }, (res) => {
      let buf = ''; res.on('data', (c) => (buf += c)); res.on('end', () => { let j; try { j = JSON.parse(buf); } catch { j = buf; } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const waitFor = async (fn, ms = 20000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)); } };
async function boot(t) {
  const { base, root } = tmpSandbox({ nm: 5 });
  const app = await start({ sandbox: root, data: path.join(base, 'data'), port: 0 });
  t.after(() => { app.server.close(); cleanup(base); });
  return { app, root, base };
}

test('app cleanup guard: only folders strictly inside AppData/ProgramData/Program Files, never system folders', () => {
  const g = createGuard({ sandbox: '/tmp/sbx' });
  const ok = (p) => { try { g.assertAppCleanup(p); return true; } catch (e) { assert.ok(e instanceof GuardError); return false; } };
  assert.ok(ok('/tmp/sbx/profile/AppData/Local/FakeApp'));
  assert.ok(ok('/tmp/sbx/Program Files/FakeApp'));
  assert.ok(ok('/tmp/sbx/profile/AppData/Local/Programs/VSCode'));
  assert.ok(!ok('/tmp/sbx/profile/AppData/Local'), 'the root itself');
  assert.ok(!ok('/tmp/sbx/profile/AppData/Local/Microsoft'));
  assert.ok(!ok('/tmp/sbx/profile/AppData/Local/Programs'));
  assert.ok(!ok('/tmp/sbx/Program Files/Windows NT'));
  assert.ok(!ok('/tmp/sbx/profile/Documents/x'));
  assert.ok(!ok('/etc/passwd'));
  assert.throws(() => createGuard({}).assertAppCleanup('/tmp/sbx/Program Files/x'), GuardError); // read-only mode
});

test('uninstall command selection + leftover candidates (pure)', () => {
  assert.deepStrictEqual(splitCommand('"C:\\Program Files\\X\\unins000.exe" /SILENT'), { exe: 'C:\\Program Files\\X\\unins000.exe', args: '/SILENT' });
  assert.strictEqual(uninstallMethod({ type: 'win', uninstall: 'MsiExec.exe /I{12345678-1234-1234-1234-123456789ABC}' }).display, 'msiexec.exe /x {12345678-1234-1234-1234-123456789ABC} /qn /norestart');
  assert.strictEqual(uninstallMethod({ type: 'win', uninstall: '"C:\\x\\u.exe"' }, () => true).method, 'interactive');
  assert.strictEqual(uninstallMethod({ type: 'win', quiet: '"C:\\x\\u.exe" /S', uninstall: '"C:\\x\\u.exe"' }, () => true).method, 'quiet');
  assert.strictEqual(uninstallMethod({ type: 'win', uninstall: '"C:\\gone\\u.exe"' }, () => false).method, 'none');
  assert.strictEqual(uninstallMethod({ type: 'appx', key: 'Pkg_1.0_x64__abc' }).method, 'appx');
  const exists = (p) => /Local\\Acme\\FakeApp|Local\\FakeApp$|Program Files\\FakeApp$/.test(p.replace(/\//g, '\\'));
  const c = leftoverCandidates({ type: 'win', name: 'FakeApp 1.2.3 (x64)', publisher: 'Acme Inc.', installLocation: '' }, ['C:\\U\\AppData\\Local'.replace(/\\/g, require('path').sep)], (p) => true);
  assert.ok(c.some((x) => x.confidence === 'exact' && /FakeApp$/.test(x.path)));
  void exists;
});

test('Apps: list, preview leftovers, uninstall + delete only ticked leftovers; failed uninstall deletes nothing', async (t) => {
  const { app, root } = await boot(t);
  const list = (await call(app, 'POST', '/api/apps/scan', {})).body.apps;
  assert.deepStrictEqual(list.map((a) => a.name).sort(), ['FakeApp 1.2.3 (x64)', 'Microsoft Visual C++ 2015-2022 Redistributable (x64)', 'OtherApp', 'StubbornApp']);
  assert.ok(list.find((a) => /Visual C\+\+/.test(a.name)).risky, 'runtimes are flagged');
  const fake = list.find((a) => a.name.startsWith('FakeApp'));
  const stubborn = list.find((a) => a.name === 'StubbornApp');

  const pv = (await call(app, 'POST', '/api/apps/preview', { ids: [fake.id, stubborn.id] })).body.items;
  const fp = pv.find((i) => i.id === fake.id);
  const paths = fp.leftovers.map((l) => l.path);
  assert.ok(paths.includes(path.join(root, 'Program Files', 'FakeApp')), 'install folder offered');
  assert.ok(paths.includes(path.join(root, 'profile', 'AppData', 'Local', 'FakeApp')));
  assert.ok(paths.includes(path.join(root, 'profile', 'AppData', 'Roaming', 'FakeApp')));
  assert.ok(paths.includes(path.join(root, 'ProgramData', 'FakeApp')));
  assert.ok(paths.includes(path.join(root, 'profile', 'AppData', 'Local', 'Acme', 'FakeApp')));
  assert.ok(fp.leftovers.find((l) => l.path.endsWith(path.join('Acme', 'FakeApp'))).confidence === 'guess' && !fp.leftovers.find((l) => l.path.endsWith(path.join('Acme', 'FakeApp'))).checked, 'guesses start unticked');
  assert.ok(!paths.some((p) => /Microsoft/.test(p)), 'system folders never offered');

  // confirmation + safety gates
  assert.strictEqual((await call(app, 'POST', '/api/apps/run', { items: [{ id: fake.id }] })).status, 400, 'needs UNINSTALL word');
  // a leftover that was not offered is refused even if the client asks for it
  const sneaky = path.join(root, 'profile', 'AppData', 'Local', 'StubbornApp');
  const keep = path.join(root, 'profile', 'Documents', 'cv.pdf');
  const chosen = [path.join(root, 'profile', 'AppData', 'Local', 'FakeApp'), path.join(root, 'ProgramData', 'FakeApp'), keep, sneaky];
  assert.strictEqual((await call(app, 'POST', '/api/apps/run', { word: 'UNINSTALL', permanent: true, items: [{ id: fake.id, leftovers: chosen }, { id: stubborn.id, leftovers: [sneaky] }] })).status, 200);
  const job = await waitFor(async () => { const j = (await call(app, 'GET', '/api/apps/run')).body.job; return j && j.phase !== 'running' && j; });
  assert.strictEqual(job.phase, 'finished');
  const f = job.items.find((i) => i.id === fake.id); const s = job.items.find((i) => i.id === stubborn.id);
  assert.strictEqual(f.status, 'uninstalled');
  const st = Object.fromEntries(f.leftovers.map((l) => [l.path, l.status]));
  assert.strictEqual(st[chosen[0]], 'deleted'); assert.strictEqual(st[chosen[1]], 'deleted');
  assert.strictEqual(st[keep], 'failed', 'a non-offered path (user document) is refused');
  assert.ok(fs.existsSync(keep));
  assert.ok(!fs.existsSync(chosen[0]) && !fs.existsSync(chosen[1]));
  assert.ok(fs.existsSync(path.join(root, 'profile', 'AppData', 'Roaming', 'FakeApp')), 'unticked leftovers stay');
  assert.ok(fs.existsSync(path.join(root, 'profile', 'AppData', 'Local', 'Microsoft', 'Windows', 'keep-me.txt')));
  assert.strictEqual(s.status, 'failed');
  assert.ok(fs.existsSync(sneaky) && fs.existsSync(path.join(root, 'Program Files', 'StubbornApp')), 'failed uninstall => nothing deleted for that app');
  assert.ok(!(await call(app, 'POST', '/api/apps/scan', {})).body.apps.some((a) => a.id === fake.id), 'gone from the list after uninstall');
});

test('Installers in Downloads: scan top-level entries, delete needs DELETE and only scanned entries', async (t) => {
  const { app, root } = await boot(t);
  const inst = (await call(app, 'POST', '/api/installers/scan', {})).body;
  const names = inst.entries.map((e) => e.name);
  assert.ok(names.includes('pc apps') && names.includes('setup.exe'));
  const pc = inst.entries.find((e) => e.name === 'pc apps');
  assert.ok(pc.isDir && pc.installers >= 2 && pc.size > 100000 && !pc.hasProject);
  assert.ok(inst.entries[0].size >= inst.entries[inst.entries.length - 1].size, 'largest first');
  assert.strictEqual((await call(app, 'POST', '/api/installers/delete', { ids: [pc.id] })).status, 400);
  const r = (await call(app, 'POST', '/api/installers/delete', { ids: [pc.id, 'deadbeef00'], word: 'DELETE' })).body.results;
  assert.strictEqual(r.find((x) => x.id === pc.id).ok, true);
  assert.strictEqual(r.find((x) => x.id === 'deadbeef00').ok, false);
  assert.ok(!fs.existsSync(path.join(root, 'profile', 'Downloads', 'pc apps')));
  assert.ok(fs.existsSync(path.join(root, 'profile', 'Downloads', 'setup.exe')), 'unselected entries untouched');
  assert.ok(fs.readdirSync(path.join(root, '.recycle')).some((n) => n.endsWith('pc apps')), 'went to the (fake) recycle bin');
});

test('Company Groups: name normalisation + clustering', () => {
  assert.strictEqual(normalizeName('My App - Copy (2)'), 'my app');
  assert.strictEqual(normalizeName('codecodestream-sve_java_new-42c3b6f2d072'), 'codecodestream sve java');
  assert.strictEqual(normalizeName('portal_v2'), 'portal');
  const groups = clusterNames(['heroapp', 'heroapp-master', 'heroapp (2)', 'portal', 'portal-copy', 'unrelated-thing', 'shop-ui', 'shop-api']);
  assert.deepStrictEqual(groups.map((g) => g.suggestedName).sort(), ['heroapp', 'portal']);
  assert.deepStrictEqual(groups.find((g) => g.suggestedName === 'heroapp').members.sort(), ['heroapp', 'heroapp (2)', 'heroapp-master']);
});

test('Company Groups: scan, suggest, plan validation, apply, undo (incl. group named like a member)', async (t) => {
  const { app, root } = await boot(t);
  const CH = path.join(root, 'Company_Handover');
  await call(app, 'POST', '/api/groups/scan', {});
  const v = await waitFor(async () => { const x = (await call(app, 'GET', '/api/groups')).body; return !x.running && x.scannedAt && x; });
  assert.deepStrictEqual(v.entries.map((e) => e.name).sort(), ['heroapp', 'heroapp (2)', 'heroapp-master', 'portal', 'portal-copy', 'unrelated-thing']);
  assert.strictEqual(v.suggestions.length, 2);
  assert.ok(v.entries.find((e) => e.name === 'heroapp').isProject);
  assert.ok(v.entries.find((e) => e.name === 'heroapp').identicalTo.includes('heroapp (2)'), 'identical folders are flagged');

  // plan validation
  const bad = (await call(app, 'POST', '/api/groups/plan', { groups: [{ name: 'a/b', members: ['portal'] }, { name: 'Files', members: ['portal'] }, { name: 'X', members: ['nope'] }, { name: 'unrelated-thing', members: ['portal'] }] })).body;
  assert.ok(bad.errors.length >= 4, JSON.stringify(bad.errors));
  assert.strictEqual((await call(app, 'POST', '/api/groups/apply', { groups: [{ name: 'g', members: ['portal'] }] })).status, 400, 'needs confirm');

  // apply: group "heroapp" contains a member also called "heroapp"
  const groups = [{ name: 'heroapp', members: ['heroapp', 'heroapp (2)', 'heroapp-master'] }, { name: 'Portal group', members: ['portal', 'portal-copy'] }];
  const pl = (await call(app, 'POST', '/api/groups/plan', { groups })).body;
  assert.deepStrictEqual(pl.errors, []); assert.strictEqual(pl.ops.length, 5);
  const ap = await call(app, 'POST', '/api/groups/apply', { groups, confirm: true });
  assert.strictEqual(ap.status, 200, JSON.stringify(ap.body));
  assert.ok(ap.body.log.moves.every((m) => m.done), JSON.stringify(ap.body.log.moves));
  assert.ok(fs.existsSync(path.join(CH, 'heroapp', 'heroapp', 'package.json')));
  assert.ok(fs.existsSync(path.join(CH, 'heroapp', 'heroapp (2)', 'src', 'index.js')));
  assert.ok(fs.existsSync(path.join(CH, 'Portal group', 'portal-copy', 'package.json')));
  assert.ok(fs.existsSync(path.join(CH, 'unrelated-thing', 'package.json')), 'ungrouped folders stay as they are');
  assert.ok(!fs.existsSync(path.join(CH, 'portal')));
  const after = await waitFor(async () => { const x = (await call(app, 'GET', '/api/groups')).body; return !x.running && x.entries.length && x; });
  assert.ok(after.entries.find((e) => e.name === 'heroapp').isGroup && after.entries.find((e) => e.name === 'heroapp').children === 3);
  assert.ok(after.canUndo);

  // undo restores the exact original layout
  const un = await call(app, 'POST', '/api/groups/undo', {});
  assert.deepStrictEqual(un.body.errors, []);
  assert.deepStrictEqual(fs.readdirSync(CH).sort(), ['Files', 'heroapp', 'heroapp (2)', 'heroapp-master', 'portal', 'portal-copy', 'unrelated-thing']);
  assert.ok(fs.existsSync(path.join(CH, 'heroapp', 'package.json')) && !fs.existsSync(path.join(CH, 'heroapp', '.handover-group.json')));
  assert.ok(fs.existsSync(path.join(CH, 'portal', 'src', 'index.js')));
});
