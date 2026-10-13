'use strict';
// All destructive primitives live here. Each one asserts through the guard first.
// Windows: robocopy + PowerShell Recycle Bin. Elsewhere: Node fallbacks (dev/test only).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { isWin, lp, norm, isInsideOrSame } = require('./platform');
const { walkTree, Limiter, readDirents } = require('./projwalk');
const { CONDITIONAL_REGEN, isRegenDir, makeRegenSet } = require('./categories');

class VerifyError extends Error {}
const MTIME_TOLERANCE_MS = 2500; // exFAT/FAT store 2-second timestamps

const RECYCLE_PS = `param([string]$ListFile)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName Microsoft.VisualBasic
$items = Get-Content -LiteralPath $ListFile -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($it in $items) {
  try {
    if ($it.d) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($it.p, 'OnlyErrorDialogs', 'SendToRecycleBin') }
    else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($it.p, 'OnlyErrorDialogs', 'SendToRecycleBin') }
    Write-Output ("OK\`t" + $it.i)
  } catch {
    $m = ($_.Exception.Message -replace '[\\r\\n\\t]+', ' ')
    Write-Output ("ERR\`t" + $it.i + "\`t" + $m)
  }
}
`;

/** robocopy argument list for a project copy (exported for tests). */
function robocopyArgs(src, dst, xd) {
  const args = [src, dst, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/MT:16', '/XJ', '/XJF', '/XJD', '/NP'];
  if (xd.length) args.push('/XD', ...xd);
  return args;
}
const robocopyOk = (code) => code >= 0 && code < 8;

/** Regenerable names that are safe to hand to robocopy /XD as plain names. */
function unconditionalNames(regenDirs) {
  return regenDirs.filter((n) => !CONDITIONAL_REGEN.has(n.toLowerCase()));
}

function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(lp(p)).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

class FsOps {
  /** @param {{guard, dataDir:string, sandbox?:string|null}} o */
  constructor(o) {
    this.guard = o.guard;
    this.dataDir = o.dataDir;
    this.sandbox = o.sandbox || null;
    this.children = new Set();
    this.psFile = null;
  }

  killAll() { for (const c of this.children) { try { c.kill(); } catch { /* gone */ } } }

  run(cmd, args, { timeout = 0, logFile = null } = {}) {
    return new Promise((resolve, reject) => {
      const c = spawn(cmd, args, { windowsHide: true });
      this.children.add(c);
      let out = '';
      let log = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : null;
      const t = timeout ? setTimeout(() => { try { c.kill(); } catch { /* */ } }, timeout) : null;
      c.stdout.on('data', (d) => { if (log) log.write(d); else if (out.length < 4e6) out += d; });
      c.stderr.on('data', (d) => { if (out.length < 4e6) out += d; });
      c.on('error', (e) => { this.children.delete(c); if (t) clearTimeout(t); log && log.end(); reject(e); });
      c.on('close', (code) => { this.children.delete(c); if (t) clearTimeout(t); log && log.end(); resolve({ code, out }); });
    });
  }

  // ---------------- copying ----------------
  async copyFile(src, dst) {
    this.guard.assertWritable(dst);
    await fs.promises.mkdir(lp(path.dirname(dst)), { recursive: true });
    await fs.promises.copyFile(lp(src), lp(dst));
    const st = await fs.promises.stat(lp(src));
    await fs.promises.utimes(lp(dst), st.atime, st.mtime);
  }

  /** Copy a project/folder, skipping regenerable dirs. `xdPaths` = absolute regen dirs found in src. */
  async copyTree(src, dst, { regenDirs, xdPaths, logFile }) {
    this.guard.assertWritable(dst);
    await fs.promises.mkdir(lp(dst), { recursive: true });
    if (isWin) {
      const xd = [...unconditionalNames(regenDirs), ...xdPaths.filter((p) => CONDITIONAL_REGEN.has(path.basename(p).toLowerCase()))];
      const { code, out } = await this.run('robocopy', robocopyArgs(src, dst, xd), { logFile });
      if (!robocopyOk(code)) throw new Error(`robocopy failed (exit ${code}). ${out.slice(-300)}`);
      return;
    }
    const skip = new Set(xdPaths.map(norm));
    const lim = new Limiter(8);
    const rec = async (s, d) => {
      await fs.promises.mkdir(d, { recursive: true });
      const entries = await readDirents(s);
      await Promise.all(entries.map(async (e) => {
        if (e.isSymbolicLink()) return;
        const sp = path.join(s, e.name); const dp = path.join(d, e.name);
        if (e.isDirectory()) { if (!skip.has(norm(sp))) await rec(sp, dp); } // never hold a limiter slot while recursing
        else if (e.isFile()) {
          await lim.run(async () => { await fs.promises.copyFile(sp, dp); const st = await fs.promises.stat(sp); await fs.promises.utimes(dp, st.atime, st.mtime); });
        }
      }));
      const st = await fs.promises.stat(s);
      await fs.promises.utimes(d, st.atime, st.mtime);
    };
    await rec(src, dst);
  }

  // ---------------- verification ----------------
  async verifyFile(src, dst, paranoid) {
    const a = await fs.promises.stat(lp(src));
    let b;
    try { b = await fs.promises.stat(lp(dst)); } catch { throw new VerifyError(`Destination missing: ${dst}`); }
    if (a.size !== b.size) throw new VerifyError(`Size mismatch (${a.size} vs ${b.size})`);
    if (Math.abs(a.mtimeMs - b.mtimeMs) > MTIME_TOLERANCE_MS) throw new VerifyError('Modified-time mismatch');
    if (paranoid && (await hashFile(src)) !== (await hashFile(dst))) throw new VerifyError('SHA-256 mismatch');
  }

  async verifyTree(src, dst, regenDirs, paranoid) {
    const a = await walkTree(src, { regen: regenDirs });
    if (!fs.existsSync(lp(dst))) throw new VerifyError(`Destination missing: ${dst}`);
    const b = await walkTree(dst, { regen: regenDirs });
    if (a.errors || b.errors) throw new VerifyError(`Could not read ${a.errors + b.errors} folder(s)/file(s) while verifying`);
    if (a.files !== b.files) throw new VerifyError(`File count mismatch (${a.files} vs ${b.files})`);
    if (a.bytes !== b.bytes) throw new VerifyError(`Total size mismatch (${a.bytes} vs ${b.bytes})`);
    if (paranoid) await this.compareHashes(src, dst, regenDirs);
    return a;
  }

  async compareHashes(src, dst, regenDirs) {
    const set = makeRegenSet(regenDirs, isWin);
    const rec = async (rel) => {
      const sd = path.join(src, rel);
      const entries = await readDirents(sd);
      const names = entries.map((e) => e.name);
      for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        const r = path.join(rel, e.name);
        if (e.isDirectory()) { if (!isRegenDir(e.name, set, names, isWin)) await rec(r); }
        else if (e.isFile() && (await hashFile(path.join(src, r))) !== (await hashFile(path.join(dst, r)))) throw new VerifyError(`SHA-256 mismatch: ${r}`);
      }
    };
    await rec('');
  }

  // ---------------- removal ----------------
  async move(src, dst) {
    this.guard.assertWritable(src); this.guard.assertWritable(dst);
    await fs.promises.mkdir(lp(path.dirname(dst)), { recursive: true });
    await fs.promises.rename(lp(src), lp(dst)); // throws EXDEV across volumes
  }

  /** Permanently delete (fast) a regenerable directory. */
  async purgeDir(dir) {
    this.guard.assertWritable(dir);
    this.guard.assertNotSymlink(dir);
    if (!fs.existsSync(lp(dir))) return;
    if (isWin) {
      const empty = path.join(this.dataDir, 'empty-dir');
      fs.mkdirSync(empty, { recursive: true });
      await this.run('robocopy', [empty, dir, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:0', '/W:0', '/XJ']);
      try { await fs.promises.rmdir(lp(dir)); return; } catch { /* fall back */ }
    }
    await fs.promises.rm(lp(dir), { recursive: true, force: true, maxRetries: 2 });
  }

  async purgeAll(dirs) { for (const d of dirs) await this.purgeDir(d); return dirs.length; }

  /** Send items to the Recycle Bin (or delete permanently). items: [{p, isDir}] -> [{p, ok, error?}] */
  async recycle(items, { permanent = false } = {}) {
    for (const it of items) this.guard.assertWritable(it.p);
    for (const it of items) this.guard.assertNotSymlink(it.p);
    if (permanent) {
      return Promise.all(items.map(async (it) => {
        try { await fs.promises.rm(lp(it.p), { recursive: true, force: true }); return { p: it.p, ok: true }; } catch (e) { return { p: it.p, ok: false, error: e.message }; }
      }));
    }
    if (!isWin) {
      if (!this.sandbox) throw new Error('Recycle Bin is only available on Windows');
      const bin = path.join(this.sandbox, '.recycle');
      await fs.promises.mkdir(bin, { recursive: true });
      return Promise.all(items.map(async (it, i) => {
        try {
          const dest = path.join(bin, `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}-${path.basename(it.p)}`);
          (this.guard.assertRecycleDest || this.guard.assertWritable).call(this.guard, dest); // the fake bin is a destination, not a source
          await fs.promises.rename(it.p, dest);
          return { p: it.p, ok: true };
        } catch (e) { return { p: it.p, ok: false, error: e.message }; }
      }));
    }
    if (!this.psFile) { this.psFile = path.join(this.dataDir, 'recycle.ps1'); fs.writeFileSync(this.psFile, RECYCLE_PS); }
    const listFile = path.join(this.dataDir, `recycle-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(listFile, JSON.stringify(items.map((it, i) => ({ i, p: it.p, d: !!it.isDir }))));
    const results = new Map();
    try {
      const { out } = await this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.psFile, '-ListFile', listFile], { timeout: 20 * 60 * 1000 });
      for (const line of out.split(/\r?\n/)) {
        const [st, i, ...msg] = line.split('\t');
        if (st === 'OK') results.set(+i, { ok: true });
        else if (st === 'ERR') results.set(+i, { ok: false, error: msg.join(' ') });
      }
    } finally { try { fs.unlinkSync(listFile); } catch { /* */ } }
    return items.map((it, i) => {
      const r = results.get(i);
      if (!r) return { p: it.p, ok: !fs.existsSync(lp(it.p)) ? true : false, error: fs.existsSync(lp(it.p)) ? 'Recycle Bin call returned no result' : undefined };
      return { p: it.p, ...r };
    });
  }

  rmdirIfEmpty(dir) {
    try { this.guard.assertWritable(dir); fs.rmdirSync(lp(dir)); return true; } catch { return false; }
  }
}

module.exports = { FsOps, VerifyError, robocopyArgs, robocopyOk, unconditionalNames, RECYCLE_PS, isInsideOrSame };
