'use strict';
const { isWin } = require('./platform');

function normRemote(u) {
  let s = String(u || '').trim().toLowerCase();
  s = s.replace(/^[a-z+]+:\/\//, '').replace(/^[^@\/]+@/, '').replace(/\.git$/, '');
  s = s.replace(/^([^\/:]+):(?!\d+\/)/, '$1/');
  return s.replace(/\/+$/, '');
}
function matchesAny(remote, patterns) {
  const r = normRemote(remote);
  return patterns.some((p) => { const n = normRemote(p); return n && r.includes(n); });
}

function underDir(p, names) {
  const parts = (isWin ? p.toLowerCase() : p).split(/[\\/]/);
  return names.some((n) => parts.includes(isWin ? n.toLowerCase() : n));
}

const IGNORE_EXT = new Set(['exe', 'msi', 'iso', 'dmg', 'tmp', 'log']);

/** Returns 'company' | 'mine' | 'ignore' | null. Pure; never touches the disk. */
function suggestFor(item, settings, now = Date.now()) {
  if (item.kind === 'p') {
    const r = item.git && item.git.remote;
    if (!r) return null;
    if (matchesAny(r, settings.companyPatterns)) return 'company';
    if (matchesAny(r, settings.minePatterns)) return 'mine';
    return null;
  }
  if (IGNORE_EXT.has(item.e)) return 'ignore';
  if (underDir(item.p, ['Downloads']) && settings.downloadsOlderThanDays > 0 &&
      now - item.m > settings.downloadsOlderThanDays * 86400000) return 'ignore';
  if ((item.c === 'images' || item.c === 'videos' || item.c === 'documents') &&
      underDir(item.p, ['Pictures', 'Videos', 'Desktop', 'Documents'])) return 'mine';
  return null;
}

module.exports = { suggestFor, normRemote, matchesAny };
