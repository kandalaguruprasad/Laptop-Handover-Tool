'use strict';
// In-memory item store. Scan results are NDJSON on disk; tags are a path->tag JSON map
// so they survive re-scans. Zero native dependencies.
const fs = require('fs');
const path = require('path');
const { key, isInsideOrSame } = require('./platform');
const { extOf, categoryOf, TABS } = require('./categories');
const { suggestFor } = require('./suggest');
const { writeJsonAtomic, readJson } = require('./jsonfile');

const CLOUD_RE = /[\\/](onedrive[^\\/]*|dropbox[^\\/]*|google drive|googledrive|icloud[^\\/]*|box)([\\/]|$)/i;
const TAGS = ['company', 'mine', 'ignore'];

class DB {
  constructor(dir) {
    this.dir = dir;
    this.scanFile = path.join(dir, 'scan.ndjson');
    this.tagFile = path.join(dir, 'tags.json');
    this.items = [];
    this.byPath = new Map();
    this.tags = readJson(this.tagFile, {});
    this.meta = null;
    this.version = 0;
    this.cache = [];
    this.folderSizes = null;
    this.dupes = null;
    this._saveTimer = null;
  }

  // ---------- load / save ----------
  load() {
    if (!fs.existsSync(this.scanFile)) return false;
    const lines = fs.readFileSync(this.scanFile, 'utf8').split('\n');
    const items = [];
    let meta = null;
    for (const line of lines) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r[0] === 'meta') meta = r[1];
      else items.push(r);
    }
    this._ingest(items);
    this.meta = meta;
    return true;
  }

  _ingest(rows) {
    this.items = []; this.byPath = new Map(); this.dupes = null; this.folderSizes = null;
    for (const r of rows) this._add(r);
    for (const it of this.items) { const t = this.tags[it.p]; it.tag = TAGS.includes(t) ? t : null; }
    this.bump();
  }

  _add(r) {
    const id = this.items.length;
    let it;
    if (r[0] === 'f') {
      const p = r[1];
      const n = path.basename(p);
      const e = extOf(n);
      it = { id, kind: 'f', p, n, e, s: r[2], m: r[3], c: categoryOf(e), d: path.dirname(p), tag: null, sug: null };
    } else {
      const o = r[1];
      it = { id, kind: 'p', p: o.p, n: path.basename(o.p), e: '', s: o.s, m: o.m, c: 'projects', d: path.dirname(o.p),
        tag: null, sug: null, fc: o.fc, stack: o.stack, regen: o.regen || [], hasGit: !!o.hasGit, git: o.git || null };
    }
    it.cloud = CLOUD_RE.test(it.p);
    this.items.push(it);
    this.byPath.set(key(it.p), id);
  }

  /** Replace scan contents. rows = ['f',path,size,mtime] | ['p',{...}] */
  replaceScan(rows, meta) {
    this._ingest(rows);
    this.meta = meta;
    const out = [JSON.stringify(['meta', meta])];
    for (const it of this.items) {
      out.push(JSON.stringify(it.kind === 'f' ? ['f', it.p, it.s, it.m] : ['p', {
        p: it.p, s: it.s, m: it.m, fc: it.fc, stack: it.stack, regen: it.regen, hasGit: it.hasGit, git: it.git }]));
    }
    const tmp = this.scanFile + '.tmp';
    fs.writeFileSync(tmp, out.join('\n') + '\n');
    fs.renameSync(tmp, this.scanFile);
    // keep tags only for paths that still exist
    const next = {};
    for (const it of this.items) if (it.tag) next[it.p] = it.tag;
    this.tags = next;
    this.saveTagsNow();
  }

  /** Drop items by path (after a run moved/deleted them) and persist; ids are re-assigned. */
  removePaths(paths) {
    const keys = new Set([...paths].map((p) => key(p)));
    const rows = [];
    for (const it of this.items) {
      if (keys.has(key(it.p))) { delete this.tags[it.p]; continue; }
      rows.push(it.kind === 'f' ? ['f', it.p, it.s, it.m] : ['p', { p: it.p, s: it.s, m: it.m, fc: it.fc, stack: it.stack, regen: it.regen, hasGit: it.hasGit, git: it.git }]);
    }
    this._ingest(rows);
    const out = [JSON.stringify(['meta', this.meta])].concat(rows.map((r) => JSON.stringify(r)));
    fs.writeFileSync(this.scanFile + '.tmp', out.join('\n') + '\n');
    fs.renameSync(this.scanFile + '.tmp', this.scanFile);
    this.saveTagsNow();
  }

  saveTagsSoon() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; try { this.saveTagsNow(); } catch (e) { console.error('tag save failed', e.message); } }, 400);
  }
  saveTagsNow() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    writeJsonAtomic(this.tagFile, this.tags);
  }

  bump() { this.version++; this.cache = []; }

  recomputeSuggestions(settings) {
    const now = Date.now();
    for (const it of this.items) it.sug = suggestFor(it, settings, now);
    this.bump();
  }

  // ---------- tagging ----------
  setTag(it, tag) {
    it.tag = tag || null;
    if (tag) this.tags[it.p] = tag; else delete this.tags[it.p];
  }
  applyTag(ids, tag) {
    let n = 0;
    for (const id of ids) { const it = this.items[id]; if (it) { this.setTag(it, tag); n++; } }
    this.bump(); this.saveTagsSoon();
    return n;
  }
  /** Tag everything at or under a folder (files and projects). */
  tagFolder(folder, tag) {
    let n = 0;
    for (const it of this.items) if (isInsideOrSame(it.p, folder)) { this.setTag(it, tag); n++; }
    this.bump(); this.saveTagsSoon();
    return n;
  }
  acceptSuggestions(tab) {
    let n = 0;
    for (const it of this.items) {
      if (!it.tag && it.sug && (!tab || tab === 'all' || it.c === tab)) { this.setTag(it, it.sug); n++; }
    }
    this.bump(); this.saveTagsSoon();
    return n;
  }

  // ---------- querying ----------
  _match(it, f) {
    if (f.tab && f.tab !== 'all' && it.c !== f.tab) return false;
    if (f.tag) {
      if (f.tag === 'undecided') { if (it.tag) return false; }
      else if (f.tag === 'suggested') { if (it.tag || !it.sug) return false; }
      else if (it.tag !== f.tag) return false;
    }
    if (f.minSize != null && it.s < f.minSize) return false;
    if (f.maxSize != null && it.s > f.maxSize) return false;
    if (f.from != null && it.m < f.from) return false;
    if (f.to != null && it.m > f.to) return false;
    if (f.ext && it.e !== f.ext) return false;
    if (f.q) {
      const hay = f._ql ? it.p.toLowerCase() : it.p;
      if (!hay.includes(f._q)) return false;
    }
    return true;
  }

  _run(f) {
    const ck = JSON.stringify(f);
    const hit = this.cache.find((c) => c.ck === ck);
    if (hit) return hit;
    const ff = { ...f };
    if (ff.q) { ff._q = String(ff.q).toLowerCase(); ff._ql = true; }
    if (ff.ext) ff.ext = String(ff.ext).replace(/^\./, '').toLowerCase();
    let ids = [];
    let bytes = 0;
    for (const it of this.items) if (this._match(it, ff)) { ids.push(it.id); bytes += it.s; }
    const dir = f.dir === 'desc' ? -1 : 1;
    const sort = f.sort || 'path';
    const I = this.items;
    const cmp = {
      name: (a, b) => I[a].n.localeCompare(I[b].n),
      size: (a, b) => I[a].s - I[b].s,
      date: (a, b) => I[a].m - I[b].m,
      path: (a, b) => (I[a].p < I[b].p ? -1 : I[a].p > I[b].p ? 1 : 0),
    }[sort] || ((a, b) => 0);
    let rows = ids;
    let groups = null;
    if (f.group) {
      ids.sort((a, b) => (I[a].d < I[b].d ? -1 : I[a].d > I[b].d ? 1 : cmp(a, b) * dir));
      rows = []; groups = [];
      let cur = null;
      for (const id of ids) {
        const it = I[id];
        if (!cur || cur.folder !== it.d) {
          cur = { folder: it.d, count: 0, bytes: 0, tags: { company: 0, mine: 0, ignore: 0, none: 0 } };
          groups.push(cur); rows.push(-groups.length);
        }
        cur.count++; cur.bytes += it.s; cur.tags[it.tag || 'none']++;
        rows.push(id);
      }
    } else ids.sort((a, b) => cmp(a, b) * dir);
    const res = { ck, rows, groups, count: ids.length, bytes, ids };
    this.cache.unshift(res); this.cache.length = Math.min(this.cache.length, 4);
    return res;
  }

  itemView(it) {
    const o = { id: it.id, kind: it.kind, p: it.p, n: it.n, e: it.e, s: it.s, m: it.m, c: it.c, d: it.d, tag: it.tag, sug: it.sug, cloud: it.cloud };
    if (it.kind === 'p') { o.stack = it.stack; o.git = it.git; o.fc = it.fc; }
    return o;
  }

  page(f, offset, limit) {
    const r = this._run(f);
    const out = [];
    for (let i = offset; i < Math.min(r.rows.length, offset + limit); i++) {
      const v = r.rows[i];
      if (v >= 0) out.push(this.itemView(this.items[v]));
      else out.push({ t: 'g', ...r.groups[-v - 1] });
    }
    return { total: r.rows.length, count: r.count, bytes: r.bytes, rows: out, version: this.version };
  }

  /** Item ids for row indexes [from,to] (headers skipped). Whole filter if from/to omitted. */
  idsRange(f, from, to) {
    const r = this._run(f);
    if (from == null) return r.ids.slice();
    const out = [];
    for (let i = Math.max(0, from); i <= Math.min(r.rows.length - 1, to); i++) if (r.rows[i] >= 0) out.push(r.rows[i]);
    return out;
  }

  // ---------- summaries ----------
  summary() {
    const by = { company: { n: 0, bytes: 0 }, mine: { n: 0, bytes: 0 }, ignore: { n: 0, bytes: 0 }, undecided: { n: 0, bytes: 0 } };
    const tabs = {};
    for (const t of [...TABS, 'all']) tabs[t] = { n: 0, bytes: 0, undecided: 0, suggested: 0 };
    for (const it of this.items) {
      const b = by[it.tag || 'undecided']; b.n++; b.bytes += it.s;
      for (const t of [it.c, 'all']) {
        const x = tabs[t]; x.n++; x.bytes += it.s;
        if (!it.tag) { x.undecided++; if (it.sug) x.suggested++; }
      }
    }
    return { by, tabs, scanned: !!this.meta, meta: this.meta };
  }

  storage() {
    if (!this.folderSizes) {
      const map = new Map();
      const rootKeys = ((this.meta && this.meta.roots) || []).map((r) => key(r));
      for (const it of this.items) {
        let d = it.d;
        for (let guard = 0; guard < 40; guard++) {
          const k = key(d);
          map.set(k, { p: d, s: ((map.get(k) || {}).s || 0) + it.s });
          if (rootKeys.includes(k)) break;
          const up = path.dirname(d);
          if (up === d) break;
          d = up;
        }
      }
      const list = [...map.values()].filter((x) => !rootKeys.includes(key(x.p))).sort((a, b) => b.s - a.s).slice(0, 100);
      this.folderSizes = list;
    }
    const cats = {};
    for (const it of this.items) { const c = cats[it.c] || (cats[it.c] = { n: 0, bytes: 0 }); c.n++; c.bytes += it.s; }
    return { categories: cats, largest: this.folderSizes };
  }
}

module.exports = { DB, TAGS };
