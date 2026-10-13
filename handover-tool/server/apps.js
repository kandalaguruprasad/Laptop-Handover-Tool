'use strict';
// "Apps" tab backend: installed programs, uninstall + leftover cleanup, downloaded installers.
// Windows: registry Uninstall keys + Store apps via PowerShell. Sandbox (any OS): a fake catalogue in <sandbox>/_apps.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { isWin, norm, key, isInside } = require('./platform');
const { appCleanupRoots } = require('./guard');
const { walkTree, Limiter, readDirents, classify } = require('./projwalk');
const { FsOps } = require('./fsops');

const LIST_PS = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$paths = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
$win = Get-ItemProperty $paths | Where-Object { $_.DisplayName -and $_.SystemComponent -ne 1 -and -not $_.ParentKeyName -and $_.DisplayName -notmatch '^(KB\\d{6,}|Update for |Security Update for |Hotfix )' } | ForEach-Object {
  [pscustomobject]@{ type='win'; key=$_.PSChildName; hive=(($_.PSPath -split '::')[1] -split '\\\\')[0]; name=$_.DisplayName; publisher=$_.Publisher; version=$_.DisplayVersion; installDate=$_.InstallDate; sizeKB=$_.EstimatedSize; installLocation=$_.InstallLocation; uninstall=$_.UninstallString; quiet=$_.QuietUninstallString }
}
$store = Get-AppxPackage | Where-Object { -not $_.IsFramework -and -not $_.NonRemovable -and $_.SignatureKind -ne 'System' } | ForEach-Object {
  [pscustomobject]@{ type='appx'; key=$_.PackageFullName; hive=''; name=$_.Name; publisher=$_.Publisher; version=[string]$_.Version; installLocation=$_.InstallLocation }
}
$all = @($win) + @($store)
if ($all.Count -eq 0) { '[]' } else { ConvertTo-Json -InputObject $all -Compress -Depth 3 }
`;
const UNINSTALL_PS = `param([string]$Exe,[string]$ArgList,[string]$Appx)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if ($Appx) { try { Remove-AppxPackage -Package $Appx -ErrorAction Stop; exit 0 } catch { Write-Output $_.Exception.Message; exit 1 } }
try {
  if ($ArgList) { $p = Start-Process -FilePath $Exe -ArgumentList $ArgList -Wait -PassThru -ErrorAction Stop }
  else { $p = Start-Process -FilePath $Exe -Wait -PassThru -ErrorAction Stop }
  exit $p.ExitCode
} catch { Write-Output $_.Exception.Message; exit 1223 }
`;

const RUNTIME_RE = /(visual c\+\+|\.net |\.net$|runtime|redistributable|webview2|directx|windows sdk|driver kit|update health tools|vulkan)/i;
const INSTALLER_EXT = new Set(['exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle', 'iso', 'dmg']);
const GENERIC = new Set(['app', 'apps', 'data', 'setup', 'tools', 'tool', 'client', 'common', 'shared', 'bin', 'cache', 'logs', 'temp', 'update', 'updates', 'program', 'programs', 'launcher']);

const idOf = (a) => crypto.createHash('sha1').update([a.type, a.hive, a.key].join('|')).digest('hex').slice(0, 10);

function splitCommand(cmd) {
  cmd = String(cmd || '').trim();
  if (!cmd) return null;
  if (cmd[0] === '"') { const i = cmd.indexOf('"', 1); return i > 0 ? { exe: cmd.slice(1, i), args: cmd.slice(i + 1).trim() } : null; }
  const m = cmd.match(/^(.+?\.(?:exe|msi|bat|cmd|com))(\s+.*)?$/i);
  return m ? { exe: m[1], args: (m[2] || '').trim() } : { exe: cmd.split(' ')[0], args: cmd.split(' ').slice(1).join(' ') };
}

/** How to uninstall: appx | msi | quiet | interactive | none (+ the command that will run). Pure; used for preview and run. */
function uninstallMethod(a, fileExists = fs.existsSync) {
  if (a.type === 'appx') return { method: 'appx', display: `Remove-AppxPackage ${a.key}`, appx: a.key };
  const guid = /\{[0-9A-Fa-f-]{36}\}/.exec(`${a.uninstall || ''} ${a.quiet || ''}`);
  if (a.quiet) {
    const c = splitCommand(a.quiet);
    if (c && /msiexec/i.test(c.exe) && guid) return { method: 'msi', exe: 'msiexec.exe', args: `/x ${guid[0]} /qn /norestart`, display: `msiexec.exe /x ${guid[0]} /qn /norestart` };
    if (c && (fileExists(c.exe) || /msiexec/i.test(c.exe))) return { method: 'quiet', ...c, display: a.quiet };
  }
  if (a.uninstall) {
    if (/msiexec/i.test(a.uninstall) && guid) return { method: 'msi', exe: 'msiexec.exe', args: `/x ${guid[0]} /qn /norestart`, display: `msiexec.exe /x ${guid[0]} /qn /norestart` };
    const c = splitCommand(a.uninstall);
    if (c && fileExists(c.exe)) return { method: 'interactive', ...c, display: a.uninstall };
    return { method: 'none', display: '', reason: 'The uninstaller file no longer exists' };
  }
  return { method: 'none', display: '', reason: 'No uninstall command registered' };
}

const cleanName = (s) => String(s || '').replace(/\s*[\(\[][^)\]]*[\)\]]/g, '').replace(/\s+v?\d+(\.\d+)+.*$/, '').replace(/\s+(x64|x86|64-bit|32-bit)\b/ig, '').trim();
const cleanPub = (s) => String(s || '').replace(/[,.]?\s*(inc|ltd|llc|corp|corporation|gmbh|co|pvt|limited)\.?$/ig, '').trim();

/** Candidate leftover folders for an app. Pure except existence checks via `exists`. */
function leftoverCandidates(a, roots, exists = fs.existsSync) {
  if (a.type === 'appx') return [];
  const full = cleanName(a.name); const pub = cleanPub(a.publisher);
  const exact = new Set([a.name, full].filter(Boolean));
  const loc = a.installLocation ? norm(a.installLocation.replace(/[\\/]+$/, '')) : '';
  if (loc && path.basename(loc)) exact.add(path.basename(loc));
  const guess = new Set();
  if (pub && full.toLowerCase().startsWith(pub.toLowerCase() + ' ')) guess.add(full.slice(pub.length + 1).trim());
  const ok = (n) => n && n.length >= 3 && !GENERIC.has(n.toLowerCase());
  const out = new Map();
  const add = (p, confidence, why) => { if (exists(p)) { const k = key(norm(p)); if (!out.has(k)) out.set(k, { path: norm(p), confidence, why }); } };
  if (loc && roots.some((r) => isInside(loc, r))) add(loc, 'exact', 'install folder');
  for (const r of roots) {
    for (const n of exact) if (ok(n)) add(path.join(r, n), 'exact', 'same name as the app');
    for (const n of guess) if (ok(n)) add(path.join(r, n), 'guess', 'name without publisher');
    if (pub) for (const n of [...exact, ...guess]) if (ok(n) && ok(pub)) add(path.join(r, pub, n), 'guess', 'publisher folder');
  }
  let list = [...out.values()];
  list = list.filter((c) => !list.some((o) => o !== c && isInside(c.path, o.path))); // keep outermost
  return list;
}

function runFile(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || '') + String(stderr || '') });
    });
  });
}

function createAppsService(app) {
  const st = { apps: [], scannedAt: 0, previews: new Map(), job: null, inst: { entries: [], scannedAt: 0, roots: [] } };
  const limiter = new Limiter(8);
  const sandbox = app.sandbox;
  const g = app.guard;
  const appGuard = { destructiveEnabled: g.destructiveEnabled, assertWritable: (p) => g.assertAppCleanup(p), assertNotSymlink: (p) => g.assertNotSymlink(p) };
  const appFs = new FsOps({ guard: appGuard, dataDir: app.dataDir, sandbox });
  const mainFs = new FsOps({ guard: g, dataDir: app.dataDir, sandbox });
  const catalogue = sandbox ? path.join(sandbox, '_apps.json') : null;

  async function listRaw() {
    if (catalogue) { try { return JSON.parse(fs.readFileSync(catalogue, 'utf8')); } catch { return []; } }
    if (!isWin) return [];
    const f = path.join(app.dataDir, 'list-apps.ps1');
    fs.writeFileSync(f, LIST_PS);
    const { out } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], 120000);
    try { const j = JSON.parse(out.trim()); return Array.isArray(j) ? j : [j]; } catch { return []; }
  }

  async function scan() {
    const raw = await listRaw();
    const seen = new Set();
    const apps = [];
    for (const r of raw) {
      const a = { type: r.type || 'win', key: String(r.key || r.name), hive: r.hive || '', name: String(r.name || ''), publisher: r.publisher || '', version: r.version || '', installDate: r.installDate || '',
        sizeKB: Number(r.sizeKB) || 0, installLocation: r.installLocation || '', uninstall: r.uninstall || '', quiet: r.quiet || '', fail: !!r.fail };
      const dk = `${a.name}|${a.version}|${a.type}`.toLowerCase();
      if (!a.name || seen.has(dk)) continue;
      seen.add(dk);
      a.id = idOf(a);
      a.risky = RUNTIME_RE.test(a.name) ? 'Runtime / shared component — other programs may need it' : /^node\.?js\b/i.test(a.name) ? 'This tool runs on Node.js — uninstalling it stops the tool. Do this last.' : null;
      const um = catalogue ? { method: 'quiet', display: '(sandbox simulated uninstaller)' } : uninstallMethod(a);
      a.method = um.method; a.methodNote = um.reason || '';
      apps.push(a);
    }
    apps.sort((x, y) => x.name.localeCompare(y.name));
    st.apps = apps; st.scannedAt = Date.now();
    return apps;
  }

  const view = (a) => ({ id: a.id, type: a.type, name: a.name, publisher: a.publisher, version: a.version, installDate: a.installDate, sizeKB: a.sizeKB,
    installLocation: a.installLocation, risky: a.risky, method: a.method, methodNote: a.methodNote });

  async function preview(ids) {
    const roots = appCleanupRoots(sandbox);
    const out = [];
    for (const id of ids) {
      const a = st.apps.find((x) => x.id === id);
      if (!a) continue;
      const um = catalogue ? { method: 'quiet', display: '(sandbox simulated uninstaller)' } : uninstallMethod(a);
      const cands = [];
      for (const c of leftoverCandidates(a, roots)) {
        try { g.assertAppCleanup(c.path); } catch { continue; }
        const w = await walkTree(c.path, {});
        cands.push({ path: c.path, confidence: c.confidence, why: c.why, bytes: w.bytes, files: w.files, checked: c.confidence === 'exact' });
      }
      st.previews.set(id, new Set(cands.map((c) => key(c.path))));
      out.push({ ...view(a), command: um.display, leftovers: cands });
    }
    return out;
  }

  async function uninstallOne(a) {
    if (catalogue) {
      if (a.fail) return { code: 1, out: 'Uninstaller reported an error (simulated)' };
      try {
        if (a.installLocation && fs.existsSync(a.installLocation)) await appFs.recycle([{ p: a.installLocation, isDir: true }], { permanent: true });
        const rest = (await listRaw()).filter((r) => String(r.key || r.name) !== a.key);
        fs.writeFileSync(catalogue, JSON.stringify(rest, null, 1));
        return { code: 0, out: '' };
      } catch (e) { return { code: 1, out: e.message }; }
    }
    const um = uninstallMethod(a);
    if (um.method === 'none') return { code: 1, out: um.reason };
    const f = path.join(app.dataDir, 'uninstall-app.ps1');
    fs.writeFileSync(f, UNINSTALL_PS);
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f];
    if (um.method === 'appx') args.push('-Appx', um.appx); else { args.push('-Exe', um.exe); if (um.args) args.push('-ArgList', um.args); }
    return runFile('powershell.exe', args, 45 * 60 * 1000);
  }

  function startRun(items, { permanent }) {
    if (st.job && st.job.phase === 'running') throw new Error('An uninstall run is already in progress.');
    const job = { phase: 'running', startedAt: Date.now(), cancelled: false, permanent: !!permanent,
      items: items.map((it) => { const a = st.apps.find((x) => x.id === it.id); return { id: it.id, name: a ? a.name : it.id, status: 'pending', message: '', leftovers: (it.leftovers || []).map((p) => ({ path: p, status: 'pending', error: '' })) }; }) };
    st.job = job;
    const push = () => app.broadcast({ type: 'apps-run', state: jobView() });
    (async () => {
      for (const it of job.items) {
        if (job.cancelled) { it.status = 'skipped'; it.message = 'Cancelled before this app'; continue; }
        const a = st.apps.find((x) => x.id === it.id);
        if (!a) { it.status = 'failed'; it.message = 'App not found (scan again)'; continue; }
        it.status = 'uninstalling'; it.message = a.method === 'interactive' ? 'The uninstaller window may open — complete it there' : ''; push();
        const r = await uninstallOne(a);
        const after = await scan();                       // verify against the registry, not the exit code
        const still = after.some((x) => x.id === a.id);
        const okCode = [0, 3010, 1641].includes(r.code);
        if (still) { it.status = 'failed'; it.message = `Still installed afterwards (exit ${r.code}). ${r.out.trim().slice(0, 200)}`.trim(); push(); continue; }
        it.status = 'uninstalled'; it.message = okCode ? (r.code === 3010 || r.code === 1641 ? 'Done — a restart is needed to finish' : '') : `Removed (uninstaller exit code ${r.code})`;
        const allowed = st.previews.get(it.id) || new Set();
        for (const l of it.leftovers) {
          if (job.cancelled) { l.status = 'skipped'; continue; }
          try {
            if (!allowed.has(key(norm(l.path)))) throw new Error('Not an offered leftover');
            g.assertAppCleanup(l.path);
            if (!fs.existsSync(l.path)) { l.status = 'deleted'; continue; }
            if (job.permanent) await appFs.purgeDir(l.path);
            else { const [res] = await appFs.recycle([{ p: l.path, isDir: true }], { permanent: false }); if (!res.ok) throw new Error(res.error); }
            l.status = 'deleted';
          } catch (e) { l.status = 'failed'; l.error = String(e.message || e); }
          push();
        }
        push();
      }
      job.phase = job.cancelled ? 'cancelled' : 'finished'; job.finishedAt = Date.now(); push();
    })().catch((e) => { job.phase = 'error'; job.error = String(e.message || e); push(); });
    return true;
  }
  const jobView = () => st.job && { phase: st.job.phase, error: st.job.error || null, startedAt: st.job.startedAt, permanent: st.job.permanent, items: st.job.items };

  // ---------------- downloaded installers ----------------
  function downloadRoots() {
    const set = new Map();
    const add = (p) => { if (p && fs.existsSync(p)) set.set(key(norm(p)), norm(p)); };
    for (const r of app.settings.scanRoots) if (path.basename(r).toLowerCase() === 'downloads') add(r);
    add(path.join(app.settings.profileRoot, 'Downloads'));
    return [...set.values()];
  }
  async function walkInfo(p, isFile) {
    const info = { size: 0, files: 0, installers: 0, newest: 0, hasProject: false };
    const note = (name, st2) => {
      info.files++; info.size += st2.size; if (st2.mtimeMs > info.newest) info.newest = st2.mtimeMs;
      const ext = path.extname(name).slice(1).toLowerCase(); if (INSTALLER_EXT.has(ext)) info.installers++;
      if (/^(package\.json|pom\.xml|requirements\.txt|go\.mod|cargo\.toml)$/i.test(name)) info.hasProject = true;
    };
    if (isFile) { try { note(path.basename(p), await fs.promises.lstat(p)); } catch { /* gone */ } return info; }
    async function visit(dir, depth) {
      let entries; try { entries = await limiter.run(() => readDirents(dir)); } catch { return; }
      const items = await classify(dir, entries, limiter);
      await Promise.all(items.map(async (e) => {
        const full = path.join(dir, e.name);
        if (e.isDir) { if (e.name === '.git') info.hasProject = true; else if (e.name.toLowerCase() !== 'node_modules') await visit(full, depth + 1); else { /* skipped */ } }
        else if (e.isFile) { try { note(e.name, await limiter.run(() => fs.promises.lstat(full))); } catch { /* gone */ } }
      }));
    }
    await visit(p, 0);
    return info;
  }
  async function scanInstallers() {
    const roots = downloadRoots();
    const entries = [];
    for (const root of roots) {
      let list; try { list = await readDirents(root); } catch { continue; }
      const cls = await classify(root, list, limiter);
      await Promise.all(cls.map(async (e) => {
        const p = path.join(root, e.name);
        const info = await walkInfo(p, !e.isDir);
        entries.push({ id: crypto.createHash('sha1').update(p).digest('hex').slice(0, 10), path: p, name: e.name, isDir: e.isDir, size: info.size, files: info.files, installers: info.installers, hasProject: info.hasProject, m: info.newest, root });
      }));
    }
    entries.sort((a, b) => b.size - a.size);
    st.inst = { entries, scannedAt: Date.now(), roots };
    return st.inst;
  }
  async function deleteInstallers(ids, { permanent }) {
    const results = [];
    for (const id of ids) {
      const e = st.inst.entries.find((x) => x.id === id);
      if (!e) { results.push({ id, ok: false, error: 'Not in the last scan' }); continue; }
      try {
        // must still be a direct child of a Downloads folder we scanned
        if (!st.inst.roots.some((r) => norm(path.dirname(e.path)) === r && isInside(e.path, r))) throw new Error('Not inside a Downloads folder');
        g.assertWritable(e.path);
        if (!fs.existsSync(e.path)) { results.push({ id, name: e.name, ok: true, note: 'already gone' }); continue; }
        const [r] = await mainFs.recycle([{ p: e.path, isDir: e.isDir }], { permanent: !!permanent });
        results.push({ id, name: e.name, ok: r.ok, error: r.error });
      } catch (err) { results.push({ id, name: e.name, ok: false, error: String(err.message || err) }); }
    }
    const done = new Set(results.filter((r) => r.ok).map((r) => r.id));
    st.inst.entries = st.inst.entries.filter((x) => !done.has(x.id));
    return results;
  }

  return { scan, preview, startRun, jobView, cancel: () => { if (st.job) st.job.cancelled = true; }, scanInstallers, deleteInstallers,
    state: () => ({ apps: st.apps.map(view), scannedAt: st.scannedAt }), installers: () => ({ ...st.inst, entries: st.inst.entries }), isRunning: () => !!(st.job && st.job.phase === 'running') };
}

module.exports = { createAppsService, uninstallMethod, leftoverCandidates, splitCommand, INSTALLER_EXT, cleanName };
