'use strict';
const fs = require('fs');
const path = require('path');
const { DEFAULT_REGEN } = require('./categories');
const { userProfile, isWin } = require('./platform');

function defaults(sandbox) {
  const profile = sandbox ? path.join(sandbox, 'profile') : userProfile();
  const roots = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music'].map((d) => path.join(profile, d));
  try { // cloud-synced folders sitting next to the standard ones (OneDrive - Company, Dropbox, ...)
    for (const e of fs.readdirSync(profile, { withFileTypes: true })) {
      if (e.isDirectory() && /^(onedrive|dropbox|google ?drive)/i.test(e.name)) roots.push(path.join(profile, e.name));
    }
  } catch { /* profile missing */ }
  return {
    scanRoots: roots,
    includeAppData: false,
    regenDirs: [...DEFAULT_REGEN],
    companyPatterns: [],
    minePatterns: [],
    destDisk: sandbox ? path.join(sandbox, 'external') : '',
    permanentDelete: false,
    deleteSourceAfterCopy: true,
    paranoidHash: false,
    companyFolder: sandbox ? path.join(sandbox, 'Company_Handover') : (isWin ? 'C:\\Company_Handover' : path.join(profile, 'Company_Handover')),
    purgeCompanyRegen: true,
    downloadsOlderThanDays: 90,
    cleanEmptyDirs: true,
    profileRoot: profile,
  };
}

function load(file, sandbox) {
  const d = defaults(sandbox);
  try { return { ...d, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return d; }
}

function sanitize(input, current) {
  const s = { ...current };
  const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : null);
  for (const k of ['scanRoots', 'regenDirs', 'companyPatterns', 'minePatterns']) {
    const v = arr(input[k]); if (v) s[k] = v;
  }
  for (const k of ['includeAppData', 'permanentDelete', 'deleteSourceAfterCopy', 'paranoidHash', 'purgeCompanyRegen', 'cleanEmptyDirs']) {
    if (typeof input[k] === 'boolean') s[k] = input[k];
  }
  for (const k of ['destDisk', 'companyFolder']) if (typeof input[k] === 'string') s[k] = input[k].trim();
  if (Number.isFinite(input.downloadsOlderThanDays)) s.downloadsOlderThanDays = Math.max(0, Math.floor(input.downloadsOlderThanDays));
  return s;
}

module.exports = { defaults, load, sanitize };
