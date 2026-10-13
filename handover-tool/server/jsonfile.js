'use strict';
const fs = require('fs');

/** Atomic JSON write: tmp file + rename. */
function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
module.exports = { writeJsonAtomic, readJson };
