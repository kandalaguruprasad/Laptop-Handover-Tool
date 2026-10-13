'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function parseGitConfigRemote(root) {
  try {
    const cfg = fs.readFileSync(path.join(root, '.git', 'config'), 'utf8');
    const m = cfg.match(/\[remote "origin"\][^\[]*?url\s*=\s*(.+)/);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

function parseHeadBranch(root) {
  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref: refs\/heads\/(.+)$/);
    return m ? m[1] : head.slice(0, 8) + ' (detached)';
  } catch { return null; }
}

function run(args, cwd, timeout = 30000) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'safe.directory=*', ...args], {
      cwd, timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: path.dirname(cwd) },
    }, (err, stdout) => resolve(err ? null : stdout));
  });
}

let gitAvailable = null;
async function hasGit() {
  if (gitAvailable === null) gitAvailable = (await run(['--version'], process.cwd(), 5000)) !== null;
  return gitAvailable;
}

/** Cheap info from .git files (no process) + dirty/unpushed via CLI when available. */
async function gitInfo(root) {
  const info = { remote: parseGitConfigRemote(root), branch: parseHeadBranch(root), dirty: null, unpushed: null };
  if (!fs.existsSync(path.join(root, '.git')) || !(await hasGit())) return info;
  const st = await run(['status', '--porcelain'], root);
  if (st !== null) info.dirty = st.split('\n').filter(Boolean).length;
  const ahead = await run(['rev-list', '--count', 'HEAD', '--not', '--remotes'], root);
  if (ahead !== null) info.unpushed = parseInt(ahead.trim(), 10) || 0;
  if (!info.remote) {
    const r = await run(['config', '--get', 'remote.origin.url'], root, 5000);
    if (r) info.remote = r.trim();
  }
  return info;
}

module.exports = { gitInfo, hasGit, parseGitConfigRemote, parseHeadBranch };
