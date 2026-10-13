import { useEffect, useMemo, useState } from 'react';
import { api, useEvents } from '../api';
import type { AppState } from '../types';
import { fmtBytes, fmtDate } from '../util';

interface Entry { name: string; path: string; size: number; files: number; mtime: number; isGroup: boolean; isProject: boolean; children: number; git: { remote: string | null; branch: string | null } | null; identicalTo: string[] }
interface Suggestion { key: string; members: string[]; suggestedName: string }
interface View { running: boolean; progress: number; total: number; rootKind: 'company' | 'files'; root: string; entries: Entry[]; suggestions: Suggestion[]; scannedAt: number; error: string | null; canUndo: boolean }
interface Staged { name: string; members: string[] }
interface PlanOp { group: string; name: string; from: string; to: string; size: number }

export function Groups({ state }: { state: AppState; version: number }) {
  const [v, setV] = useState<View | null>(null);
  const [staged, setStaged] = useState<Staged[]>([]);
  const [plan, setPlan] = useState<{ errors: string[]; ops: PlanOp[] } | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [gname, setGname] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('name');
  const [ok, setOk] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState<Record<string, { name: string; off: Set<string> }>>({});

  const load = () => api<View>('/api/groups').then(setV);
  useEffect(() => { load(); }, []);
  useEvents((m) => { if (m.type === 'groups') setV(m.state); });
  const scan = (root: 'company' | 'files') => { setStaged([]); setPlan(null); setMsg(''); setErr(''); setSel(new Set()); api('/api/groups/scan', { body: { root } }).then(load); };

  const stagedNames = useMemo(() => new Set(staged.flatMap((s) => s.members)), [staged]);
  useEffect(() => {
    if (!staged.length) { setPlan(null); return; }
    api<{ errors: string[]; ops: PlanOp[] }>('/api/groups/plan', { body: { groups: staged } }).then(setPlan).catch((e) => setErr(e.message));
  }, [staged]);

  const addStaged = (g: Staged) => { setStaged((s) => [...s.filter((x) => x.name !== g.name), g]); setOk(false); };
  const apply = async () => {
    setErr(''); setMsg('');
    try {
      const r = await api<{ log: { moves: { done: boolean; error: string | null; to: string }[] } }>('/api/groups/apply', { body: { groups: staged, confirm: true } });
      const bad = r.log.moves.filter((m) => !m.done);
      setMsg(`${r.log.moves.length - bad.length} folder(s) moved into groups.${bad.length ? ` ${bad.length} failed: ${bad.map((b) => b.error).join('; ')}` : ''}`);
      setStaged([]); setPlan(null); setOk(false); setSel(new Set());
    } catch (e: any) { setErr(e.message); }
  };
  const undo = async () => {
    if (!confirm('Undo the last grouping? Folders are moved back to where they were.')) return;
    setErr(''); setMsg('');
    try { const r = await api<{ errors: string[] }>('/api/groups/undo', { body: {} }); setMsg(r.errors.length ? `Undone with notes: ${r.errors.join('; ')}` : 'Last grouping undone.'); } catch (e: any) { setErr(e.message); }
  };

  const entries = useMemo(() => {
    let l = v?.entries || [];
    if (q) l = l.filter((e) => e.name.toLowerCase().includes(q.toLowerCase()));
    return [...l].sort((a, b) => sort === 'size' ? b.size - a.size : sort === 'date' ? b.mtime - a.mtime : a.name.localeCompare(b.name));
  }, [v, q, sort]);
  const toggle = (n: string) => setSel((s) => { const x = new Set(s); if (x.has(n)) x.delete(n); else x.add(n); return x; });
  const byName = new Map((v?.entries || []).map((e) => [e.name, e]));

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">Company Groups</h2>
        <button className="btn btn-primary" disabled={v?.running} onClick={() => scan('company')}>Scan {state.settings.companyFolder}</button>
        <button className="btn" disabled={v?.running} onClick={() => scan('files')}>Scan …\Files</button>
        {v?.running && <span className="text-sm text-zinc-400">Scanning {v.progress}/{v.total}…</span>}
        {v?.canUndo && <button className="btn ml-auto" onClick={undo}>↶ Undo last grouping</button>}
      </div>
      <p className="text-xs text-zinc-500">Groups are folders inside the company handover folder. You decide per suggestion: <b>group</b> (members move into a new folder with the name you choose) or <b>keep as normal</b>. Nothing moves until you apply the plan, and the last grouping can be undone.</p>
      {err && <div className="rounded border border-red-700 p-3 text-red-300">{err}</div>}
      {msg && <div className="rounded border border-green-700 p-3 text-green-300">{msg}</div>}
      {v?.error && <div className="rounded border border-amber-600 p-3 text-amber-300">{v.error}. Run the Execute step first, or set the folder in Settings.</div>}

      {v && v.scannedAt > 0 && (
        <>
          <section className="space-y-2">
            <h3 className="font-semibold">Suggested groups ({v.suggestions.filter((s) => !s.members.every((m) => stagedNames.has(m))).length})</h3>
            {v.suggestions.length === 0 && <div className="text-sm text-zinc-500">No look-alike folder names found.</div>}
            {v.suggestions.map((s) => {
              const e = edit[s.key] || { name: s.suggestedName, off: new Set<string>() };
              const done = s.members.every((m) => stagedNames.has(m));
              return (
                <div key={s.key} className={`card space-y-2 ${done ? 'opacity-50' : ''}`}>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-zinc-400">{s.members.length} similar folders → group folder name:</span>
                    <input className="input w-64" value={e.name} onChange={(ev) => setEdit({ ...edit, [s.key]: { ...e, name: ev.target.value } })} />
                    <button className="btn btn-primary" disabled={done || !e.name.trim() || s.members.every((m) => e.off.has(m))} onClick={() => addStaged({ name: e.name.trim(), members: s.members.filter((m) => !e.off.has(m)) })}>Group these</button>
                    <button className="btn" onClick={() => api('/api/groups/dismiss', { body: { key: s.key } }).then(load)}>Keep as normal</button>
                  </div>
                  <table className="w-full text-xs">
                    <tbody>
                      {s.members.map((m) => { const en = byName.get(m); return (
                        <tr key={m} className="border-t border-zinc-800">
                          <td className="w-8 p-1"><input type="checkbox" checked={!e.off.has(m)} onChange={() => { const off = new Set(e.off); if (off.has(m)) off.delete(m); else off.add(m); setEdit({ ...edit, [s.key]: { ...e, off } }); }} /></td>
                          <td className="font-medium">{m}</td><td className="text-right">{en ? fmtBytes(en.size) : ''}</td><td className="text-right text-zinc-500">{en ? `${en.files.toLocaleString()} files` : ''}</td>
                          <td className="px-2 text-zinc-500">{en ? fmtDate(en.mtime) : ''}</td>
                          <td className="break-all text-zinc-500">{en?.git ? `${en.git.remote || 'no remote'} · ${en.git.branch || ''}` : ''}</td>
                          <td>{en?.identicalTo.length ? <span className="rounded bg-amber-500/20 px-1.5 text-amber-300" title={`Same file count and size as: ${en.identicalTo.join(', ')}`}>identical to {en.identicalTo.length}</span> : null}</td>
                        </tr>); })}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </section>

          {staged.length > 0 && (
            <section className="card space-y-2 border-sky-900">
              <h3 className="font-semibold">Grouping plan ({staged.length} group{staged.length > 1 ? 's' : ''}, {staged.reduce((a, g) => a + g.members.length, 0)} folders)</h3>
              {staged.map((g) => (
                <div key={g.name} className="text-sm"><b>📦 {g.name}</b> ← {g.members.join(', ')} <button className="ml-2 text-xs text-zinc-400 underline" onClick={() => setStaged(staged.filter((x) => x !== g))}>remove</button></div>
              ))}
              {plan?.errors.map((e, i) => <div key={i} className="text-sm text-red-400">⛔ {e}</div>)}
              {plan && !plan.errors.length && (
                <div className="max-h-48 overflow-auto text-xs text-zinc-400">{plan.ops.map((o) => <div key={o.to} className="break-all">{o.from} → {o.to}</div>)}</div>
              )}
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={ok} onChange={(e) => setOk(e.target.checked)} /> I reviewed the moves above. Folders are only renamed/moved inside the company folder (undoable).</label>
              <button className="btn btn-danger" disabled={!ok || !plan || plan.errors.length > 0 || state.mode === 'readonly'} onClick={apply}>Apply grouping</button>
            </section>
          )}

          <section className="card p-0">
            <div className="flex flex-wrap items-center gap-3 p-3">
              <h3 className="font-semibold">All folders in {v.root} ({v.entries.length})</h3>
              <input className="input w-52" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
              <select className="input" value={sort} onChange={(e) => setSort(e.target.value)}><option value="name">Name A→Z</option><option value="size">Largest first</option><option value="date">Newest first</option></select>
            </div>
            <div className="max-h-[26rem] overflow-auto text-sm">
              <table className="w-full">
                <thead className="sticky top-0 bg-zinc-900 text-left text-xs text-zinc-500"><tr><th className="w-8 p-2" /><th>Folder</th><th className="text-right">Size</th><th className="text-right">Files</th><th>Modified</th><th>Git</th></tr></thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.name} onClick={() => !e.isGroup && !stagedNames.has(e.name) && toggle(e.name)} className={`border-t border-zinc-800 ${sel.has(e.name) ? 'bg-sky-900/30' : ''} ${stagedNames.has(e.name) ? 'opacity-40' : ''}`}>
                      <td className="p-2"><input type="checkbox" readOnly disabled={e.isGroup || stagedNames.has(e.name)} checked={sel.has(e.name)} className="pointer-events-none" /></td>
                      <td><span className="font-medium">{e.isGroup ? '📦' : '📁'} {e.name}</span>
                        {e.isGroup && <span className="ml-2 rounded bg-sky-500/20 px-1.5 text-xs text-sky-300">group · {e.children} folders</span>}
                        {e.isProject && <span className="ml-2 rounded bg-zinc-800 px-1.5 text-xs text-zinc-400">project</span>}
                        {e.identicalTo.length > 0 && <span className="ml-2 rounded bg-amber-500/20 px-1.5 text-xs text-amber-300" title={`Same file count and size as: ${e.identicalTo.join(', ')}`}>identical to {e.identicalTo.length}</span>}</td>
                      <td className="text-right text-xs">{fmtBytes(e.size)}</td><td className="text-right text-xs">{e.files.toLocaleString()}</td><td className="text-xs text-zinc-400">{fmtDate(e.mtime)}</td>
                      <td className="break-all text-xs text-zinc-500">{e.git ? `${e.git.remote || 'no remote'} · ${e.git.branch || ''}` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 p-3">
              <span className="text-sm">{sel.size} selected</span>
              <input className="input w-64" placeholder="Group folder name…" value={gname} onChange={(e) => setGname(e.target.value)} />
              <button className="btn btn-primary" disabled={!sel.size || !gname.trim()} onClick={() => { addStaged({ name: gname.trim(), members: [...sel] }); setSel(new Set()); setGname(''); }}>Group selected</button>
              <span className="text-xs text-zinc-500">Anything you don't select stays as a normal folder.</span>
            </div>
          </section>
        </>
      )}
      {v && !v.scannedAt && !v.running && !v.error && <div className="text-sm text-zinc-500">Click “Scan” to list the folders.</div>}
    </div>
  );
}
