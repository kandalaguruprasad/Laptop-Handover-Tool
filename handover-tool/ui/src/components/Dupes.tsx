import { useEffect, useState } from 'react';
import { api, useEvents } from '../api';
import type { Item } from '../types';
import { fmtBytes } from '../util';

interface DupeData { computed: boolean; running: boolean; groups?: number; wasted?: number; view?: { size: number; items: Item[] }[] }

export function Dupes({ onClose }: { onClose: () => void }) {
  const [d, setD] = useState<DupeData | null>(null);
  const [prog, setProg] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api<DupeData>('/api/dupes').then(setD);
  useEffect(() => { load(); }, []);
  useEvents((m) => {
    if (m.type === 'dupes') { setProg(`${m.done}/${m.total} files hashed`); if (m.finished) { setProg(''); load(); } }
  });
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4">
      <div className="card flex max-h-[85vh] w-full max-w-4xl flex-col bg-zinc-900">
        <div className="mb-3 flex items-center gap-3">
          <h3 className="text-lg font-semibold">Exact duplicates</h3>
          <button className="btn ml-auto" onClick={onClose}>Close</button>
        </div>
        <p className="mb-3 text-xs text-zinc-500">Same size + same SHA-256. This reads file contents, so it only runs when you click. Cloud-synced files (OneDrive etc.) and files under 1 KB are skipped.</p>
        <div className="mb-3 flex items-center gap-3">
          <button className="btn btn-primary" disabled={!!prog || d?.running} onClick={() => api('/api/dupes/find', { body: {} })}>{d?.computed ? 'Re-run' : 'Find duplicates'}</button>
          {prog && <span className="text-sm text-zinc-400">{prog}</span>}
          {d?.computed && !!d.groups && (
            <>
              <span className="text-sm">{d.groups} groups · {fmtBytes(d.wasted || 0)} reclaimable</span>
              <button className="btn" onClick={async () => { const r = await api<{ marked: number }>('/api/dupes/mark', { body: {} }); setMsg(`Marked ${r.marked} copies Ignore (one copy kept per group; existing tags untouched).`); }}>
                Mark duplicates Ignore, keep one
              </button>
            </>
          )}
        </div>
        {msg && <div className="mb-2 text-sm text-green-400">{msg}</div>}
        <div className="min-h-0 flex-1 overflow-auto text-xs">
          {d?.computed && !d.groups && <div className="text-zinc-400">No exact duplicates found.</div>}
          {d?.view?.map((g, i) => (
            <div key={i} className="mb-2 rounded border border-zinc-800 p-2">
              <div className="mb-1 text-zinc-400">{fmtBytes(g.size)} × {g.items.length}</div>
              {g.items.map((it, j) => <div key={it.id} className="truncate" title={it.p}>{j === 0 ? '✔ keep ' : '   '}{it.p}{it.tag ? ` [${it.tag}]` : ''}</div>)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
