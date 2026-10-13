'use strict';
// Generates a fake "laptop" under <dir>. Safe: refuses to write outside the given dir, and
// refuses to run if <dir> exists and is non-empty without --force (it deletes only its own old output).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function git(cwd, args) {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fx@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });
}
function hasGit() { try { execFileSync('git', ['--version'], { stdio: 'pipe' }); return true; } catch { return false; } }

function w(file, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function bytes(n, seed = 1) { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 255; return b; }

function makeProject(dir, { remote, nm = 0, extra = {}, realGit = true, files = 5 } = {}) {
  w(path.join(dir, 'package.json'), JSON.stringify({ name: path.basename(dir) }));
  for (let i = 0; i < files; i++) w(path.join(dir, 'src', `file${i}.ts`), `export const v${i} = ${i};\n`.repeat(20));
  w(path.join(dir, '.gitignore'), 'node_modules\ndist\n');
  w(path.join(dir, 'dist', 'bundle.js'), 'built'.repeat(100));
  for (let i = 0; i < nm; i++) w(path.join(dir, 'node_modules', `pkg${i % 50}`, `f${i}.js`), 'm');
  for (const [rel, c] of Object.entries(extra)) w(path.join(dir, rel), c);
  if (realGit && hasGit()) {
    git(dir, ['init', '-q']);
    git(dir, ['add', 'package.json', 'src', '.gitignore']);
    git(dir, ['commit', '-q', '-m', 'init']);
    if (remote) git(dir, ['remote', 'add', 'origin', remote]);
  } else {
    w(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    w(path.join(dir, '.git', 'config'), `[core]\n\trepositoryformatversion = 0\n${remote ? `[remote "origin"]\n\turl = ${remote}\n` : ''}`);
  }
}

function makeFixtures(root, opts = {}) {
  const nm = opts.nm ?? 3000;
  root = path.resolve(root);
  if (fs.existsSync(root)) {
    if (fs.readdirSync(root).length && !opts.force) throw new Error(`${root} is not empty (use --force to regenerate)`);
    if (path.basename(root) !== 'sandbox' && !opts.force) throw new Error('refusing to wipe a dir not named "sandbox"');
    fs.rmSync(root, { recursive: true, force: true });
  }
  const P = path.join(root, 'profile');
  const D = (...a) => path.join(P, ...a);

  // projects
  makeProject(D('Documents', 'work', 'acme-portal'), { remote: 'https://github.com/acme-corp/portal.git', nm });
  makeProject(D('Documents', 'work', 'acme-api'), { remote: 'git@github.com:acme-corp/api.git', nm: 200 });
  makeProject(D('Documents', 'personal', 'my-blog'), { remote: 'https://github.com/mrkgp/blog.git', nm: 500 });
  makeProject(D('Documents', 'random-app'), { nm: 100, realGit: false });
  makeProject(D('Desktop', 'dirty-repo'), { remote: 'https://github.com/mrkgp/dirty.git' });
  w(D('Desktop', 'dirty-repo', 'src', 'file0.ts'), 'changed locally\n');
  w(D('Desktop', 'dirty-repo', 'untracked.txt'), 'new');
  makeProject(D('Documents', 'rust-thing'), { realGit: false, extra: { 'Cargo.toml': '[package]\nname="x"', 'target/debug/app.exe': 'bin' } });
  w(D('Documents', 'bin-no-project', 'bin', 'tool.dll'), 'a'); // 'bin' w/o sibling build file => NOT regenerable (and not in a project)
  // OneDrive-like
  w(D('OneDrive - Acme', 'Documents', 'notes.txt'), 'cloud notes');
  w(D('OneDrive - Acme', 'Documents', 'plan.docx'), bytes(4000, 3));
  makeProject(D('OneDrive - Acme', 'Projects', 'cloud-proj'), { realGit: false });
  // pictures / videos / docs / audio
  for (let i = 0; i < 12; i++) w(D('Pictures', '2023', 'Holiday', `img${i}.jpg`), bytes(3000 + i, i));
  for (let i = 0; i < 4; i++) w(D('Pictures', 'Screenshots', `shot${i}.png`), bytes(1500 + i, 40 + i));
  w(D('Videos', 'trip.mp4'), bytes(200000, 9));
  w(D('Videos', 'clips', 'a.mkv'), bytes(50000, 11));
  w(D('Documents', 'cv.pdf'), bytes(20000, 5));
  w(D('Documents', 'budget.xlsx'), bytes(8000, 6));
  w(D('Documents', 'notes.md'), '# notes');
  w(D('Music', 'song.mp3'), bytes(30000, 7));
  // downloads (installer, old stuff, log, a duplicate of an image)
  w(D('Downloads', 'setup.exe'), bytes(60000, 12));
  w(D('Downloads', 'tool.msi'), bytes(10000, 13));
  w(D('Downloads', 'debug.log'), 'log');
  w(D('Downloads', 'old-report.pdf'), bytes(5000, 14));
  w(D('Downloads', 'fresh.pdf'), bytes(5000, 15));
  w(D('Downloads', 'copy-of-img0.jpg'), bytes(3000, 0)); // exact duplicate of Pictures/.../img0.jpg
  w(D('Downloads', 'bundle.zip'), bytes(9000, 16));
  const old = new Date(Date.now() - 400 * 86400000);
  for (const f of ['old-report.pdf', 'bundle.zip']) fs.utimesSync(D('Downloads', f), old, old);
  // junk: hidden, system
  w(D('Documents', '.hidden-file'), 'h');
  w(D('Documents', 'desktop.ini'), '[.ShellClassInfo]');
  // standalone node_modules outside any project (must never be walked)
  w(D('Documents', 'stray', 'node_modules', 'x', 'index.js'), 'x');
  // long path (>260 chars)
  let deep = D('Documents', 'deep');
  while (deep.length < 300) deep = path.join(deep, 'very_long_folder_name_segment_' + String(deep.length));
  try { w(path.join(deep, 'long-file.txt'), 'long'); } catch { /* some FS limits */ }
  // locked file placeholder (use scripts/hold-lock.js on Windows to really lock it)
  w(D('Documents', 'locked', 'in-use.docx'), bytes(2000, 21));
  // symlink loop
  try { fs.symlinkSync(D('Documents'), D('Documents', 'loop'), 'junction'); } catch { /* may lack permission */ }
  // AppData must never be scanned, even when it contains projects
  w(D('AppData', 'Local', 'Tool', 'data.bin'), 'x');
  makeProject(D('AppData', 'Local', 'Android', 'Sdk', 'python-packages', 'adb'), { realGit: false });
  // fake installed programs for the Apps tab (sandbox backend reads _apps.json)
  w(path.join(root, 'Program Files', 'FakeApp', 'bin', 'fake.exe'), 'x');
  w(path.join(root, 'Program Files', 'OtherApp', 'other.exe'), 'x');
  w(path.join(root, 'Program Files', 'StubbornApp', 'stubborn.exe'), 'x');
  w(path.join(P, 'AppData', 'Local', 'FakeApp', 'cache', 'blob.bin'), bytes(5000, 2));
  w(path.join(P, 'AppData', 'Roaming', 'FakeApp', 'settings.json'), '{}');
  w(path.join(P, 'AppData', 'Local', 'Acme', 'FakeApp', 'state.db'), 'x');       // publisher\\name -> "guess"
  w(path.join(root, 'ProgramData', 'FakeApp', 'license.dat'), 'x');
  w(path.join(P, 'AppData', 'Local', 'Microsoft', 'Windows', 'keep-me.txt'), 'system'); // must never be offered
  w(path.join(P, 'AppData', 'Local', 'StubbornApp', 'keep.dat'), 'x');
  fs.writeFileSync(path.join(root, '_apps.json'), JSON.stringify([
    { type: 'win', key: 'FakeApp', hive: 'HKLM', name: 'FakeApp 1.2.3 (x64)', publisher: 'Acme Inc.', version: '1.2.3', sizeKB: 20480, installLocation: path.join(root, 'Program Files', 'FakeApp') },
    { type: 'win', key: 'OtherApp', hive: 'HKCU', name: 'OtherApp', publisher: 'Other', version: '2.0', sizeKB: 1024, installLocation: path.join(root, 'Program Files', 'OtherApp') },
    { type: 'win', key: 'StubbornApp', hive: 'HKLM', name: 'StubbornApp', publisher: 'Acme', version: '9', sizeKB: 512, installLocation: path.join(root, 'Program Files', 'StubbornApp'), fail: true },
    { type: 'win', key: 'VCRedist', hive: 'HKLM', name: 'Microsoft Visual C++ 2015-2022 Redistributable (x64)', publisher: 'Microsoft Corporation', version: '14.38', sizeKB: 20000, installLocation: '' },
  ], null, 1));
  // downloaded installers: loose files + a folder of an extracted installer set
  w(D('Downloads', 'pc apps', 'Photoshop App', 'Setup.exe'), bytes(70000, 31));
  w(D('Downloads', 'pc apps', 'Photoshop App', 'resources', 'data.pak'), bytes(90000, 32));
  w(D('Downloads', 'pc apps', 'tool-setup.msi'), bytes(8000, 33));
  // company handover folder with look-alike project folders (Company Groups tab)
  for (const n of ['heroapp', 'heroapp-master', 'heroapp (2)', 'portal', 'portal-copy', 'unrelated-thing']) {
    const base = n.startsWith('heroapp') ? 'heroapp' : n; // heroapp variants are byte-identical copies
    w(path.join(root, 'Company_Handover', n, 'package.json'), JSON.stringify({ name: base }));
    w(path.join(root, 'Company_Handover', n, 'src', 'index.js'), `// ${base}`);
  }
  w(path.join(root, 'Company_Handover', 'Files', 'loose.txt'), 'x');
  // external "hard disk"
  fs.mkdirSync(path.join(root, 'external'), { recursive: true });
  return { root, profile: P, external: path.join(root, 'external') };
}

module.exports = { makeFixtures, makeProject };

if (require.main === module) {
  const dir = process.argv[2] || './sandbox';
  const force = process.argv.includes('--force');
  const r = makeFixtures(dir, { force });
  console.log('Fixture tree created at', r.root);
}
