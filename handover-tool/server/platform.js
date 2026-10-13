'use strict';
const path = require('path');
const os = require('os');

const isWin = process.platform === 'win32';

/** Absolute, normalised path (no trailing separator except for roots). */
function norm(p) {
  let r = path.resolve(p);
  if (r.length > 3 && (r.endsWith('\\') || r.endsWith('/'))) r = r.slice(0, -1);
  return r;
}

/** Case-insensitive key on Windows, exact elsewhere. */
function key(p) {
  return isWin ? p.toLowerCase() : p;
}

function isInside(child, parent) {
  const c = key(norm(child));
  const p = key(norm(parent));
  if (c === p) return false;
  const withSep = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(withSep);
}

function isInsideOrSame(child, parent) {
  return key(norm(child)) === key(norm(parent)) || isInside(child, parent);
}

/** Long-path prefix for Win32 file APIs. */
function lp(p) {
  if (!isWin) return p;
  const r = norm(p);
  if (r.startsWith('\\\\?\\')) return r;
  if (r.length < 240) return r;
  if (r.startsWith('\\\\')) return '\\\\?\\UNC\\' + r.slice(2);
  return '\\\\?\\' + r;
}

function protectedPaths() {
  if (!isWin) return ['/proc', '/sys', '/dev', '/boot', '/etc', '/bin', '/sbin', '/usr', '/lib', '/var'];
  const sysDrive = process.env.SystemDrive || 'C:';
  const list = [
    process.env.SystemRoot || sysDrive + '\\Windows',
    process.env['ProgramFiles'] || sysDrive + '\\Program Files',
    process.env['ProgramFiles(x86)'] || sysDrive + '\\Program Files (x86)',
    process.env.ProgramData || sysDrive + '\\ProgramData',
    sysDrive + '\\$Recycle.Bin',
    sysDrive + '\\System Volume Information',
  ];
  return [...new Set(list.map(norm))];
}

const PROTECTED_DIR_NAMES = new Set(['$recycle.bin', 'system volume information']);

function userProfile() {
  return os.homedir();
}

function isRootPath(p) {
  const r = norm(p);
  return path.parse(r).root === r || r === '/';
}

module.exports = { isWin, norm, key, isInside, isInsideOrSame, lp, protectedPaths, PROTECTED_DIR_NAMES, userProfile, isRootPath };
