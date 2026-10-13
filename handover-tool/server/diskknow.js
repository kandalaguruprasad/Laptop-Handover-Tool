'use strict';
// "Is it useful?" knowledge for the C Drive tab. Pure functions: path in -> verdict, plain-language explanation, deletable flag.
//   safe   = rebuilds/regenerates itself, fine to remove
//   review = could be yours: your decision
//   keep   = programs or settings rely on it
//   system = Windows itself
const path = require('path');
const os = require('os');
const { norm, key, isInside, isWin } = require('./platform');

function buildEnv({ sandbox, profileRoot }) {
  if (sandbox) {
    const root = norm(sandbox); const profile = norm(profileRoot || path.join(root, 'profile'));
    const local = path.join(profile, 'AppData', 'Local');
    return { root, profile, usersRoot: path.join(root, '_Users') /* sandbox has no other accounts */, local, roaming: path.join(profile, 'AppData', 'Roaming'), temp: path.join(local, 'Temp'), windows: path.join(root, 'Windows'),
      pf: [path.join(root, 'Program Files'), path.join(root, 'Program Files (x86)')], pd: path.join(root, 'ProgramData'), recycle: path.join(root, '.recycle'), sandbox: true };
  }
  const e = process.env;
  const profile = norm(profileRoot || os.homedir());
  const root = isWin ? norm((e.SystemDrive || 'C:') + '\\') : path.parse(profile).root;
  const local = norm(e.LOCALAPPDATA || path.join(profile, 'AppData', 'Local'));
  return { root, profile, usersRoot: path.join(root, '_Users') /* sandbox has no other accounts */, local, roaming: norm(e.APPDATA || path.join(profile, 'AppData', 'Roaming')), temp: norm(e.TEMP || path.join(local, 'Temp')),
    windows: norm(e.SystemRoot || path.join(root, 'Windows')), pf: [e.ProgramFiles, e['ProgramFiles(x86)']].filter(Boolean).map(norm), pd: norm(e.ProgramData || path.join(root, 'ProgramData')),
    recycle: path.join(root, '$Recycle.Bin'), sandbox: false };
}

const REPRO_DIRS = { 'node_modules': 'npm/yarn packages (re-install with `npm install`)', '.venv': 'a Python virtual environment (re-create with pip)', 'venv': 'a Python virtual environment (re-create with pip)',
  '__pycache__': 'compiled Python cache', '.next': 'Next.js build output', '.pytest_cache': 'pytest cache', '.gradle': 'Gradle cache', '.parcel-cache': 'Parcel cache', '.turbo': 'Turborepo cache' };
const EXT_HINT = [
  [/\.(tmp|temp|dmp|mdmp|hdmp)$/i, 'safe', 'Temporary or crash-dump file', 'Temporary files and crash dumps are not needed after the program that made them closes.'],
  [/\.(log|etl)$/i, 'safe', 'Log file', 'Diagnostic log. Safe to delete; programs create new ones.'],
  [/\.(iso|img)$/i, 'review', 'Disk image', 'Often an installer or OS image. Safe to delete if you already installed from it or can download it again.'],
  [/\.(exe|msi|msix|appx|msixbundle|appxbundle)$/i, 'review', 'Installer / program file', 'If it sits in Downloads it is almost always just an installer you can delete after installing.'],
  [/\.(vhd|vhdx|vmdk|vdi|ova|ovf|qcow2)$/i, 'review', 'Virtual machine disk', 'Very large. Delete only if you no longer use that virtual machine.'],
  [/\.(zip|7z|rar|tar|gz|tgz|bz2|xz)$/i, 'review', 'Archive', 'Compressed bundle. If you already extracted it, the archive is usually redundant.'],
  [/\.(bak|old|orig)$/i, 'review', 'Backup copy', 'A backup of something else. Check what it belongs to first.'],
  [/\.(mp4|mkv|mov|avi|wmv|webm)$/i, 'review', 'Video', 'Your own video. Videos are usually the biggest personal files.'],
  [/\.(jpg|jpeg|png|heic|raw|cr2|nef)$/i, 'review', 'Picture', 'Your own picture.'],
  [/\.(pst|ost)$/i, 'review', 'Outlook mail data', 'Local copy of an Outlook mailbox. OST files are re-created from the server; PST files may be your only copy.'],
];

const STD_FOLDERS = new Set(['desktop', 'documents', 'downloads', 'pictures', 'videos', 'music', 'favorites', 'links', 'searches', 'contacts', 'saved games', '3d objects']);
const CLOUD_RE = /^(onedrive|dropbox|google ?drive|icloud)/i;

/** @returns {{verdict, title, why, deletable, group?, special?}} */
function explain(p, isDir, env) {
  const n = norm(p); const base = path.basename(n); const lbase = base.toLowerCase();
  const under = (r) => r && isInside(n, r); const eq = (r) => r && key(n) === key(norm(r));
  const eqOrUnder = (r) => eq(r) || under(r);
  const R = (verdict, title, why, deletable, extra = {}) => ({ verdict, title, why, deletable: !!deletable, ...extra });

  if (eq(env.root)) return R('system', 'The drive itself', 'Top of the drive.', false);
  if (eqOrUnder(env.recycle)) return R('safe', 'Recycle Bin', 'Things you already deleted. They still use space until the bin is emptied. Check you do not need anything in it, then use "Empty Recycle Bin".', false, { special: 'recycle', group: 'recycle' });
  if (path.dirname(n) === norm(env.root)) {
    if (/^(pagefile|hiberfil|swapfile)\.sys$/i.test(base)) {
      const why = { 'pagefile.sys': 'Windows virtual memory (swap). Windows manages its size; leave it.', 'swapfile.sys': 'Windows swap file for apps. Leave it.', 'hiberfil.sys': 'Hibernate / fast-startup file, often as big as your RAM. Only an administrator can shrink it (powercfg /h off) and it is not safe to delete by hand.' }[lbase];
      return R('system', `${base} (Windows)`, why, false);
    }
    if (/^system volume information$/i.test(base)) return R('system', 'System Volume Information', 'Restore points / shadow copies. Shrink them in System Protection settings, not by deleting folders.', false);
    if (/^windows\.old$/i.test(base)) return R('safe', 'Windows.old', 'The previous Windows version kept after an upgrade. Safe to remove, but only through Windows "Disk Cleanup → Previous Windows installation(s)" (needs administrator).', false);
    if (/^\$/.test(base)) return R('review', `${base} (Windows leftovers)`, 'Hidden Windows upgrade/recovery folders. Remove through Disk Cleanup, not by hand.', false);
    if (/^(recovery|perflogs|msocache|config\.msi|documents and settings|intel|amd|nvidia|drivers|dell|hp|lenovo)$/i.test(base)) return R('keep', base, 'Vendor/recovery folder created by Windows or a driver installer. Leave it unless you know what it is.', false);
  }
  // ---- Windows ----
  if (eqOrUnder(env.windows)) {
    const rel = path.relative(env.windows, n).replace(/\\/g, '/').toLowerCase();
    if (rel === 'temp' || rel.startsWith('temp/')) return R('safe', 'Windows temp files', 'Temporary files left by Windows and installers. Safe to clear (administrator rights may be needed).', rel !== 'temp', { group: 'temp' });
    if (rel === 'softwaredistribution/download' || rel.startsWith('softwaredistribution/download/')) return R('safe', 'Windows Update downloads', 'Update files Windows already installed or can download again. Safe to clear.', rel !== 'softwaredistribution/download', { group: 'winupdate' });
    if (rel === 'minidump' || rel.startsWith('minidump/') || rel === 'livekernelreports' || rel.startsWith('livekernelreports/')) return R('safe', 'Crash dumps', 'Memory dumps written after a Windows crash. Only useful for debugging; safe to delete.', rel.includes('/'), { group: 'crash' });
    if (rel === 'winsxs' || rel.startsWith('winsxs/')) return R('system', 'WinSxS (component store)', 'Windows keeps every system component here and shares files with System32 via hard links, so it looks bigger than it is. Never delete by hand; shrink with Disk Cleanup "Windows Update Cleanup" or DISM.', false);
    if (rel === 'installer' || rel.startsWith('installer/')) return R('keep', 'Windows Installer cache', 'Needed to repair or uninstall programs installed with MSI. Deleting it can make uninstalls fail.', false);
    if (rel === 'system32' || rel.startsWith('system32/') || rel === 'syswow64' || rel.startsWith('syswow64/')) return R('system', 'Windows core files', 'The heart of Windows. Deleting anything here can stop Windows from starting.', false);
    return R('system', eq(env.windows) ? 'Windows' : `Windows: ${base}`, 'Part of Windows itself. Needed; not something to clean by hand.', false);
  }
  // ---- Program Files / ProgramData ----
  for (const pf of env.pf) if (eqOrUnder(pf)) return R('keep', eq(pf) ? 'Installed programs' : `Program: ${path.relative(pf, n).split(path.sep)[0]}`, 'Installed programs. To free this space uninstall the program from the Apps tab, rather than deleting folders (that leaves it half-installed).', false);
  if (eqOrUnder(env.pd)) return R('keep', eq(env.pd) ? 'ProgramData' : `Shared data: ${path.relative(env.pd, n).split(path.sep)[0]}`, 'Data shared by programs for all users (licences, databases, caches). The Apps tab can clean it up when you uninstall the program that owns it.', false);
  // ---- other users ----
  if (under(env.usersRoot) && !eqOrUnder(env.profile) && !eq(env.usersRoot)) return R('keep', 'Another Windows user', 'Belongs to a different account on this PC. Not touched here.', false);
  if (eq(env.usersRoot)) return R('keep', 'User accounts', 'Holds one folder per Windows user.', false);

  // ---- my profile ----
  if (eqOrUnder(env.profile)) {
    const rel = path.relative(env.profile, n).split(path.sep); const top = (rel[0] || '').toLowerCase();
    const relLower = rel.join('/').toLowerCase();
    if (eq(env.profile)) return R('keep', 'Your user folder', 'Everything that belongs to your account.', false);
    if (eqOrUnder(env.temp)) return R('safe', 'Temporary files', 'Scratch files from programs and installers. Safe to clear; close programs first, files in use are skipped.', !eq(env.temp), { group: 'temp' });
    if (/(^|\/)appdata\/local\/crashdumps(\/|$)/.test(relLower)) return R('safe', 'Crash dumps', 'Memory dumps of crashed programs. Only useful for debugging.', relLower !== 'appdata/local/crashdumps', { group: 'crash' });
    if (/(^|\/)appdata\/local\/microsoft\/windows\/(inetcache|explorer)(\/|$)/.test(relLower)) return R('safe', 'Windows thumbnail / web cache', 'Cached thumbnails and web content. Windows rebuilds it automatically.', !/(inetcache|explorer)$/.test(relLower), { group: 'thumb' });
    if (/appdata\/local\/(google\/chrome|microsoft\/edge|bravesoftware\/brave-browser|mozilla\/firefox|opera software)\/.*\/(cache|code cache|gpucache|cache2|service worker\/cachestorage|media cache)$/.test(relLower)) return R('safe', 'Browser cache', 'Web pages/images your browser saved to load faster. Rebuilds automatically (close the browser first). Passwords and bookmarks are NOT in here.', true, { group: 'browser' });
    if (/(^|\/)(appdata\/local\/npm-cache|\.npm\/_cacache|appdata\/local\/pip\/cache|\.cache|\.gradle\/caches|appdata\/local\/yarn\/cache|appdata\/local\/pnpm-cache|appdata\/local\/pnpm\/store)(\/|$)/.test(relLower)) return R('safe', 'Developer download cache', 'Packages your tools downloaded before. They re-download when needed (a little slower the next time).', !/\/?(\.cache|\.gradle\/caches|npm-cache|_cacache|pip\/cache)$/.test(relLower), { group: 'devcache' });
    if (isDir && REPRO_DIRS[lbase]) return R('safe', lbase, `${REPRO_DIRS[lbase]}. Can be rebuilt. Only delete if you are finished with that project or do not mind rebuilding.`, true, { group: lbase === 'node_modules' ? 'node_modules' : 'repro' });
    if (/^\.(ssh|aws|gnupg|kube|azure|docker)$/.test(top) || top === '.gitconfig' || top === '.config') return R('keep', base, 'Keys, credentials or tool settings. Deleting them can lock you out of servers or accounts.', false);
    if (top === 'appdata') {
      if (rel.length === 1) return R('keep', 'AppData', 'Settings and data of your programs (caches, logins, game saves). Look inside for what is big.', false);
      const sub = (rel[1] || '').toLowerCase(); const rest = rel.slice(2).join('/').toLowerCase();
      if (sub === 'local' && rel.length === 2) return R('keep', 'AppData\\Local', 'Per-PC program data and caches.', false);
      if (sub === 'roaming' && rel.length === 2) return R('keep', 'AppData\\Roaming', 'Program settings that follow your account.', false);
      if (sub === 'locallow' && rel.length === 2) return R('keep', 'AppData\\LocalLow', 'Low-integrity program data.', false);
      if (sub === 'local' && /^packages(\/|$)/.test(rest)) return R('keep', 'Store app data', 'Data of Microsoft Store apps (Photos, Teams…). Removing it breaks those apps; uninstall the app instead.', false);
      if (sub === 'local' && /^microsoft(\/|$)/.test(rest)) return R('keep', `Microsoft: ${rel.slice(2).join('\\')}`, 'Windows and Microsoft programs keep their data here. Leave it.', false);
      if (sub === 'local' && /^programs(\/|$)/.test(rest)) return R('keep', rel.length > 3 ? `Program: ${rel[3]}` : 'Per-user programs', 'Programs installed just for you. Uninstall them from the Apps tab.', false);
      if (sub === 'local' && /^(docker|android\/sdk)(\/|$)/.test(rest)) return R('review', rest.startsWith('docker') ? 'Docker data' : 'Android SDK', rest.startsWith('docker') ? 'Docker images and the WSL disk. Huge, but deleting breaks your containers.' : 'Android development tools. Delete only if you no longer build Android apps.', rel.length > 3);
      return R('review', `Program data: ${rel.slice(1).join('\\')}`, 'Data left by a program. If you uninstalled that program the folder is leftover and the Apps tab can remove it; otherwise leave it.', false);
    }
    if (STD_FOLDERS.has(top) && rel.length === 1) return R('review', base, 'One of your personal folders. The folder itself stays; decide what to remove inside it.', false);
    if (CLOUD_RE.test(rel[0]) && rel.length === 1) return R('review', `${base} (cloud-synced)`, 'Synced with the cloud. Online-only files here do not use disk space. Deleting inside it deletes from the cloud too.', false);
    if (/^(\.vscode|\.vscode-)/.test(top) && /extensions$/.test(relLower)) return R('review', 'VS Code extensions', 'Editor extensions; re-installable.', true);
    if (relLower === '.android/avd' || relLower.startsWith('.android/avd/')) return R('review', 'Android emulators', 'Virtual phones for development. Large; delete if unused.', relLower !== '.android/avd');
    if (relLower.startsWith('.m2/repository') || relLower.startsWith('.nuget/packages')) return R('review', 'Package downloads', 'Libraries your builds downloaded. They re-download when needed.', rel.length > 2);
    if (top === 'downloads' && !isDir) { const hint = EXT_HINT.find((h) => h[0].test(base)); if (hint) return R(hint[1], `Download: ${hint[2]}`, hint[3], true); }
    // generic: user data
    const hint = !isDir ? EXT_HINT.find((h) => h[0].test(base)) : null;
    const cloud = CLOUD_RE.test(rel[0] || '');
    return hint ? R(hint[1], hint[2], hint[3] + (cloud ? ' It is in a cloud-synced folder: deleting also deletes it from the cloud.' : ''), true)
      : R('review', isDir ? 'Your folder' : 'Your file', cloud ? 'Cloud-synced: deleting here also deletes it from the cloud and your other devices.' : 'Your own data. Only you can say whether it is useful.', true);
  }
  // ---- anything else on the drive (C:\Projects, C:\Company_Handover, tools…) ----
  const hint = !isDir ? EXT_HINT.find((h) => h[0].test(base)) : null;
  if (isDir && REPRO_DIRS[lbase]) return R('safe', lbase, `${REPRO_DIRS[lbase]}. Can be rebuilt.`, true, { group: lbase === 'node_modules' ? 'node_modules' : 'repro' });
  return hint ? R(hint[1], hint[2], hint[3], true) : R('review', isDir ? 'Folder outside Windows and Program Files' : 'File', 'Not part of Windows or an installed program. It is yours (or a tool you installed by hand), so you decide.', true);
}

const GROUP_TITLES = {
  recycle: 'Recycle Bin', temp: 'Temporary files', winupdate: 'Windows Update downloads', crash: 'Crash dumps', thumb: 'Thumbnail & web cache', browser: 'Browser caches',
  devcache: 'Developer download caches', node_modules: 'node_modules folders (all projects)', repro: 'Other rebuildable project folders (.venv, __pycache__ …)',
};

module.exports = { buildEnv, explain, GROUP_TITLES, REPRO_DIRS, CLOUD_RE };
