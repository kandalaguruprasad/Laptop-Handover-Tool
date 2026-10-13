'use strict';
// "Company Groups" tab backend: find similarly named folders in the company handover folder, group them on request.
const fs = require('fs');
const path = require('path');
const { norm, isInside, key } = require('./platform');
const { walkTree, Limiter, readDirents, classify } = require('./projwalk');
const { parseGitConfigRemote, parseHeadBranch } = require('./git');
const { isProjectRoot } = require('./categories');
const { FsOps } = require('./fsops');
const { writeJsonAtomic, readJson } = require('./jsonfile');

const MARKER = '.handover-group.json';
const NOISE = new Set(['copy', 'final', 'new', 'old', 'backup', 'bak', 'latest', 'master', 'main', 'clone', 'extracted', 'copia', 'duplicate', 'dup', 'tmp', 'temp']);

/** "My App - Copy (2)", "my_app_v2", "myapp-final-2023-01-05", "app-42c3b6f2d072" -> "my app"/"myapp"/"app" */
function normalizeName(name) {
  let s = String(name).toLowerCase().replace(/\(\d+\)/g, ' ').replace(/[._\-\s]+/g, ' ').trim();
  const toks = s.split(' ').filter(Boolean).filter((t) => {
    if (/^\d+$/.test(t)) return false;
    if (/^v?\d+(\.\d+)*$/.test(t) || /^v\d+/.test(t)) return false;
    if (/^[0-9a-f]{7,}$/.test(t) && /\d/.test(t) && /[a-f]/.test(t)) return false; // git/hash-like suffix
    if (NOISE.has(t)) return false;
    return true;
  });
  return toks.length ? toks.join(' ') : s;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

function suggestName(members) {
  const strip = (n) => { let p = n; for (let i = 0; i < 6; i++) { const q = p.replace(/[\s._-]*(\(\d+\)|copy|final|new|old|backup|bak|latest|clone|v\d+(\.\d+)*|\d+|[0-9a-f]{7,})$/i, ''); if (q === p || !q) break; p = q; } return p; };
  const shortest = [...members].sort((a, b) => a.length - b.length)[0];
  return strip(shortest) || shortest;
}

/** Cluster names that look like variants of one project. Returns [{key, members:[...], suggestedName}] for clusters of 2+. */
function clusterNames(names) {
  const keys = names.map(normalizeName);
  const parent = names.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { parent[find(a)] = find(b); };
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const a = keys[i], b = keys[j];
    if (a === b) { union(i, j); continue; }
    const [s, l] = a.length <= b.length ? [a, b] : [b, a];
    if (s.length >= 5 && (l.startsWith(s + ' ') || l.startsWith(s) && l.length - s.length <= 3)) { union(i, j); continue; }
    if (s.length >= 6 && l.length - s.length <= 2 && s[0] === l[0] && levenshtein(a, b) <= Math.max(1, Math.floor(s.length / 7))) union(i, j);
  }
  const by = new Map();
  names.forEach((n, i) => { const r = find(i); (by.get(r) || by.set(r, []).get(r)).push(n); });
  return [...by.values()].filter((m) => m.length > 1).map((m) => ({ key: normalizeName(m[0]) + '|' + m.map((x) => x.toLowerCase()).sort().join(','), members: m.sort((x, y) => x.localeCompare(y)), suggestedName: suggestName(m) }))
    .sort((a, b) => b.members.length - a.members.length);
}

const validName = (n) => typeof n === 'string' && n.trim() && n.trim().length <= 100 && !/[\\/:*?"<>|]/.test(n) && !/^\.+$/.test(n.trim()) && !/[. ]$/.test(n.trim()) &&
  !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n.trim());

function createGroupsService(app) {
  const st = { running: false, progress: 0, total: 0, rootKind: 'company', root: '', entries: [], suggestions: [], scannedAt: 0, error: null };
  const stateFile = path.join(app.dataDir, 'groups.json');
  const lastFile = path.join(app.dataDir, 'regroup-last.json');
  const limiter = new Limiter(12);
  const fsops = () => new FsOps({ guard: app.guard, dataDir: app.dataDir, sandbox: app.sandbox });
  const rootFor = (kind) => { const c = norm(app.settings.companyFolder); return kind === 'files' ? path.join(c, 'Files') : c; };

  const dismissed = () => new Set((readJson(stateFile, { dismissed: [] }).dismissed) || []);
  function dismiss(k) { const s = dismissed(); s.add(k); writeJsonAtomic(stateFile, { dismissed: [...s] }); computeSuggestions(); }
  function computeSuggestions() {
    const dis = dismissed();
    const candidates = st.entries.filter((e) => !e.isGroup).map((e) => e.name);
    st.suggestions = clusterNames(candidates).filter((c) => !dis.has(c.key));
  }

  async function scan(kind = 'company') {
    if (st.running) return false;
    const root = rootFor(kind);
    Object.assign(st, { running: true, rootKind: kind, root, entries: [], suggestions: [], progress: 0, total: 0, error: null });
    app.broadcast({ type: 'groups', state: view() });
    (async () => {
      if (!fs.existsSync(root)) throw new Error(`Folder not found: ${root}`);
      const list = await readDirents(root);
      const cls = (await classify(root, list, limiter)).filter((e) => e.isDir && !(kind === 'company' && e.name.toLowerCase() === 'files')); // Files = loose company files, not a project
      st.total = cls.length;
      const entries = [];
      await Promise.all(cls.map(async (e) => {
        const p = path.join(root, e.name);
        const w = await walkTree(p, {});
        let names = []; try { names = fs.readdirSync(p); } catch { /* unreadable */ }
        const isGroup = names.includes(MARKER);
        const hasGit = names.includes('.git');
        entries.push({ name: e.name, path: p, size: w.bytes, files: w.files, mtime: w.maxMtime, isGroup, isProject: isProjectRoot(names),
          git: hasGit ? { remote: parseGitConfigRemote(p), branch: parseHeadBranch(p) } : null,
          children: isGroup ? names.filter((n) => { try { return fs.statSync(path.join(p, n)).isDirectory(); } catch { return false; } }).length : 0 });
        st.progress++;
        if (st.progress % 5 === 0) app.broadcast({ type: 'groups', state: view() });
      }));
      entries.sort((a, b) => a.name.localeCompare(b.name));
      // identical-looking folders (same file count + total size)
      const sig = new Map();
      for (const e of entries) if (e.files > 0 && !e.isGroup) (sig.get(`${e.files}:${e.size}`) || sig.set(`${e.files}:${e.size}`, []).get(`${e.files}:${e.size}`)).push(e.name);
      for (const e of entries) { const g = sig.get(`${e.files}:${e.size}`); e.identicalTo = g && g.length > 1 ? g.filter((n) => n !== e.name) : []; }
      st.entries = entries; st.scannedAt = Date.now();
      computeSuggestions();
    })().catch((e) => { st.error = String(e.message || e); }).finally(() => { st.running = false; app.broadcast({ type: 'groups', state: view() }); });
    return true;
  }

  const view = () => ({ running: st.running, progress: st.progress, total: st.total, rootKind: st.rootKind, root: st.root, entries: st.entries, suggestions: st.suggestions, scannedAt: st.scannedAt, error: st.error,
    canUndo: fs.existsSync(lastFile) && !!(readJson(lastFile, {}).moves || []).some((m) => m.done) });

  /** Validate + describe what would happen. groups: [{name, members:[folderName]}] */
  function plan(groups) {
    const root = st.root; const errors = []; const ops = [];
    if (!root) return { errors: ['Scan the folder first.'], ops };
    const byName = new Map(st.entries.map((e) => [e.name.toLowerCase(), e]));
    const used = new Map();
    for (const g of groups || []) {
      const gname = String(g.name || '').trim();
      if (!validName(gname)) { errors.push(`Invalid group name: "${g.name}"`); continue; }
      if (st.rootKind === 'company' && gname.toLowerCase() === 'files') { errors.push('"Files" is reserved for loose company files.'); continue; }
      const members = [...new Set(g.members || [])];
      if (!members.length) { errors.push(`Group "${gname}" has no members.`); continue; }
      const gdir = path.join(root, gname);
      const existing = byName.get(gname.toLowerCase());
      const selfMember = members.find((m) => m.toLowerCase() === gname.toLowerCase());
      if (existing && !existing.isGroup && !selfMember) { errors.push(`A folder named "${gname}" already exists and is not part of this group.`); continue; }
      if (existing && existing.isGroup && selfMember) { errors.push(`"${gname}" is already a group.`); continue; }
      for (const m of members) {
        const e = byName.get(m.toLowerCase());
        if (!e) { errors.push(`Folder not found: ${m}`); continue; }
        if (e.isGroup) { errors.push(`${m} is already a group; groups are not nested.`); continue; }
        if (used.has(e.name)) { errors.push(`${m} is in two groups (${used.get(e.name)} and ${gname}).`); continue; }
        used.set(e.name, gname);
        const to = path.join(gdir, e.name);
        if (!selfMember && fs.existsSync(to)) { errors.push(`${to} already exists.`); continue; }
        ops.push({ group: gname, groupPath: gdir, name: e.name, from: e.path, to, size: e.size, selfName: !!selfMember && e.name.toLowerCase() === gname.toLowerCase(), newGroup: !existing || !!selfMember });
      }
    }
    return { errors, ops };
  }

  function apply(groups) {
    const p = plan(groups);
    if (p.errors.length) throw new Error(p.errors.join(' | '));
    const f = fsops(); const root = st.root; const log = { at: Date.now(), root, rootKind: st.rootKind, moves: [], groups: [] };
    const inRoot = (x) => { if (!isInside(x, root)) throw new Error(`Outside the company folder: ${x}`); };
    const byGroup = new Map();
    for (const op of p.ops) (byGroup.get(op.group) || byGroup.set(op.group, []).get(op.group)).push(op);
    for (const [gname, ops] of byGroup) {
      const gdir = path.join(root, gname);
      const rec = { name: gname, path: gdir, created: false, self: null };
      log.groups.push(rec);
      try {
        const self = ops.find((o) => o.selfName);
        if (self) { // group name == one member's name: park that member, build the group, move it in
          const tmp = path.join(root, `${gname}.__regroup_tmp`);
          inRoot(tmp); fs.renameSync(self.from, tmp); self.parked = tmp; rec.self = { tmp, name: self.name };
        }
        if (!fs.existsSync(gdir)) { inRoot(gdir); app.guard.assertWritable(gdir); fs.mkdirSync(gdir); rec.created = true; }
        fs.writeFileSync(path.join(gdir, MARKER), JSON.stringify({ createdAt: new Date().toISOString(), by: 'Laptop Handover Tool' }));
        for (const op of ops) {
          const m = { from: op.from, to: op.to, done: false, error: null };
          log.moves.push(m);
          try {
            inRoot(op.from); inRoot(op.to);
            if (op.parked) { app.guard.assertWritable(op.to); fs.renameSync(op.parked, op.to); }
            else { fs.mkdirSync(path.dirname(op.to), { recursive: true }); app.guard.assertWritable(op.from); app.guard.assertWritable(op.to); fs.renameSync(op.from, op.to); }
            m.done = true;
          } catch (e) { m.error = String(e.message || e); if (op.parked && fs.existsSync(op.parked) && !fs.existsSync(op.from)) { try { fs.renameSync(op.parked, op.from); } catch { /* leave parked */ } } }
        }
      } catch (e) { log.moves.push({ from: gname, to: gname, done: false, error: `Group "${gname}": ${String(e.message || e)}` }); }
    }
    writeJsonAtomic(lastFile, log);
    void f;
    return log;
  }

  function undo() {
    const log = readJson(lastFile, null);
    if (!log) throw new Error('Nothing to undo.');
    const root = log.root; const errors = [];
    const inRoot = (x) => { if (!isInside(x, root)) throw new Error(`Outside the company folder: ${x}`); };
    for (const g of [...log.groups].reverse()) {
      try {
        const mine = log.moves.filter((m) => m.done && path.dirname(m.to) === g.path).reverse();
        let dir = g.path;
        if (g.self && fs.existsSync(g.path)) { // group dir shares its name with a member: step the group aside first
          dir = `${g.path}.__undo_tmp`; inRoot(dir); app.guard.assertWritable(dir); fs.renameSync(g.path, dir);
        }
        for (const m of mine) {
          inRoot(m.from); app.guard.assertWritable(m.from);
          const cur = path.join(dir, path.basename(m.to));
          if (fs.existsSync(cur) && !fs.existsSync(m.from)) fs.renameSync(cur, m.from); else errors.push(`Could not move back ${m.to}`);
        }
        try { fs.unlinkSync(path.join(dir, MARKER)); } catch { /* already gone */ }
        try { if (g.created || g.self) fs.rmdirSync(dir); } catch { errors.push(`Group folder ${dir} is not empty; left in place.`); }
      } catch (e) { errors.push(String(e.message || e)); }
    }
    try { fs.unlinkSync(lastFile); } catch { /* none */ }
    return { errors };
  }

  return { scan, view, plan, apply, undo, dismiss, rootFor };
}

module.exports = { createGroupsService, normalizeName, clusterNames, suggestName, MARKER };
