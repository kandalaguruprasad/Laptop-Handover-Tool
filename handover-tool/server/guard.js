'use strict';
// Every destructive primitive calls guard.assertWritable(path) first.
const fs = require('fs');
const { protectedPaths, isInside, isInsideOrSame, isRootPath, norm } = require('./platform');

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
    assertNotSymlink(p) {
      try { if (fs.lstatSync(p).isSymbolicLink()) throw new GuardError(`Refusing symlink/junction: ${p}`); }
      catch (e) { if (e instanceof GuardError) throw e; }
    },
  };
  return guard;
}

module.exports = { createGuard, GuardError };
