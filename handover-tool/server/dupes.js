'use strict';
const fs = require('fs');
const crypto = require('crypto');

function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/** Lazy duplicate detection: same size, then SHA-256. Skips cloud-synced files (would trigger downloads). */
async function findDuplicates(db, onProgress) {
  const bySize = new Map();
  for (const it of db.items) {
    if (it.kind !== 'f' || it.s < 1024 || it.cloud) continue;
    (bySize.get(it.s) || bySize.set(it.s, []).get(it.s)).push(it);
  }
  const cands = [...bySize.values()].filter((a) => a.length > 1).flat();
  let done = 0;
  const byHash = new Map();
  let idx = 0;
  async function worker() {
    while (idx < cands.length) {
      const it = cands[idx++];
      try {
        const h = it.s + ':' + (await hashFile(it.p));
        (byHash.get(h) || byHash.set(h, []).get(h)).push(it.id);
      } catch { /* unreadable: ignore */ }
      if (++done % 25 === 0) onProgress && onProgress(done, cands.length);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  onProgress && onProgress(cands.length, cands.length);
  return [...byHash.values()].filter((g) => g.length > 1)
    .map((g) => g.sort((a, b) => db.items[a].m - db.items[b].m || db.items[a].p.length - db.items[b].p.length))
    .sort((a, b) => db.items[b[0]].s * b.length - db.items[a[0]].s * a.length);
}

/** Mark all-but-one of each group Ignore. Keeps a tagged copy if any, else the oldest. Never overrides existing tags. */
function markDuplicatesIgnore(db, groups) {
  let marked = 0;
  for (const g of groups) {
    const keep = g.find((id) => db.items[id].tag && db.items[id].tag !== 'ignore') ?? g[0];
    for (const id of g) if (id !== keep && !db.items[id].tag) { db.setTag(db.items[id], 'ignore'); marked++; }
  }
  db.bump(); db.saveTagsSoon();
  return marked;
}

module.exports = { findDuplicates, markDuplicatesIgnore };
