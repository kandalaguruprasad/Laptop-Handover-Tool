'use strict';
// Builds the list of operations from tags. Never modifies the filesystem.
const fs = require('fs');
const path = require('path');
const { key, isInside, isInsideOrSame, norm, isWin } = require('./platform');
const { CATEGORY_DIR } = require('./categories');
const { freeBytes } = require('./drives');
const { walkTree } = require('./projwalk');

const FAT32_MAX = 4 * 1024 * 1024 * 1024 - 1;
const SAFETY_MARGIN = 1.02;

function nearestExisting(p) {
  let d = norm(p);
  for (let i = 0; i < 60; i++) { if (fs.existsSync(d)) return d; const up = path.dirname(d); if (up === d) break; d = up; }
  return d;
}
function devOf(p) { try { return fs.statSync(nearestExisting(p)).dev; } catch { return null; } }

/** Path of an item relative to the user profile (or to its scan root). */
function relFor(item, settings, scanRoots) {
  const p = norm(item.p);
  if (settings.profileRoot && isInside(p, settings.profileRoot)) return path.relative(settings.profileRoot, p);
  const root = scanRoots.filter((r) => isInside(p, r)).sort((a, b) => b.length - a.length)[0];
  if (root) return path.join(path.basename(root) || 'root', path.relative(root, p));
  return path.join('Other', path.basename(p));
}

function withSuffix(p, n, isDir) {
  if (isDir) return `${p} (${n})`;
  const ext = path.extname(p);
  return `${p.slice(0, p.length - ext.length)} (${n})${ext}`;
}

async function buildPlan({ db, settings, guard, drives = [], now = Date.now() }) {
  const warnings = [];
  const blockers = [];
  const scanRoots = ((db.meta && db.meta.roots) || settings.scanRoots).map(norm);
  const destRoot = settings.destDisk ? norm(path.join(settings.destDisk, 'Laptop_Backup')) : '';
  const companyRoot = settings.companyFolder ? norm(settings.companyFolder) : '';
  const tagged = db.items.filter((i) => i.tag);
  const undecided = db.items.length - tagged.length;

  const used = new Set();
  async function allocate(dst, isDir, srcStatsFn) {
    let cand = dst;
    for (let n = 2; n < 1000; n++) {
      const k = key(cand);
      if (!used.has(k)) {
        if (!fs.existsSync(cand)) { used.add(k); return { dst: cand, reuse: false }; }
        if (srcStatsFn && (await srcStatsFn(cand))) { used.add(k); return { dst: cand, reuse: true }; } // identical copy already there (earlier run)
      }
      cand = withSuffix(dst, n, isDir);
    }
    throw new Error('Could not allocate a unique destination for ' + dst);
  }

  const ops = [];
  let skippedMissing = 0;
  let seq = 0;
  const mineBytesByVolume = new Map();

  const hasMine = tagged.some((i) => i.tag === 'mine');
  if (hasMine) {
    if (!settings.destDisk) blockers.push('No destination hard disk configured (Settings → Destinations).');
    else if (!fs.existsSync(settings.destDisk)) blockers.push(`Destination ${settings.destDisk} not found — is the hard disk plugged in?`);
    else if (scanRoots.some((r) => isInsideOrSame(settings.destDisk, r))) blockers.push('The destination lies inside a scan root.');
  }
  for (const [label, root] of [['Destination', hasMine ? destRoot : ''], ['Company folder', companyRoot]]) {
    if (!root) continue;
    try { guard.assertWritable(root); } catch (e) { blockers.push(`${label}: ${e.message}`); }
  }
  if (!guard.destructiveEnabled) blockers.push('Server is in read-only mode. Restart with --live (or --sandbox <dir> for testing) to execute.');

  const sortKey = (i) => (i.kind === 'p' ? '0' : '1') + i.p;
  for (const it of tagged.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1))) {
    if (!fs.existsSync(it.p)) { skippedMissing++; continue; }
    const isProj = it.kind === 'p';
    const base = { itemId: it.id, name: it.n, tag: it.tag, kind: isProj ? 'project' : 'file', src: it.p, bytes: it.s, files: isProj ? it.fc : 1, cat: it.c, status: 'pending', error: null, attempts: 0 };
    const rel = relFor(it, settings, scanRoots);
    let op;
    if (it.tag === 'ignore') {
      op = { ...base, action: 'recycle', dst: null, removeRegen: isProj };
    } else if (it.tag === 'mine') {
      const want = isProj ? path.join(destRoot, 'Projects', it.n) : path.join(destRoot, CATEGORY_DIR[it.c] || 'Other', rel);
      const al = await allocate(want, isProj, async (c) => sameAlready(it, c, settings));
      op = { ...base, action: 'copy', dst: al.dst, reuse: al.reuse, removeSource: !!settings.deleteSourceAfterCopy, removeRegen: isProj };
      const vol = devOf(destRoot);
      mineBytesByVolume.set(vol, (mineBytesByVolume.get(vol) || 0) + it.s);
    } else { // company
      const want = isProj ? path.join(companyRoot, it.n) : path.join(companyRoot, 'Files', rel);
      const al = await allocate(want, isProj, async (c) => sameAlready(it, c, settings));
      const sameVol = devOf(it.p) !== null && devOf(it.p) === devOf(al.dst);
      op = { ...base, action: sameVol ? 'move' : 'copy', dst: al.dst, reuse: al.reuse, removeSource: sameVol ? true : !!settings.deleteSourceAfterCopy, removeRegen: isProj && settings.purgeCompanyRegen };
      if (!sameVol) { const v = devOf(companyRoot); mineBytesByVolume.set(v, (mineBytesByVolume.get(v) || 0) + it.s); }
    }
    op.id = 'op' + String(++seq).padStart(6, '0');
    op.cloud = it.cloud;
    op.git = isProj && it.git ? { dirty: it.git.dirty, unpushed: it.git.unpushed } : null;
    ops.push(op);
  }

  // ---- summary ----
  const sum = { company: { items: 0, bytes: 0, projects: 0, files: 0 }, mine: { items: 0, bytes: 0, projects: 0, files: 0 }, ignore: { items: 0, bytes: 0, projects: 0, files: 0 } };
  for (const o of ops) { const s = sum[o.tag]; s.items++; s.bytes += o.bytes; if (o.kind === 'project') s.projects++; else s.files++; }
  const moves = ops.filter((o) => o.action === 'move').length;

  // ---- free space ----
  const space = [];
  for (const [dev, need] of mineBytesByVolume) {
    const probe = ops.find((o) => o.dst && devOf(o.dst) === dev);
    const fb = probe ? freeBytes(nearestExisting(path.dirname(probe.dst))) : null;
    const required = Math.ceil(need * SAFETY_MARGIN);
    const entry = { volume: probe ? path.parse(norm(probe.dst)).root : String(dev), required, free: fb ? fb.free : null };
    space.push(entry);
    if (fb && fb.free < required) blockers.push(`Not enough free space on ${entry.volume}: need ${required} bytes, only ${fb.free} free.`);
    if (!fb) warnings.push({ level: 'warn', text: `Could not determine free space on ${entry.volume}.` });
  }

  // ---- warnings ----
  const risky = ops.filter((o) => (o.tag === 'mine' || o.tag === 'ignore') && o.git && (o.git.dirty || o.git.unpushed));
  for (const o of risky) {
    warnings.push({ level: 'danger', text: `${o.tag === 'ignore' ? 'IGNORE (will be deleted)' : 'Mine'} project "${o.name}" has ${o.git.dirty || 0} uncommitted file(s) and ${o.git.unpushed || 0} unpushed commit(s).` });
  }
  const cloud = ops.filter((o) => o.cloud && (o.tag === 'mine' || o.tag === 'ignore'));
  if (cloud.length) warnings.push({ level: 'warn', text: `${cloud.length} Mine/Ignore item(s) are in cloud-synced folders (OneDrive/Dropbox…). Moving or deleting them may trigger downloads or cloud deletions.` });
  const destFs = hasMine && settings.destDisk ? (drives.find((d) => key(norm(settings.destDisk)).startsWith(key(d.path.replace(/[\\/]+$/, ''))) && d.path.length > 1) || {}).fs : '';
  if (/fat32|^fat$/i.test(destFs || '')) {
    const big = ops.filter((o) => o.tag === 'mine' && o.kind === 'file' && o.bytes > FAT32_MAX);
    if (big.length) blockers.push(`Destination is FAT32 and ${big.length} file(s) exceed 4 GB.`);
    else warnings.push({ level: 'warn', text: 'Destination is FAT32: files over 4 GB cannot be stored and long paths may fail.' });
  } else if (/exfat/i.test(destFs || '')) {
    warnings.push({ level: 'warn', text: 'Destination is exFAT: no file permissions/ACLs are kept and very long paths can fail. Timestamps have 2-second resolution (handled).' });
  }
  const longDst = ops.filter((o) => o.dst && o.dst.length > 250).length;
  if (longDst) warnings.push({ level: 'warn', text: `${longDst} destination path(s) exceed 250 characters; copies use the \\\\?\\ prefix but some programs may not open them afterwards.` });
  if (sum.ignore.items) {
    warnings.push({ level: settings.permanentDelete ? 'danger' : 'warn', text: settings.permanentDelete
      ? `PERMANENT DELETE is ON: ${sum.ignore.items} Ignore item(s) will be deleted for good (no Recycle Bin).`
      : `${sum.ignore.items} Ignore item(s) go to the Recycle Bin. Windows permanently deletes items that are too big for the Recycle Bin instead.` });
  }
  if (undecided) warnings.push({ level: 'info', text: `${undecided} undecided item(s) will not be touched.` });
  if (skippedMissing) warnings.push({ level: 'info', text: `${skippedMissing} tagged item(s) no longer exist on disk and were skipped.` });
  if (!settings.deleteSourceAfterCopy) warnings.push({ level: 'info', text: 'Sources are kept after verified copies ("delete source after verified copy" is off).' });

  return {
    id: 'plan-' + now, createdAt: now, ops, sum, moves, space, warnings, blockers, undecided,
    destRoot, companyRoot, scanRoots, destDisk: settings.destDisk,
    settings: { deleteSourceAfterCopy: !!settings.deleteSourceAfterCopy, paranoidHash: !!settings.paranoidHash, permanentDelete: !!settings.permanentDelete, regenDirs: settings.regenDirs.slice(), cleanEmptyDirs: !!settings.cleanEmptyDirs, purgeCompanyRegen: !!settings.purgeCompanyRegen },
    requiresDelete: sum.ignore.items > 0,
    mode: guard.mode,
  };
}

/** True if `cand` already holds an identical copy of the item (from an earlier run). */
async function sameAlready(it, cand, settings) {
  try {
    const st = fs.statSync(cand);
    if (it.kind === 'f') return st.isFile() && st.size === it.s && Math.abs(st.mtimeMs - it.m) <= 2500;
    if (!st.isDirectory()) return false;
    const a = await walkTree(it.p, { regen: settings.regenDirs });
    const b = await walkTree(cand, {});
    return a.files === b.files && a.bytes === b.bytes;
  } catch { return false; }
}

function csvEscape(v) { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function planToCsv(plan, header = true) {
  const rows = header ? [['item', 'tag', 'action', 'source', 'destination', 'size_bytes', 'status', 'error']] : [];
  for (const o of plan.ops) rows.push([o.name, o.tag, o.action, o.src, o.dst || (o.action === 'recycle' ? '(recycle bin)' : ''), o.bytes, o.status, o.error || '']);
  return rows.map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

module.exports = { buildPlan, planToCsv, relFor, nearestExisting, devOf, csvEscape };
