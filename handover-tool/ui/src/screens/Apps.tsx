import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, useEvents } from '../api';
import type { AppState } from '../types';
import { fmtBytes, fmtDate } from '../util';

interface AppRow { id: string; type: 'win' | 'appx'; name: string; publisher: string; version: string; installDate: string; sizeKB: number; installLocation: string; risky: string | null; method: string; methodNote: string }
interface Leftover { path: string; confidence: 'exact' | 'guess'; why: string; bytes: number; files: number; checked: boolean }
interface PreviewItem extends AppRow { command: string; leftovers: Leftover[] }
interface JobItem { id: string; name: string; status: string; message: string; leftovers: { path: string; status: string; error: string }[] }
interface Job { phase: string; error: string | null; items: JobItem[] }
interface Inst { id: string; path: string; name: string; isDir: boolean; size: number; files: number; installers: number; hasProject: boolean; m: number }

const METHOD: Record<string, [string, string]> = {
  quiet: ['silent', 'text-green-300'], msi: ['silent (MSI)', 'text-green-300'], interactive: ['opens its own uninstaller', 'text-amber-300'],
  appx: ['Store app', 'text-sky-300'], none: ['no auto-uninstall', 'text-red-300'],
};
const STATUS_CLS: Record<string, string> = { uninstalled: 'text-green-400', failed: 'text-red-400', uninstalling: 'text-sky-300', pending: 'text-zinc-500', skipped: 'text-zinc-500', deleted: 'text-green-400' };

export function Apps({ state }: { state: AppState; version: number }) {
  const [sub, setSub] = useState<'programs' | 'installers'>('programs');
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold">Apps</h2>
        {(['programs', 'installers'] as const).map((s) => (
          <button key={s} onClick={() => setSub(s)} className={`rounded px-3 py-1 text-sm ${sub === s ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:bg-zinc-800'}`}>
            {s === 'programs' ? 'Installed programs' : 'Downloaded installers'}
          </button>
        ))}
        <span className="ml-auto text-xs text-zinc-500">Separate from the file review: nothing here is touched until you confirm.</span>
      </div>
      {state.mode === 'readonly' && <div className="rounded border border-amber-600 p-3 text-amber-300">Server is read-only. Restart with <code>--live</code> (start.bat does this) to uninstall or delete.</div>}
      {sub === 'programs' ? <Programs mode={state.mode} /> : <Installers mode={state.mode} />}
    </div>
  );
}

function Programs({ mode }: { mode: string }) {
  const [apps, setApps] = useState<AppRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('name');
  const [hideShared, setHideShared] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<PreviewItem[] | null>(null);
  const [ticked, setTicked] = useState<Record<string, Set<string>>>({});
  const [permanent, setPermanent] = useState(false);
  const [ok, setOk] = useState(false);
  const [word, setWord] = useState('');
  const [job, setJob] = useState<Job | null>(null);

  const scan = useCallback(async () => { setBusy(true); setErr(''); try { const r = await api<{ apps: AppRow[] }>('/api/apps/scan', { body: {} }); setApps(r.apps); setSel(new Set()); setPreview(null); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } }, []);
  useEffect(() => { api<{ apps: AppRow[]; scannedAt: number }>('/api/apps').then((r) => { if (r.scannedAt) setApps(r.apps); }).catch(() => {}); api<{ job: Job | null }>('/api/apps/run').then((r) => setJob(r.job)).catch(() => {}); }, []);
  useEvents((m) => { if (m.type === 'apps-run') setJob(m.state); });
  useEffect(() => { if (job && job.phase !== 'running' && job.phase !== 'pending') api<{ apps: AppRow[] }>('/api/apps').then((r) => setApps(r.apps)).catch(() => {}); }, [job?.phase]);

  const shown = useMemo(() => {
    let l = apps || [];
    if (q) l = l.filter((a) => (a.name + ' ' + a.publisher).toLowerCase().includes(q.toLowerCase()));
    if (hideShared) l = l.filter((a) => !a.risky);
    return [...l].sort((a, b) => sort === 'size' ? b.sizeKB - a.sizeKB : sort === 'date' ? (b.installDate || '').localeCompare(a.installDate || '') : a.name.localeCompare(b.name));
  }, [apps, q, sort, hideShared]);

  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const doPreview = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api<{ items: PreviewItem[] }>('/api/apps/preview', { body: { ids: [...sel] } });
      setPreview(r.items);
      setTicked(Object.fromEntries(r.items.map((i) => [i.id, new Set(i.leftovers.filter((l) => l.checked).map((l) => l.path))])));
      setOk(false); setWord('');
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const toggleLeft = (id: string, p: string) => setTicked((t) => { const s = new Set(t[id]); if (s.has(p)) s.delete(p); else s.add(p); return { ...t, [id]: s }; });
  const run = async () => {
    if (!preview) return;
    setErr('');
    try {
      await api('/api/apps/run', { body: { word, permanent, items: preview.filter((i) => i.method !== 'none').map((i) => ({ id: i.id, leftovers: [...(ticked[i.id] || [])] })) } });
      setPreview(null); setSel(new Set());
    } catch (e: any) { setErr(e.message); }
  };

  const running = job?.phase === 'running';
  const totalLeft = preview ? preview.reduce((a, i) => a + i.leftovers.filter((l) => ticked[i.id]?.has(l.path)).reduce((x, l) => x + l.bytes, 0), 0) : 0;
  const hasRisky = preview?.some((i) => i.risky);
  const hasInteractive = preview?.some((i) => i.method === 'interactive');

  return (
    <>
      <section className="card flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" disabled={busy || running} onClick={scan}>{apps ? 'Re-scan programs' : 'Scan installed programs'}</button>
        {apps && <span className="text-sm text-zinc-300">{apps.length} programs found</span>}
        {apps && <input className="input w-60" placeholder="Search name or publisher…" value={q} onChange={(e) => setQ(e.target.value)} />}
        {apps && <select className="input" value={sort} onChange={(e) => setSort(e.target.value)}><option value="name">Name A→Z</option><option value="size">Largest first</option><option value="date">Newest installed</option></select>}
        {apps && <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={hideShared} onChange={(e) => setHideShared(e.target.checked)} /> hide runtimes / shared components</label>}
      </section>
      {err && <div className="rounded border border-red-700 p-3 text-red-300">{err}</div>}

      {apps && (
        <section className="card p-0">
          <div className="max-h-[28rem] overflow-auto text-sm">
            <table className="w-full">
              <thead className="sticky top-0 bg-zinc-900 text-left text-xs text-zinc-500"><tr><th className="w-8 p-2" /><th>Program</th><th>Version</th><th className="text-right">Size</th><th>Installed</th><th>Uninstall</th></tr></thead>
              <tbody>
                {shown.map((a) => (
                  <tr key={a.id} onClick={() => toggle(a.id)} className={`cursor-default border-t border-zinc-800 ${sel.has(a.id) ? 'bg-sky-900/30' : 'hover:bg-zinc-900'}`}>
                    <td className="p-2"><input type="checkbox" readOnly checked={sel.has(a.id)} className="pointer-events-none" /></td>
                    <td><div className="font-medium">{a.name}{a.risky && <span title={a.risky} className="ml-2 rounded bg-amber-500/20 px-1.5 text-xs text-amber-300">shared</span>}</div><div className="text-xs text-zinc-500">{a.publisher}{a.installLocation ? ` · ${a.installLocation}` : ''}</div></td>
                    <td className="text-xs text-zinc-400">{a.version}</td>
                    <td className="text-right text-xs">{a.sizeKB ? fmtBytes(a.sizeKB * 1024) : '—'}</td>
                    <td className="text-xs text-zinc-400">{/^\d{8}$/.test(a.installDate) ? fmtDate(new Date(`${a.installDate.slice(0, 4)}-${a.installDate.slice(4, 6)}-${a.installDate.slice(6)}`).getTime()) : a.installDate}</td>
                    <td className={`text-xs ${METHOD[a.method]?.[1]}`} title={a.methodNote}>{METHOD[a.method]?.[0]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-3 border-t border-zinc-800 p-3">
            <span className="text-sm">{sel.size} selected</span>
            <button className="btn" disabled={!sel.size || busy || running} onClick={doPreview}>Preview uninstall…</button>
            {sel.size > 0 && <button className="btn" onClick={() => setSel(new Set())}>Clear selection</button>}
          </div>
        </section>
      )}

      {preview && (
        <section className="card space-y-3 border-red-900/50">
          <h3 className="font-semibold">Preview — {preview.length} program(s) · leftover data to delete: {fmtBytes(totalLeft)}</h3>
          {hasRisky && <div className="text-sm text-amber-300">⚠️ Some selected items are runtimes/shared components. Other programs (and tools you still use) may stop working if you remove them.</div>}
          {hasInteractive && <div className="text-sm text-amber-300">⚠️ Some uninstallers cannot run silently: their own window will open on this PC and you must click through it. Windows may also ask for administrator permission (UAC).</div>}
          <div className="max-h-96 space-y-3 overflow-auto">
            {preview.map((i) => (
              <div key={i.id} className="rounded border border-zinc-800 p-2 text-sm">
                <div className="font-medium">{i.name} <span className={`text-xs ${METHOD[i.method]?.[1]}`}>({METHOD[i.method]?.[0]})</span></div>
                <div className="break-all text-xs text-zinc-500">{i.method === 'none' ? `Cannot be uninstalled automatically: ${i.methodNote}. Use Windows Settings → Apps.` : `Runs: ${i.command}`}</div>
                {i.leftovers.length > 0 && <div className="mt-1 text-xs text-zinc-400">Leftover folders found (ticked ones are deleted after a successful uninstall):</div>}
                {i.leftovers.map((l) => (
                  <label key={l.path} className="flex items-start gap-2 text-xs">
                    <input type="checkbox" className="mt-0.5" disabled={i.method === 'none'} checked={!!ticked[i.id]?.has(l.path)} onChange={() => toggleLeft(i.id, l.path)} />
                    <span className="break-all">{l.path} <span className="text-zinc-500">· {fmtBytes(l.bytes)} · {l.files.toLocaleString()} files · {l.why}</span> {l.confidence === 'guess' && <span className="rounded bg-zinc-800 px-1 text-zinc-400">guess — check it</span>}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={permanent} onChange={(e) => setPermanent(e.target.checked)} /> Delete leftover data permanently (faster, no Recycle Bin). Off = Recycle Bin.</label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={ok} onChange={(e) => setOk(e.target.checked)} /> I reviewed this list. Uninstalling cannot be undone (I would have to reinstall the program).</label>
          <div className="flex items-center gap-3">
            <input className="input w-44" placeholder="type UNINSTALL" value={word} onChange={(e) => setWord(e.target.value)} />
            <button className="btn btn-danger" disabled={!ok || word !== 'UNINSTALL' || mode === 'readonly' || busy} onClick={run}>Uninstall {preview.filter((i) => i.method !== 'none').length} program(s)</button>
            <button className="btn" onClick={() => setPreview(null)}>Cancel</button>
          </div>
        </section>
      )}

      {job && (
        <section className="card space-y-2">
          <div className="flex items-center gap-3"><h3 className="font-semibold">Uninstall progress — <span className="capitalize">{job.phase}</span></h3>
            {running && <button className="btn btn-danger" onClick={() => api('/api/apps/run/cancel', { body: {} })}>Stop after current program</button>}</div>
          {job.error && <div className="text-red-400">{job.error}</div>}
          <div className="max-h-80 overflow-auto text-sm">
            {job.items.map((i) => (
              <div key={i.id} className="border-t border-zinc-800 py-1">
                <span className="font-medium">{i.name}</span> <span className={STATUS_CLS[i.status]}>{i.status}</span> <span className="text-xs text-zinc-500">{i.message}</span>
                {i.leftovers.map((l) => <div key={l.path} className="ml-4 break-all text-xs"><span className={STATUS_CLS[l.status]}>{l.status}</span> {l.path} <span className="text-red-400">{l.error}</span></div>)}
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function Installers({ mode }: { mode: string }) {
  const [list, setList] = useState<Inst[] | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [onlyInst, setOnlyInst] = useState(true);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [word, setWord] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const apply = (r: { entries: Inst[]; roots: string[] }) => { setList(r.entries); setRoots(r.roots); };
  useEffect(() => { api<{ entries: Inst[]; roots: string[]; scannedAt: number }>('/api/installers').then((r) => { if (r.scannedAt) apply(r); }).catch(() => {}); }, []);
  const scan = async () => { setBusy(true); setErr(''); setMsg(''); try { apply(await api('/api/installers/scan', { body: {} })); setSel(new Set()); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const shown = (list || []).filter((e) => !onlyInst || e.installers > 0);
  const selBytes = (list || []).filter((e) => sel.has(e.id)).reduce((a, e) => a + e.size, 0);
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const del = async () => {
    setErr('');
    try {
      const r = await api<{ results: { ok: boolean; name?: string; error?: string }[]; installers: { entries: Inst[]; roots: string[] } }>('/api/installers/delete', { body: { ids: [...sel], word } });
      apply(r.installers); setSel(new Set()); setWord('');
      const bad = r.results.filter((x) => !x.ok);
      setMsg(`${r.results.length - bad.length} deleted${bad.length ? `, ${bad.length} failed: ${bad.map((b) => `${b.name || ''} (${b.error})`).join('; ')}` : ''}.`);
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <section className="card flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" disabled={busy} onClick={scan}>{list ? 'Re-scan Downloads' : 'Scan Downloads'}</button>
        {roots.length > 0 && <span className="text-xs text-zinc-500">{roots.join(' · ')}</span>}
        <label className="ml-auto flex items-center gap-1 text-xs"><input type="checkbox" checked={onlyInst} onChange={(e) => setOnlyInst(e.target.checked)} /> only things that contain installers (.exe .msi .msix .appx .iso)</label>
      </section>
      {err && <div className="rounded border border-red-700 p-3 text-red-300">{err}</div>}
      {msg && <div className="rounded border border-green-700 p-3 text-green-300">{msg}</div>}
      {list && (
        <section className="card p-0">
          <div className="max-h-[28rem] overflow-auto text-sm">
            <table className="w-full">
              <thead className="sticky top-0 bg-zinc-900 text-left text-xs text-zinc-500"><tr><th className="w-8 p-2" /><th>Name (top level of Downloads)</th><th className="text-right">Size</th><th className="text-right">Files</th><th className="text-right">Installers</th><th>Modified</th></tr></thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.id} onClick={() => toggle(e.id)} className={`cursor-default border-t border-zinc-800 ${sel.has(e.id) ? 'bg-sky-900/30' : 'hover:bg-zinc-900'}`}>
                    <td className="p-2"><input type="checkbox" readOnly checked={sel.has(e.id)} className="pointer-events-none" /></td>
                    <td><div className="font-medium">{e.isDir ? '📁' : '📄'} {e.name}{e.hasProject && <span className="ml-2 rounded bg-amber-500/20 px-1.5 text-xs text-amber-300" title="Contains project files (package.json, .git, pom.xml…)">⚠ contains a project</span>}</div><div className="break-all text-xs text-zinc-500">{e.path}</div></td>
                    <td className="text-right text-xs">{fmtBytes(e.size)}</td><td className="text-right text-xs">{e.files.toLocaleString()}</td><td className="text-right text-xs">{e.installers}</td><td className="text-xs text-zinc-400">{fmtDate(e.m)}</td>
                  </tr>
                ))}
                {!shown.length && <tr><td colSpan={6} className="p-6 text-center text-zinc-500">Nothing to show.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 p-3">
            <span className="text-sm">{sel.size} selected · {fmtBytes(selBytes)}</span>
            <input className="input w-36" placeholder="type DELETE" value={word} onChange={(e) => setWord(e.target.value)} />
            <button className="btn btn-danger" disabled={!sel.size || word !== 'DELETE' || mode === 'readonly'} onClick={del}>Delete selected (Recycle Bin)</button>
            <span className="text-xs text-zinc-500">Whole folders are removed, including everything inside. Windows deletes items too big for the Recycle Bin permanently.</span>
          </div>
        </section>
      )}
    </>
  );
}
