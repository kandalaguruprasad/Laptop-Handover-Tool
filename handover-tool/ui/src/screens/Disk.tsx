import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, useEvents } from '../api';
import type { AppState } from '../types';
import { Donut, topSlices } from '../components/Donut';
import { fmtBytes, fmtDate, fmtDur } from '../util';

type Verdict = 'safe' | 'review' | 'keep' | 'system';
interface Row { name: string; path: string; isDir: boolean; size: number; verdict: Verdict; title: string; why: string; deletable: boolean; special: string | null; group: string | null; files?: number; pct?: number; m?: number }
interface DiskState {
  drive: { path: string; total: number; used: number; free: number; fs: string }; scan: { running: boolean; stats: { files: number; dirs: number; bytes: number; errors: number } | null; current: string; startedAt: number; error: string | null; scannedAt: number };
  scanned: boolean; scannedBytes: number; unaccounted: number; cloud: string[]; unreadable: number; unreadableSamples: string[];
}
interface Listing { path: string; crumbs: { name: string; path: string }[]; total: number; ownBytes: number; here: Row; dirs: Row[]; files: Row[]; moreFiles: number; moreDirs: number }
interface CatDetail { name: string; bytes: number; files: number; exts: { ext: string; bytes: number; files: number }[]; moreExts: number; onlyExt: string | null; items: Row[]; listedBytes: number }
interface Quick { group: string; title: string; bytes: number; verdict: Verdict; why: string; special: string | null; deletableCount: number; paths: { path: string; bytes: number; deletable: boolean }[] }

const V: Record<Verdict, [string, string, string]> = {
  safe: ['Safe to remove', 'bg-green-500/20 text-green-300 border-green-500/50', 'Rebuilds itself or is only temporary'],
  review: ['Your call', 'bg-amber-500/20 text-amber-300 border-amber-500/50', 'Could be yours: only you can say'],
  keep: ['Needed by programs', 'bg-sky-500/20 text-sky-300 border-sky-500/50', 'Programs or settings rely on it'],
  system: ['Windows system', 'bg-red-500/20 text-red-300 border-red-500/50', 'Part of Windows: do not touch'],
};
interface CleanJob { phase: string; total: number; done: number; ok: number; failed: number; freed: number; current: string; startedAt: number; finishedAt: number; permanent: boolean; errors: { path: string; error: string }[]; cancelled: boolean }
const CleanCtx = createContext<{ start: (paths: string[], permanent: boolean, word: string) => Promise<void>; running: boolean }>({ start: async () => {}, running: false });
const Chip = ({ v }: { v: Verdict }) => <span title={V[v][2]} className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-xs ${V[v][1]}`}>{V[v][0]}</span>;

export function Disk({ state }: { state: AppState; version: number }) {
  const [ds, setDs] = useState<DiskState | null>(null);
  const [tab, setTab] = useState<'overview' | 'browse' | 'files' | 'types'>('overview');
  const [cat, setCat] = useState<string | null>(null);
  const [catExt, setCatExt] = useState<string | null>(null);
  const [catData, setCatData] = useState<CatDetail | null>(null);
  const [cwd, setCwd] = useState('');
  const [listing, setListing] = useState<Listing | null>(null);
  const [cats, setCats] = useState<{ name: string; bytes: number; files: number }[]>([]);
  const [rootList, setRootList] = useState<Listing | null>(null);
  const [quick, setQuick] = useState<Quick[]>([]);
  const [top, setTop] = useState<Row[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [job, setJob] = useState<CleanJob | null>(null);
  const [dismissed, setDismissed] = useState(0);

  const loadState = useCallback(() => api<DiskState>('/api/disk').then(setDs).catch((e) => setErr(e.message)), []);
  const loadScanned = useCallback(async () => {
    try {
      const [rl, c, q, t] = await Promise.all([api<Listing>('/api/disk/list'), api<{ categories: typeof cats }>('/api/disk/categories'), api<{ items: Quick[] }>('/api/disk/quick'), api<{ files: Row[] }>('/api/disk/top')]);
      setRootList(rl); setCats(c.categories); setQuick(q.items); setTop(t.files);
    } catch (e: any) { setErr(e.message); }
  }, []);
  const loadList = useCallback((p: string) => api<Listing>(`/api/disk/list?path=${encodeURIComponent(p)}`).then((l) => { setListing(l); setCwd(l.path); }).catch((e) => setErr(e.message)), []);
  useEffect(() => { loadState(); }, [loadState]);
  useEffect(() => { if (ds?.scanned) loadScanned(); }, [ds?.scanned, ds?.scan.scannedAt, loadScanned]);
  useEffect(() => { if (ds?.scanned && tab === 'browse' && !listing) loadList(cwd || ''); }, [tab, ds?.scanned, listing, cwd, loadList]);
  useEvents((m) => {
    if (m.type === 'disk-clean') setJob(m.state);
    else if (m.type === 'disk-changed') { loadScanned(); loadState(); }
    else if (m.type === 'disk') setDs((d) => (d ? { ...d, scan: m.state, scanned: d.scanned || !!m.state.scannedAt } : d));
  });
  useEffect(() => { if (ds && !ds.scan.running) loadState(); }, [ds?.scan.running]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { api<{ job: CleanJob | null }>('/api/disk/clean').then((r) => { if (r.job) setJob(r.job); }).catch(() => {}); }, []);
  const startClean = useCallback(async (paths: string[], permanent: boolean, word: string) => {
    setErr(''); setMsg('');
    await api('/api/disk/delete', { body: { paths, permanent, word } });
    api<{ job: CleanJob | null }>('/api/disk/clean').then((r) => setJob(r.job));
    document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);
  const openCat = useCallback(async (name: string, ext: string | null = null) => {
    setErr('');
    try {
      const d = await api<CatDetail>(`/api/disk/category?name=${encodeURIComponent(name)}${ext === null ? '' : `&ext=${encodeURIComponent(ext)}`}`);
      setCat(name); setCatExt(ext); setCatData(d); setTab('types');
    } catch (e: any) { setErr(e.message); }
  }, []);
  const refreshAll = async () => { if (cat) await openCat(cat, catExt); await loadState(); await loadScanned(); if (tab === 'browse') await loadList(cwd); };
  const scan = () => { setErr(''); setMsg(''); setListing(null); api('/api/disk/scan', { body: {} }).then(loadState); };
  const drill = (p: string) => { setTab('browse'); loadList(p); };

  const d = ds?.drive;
  const pctUsed = d && d.total ? Math.round((d.used / d.total) * 100) : 0;
  const running = ds?.scan.running;

  const cleaning = job?.phase === 'running';
  return (
    <CleanCtx.Provider value={{ start: startClean, running: !!cleaning }}>
    <div className="mx-auto max-w-6xl space-y-5 p-4">
      {(msg || (job && (cleaning || job.startedAt !== dismissed))) && (
        <div className="sticky top-0 z-20 space-y-2">
          {job && (cleaning || job.startedAt !== dismissed) && <CleanPanel job={job} onDismiss={() => setDismissed(job.startedAt)} />}
          {msg && <div className="flex items-start justify-between rounded border border-green-700 bg-zinc-950 p-3 text-sm text-green-300">{msg}<button className="ml-3 underline" onClick={() => setMsg('')}>dismiss</button></div>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">C Drive</h2>
        <button className="btn btn-primary" disabled={running} onClick={scan}>{ds?.scanned ? 'Re-scan the drive' : 'Scan the whole drive'}</button>
        {running && <button className="btn" onClick={() => api('/api/disk/cancel', { body: {} })}>Cancel</button>}
        <span className="text-xs text-zinc-500">Read-only analysis: sizes only, nothing is opened or changed. Cleaning only happens when you tick items and confirm.</span>
      </div>
      {err && <div className="rounded border border-red-700 p-3 text-red-300">{err}</div>}

      {d && (
        <section className="card">
          <div className="flex flex-wrap items-center gap-6">
            <Donut size={200} fmt={fmtBytes} legend={false} center={{ title: `${pctUsed}%`, sub: 'of the drive is used' }}
              slices={[{ label: 'Used', value: d.used, color: pctUsed > 90 ? '#f87171' : '#38bdf8' }, { label: 'Free', value: d.free, color: '#3f3f46' }]} />
            <div className="space-y-1 text-sm">
              <div className="text-base font-medium">{d.path} {d.fs && <span className="text-zinc-500">({d.fs})</span>}</div>
              <div><span className="text-zinc-400">Total</span> <b>{fmtBytes(d.total)}</b></div>
              <div><span className="text-sky-300">Used</span> <b>{fmtBytes(d.used)}</b></div>
              <div><span className="text-zinc-400">Free</span> <b>{fmtBytes(d.free)}</b></div>
              {ds.scanned && (
                <div className="max-w-md pt-2 text-xs text-zinc-400">
                  Scan found <b>{fmtBytes(ds.scannedBytes)}</b> in files it could read.
                  {ds.unaccounted > 1e8 && <> The other <b>{fmtBytes(ds.unaccounted)}</b> is space Windows hides from normal programs: restore points (System Volume Information), other users' data, the Recycle Bin of other accounts, and file-system overhead.</>}
                  {ds.unaccounted < -1e8 && <> The scan counts shared system files once, but some compressed or sparse files report a larger size than they use on disk.</>}
                  {ds.cloud.length > 0 && <div className="pt-1">Cloud folders ({ds.cloud.map((c) => c.split(/[\\/]/).pop()).join(', ')}) are not counted: online-only files there use no disk space.</div>}
                  {ds.unreadable > 0 && <details className="pt-1"><summary className="cursor-pointer">{ds.unreadable.toLocaleString()} protected folders/files could not be read</summary>{ds.unreadableSamples.map((s, i) => <div key={i} className="break-all">{s}</div>)}</details>}
                </div>
              )}
            </div>
            {running && ds?.scan.stats && (
              <div className="min-w-[14rem] flex-1 text-sm">
                <div className="mb-1 font-medium">Scanning… {fmtDur(Date.now() - ds.scan.startedAt)}</div>
                <div className="h-2 overflow-hidden rounded bg-zinc-800"><div className="h-full animate-pulse bg-sky-500" style={{ width: `${Math.min(100, d.used ? (ds.scan.stats.bytes / d.used) * 100 : 5)}%` }} /></div>
                <div className="mt-1 text-xs text-zinc-400">{ds.scan.stats.files.toLocaleString()} files · {fmtBytes(ds.scan.stats.bytes)} of ~{fmtBytes(d.used)} · {ds.scan.stats.dirs.toLocaleString()} folders</div>
                <div className="truncate text-xs text-zinc-500">{ds.scan.current}</div>
                <div className="text-xs text-zinc-500">A whole-drive scan takes a few minutes. Keep this tab open.</div>
              </div>
            )}
          </div>
          {ds.scan.error && <div className="mt-2 whitespace-pre-wrap break-all text-red-400">{ds.scan.error}</div>}
        </section>
      )}

      {!ds?.scanned && !running && <div className="rounded border border-zinc-800 p-6 text-center text-zinc-400">Click <b>Scan the whole drive</b> to see where the space goes: folders, file types, the biggest files, and whether each is useful.</div>}

      {ds?.scanned && (
        <>
          <div className="flex items-center gap-2">
            {([['overview', 'Overview'], ['types', 'File types'], ['browse', 'Browse folders'], ['files', 'Largest files']] as const).map(([k, l]) => (
              <button key={k} onClick={() => { setTab(k); if (k === 'types' && !catData && cats.length) openCat(cats[0].name); }} className={`rounded px-3 py-1 text-sm ${tab === k ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:bg-zinc-800'}`}>{l}</button>
            ))}
            <div className="ml-auto flex flex-wrap gap-2 text-xs">{(Object.keys(V) as Verdict[]).map((v) => <Chip key={v} v={v} />)}</div>
          </div>

          {tab === 'overview' && rootList && (
            <>
              <section className="grid gap-4 md:grid-cols-2">
                <div className="card"><h3 className="mb-3 font-semibold">Where the space goes (top-level folders)</h3>
                  <Donut size={200} fmt={fmtBytes} center={{ title: fmtBytes(rootList.total), sub: 'scanned' }}
                    slices={topSlices([...rootList.dirs.map((x) => ({ label: x.name, value: x.size, onClick: () => drill(x.path), hint: x.title })), ...rootList.files.map((f) => ({ label: f.name, value: f.size, hint: f.title }))])} /></div>
                <div className="card"><h3 className="mb-3 font-semibold">By file type</h3>
                  <Donut size={200} fmt={fmtBytes} center={{ title: fmtBytes(cats.reduce((a, c) => a + c.bytes, 0)), sub: 'all files' }} slices={topSlices(cats.map((c) => ({ label: c.name, value: c.bytes, onClick: () => openCat(c.name), hint: `${c.files.toLocaleString()} files — click to open` })), 12)} />
                  <div className="mt-2 text-xs text-zinc-500">Click a slice or a name to open that file type and see its files.</div></div>
              </section>
              <QuickWins items={quick} onDone={(m) => { setMsg(m); refreshAll(); }} mode={state.mode} />
            </>
          )}

          {tab === 'types' && (
            <section className="card space-y-3">
              <div className="flex flex-wrap gap-2">
                {cats.map((c) => (
                  <button key={c.name} onClick={() => openCat(c.name)} className={`rounded border px-2 py-1 text-xs ${cat === c.name ? 'border-sky-500 bg-sky-500/20 text-sky-200' : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'}`}>
                    {c.name} <span className="text-zinc-500">{fmtBytes(c.bytes)}</span>
                  </button>
                ))}
              </div>
              {catData && (
                <>
                  <div className="text-sm"><b>{catData.name}</b> — {fmtBytes(catData.bytes)} in {catData.files.toLocaleString()} files</div>
                  <div className="flex flex-wrap items-center gap-1 text-xs">
                    <span className="text-zinc-500">File extension:</span>
                    <button onClick={() => openCat(catData.name)} className={`rounded border px-2 py-0.5 ${catData.onlyExt === null ? 'border-sky-500 text-sky-200' : 'border-zinc-700 text-zinc-300'}`}>all</button>
                    {catData.exts.map((e) => (
                      <button key={e.ext} onClick={() => openCat(catData.name, e.ext)} className={`rounded border px-2 py-0.5 ${catData.onlyExt === e.ext ? 'border-sky-500 text-sky-200' : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'}`}>
                        {e.ext ? `.${e.ext}` : '(no extension)'} <span className="text-zinc-500">{fmtBytes(e.bytes)} · {e.files.toLocaleString()}</span>
                      </button>
                    ))}
                    {catData.moreExts > 0 && <span className="text-zinc-500">+{catData.moreExts} more small types</span>}
                  </div>
                  <div className="text-xs text-zinc-500">Showing the {catData.items.length} largest files{catData.onlyExt !== null ? ` of this extension` : ''} ({fmtBytes(catData.listedBytes)}). Files under 256 KB are counted in the totals but not listed one by one.</div>
                  <RowTable rows={catData.items} total={catData.bytes || 1} onOpenDir={() => {}} onDone={(m) => { setMsg(m); refreshAll(); }} mode={state.mode} showPath />
                </>
              )}
            </section>
          )}

          {tab === 'browse' && (
            <section className="card space-y-3">
              {listing ? <Browser l={listing} go={loadList} onDone={(m) => { setMsg(m); refreshAll(); }} mode={state.mode} /> : <div className="text-zinc-500">Loading…</div>}
            </section>
          )}

          {tab === 'files' && (
            <section className="card space-y-3">
              <h3 className="font-semibold">Largest files on the drive</h3>
              <RowTable rows={top} total={rootList?.total || 1} onOpenDir={() => {}} onDone={(m) => { setMsg(m); refreshAll(); }} mode={state.mode} showPath />
            </section>
          )}
        </>
      )}
    </div>
    </CleanCtx.Provider>
  );
}

function CleanPanel({ job, onDismiss }: { job: CleanJob; onDismiss: () => void }) {
  const running = job.phase === 'running';
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  return (
    <div className={`rounded border bg-zinc-950 p-3 text-sm shadow-lg ${running ? 'border-sky-500' : job.failed ? 'border-amber-500' : 'border-green-600'}`}>
      <div className="flex flex-wrap items-center gap-3">
        <b>{running ? '🧹 Cleaning in progress…' : job.cancelled ? 'Cleanup cancelled' : '✅ Cleanup finished'}</b>
        <span>{job.done}/{job.total} locations · freed about <b>{fmtBytes(job.freed)}</b>{job.failed > 0 && <span className="text-amber-300"> · {job.failed} could not be removed</span>}</span>
        {running ? <button className="btn ml-auto" onClick={() => api('/api/disk/clean/cancel', { body: {} })}>Stop</button> : <button className="btn ml-auto" onClick={onDismiss}>Dismiss</button>}
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded bg-zinc-800"><div className={`h-full transition-all ${running ? 'bg-sky-500' : 'bg-green-500'}`} style={{ width: `${pct}%` }} /></div>
      {running && <div className="mt-1 truncate text-xs text-zinc-500">Now: {job.current || '…'}</div>}
      {!running && job.errors.length > 0 && (
        <details className="mt-2 text-xs text-zinc-400"><summary className="cursor-pointer text-amber-300">Why some could not be removed (usually files in use or needing administrator rights)</summary>
          <div className="max-h-40 overflow-auto">{job.errors.map((e, i) => <div key={i} className="break-all">{e.path} — {e.error}</div>)}</div></details>
      )}
    </div>
  );
}

function Browser({ l, go, onDone, mode }: { l: Listing; go: (p: string) => void; onDone: (m: string) => void; mode: string }) {
  const rows = useMemo(() => [...l.dirs, ...l.files].sort((a, b) => b.size - a.size), [l]);
  return (
    <>
      <div className="flex flex-wrap items-center gap-1 text-sm">
        {l.crumbs.map((c, i) => <span key={c.path}>{i > 0 && <span className="px-1 text-zinc-600">›</span>}<button className="text-sky-300 hover:underline" onClick={() => go(c.path)}>{c.name}</button></span>)}
        <span className="ml-3 text-zinc-400">{fmtBytes(l.total)} in {(l.here.files || 0).toLocaleString()} files</span>
      </div>
      <div className="flex flex-wrap items-start gap-3 rounded border border-zinc-800 p-3">
        <Chip v={l.here.verdict} /><div className="min-w-0 flex-1 text-sm"><b>{l.here.title}</b><div className="text-xs text-zinc-400">{l.here.why}</div></div>
      </div>
      {rows.length > 1 && <Donut size={180} fmt={fmtBytes} center={{ title: fmtBytes(l.total), sub: 'in this folder' }}
        slices={topSlices(rows.map((r) => ({ label: r.name + (r.isDir ? '/' : ''), value: r.size, onClick: r.isDir ? () => go(r.path) : undefined, hint: r.title })))} />}
      <RowTable rows={rows} total={l.total || 1} onOpenDir={go} onDone={onDone} mode={mode} />
      {(l.moreDirs > 0 || l.moreFiles > 0) && <div className="text-xs text-zinc-500">{l.moreDirs} more small folders and {l.moreFiles} more small files not shown.</div>}
    </>
  );
}

function RowTable({ rows, total, onOpenDir, onDone, mode, showPath }: { rows: Row[]; total: number; onOpenDir: (p: string) => void; onDone: (m: string) => void; mode: string; showPath?: boolean }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => setSel(new Set()), [rows]);
  const chosen = rows.filter((r) => sel.has(r.path));
  const deletable = rows.filter((r) => r.deletable);
  const allOn = deletable.length > 0 && deletable.every((r) => sel.has(r.path));
  const selectAll = () => setSel(new Set(deletable.map((r) => r.path)));
  const protectedCount = rows.length - deletable.length;
  const toggle = (p: string) => setSel((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <button className="btn" disabled={!deletable.length || allOn} onClick={selectAll}>Select all {deletable.length.toLocaleString()} ({fmtBytes(deletable.reduce((a, r) => a + r.size, 0))})</button>
        {sel.size > 0 && <button className="btn" onClick={() => setSel(new Set())}>Deselect all</button>}
        {protectedCount > 0 && <span className="text-zinc-500">{protectedCount} protected item(s) (Windows, programs or your company handover folder) cannot be selected.</span>}
        <span className="text-zinc-500">Select-all covers the rows listed below only. Look at the paths before you delete.</span>
      </div>
      <div className="max-h-[32rem] overflow-auto text-sm">
        <table className="w-full table-fixed">
          <colgroup><col style={{ width: 32 }} /><col style={{ width: '30%' }} /><col style={{ width: 110 }} /><col style={{ width: 90 }} /><col style={{ width: 90 }} /><col /></colgroup>
          <thead className="sticky top-0 z-10 bg-zinc-900 text-left text-xs text-zinc-500">
            <tr><th className="p-1"><input type="checkbox" title="Select / deselect all" disabled={!deletable.length} checked={allOn} onChange={() => (allOn ? setSel(new Set()) : selectAll())} /></th>
              <th>Name</th><th>Share</th><th className="text-right">Size</th><th className="pl-3">{rows.some((r) => r.files !== undefined) ? 'Files / Modified' : 'Modified'}</th><th className="pl-2">What is it?</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.path}>
                <tr className="h-12 border-t border-zinc-800 hover:bg-zinc-900">
                  <td className="p-1 align-middle"><input type="checkbox" disabled={!r.deletable} checked={sel.has(r.path)} onChange={() => toggle(r.path)} title={r.deletable ? 'Select for cleanup' : '🔒 Protected: Windows, a program or your company handover folder needs this'} /></td>
                  <td className="overflow-hidden align-middle pr-2">
                    <div className="truncate font-medium" title={r.path}>{r.isDir ? <button className="text-sky-300 hover:underline" onClick={() => onOpenDir(r.path)}>📁 {r.name}</button> : <span>📄 {r.name}</span>}</div>
                    {showPath && <div className="truncate text-xs text-zinc-500" title={r.path}>{r.path}</div>}
                  </td>
                  <td className="align-middle"><div className="h-2 w-24 rounded bg-zinc-800"><div className="h-full rounded bg-sky-500" style={{ width: `${Math.max(1, Math.min(100, (r.size / total) * 100))}%` }} /></div></td>
                  <td className="whitespace-nowrap text-right align-middle">{fmtBytes(r.size)}</td>
                  <td className="whitespace-nowrap pl-3 align-middle text-xs text-zinc-400">{r.files !== undefined ? `${r.files.toLocaleString()} files` : r.m ? fmtDate(r.m) : ''}</td>
                  <td className="cursor-pointer overflow-hidden pl-2 align-middle" onClick={() => setOpen(open === r.path ? null : r.path)} title={r.why}>
                    <div className="flex items-center gap-2"><Chip v={r.verdict} /><span className="truncate text-xs text-zinc-400">{!r.deletable && '🔒 '}{r.title}</span></div>
                  </td>
                </tr>
                {open === r.path && <tr className="bg-zinc-900/60"><td /><td colSpan={5} className="p-2 text-xs text-zinc-300"><b>{r.title}.</b> {r.why}<div className="break-all text-zinc-500">{r.path}</div></td></tr>}
              </Fragment>
            ))}
            {!rows.length && <tr><td colSpan={6} className="p-6 text-center text-zinc-500">Nothing here.</td></tr>}
          </tbody>
        </table>
      </div>
      <CleanBar paths={chosen.map((r) => r.path)} bytes={chosen.reduce((a, r) => a + r.size, 0)} allSafe={chosen.every((r) => r.verdict === 'safe')} onDone={(m) => { setSel(new Set()); onDone(m); }} mode={mode} />
    </>
  );
}

function CleanBar({ paths, bytes, allSafe, onDone, mode }: { paths: string[]; bytes: number; allSafe: boolean; onDone: (m: string) => void; mode: string }) {
  const ctx = useContext(CleanCtx);
  const [word, setWord] = useState('');
  const [perm, setPerm] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!paths.length) return null;
  const permanent = perm ?? allSafe;
  const run = async () => {
    setBusy(true); setErr('');
    try { await ctx.start(paths, permanent, word); setWord(''); onDone(''); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 pt-3 text-sm">
      <span>{paths.length} selected · {fmtBytes(bytes)}</span>
      <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={permanent} onChange={(e) => setPerm(e.target.checked)} /> delete permanently (skip Recycle Bin)</label>
      <input className="input w-32" placeholder="type DELETE" value={word} onChange={(e) => setWord(e.target.value)} />
      <button className="btn btn-danger" disabled={word !== 'DELETE' || busy || ctx.running || mode === 'readonly'} onClick={run}>{busy ? 'Starting…' : ctx.running ? 'A cleanup is running…' : permanent ? 'Delete permanently' : 'Move to Recycle Bin'}</button>
      {err && <span className="text-red-400">{err}</span>}
      {!allSafe && <span className="text-xs text-amber-300">Includes items rated “Your call”: make sure you do not need them.</span>}
    </div>
  );
}

function QuickWins({ items, onDone, mode }: { items: Quick[]; onDone: (m: string) => void; mode: string }) {
  const ctx = useContext(CleanCtx);
  const [busy, setBusy] = useState(false);
  const [binBusy, setBinBusy] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [word, setWord] = useState('');
  const [binWord, setBinWord] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const regular = items.filter((i) => !i.special);
  const bin = items.find((i) => i.special === 'recycle');
  const chosen = regular.filter((i) => sel.has(i.group));
  const paths = chosen.flatMap((i) => i.paths.filter((p) => p.deletable).map((p) => p.path));
  const bytes = chosen.reduce((a, i) => a + i.paths.filter((p) => p.deletable).reduce((x, p) => x + p.bytes, 0), 0);
  const toggle = (g: string) => setSel((s) => { const n = new Set(s); if (n.has(g)) n.delete(g); else n.add(g); return n; });
  const run = async () => {
    setErr(''); setBusy(true);
    try { await ctx.start(paths, true, word); setSel(new Set()); setWord(''); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const emptyBin = async () => {
    setErr(''); setBinBusy(true);
    try { const r = await api<{ freed: number }>('/api/disk/empty-bin', { body: { word: binWord } }); setBinWord(''); onDone(`✅ Recycle Bin emptied (about ${fmtBytes(r.freed)} freed).`); document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e: any) { setErr(e.message); } finally { setBinBusy(false); }
  };
  if (!items.length) return null;
  return (
    <section className="card space-y-3">
      <h3 className="font-semibold">Quick wins — things that are safe to remove</h3>
      <div className="text-xs text-zinc-500">These are caches, temporary files and rebuildable folders found on your drive. Tick what you want gone; everything here regenerates by itself or can be re-installed.</div>
      {bin && (
        <div className="rounded border border-green-500/40 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-3"><b>🗑️ Recycle Bin</b> <span>{fmtBytes(bin.bytes)} (your account's part that the scan can read)</span> <Chip v="safe" />
            <input className="input w-28" placeholder="type EMPTY" value={binWord} onChange={(e) => setBinWord(e.target.value)} />
            <button className="btn btn-danger" disabled={binWord !== 'EMPTY' || binBusy || mode === 'readonly'} onClick={emptyBin}>{binBusy ? 'Emptying… please wait' : 'Empty Recycle Bin'}</button></div>
          <div className="mt-1 text-xs text-zinc-400">{bin.why}</div>
        </div>
      )}
      {regular.map((i) => (
        <div key={i.group} className="rounded border border-zinc-800 p-2 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <input type="checkbox" disabled={!i.deletableCount} checked={sel.has(i.group)} onChange={() => toggle(i.group)} />
            <b>{i.title}</b><span className="text-zinc-300">{fmtBytes(i.bytes)}</span><Chip v={i.verdict} />
            <button className="text-xs text-zinc-400 underline" onClick={() => setOpen(open === i.group ? null : i.group)}>{open === i.group ? 'hide' : `${i.paths.length} location(s)`}</button>
          </div>
          <div className="ml-6 text-xs text-zinc-400">{i.why}</div>
          {open === i.group && <div className="ml-6 mt-1 max-h-40 overflow-auto text-xs text-zinc-500">{i.paths.slice(0, 60).map((p) => <div key={p.path} className="break-all">{fmtBytes(p.bytes)} · {p.path}</div>)}</div>}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 pt-3 text-sm">
        <span>{chosen.length} group(s) selected · about {fmtBytes(bytes)}</span>
        <input className="input w-32" placeholder="type DELETE" value={word} onChange={(e) => setWord(e.target.value)} />
        <button className="btn btn-danger" disabled={!paths.length || word !== 'DELETE' || busy || ctx.running || mode === 'readonly'} onClick={run}>{busy ? 'Starting…' : ctx.running ? 'A cleanup is running…' : 'Clean selected (permanent)'}</button>
        {err && <span className="text-red-400">{err}</span>}
        <span className="text-xs text-zinc-500">Close your browser and other programs first, otherwise their cache files in use are skipped.</span>
      </div>
    </section>
  );
}
