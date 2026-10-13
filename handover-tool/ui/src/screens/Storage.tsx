import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AppState, Drive } from '../types';
import { fmtBytes, fmtDur, TAB_LABEL } from '../util';

function DriveCard({ d, tag }: { d: Drive; tag?: string }) {
  const pct = d.total ? Math.round((d.used / d.total) * 100) : 0;
  return (
    <div className="card">
      <div className="flex items-baseline justify-between">
        <div className="font-medium">{d.path} {d.label && <span className="text-zinc-500">{d.label}</span>}</div>
        <div className="flex gap-2 text-xs">
          {tag && <span className="rounded bg-amber-500/20 px-1.5 text-amber-300">{tag}</span>}
          <span className="text-zinc-400">{d.fs || '—'}</span>
        </div>
      </div>
      <div className="my-2 h-2 overflow-hidden rounded bg-zinc-800">
        <div className={`h-full ${pct > 90 ? 'bg-red-500' : 'bg-sky-500'}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-xs text-zinc-400">{fmtBytes(d.used)} used · {fmtBytes(d.free)} free · {fmtBytes(d.total)} total</div>
    </div>
  );
}

export function Storage({ state, version, refresh }: { state: AppState; version: number; refresh: () => void }) {
  const [drives, setDrives] = useState<Drive[]>([]);
  const [storage, setStorage] = useState<{ categories: Record<string, { n: number; bytes: number }>; largest: { p: string; s: number }[] } | null>(null);
  const scan = state.scan;
  const [cloud, setCloud] = useState<{ path: string; kind: string; bytes: number; files: number; covered: boolean }[]>([]);
  const loadCloud = () => api<{ folders: typeof cloud }>('/api/cloud-folders').then((r) => setCloud(r.folders)).catch(() => {});
  useEffect(() => { loadCloud(); }, [version, state.settings.scanRoots.length]);
  const addRoot = async (p: string) => { await api('/api/settings', { method: 'PUT', body: { scanRoots: [...state.settings.scanRoots, p] } }); refresh(); loadCloud(); };
  useEffect(() => { api<{ drives: Drive[] }>('/api/drives').then((r) => setDrives(r.drives)).catch(() => {}); }, []);
  useEffect(() => { if (state.summary.scanned) api('/api/storage').then(setStorage).catch(() => {}); }, [version, state.summary.scanned]);

  const norm = (a: string[]) => a.map((x) => x.toLowerCase().replace(/[\\/]+$/, '')).sort().join('|');
  const lastRoots: string[] | null = state.summary.meta?.roots || null;
  const rootsChanged = !scan.running && (!lastRoots || norm(lastRoots) !== norm(state.settings.scanRoots));
  const dest = state.settings.destDisk.toLowerCase();
  const isDest = (d: Drive) => !!dest && dest.startsWith(d.path.toLowerCase().replace(/[\\/]+$/, '')) && d.path.length > 1;
  const external = drives.filter((d) => isDest(d) || d.removable);
  const laptop = drives.filter((d) => !external.includes(d));
  const maxCat = Math.max(1, ...Object.values(storage?.categories || {}).map((c) => c.bytes));
  const maxDir = Math.max(1, ...(storage?.largest || []).map((l) => l.s));

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4">
      <section className="card">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">Scan</h2>
          <button className="btn btn-primary" disabled={scan.running} onClick={() => api('/api/scan/start', { body: {} }).then(refresh)}>
            {state.summary.scanned ? 'Re-scan' : 'Start scan'}
          </button>
          {scan.running && <button className="btn" onClick={() => api('/api/scan/cancel', { body: {} })}>Cancel</button>}
          <span className="text-xs text-zinc-500">Metadata only — file contents are never read. Re-scans keep your tags.</span>
        </div>
        {rootsChanged && (
          <div className="mt-2 rounded border border-amber-600 bg-amber-500/10 p-2 text-sm text-amber-300">
            {lastRoots ? 'The scan roots changed since the last scan, so everything below (item counts, cloud folders, Review list) still shows the OLD scan.' : 'No scan has been run yet.'} Click <b>{state.summary.scanned ? 'Re-scan' : 'Start scan'}</b>.
          </div>
        )}
        <div className="mt-2 text-xs text-zinc-400">Roots: {state.settings.scanRoots.join('  ·  ') || '(none — add some in Settings)'}</div>
        {scan.stats && (
          <div className="mt-3 text-sm text-zinc-300">
            {scan.running ? 'Scanning… ' : 'Last scan: '}
            {scan.stats.files.toLocaleString()} files · {scan.stats.projects} projects · {scan.stats.dirs.toLocaleString()} folders · {fmtBytes(scan.stats.bytes)}
            · skipped {scan.stats.skippedRegen} regenerable dirs
            {scan.running && scan.startedAt ? ` · ${fmtDur(Date.now() - scan.startedAt)}` : ''}
            {scan.running && <div className="truncate text-xs text-zinc-500">{scan.current}</div>}
          </div>
        )}
        {scan.stats && !scan.running && (() => {
          const sys = drives.find((d) => d.system);
          return sys ? (
            <div className="mt-2 rounded border border-zinc-800 p-2 text-xs text-zinc-400">
              Scanned {fmtBytes(scan.stats.bytes)} (regenerable folders like node_modules excluded) out of {fmtBytes(sys.used)} used on {sys.path}. The rest is Windows, programs, AppData and folders that are not scan roots.
              Projects stored elsewhere (e.g. <code>C:\Projects</code>, other drives) only appear after you add those folders in Settings → Scanning and re-scan.
            </div>
          ) : null;
        })()}
        {scan.stats?.errors > 0 && (
          <details className="mt-2 text-xs text-zinc-500">
            <summary>{scan.stats.errors} unreadable items were skipped (locked, vanished or permission denied) — click for samples</summary>
            {(scan.stats.errorSamples || []).map((e: string, i: number) => <div key={i} className="break-all">{e}</div>)}
          </details>
        )}
        {scan.error && <div className="mt-2 whitespace-pre-wrap break-all text-red-400">{scan.error}</div>}
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Laptop drives</h2>
          {laptop.map((d) => <DriveCard key={d.path} d={d} />)}
          {!laptop.length && <div className="text-zinc-500">No drives found.</div>}
          {cloud.map((c) => (
            <div key={c.path} className="card">
              <div className="flex items-baseline justify-between">
                <div className="font-medium">☁️ {c.kind} <span className="text-xs text-zinc-500">{c.path}</span></div>
                <span className="text-xs text-zinc-400">cloud-synced folder</span>
              </div>
              <div className="mt-1 text-xs text-zinc-400">
                {c.covered ? (rootsChanged ? 'Covered by your scan roots, but not scanned yet — click Re-scan.' : `In scan: ${c.files.toLocaleString()} items · ${fmtBytes(c.bytes)}`) : 'Not in the scan yet.'}
              </div>
              {!c.covered && <button className="btn mt-2 text-xs" onClick={() => addRoot(c.path)}>+ Add to scan</button>}
              <div className="mt-2 text-xs text-amber-300/80">Moving or deleting files here syncs to the cloud (and online-only files get downloaded to copy them). Review carefully.</div>
            </div>
          ))}
        </div>
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">External / destination</h2>
          {external.map((d) => <DriveCard key={d.path} d={d} tag={isDest(d) ? 'destination' : undefined} />)}
          {!external.length && <div className="text-zinc-500">No external drive detected. Set the destination in Settings: <code>{state.settings.destDisk || '(not set)'}</code></div>}
        </div>
      </section>

      {storage && (
        <section className="grid gap-4 md:grid-cols-2">
          <div className="card">
            <h3 className="mb-3 font-semibold">Size by category</h3>
            {Object.entries(storage.categories).sort((a, b) => b[1].bytes - a[1].bytes).map(([c, v]) => (
              <div key={c} className="mb-2">
                <div className="flex justify-between text-xs"><span>{TAB_LABEL[c] || c} <span className="text-zinc-500">({v.n.toLocaleString()})</span></span><span>{fmtBytes(v.bytes)}</span></div>
                <div className="h-1.5 rounded bg-zinc-800"><div className="h-full rounded bg-sky-500" style={{ width: `${(v.bytes / maxCat) * 100}%` }} /></div>
              </div>
            ))}
          </div>
          <div className="card">
            <h3 className="mb-3 font-semibold">Largest folders</h3>
            <div className="max-h-96 overflow-auto">
              {storage.largest.map((l) => (
                <div key={l.p} className="mb-2">
                  <div className="flex justify-between gap-2 text-xs"><span className="truncate" title={l.p}>{l.p}</span><span className="shrink-0">{fmtBytes(l.s)}</span></div>
                  <div className="h-1 rounded bg-zinc-800"><div className="h-full rounded bg-amber-500" style={{ width: `${(l.s / maxDir) * 100}%` }} /></div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
