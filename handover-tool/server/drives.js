'use strict';
const fs = require('fs');
const { execFile } = require('child_process');
const { isWin } = require('./platform');

function exec(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(err ? null : out));
  });
}

async function listDrives() {
  if (isWin) {
    const ps = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,FileSystem,Size,FreeSpace,VolumeName | ConvertTo-Json -Compress']);
    if (ps) {
      try {
        let arr = JSON.parse(ps); if (!Array.isArray(arr)) arr = [arr];
        return arr.filter((d) => d.Size).map((d) => ({
          path: d.DeviceID + '\\', label: d.VolumeName || '', fs: d.FileSystem || '', total: d.Size, free: d.FreeSpace,
          used: d.Size - d.FreeSpace, removable: d.DriveType === 2, system: d.DeviceID === (process.env.SystemDrive || 'C:'),
        }));
      } catch { /* fall through */ }
    }
    const out = [];
    for (let c = 67; c <= 90; c++) {
      const root = String.fromCharCode(c) + ':\\';
      try { const s = fs.statfsSync(root); out.push({ path: root, label: '', fs: '', total: s.blocks * s.bsize, free: s.bavail * s.bsize, used: (s.blocks - s.bavail) * s.bsize, removable: false, system: c === 67 }); } catch { /* absent */ }
    }
    return out;
  }
  const out = await exec('df', ['-kPT']);
  if (!out) return [];
  return out.split('\n').slice(1).filter(Boolean).map((l) => l.split(/\s+/)).filter((c) => c.length >= 7 && c[0].startsWith('/'))
    .map((c) => ({ path: c[6], label: c[0], fs: c[1], total: +c[2] * 1024, used: +c[3] * 1024, free: +c[4] * 1024, removable: false, system: c[6] === '/' }));
}

/** Free bytes on the volume holding `p` (nearest existing ancestor). */
function freeBytes(p) {
  let d = p;
  for (let i = 0; i < 50; i++) {
    try { const s = fs.statfsSync(d); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch { /* up */ }
    const up = require('path').dirname(d); if (up === d) break; d = up;
  }
  return null;
}

/** Filesystem name for the volume containing p (best effort). */
async function fsNameFor(p, drives) {
  const { key } = require('./platform');
  const k = key(require('path').resolve(p));
  let best = null;
  for (const d of drives) { const dk = key(d.path); if (k.startsWith(dk) && (!best || dk.length > key(best.path).length)) best = d; }
  return best ? best.fs : '';
}

module.exports = { listDrives, freeBytes, fsNameFor };
