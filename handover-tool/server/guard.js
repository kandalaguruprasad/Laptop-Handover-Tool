'use strict';
// Every destructive primitive calls guard.assertWritable(path) first.
const fs = require('fs');
const path = require('path');
const { protectedPaths, isInside, isInsideOrSame, isRootPath, norm, isWin } = require('./platform');

/** Folders where app leftovers may live. In a sandbox they are mirrored inside the sandbox. */
function appCleanupRoots(sandbox) {
  if (sandbox) {
    const s = norm(sandbox);
    return [path.join(s, 'profile', 'AppData', 'Local'), path.join(s, 'profile', 'AppData', 'Roaming'), path.join(s, 'ProgramData'), path.join(s, 'Program Files'), path.join(s, 'Program Files (x86)')];
  }
  if (!isWin) return [];
  const e = process.env;
  return [e.LOCALAPPDATA, e.APPDATA, e.ProgramData, e.ProgramFiles, e['ProgramFiles(x86)']].filter(Boolean).map(norm);
}
// first-level folders inside those roots that are never offered or touched
const APP_DENY = new Set(['microsoft', 'windows', 'windowsapps', 'common files', 'windows nt', 'microsoft shared', 'packages', 'temp', 'programs',
  'windows defender', 'windows mail', 'windows media player', 'windows photo viewer', 'windows security', 'windows portable devices', 'internet explorer',
  'microsoft.net', 'modifiablewindowsapps', 'application data', 'package cache', 'connecteddevicesplatform', 'comms', 'history', 'inetcache']);

class GuardError extends Error {}

function createGuard({ sandbox, live, extraAllowedRoots = [] }) {
  const prot = protectedPaths();
  const sb = sandbox ? norm(sandbox) : null;
  const guard = {
    sandbox: sb,
    live: !!live,
    mode: sb ? 'sandbox' : live ? 'live' : 'readonly',
    destructiveEnabled: !!(sb || live),
    assertWritable(p) {
      if (!guard.destructiveEnabled) throw new GuardError('Destructive operations are disabled: start with --sandbox <dir> or --live');
      const r = norm(p.replace(/^\\\\\?\\/, ''));
      if (isRootPath(r)) throw new GuardError(`Refusing to touch a drive root: ${r}`);
      if (sb) {
        if (!isInside(r, sb)) throw new GuardError(`Sandbox: refusing path outside ${sb}: ${r}`);
      }
      for (const pp of prot) if (isInsideOrSame(r, pp)) throw new GuardError(`Protected path: ${r}`);
      return r;
    },
    /** Strict check for app-leftover cleanup: a folder strictly inside AppData/ProgramData/Program Files roots, never a system folder. */
    assertAppCleanup(p) {
      if (!guard.destructiveEnabled) throw new GuardError('Destructive operations are disabled: start with --sandbox <dir> or --live');
      const r = norm(String(p).replace(/^\\\\\?\\/, ''));
      const roots = appCleanupRoots(sb);
      const root = roots.find((x) => isInside(r, x));
      if (!root) throw new GuardError(`Not an app-data location: ${r}`);
      const rel = path.relative(root, r).split(path.sep);
      const first = rel[0].toLowerCase();
      if (APP_DENY.has(first) && !(first === 'programs' && rel.length >= 2 && !APP_DENY.has(rel[1].toLowerCase()))) throw new GuardError(`Protected system folder: ${r}`);
      if (!sb && /[\\/]windows([\\/]|$)/i.test(r)) throw new GuardError(`Protected path: ${r}`);
      return r;
    },
    assertNotSymlink(p) {
      try { if (fs.lstatSync(p).isSymbolicLink()) throw new GuardError(`Refusing symlink/junction: ${p}`); }
      catch (e) { if (e instanceof GuardError) throw e; }
    },
  };
  return guard;
}

module.exports = { createGuard, GuardError, appCleanupRoots, APP_DENY };
