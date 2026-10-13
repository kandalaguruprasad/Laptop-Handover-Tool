import { memo, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { api, thumbUrl } from '../api';
import { isGroup } from '../types';
import type { AppState, Filter, Item, Row, GroupRow } from '../types';
import { fmtBytes, fmtDate, TAB_ICON, TAB_LABEL, TAG_CLASS, TAG_LABEL } from '../util';
import { Dupes } from '../components/Dupes';

const PAGE = 200;
const ROW_H = 46;
const TABS = ['projects', 'images', 'videos', 'documents', 'audio', 'archives', 'installers', 'other', 'all'];
const DEFAULT: Filter = { tab: 'projects', q: '', tag: '', minSize: '', maxSize: '', from: '', to: '', ext: '', group: false, sort: 'path', dir: 'asc' };

function filterBody(f: Filter) {
  const o: Record<string, unknown> = { tab: f.tab, sort: f.sort, dir: f.dir };
  if (f.q) o.q = f.q;
  if (f.tag) o.tag = f.tag;
  if (f.ext) o.ext = f.ext;
  if (f.group) o.group = true;
  if (f.minSize) o.minSize = Number(f.minSize) * 1048576;
  if (f.maxSize) o.maxSize = Number(f.maxSize) * 1048576;
  if (f.from) o.from = new Date(f.from).getTime();
  if (f.to) o.to = new Date(f.to).getTime() + 86400000 - 1;
  return o;
}

function Chip({ tag, sug, onAccept }: { tag: string | null; sug: string | null; onAccept?: () => void }) {
  if (tag) return <span className={`rounded border px-1.5 py-0.5 text-xs ${TAG_CLASS[tag]}`}>{TAG_LABEL[tag]}</span>;
  if (sug) return (
    <button title="Click to accept suggestion" onClick={(e) => { e.stopPropagation(); onAccept?.(); }}
      className={`rounded border border-dashed px-1.5 py-0.5 text-xs opacity-80 hover:opacity-100 ${TAG_CLASS[sug]}`}>→ {TAG_LABEL[sug]}</button>
  );
  return <span className="text-xs text-zinc-600">—</span>;
}

const ItemRow = memo(function ItemRow(p: { it: Item; selected: boolean; onClick: (e: React.MouseEvent) => void; onAccept: () => void }) {
  const { it } = p;
  const g = it.git;
  return (
    <div onClick={p.onClick} className={`flex h-full cursor-default items-center gap-3 border-b border-zinc-900 px-3 ${p.selected ? 'bg-sky-900/30' : 'hover:bg-zinc-900'}`}>
      <input type="checkbox" checked={p.selected} readOnly className="pointer-events-none" />
      <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded bg-zinc-800 text-base">
        {it.c === 'images' ? <img src={thumbUrl(it.id)} loading="lazy" alt="" className="h-full w-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} /> : TAB_ICON[it.c] || '📎'}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{it.n}</span>
          {it.kind === 'p' && it.stack && <span className="rounded bg-zinc-800 px-1.5 text-xs text-zinc-300">{it.stack}</span>}
          {it.kind === 'p' && g?.branch && <span className="rounded bg-zinc-800 px-1.5 text-xs text-zinc-400">⎇ {g.branch}</span>}
          {it.kind === 'p' && !!g?.dirty && <span className="rounded bg-amber-500/20 px-1.5 text-xs text-amber-300" title="Uncommitted changes">⚠ {g.dirty} dirty</span>}
          {it.kind === 'p' && !!g?.unpushed && <span className="rounded bg-amber-500/20 px-1.5 text-xs text-amber-300" title="Commits not on any remote">⚠ {g.unpushed} unpushed</span>}
          {it.kind === 'p' && g && g.remote === null && <span className="text-xs text-zinc-600">no remote</span>}
          {it.cloud && <span title="Cloud-synced folder: moving/deleting may sync to the cloud" className="text-xs">☁️</span>}
        </div>
        <div className="truncate text-xs text-zinc-500" title={it.p}>{it.kind === 'p' && g?.remote ? `${g.remote} · ` : ''}{it.p}</div>
      </div>
      <div className="w-20 shrink-0 text-right text-xs text-zinc-300">{fmtBytes(it.s)}</div>
      <div className="w-24 shrink-0 text-right text-xs text-zinc-500">{fmtDate(it.m)}</div>
      <div className="w-24 shrink-0 text-center"><Chip tag={it.tag} sug={it.sug} onAccept={p.onAccept} /></div>
    </div>
  );
});

function GroupHeader({ g, onTag }: { g: GroupRow; onTag: (tag: string | null) => void }) {
  return (
    <div className="flex h-full items-center gap-3 border-b border-zinc-800 bg-zinc-900 px-3 text-xs">
      <span>📂</span>
      <span className="min-w-0 flex-1 truncate font-medium text-zinc-200" title={g.folder}>{g.folder}</span>
      <span className="text-zinc-500">{g.count} files · {fmtBytes(g.bytes)}</span>
      <span className="text-zinc-500">
        {g.tags.company > 0 && <span className="mr-1 text-sky-300">C{g.tags.company}</span>}
        {g.tags.mine > 0 && <span className="mr-1 text-green-300">M{g.tags.mine}</span>}
        {g.tags.ignore > 0 && <span className="mr-1 text-red-300">I{g.tags.ignore}</span>}
        {g.tags.none > 0 && <span className="text-amber-300">?{g.tags.none}</span>}
      </span>
      <span className="flex gap-1">
        {(['company', 'mine', 'ignore'] as const).map((t) => <button key={t} title={`Tag only the ${g.count} items listed in this group as ${TAG_LABEL[t]}`} className={`rounded border px-1.5 py-0.5 ${TAG_CLASS[t]}`} onClick={() => onTag(t)}>{TAG_LABEL[t]}</button>)}
        <button title={`Clear the tag on the ${g.count} items listed in this group`} className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-400" onClick={() => onTag(null)}>Clear</button>
      </span>
    </div>
  );
}

export function Review({ state, version }: { state: AppState; version: number }) {
  const [f, setF] = useState<Filter>(DEFAULT);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [meta, setMeta] = useState({ count: 0, bytes: 0 });
  const [banner, setBanner] = useState('');
  const [dupes, setDupes] = useState(false);
  const [, force] = useReducer((x: number) => x + 1, 0);
  const pages = useRef(new Map<number, Row[]>());
  const loading = useRef(new Set<number>());
  const gen = useRef(0);
  const parent = useRef<HTMLDivElement>(null);
  const fRef = useRef(f); fRef.current = f;

  const qs = useCallback((offset: number) => {
    const o = filterBody(fRef.current);
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) p.set(k, String(v));
    p.set('offset', String(offset)); p.set('limit', String(PAGE));
    return p.toString();
  }, []);

  const loadPage = useCallback((pg: number, replace = false) => {
    if (loading.current.has(pg) || (!replace && pages.current.has(pg))) return;
    loading.current.add(pg);
    const g = gen.current;
    api<{ total: number; count: number; bytes: number; rows: Row[] }>(`/api/items?${qs(pg * PAGE)}`).then((r) => {
      loading.current.delete(pg);
      if (g !== gen.current) return;
      pages.current.set(pg, r.rows);
      setTotal(r.total); setMeta({ count: r.count, bytes: r.bytes });
      force();
    }).catch(() => loading.current.delete(pg));
  }, [qs]);

  const rv = useVirtualizer({ count: total, getScrollElement: () => parent.current, estimateSize: () => ROW_H, overscan: 12 });
  const vis = rv.getVirtualItems();
  const first = vis.length ? vis[0].index : 0;
  const last = vis.length ? vis[vis.length - 1].index : 0;

  // filter changed → reset; data changed (version) → refresh in place without flicker
  useEffect(() => {
    gen.current++; pages.current.clear(); loading.current.clear(); setTotal(0); setSel(new Set()); setAnchor(null);
    loadPage(0);
    parent.current?.scrollTo({ top: 0 });
  }, [f, loadPage]);
  useEffect(() => {
    if (version === 0) return;
    gen.current++; loading.current.clear();
    const keep = new Set<number>();
    for (let i = Math.floor(first / PAGE); i <= Math.floor(last / PAGE); i++) keep.add(i);
    for (const k of [...pages.current.keys()]) if (!keep.has(k)) pages.current.delete(k);
    keep.forEach((pg) => loadPage(pg, true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  useEffect(() => {
    if (!total) return;
    for (let i = Math.floor(first / PAGE); i <= Math.floor(last / PAGE); i++) loadPage(i);
  }, [first, last, total, loadPage]);

  const rowAt = (i: number): Row | undefined => pages.current.get(Math.floor(i / PAGE))?.[i % PAGE];

  const fetchIds = async (from?: number, to?: number) => (await api<{ ids: number[] }>('/api/ids', { body: { filter: filterBody(fRef.current), from, to } })).ids;

  const click = async (i: number, it: Item, e: React.MouseEvent) => {
    if (e.shiftKey && anchor !== null) {
      const ids = await fetchIds(Math.min(anchor, i), Math.max(anchor, i));
      setSel((s) => new Set([...s, ...ids]));
    } else {
      setSel((s) => { const n = new Set(s); if (n.has(it.id)) n.delete(it.id); else n.add(it.id); return n; });
      setAnchor(i);
    }
  };

  const applyTag = useCallback(async (tag: string | null, body?: Record<string, unknown>) => {
    const payload = body || { ids: [...sel] };
    if (!body && !sel.size) return;
    const r = await api<{ changed: number; cloud: number }>('/api/tag', { body: { ...payload, tag } });
    setBanner(r.cloud ? `☁️ ${r.cloud} of those items sit in a cloud-synced folder (OneDrive/Dropbox…). Moving or deleting them may trigger downloads or delete them in the cloud too.` : '');
    setSel(new Set());
  }, [sel]);

  const undo = useCallback(() => api('/api/tag/undo', { body: {} }).then(() => setSel(new Set())).catch(() => {}), []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key === 'a') { e.preventDefault(); fetchIds().then((ids) => setSel(new Set(ids))); }
      else if (e.key === 'Escape') setSel(new Set());
      else if (sel.size && !e.ctrlKey && !e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === 'c') applyTag('company'); else if (k === 'm') applyTag('mine'); else if (k === 'i') applyTag('ignore'); else if (k === 'x' || k === 'delete') applyTag(null);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [sel, applyTag, undo]);

  const set = (patch: Partial<Filter>) => setF((p) => ({ ...p, ...patch }));
  const tabs = state.summary.tabs;
  const selBytes = '';
  void selBytes;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-zinc-800 px-3 pt-2">
        {TABS.map((t) => (
          <button key={t} onClick={() => set({ tab: t })}
            className={`rounded-t px-3 py-1.5 text-sm ${f.tab === t ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-900'}`}>
            {TAB_LABEL[t]} <span className="text-xs text-zinc-500">{(tabs[t]?.n ?? 0).toLocaleString()} · {fmtBytes(tabs[t]?.bytes ?? 0)}</span>
            {(tabs[t]?.undecided ?? 0) > 0 && <span className="ml-1 text-xs text-amber-400">?{tabs[t].undecided}</span>}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs">
        <input className="input w-56" placeholder="Search name or path…" value={f.q} onChange={(e) => set({ q: e.target.value })} />
        <select className="input" value={f.tag} onChange={(e) => set({ tag: e.target.value })}>
          <option value="">Any tag</option><option value="undecided">Undecided</option><option value="suggested">Has suggestion</option>
          <option value="company">Company</option><option value="mine">Mine</option><option value="ignore">Ignore</option>
        </select>
        <input className="input w-20" placeholder="min MB" value={f.minSize} onChange={(e) => set({ minSize: e.target.value })} />
        <input className="input w-20" placeholder="max MB" value={f.maxSize} onChange={(e) => set({ maxSize: e.target.value })} />
        <input type="date" className="input" title="Modified after" value={f.from} onChange={(e) => set({ from: e.target.value })} />
        <input type="date" className="input" title="Modified before" value={f.to} onChange={(e) => set({ to: e.target.value })} />
        <input className="input w-16" placeholder="ext" value={f.ext} onChange={(e) => set({ ext: e.target.value })} />
        <select className="input" value={f.sort + ':' + f.dir} onChange={(e) => { const [sort, dir] = e.target.value.split(':'); set({ sort, dir: dir as 'asc' | 'desc' }); }}>
          <option value="path:asc">Path A→Z</option><option value="name:asc">Name A→Z</option><option value="size:desc">Largest first</option>
          <option value="size:asc">Smallest first</option><option value="date:desc">Newest first</option><option value="date:asc">Oldest first</option>
        </select>
        <label className="flex items-center gap-1"><input type="checkbox" checked={f.group} onChange={(e) => set({ group: e.target.checked })} /> Group by folder</label>
        <div className="ml-auto flex items-center gap-2">
          <button className="btn" disabled={!state.summary.undo} title={state.summary.undo ? `Undo: ${state.summary.undo.label}` : 'Nothing to undo'} onClick={undo}>
            ↶ Undo{state.summary.undo ? ` (${state.summary.undo.label})` : ''}
          </button>
          <button className="btn" onClick={() => { if (confirm('Remove ALL Company / Mine / Ignore tags from every item? (Your scan stays; no files are touched. You can still Undo this.)')) api('/api/reset', { body: { what: 'tags' } }).then(() => setSel(new Set())); }}>Reset all tags…</button>
          <button className="btn" onClick={() => setDupes(true)}>Duplicates…</button>
          <button className="btn" disabled={!(tabs[f.tab]?.suggested)} onClick={() => api('/api/suggestions/accept', { body: { tab: f.tab } })}>
            Accept suggestions here ({tabs[f.tab]?.suggested ?? 0})
          </button>
          <button className="btn" disabled={!(tabs.all?.suggested)} onClick={() => api('/api/suggestions/accept', { body: {} })}>Accept all ({tabs.all?.suggested ?? 0})</button>
        </div>
      </div>

      {banner && <div className="flex items-center justify-between bg-amber-500/10 px-3 py-1.5 text-xs text-amber-300">{banner}<button className="ml-3 underline" onClick={() => setBanner('')}>dismiss</button></div>}

      <div className="flex items-center gap-3 border-b border-zinc-800 px-3 py-1 text-xs text-zinc-500">
        <button className="underline" onClick={() => fetchIds().then((ids) => setSel(new Set(ids)))}>Select all in filter ({meta.count.toLocaleString()})</button>
        {sel.size > 0 && <button className="underline" onClick={() => setSel(new Set())}>Clear selection</button>}
        <span>{meta.count.toLocaleString()} items · {fmtBytes(meta.bytes)} · click rows to select, shift-click for range · keys: C / M / I tag, X clear, Ctrl+A all, Esc deselect, Ctrl+Z undo</span>
      </div>

      <div ref={parent} className="min-h-0 flex-1 overflow-auto">
        <div style={{ height: rv.getTotalSize(), position: 'relative' }}>
          {vis.map((v) => {
            const r = rowAt(v.index);
            return (
              <div key={v.key} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: ROW_H, transform: `translateY(${v.start}px)` }}>
                {!r ? <div className="h-full animate-pulse border-b border-zinc-900" /> : isGroup(r)
                  ? <GroupHeader g={r} onTag={(t) => applyTag(t, { group: r.folder, filter: filterBody(fRef.current) })} />
                  : <ItemRow it={r} selected={sel.has(r.id)} onClick={(e) => click(v.index, r, e)} onAccept={() => applyTag(r.sug, { ids: [r.id] })} />}
              </div>
            );
          })}
        </div>
        {!total && <div className="p-8 text-center text-zinc-500">{state.summary.scanned ? 'Nothing matches these filters.' : 'Run a scan from the Storage screen first.'}</div>}
      </div>

      {sel.size > 0 && (
        <div className="sticky bottom-0 flex items-center gap-3 border-t border-zinc-700 bg-zinc-900 px-4 py-2 shadow-lg">
          <span className="text-sm font-medium">{sel.size.toLocaleString()} selected</span>
          <button className="btn border-sky-600 text-sky-300" onClick={() => applyTag('company')}>Company <kbd className="text-xs opacity-60">C</kbd></button>
          <button className="btn border-green-600 text-green-300" onClick={() => applyTag('mine')}>Mine <kbd className="text-xs opacity-60">M</kbd></button>
          <button className="btn border-red-600 text-red-300" onClick={() => applyTag('ignore')}>Ignore <kbd className="text-xs opacity-60">I</kbd></button>
          <button className="btn" onClick={() => applyTag(null)}>Clear tag <kbd className="text-xs opacity-60">X</kbd></button>
          <button className="btn ml-auto" onClick={() => setSel(new Set())}>Deselect</button>
        </div>
      )}
      {dupes && <Dupes onClose={() => setDupes(false)} />}
    </div>
  );
}
