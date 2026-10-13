import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AppState, Drive, Settings as S } from '../types';

const lines = (a: string[]) => a.join('\n');
const parse = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

function Toggle({ label, hint, v, on }: { label: string; hint?: string; v: boolean; on: (b: boolean) => void }) {
  return (
    <label className="flex items-start gap-2 py-1">
      <input type="checkbox" className="mt-1" checked={v} onChange={(e) => on(e.target.checked)} />
      <span><span>{label}</span>{hint && <span className="block text-xs text-zinc-500">{hint}</span>}</span>
    </label>
  );
}
function Area({ label, hint, v, on }: { label: string; hint?: string; v: string[]; on: (a: string[]) => void }) {
  const [t, setT] = useState(lines(v));
  useEffect(() => setT(lines(v)), [v]);
  return (
    <div>
      <div className="mb-1 text-sm font-medium">{label}</div>
      {hint && <div className="mb-1 text-xs text-zinc-500">{hint}</div>}
      <textarea className="input h-28 w-full font-mono text-xs" value={t} onChange={(e) => setT(e.target.value)} onBlur={() => on(parse(t))} />
    </div>
  );
}

export function Settings({ state, refresh }: { state: AppState; refresh: () => void }) {
  const [s, setS] = useState<S>(state.settings);
  const [saved, setSaved] = useState(false);
  const [profileDirs, setProfileDirs] = useState<string[]>([]);
  useEffect(() => { api<{ dirs: string[] }>('/api/profile-folders').then((r) => setProfileDirs(r.dirs)).catch(() => {}); }, []);
  const [drives, setDrives] = useState<Drive[]>([]);
  const [driveDirs, setDriveDirs] = useState<Record<string, string[]>>({});
  useEffect(() => {
    api<{ drives: Drive[] }>('/api/drives').then(async (r) => {
      const dest = (state.settings.destDisk || '').toLowerCase();
      const local = r.drives.filter((d) => !(dest && dest.startsWith(d.path.toLowerCase().replace(/[\\/]+$/, '')) && d.path.length > 1) && !d.removable && d.total > 1e8);
      setDrives(local);
      const out: Record<string, string[]> = {};
      for (const d of local) out[d.path] = (await api<{ dirs: string[] }>(`/api/dirs?path=${encodeURIComponent(d.path)}`)).dirs;
      setDriveDirs(out);
    }).catch(() => {});
  }, [state.settings.destDisk]);
  const set = <K extends keyof S>(k: K, v: S[K]) => { setS((p) => ({ ...p, [k]: v })); setSaved(false); };
  const save = async () => { await api('/api/settings', { method: 'PUT', body: s }); setSaved(true); refresh(); };
  const extra = profileDirs.filter((d) => !s.scanRoots.some((r) => r.toLowerCase() === d.toLowerCase()));

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold">Settings</h2>
        <button className="btn btn-primary" onClick={save}>Save</button>
        {saved && <span className="text-sm text-green-400">Saved</span>}
      </div>

      <section className="card space-y-3">
        <h3 className="font-semibold">Scanning</h3>
        <Area label="Scan roots (one per line)" v={s.scanRoots} on={(a) => set('scanRoots', a)} />
        {extra.length > 0 && (
          <div className="text-xs">
            <div className="mb-1 text-zinc-500">Other top-level folders in your profile (click to add):</div>
            <div className="flex flex-wrap gap-1">
              {extra.map((d) => <button key={d} className="rounded border border-zinc-700 px-2 py-0.5 hover:bg-zinc-800" onClick={() => set('scanRoots', [...s.scanRoots, d])}>+ {d.split(/[\\/]/).pop()}</button>)}
            </div>
          </div>
        )}
        {drives.length > 0 && (
          <div className="space-y-2 text-xs">
            <div className="text-zinc-500">Projects can live anywhere. Add the folders where you keep code or files (click to add as a scan root):</div>
            {drives.map((d) => (
              <div key={d.path}>
                <button className="mr-1 rounded border border-amber-600 px-2 py-0.5 text-amber-300 hover:bg-zinc-800" title="Scans everything on the drive except Windows, Program Files, ProgramData and AppData"
                  onClick={() => set('scanRoots', [...s.scanRoots, d.path])}>+ whole drive {d.path}</button>
                {(driveDirs[d.path] || []).filter((x) => !s.scanRoots.some((r) => r.toLowerCase() === x.toLowerCase())).map((x) => (
                  <button key={x} className="mr-1 mt-1 rounded border border-zinc-700 px-2 py-0.5 hover:bg-zinc-800" onClick={() => set('scanRoots', [...s.scanRoots, x])}>+ {x}</button>
                ))}
              </div>
            ))}
          </div>
        )}
        <div className="text-xs text-zinc-500">AppData (<code>C:\Users\&lt;you&gt;\AppData</code>) is always excluded: it only holds caches, SDKs and app data.</div>
        <Area label="Regenerable directories" hint="Never descended into inside projects, never copied. 'target' and 'bin' only count when a Cargo.toml / pom.xml / .csproj sits next to them. node_modules is always skipped." v={s.regenDirs} on={(a) => set('regenDirs', a)} />
      </section>

      <section className="card space-y-3">
        <h3 className="font-semibold">Suggestions</h3>
        <Area label="Company git patterns" hint="Matched against the project's origin URL, e.g. github.com/acme-corp" v={s.companyPatterns} on={(a) => set('companyPatterns', a)} />
        <Area label="My git patterns" hint="e.g. github.com/your-username" v={s.minePatterns} on={(a) => set('minePatterns', a)} />
        <label className="flex items-center gap-2">Suggest Ignore for Downloads older than
          <input type="number" min={0} className="input w-20" value={s.downloadsOlderThanDays} onChange={(e) => set('downloadsOlderThanDays', Number(e.target.value))} /> days (0 = off)
        </label>
      </section>

      <section className="card space-y-2">
        <h3 className="font-semibold">Destinations</h3>
        <label className="block">Destination hard disk (folder or drive root)
          <input className="input mt-1 w-full" value={s.destDisk} onChange={(e) => set('destDisk', e.target.value)} placeholder="E:\" />
        </label>
        <label className="block">Company handover folder
          <input className="input mt-1 w-full" value={s.companyFolder} onChange={(e) => set('companyFolder', e.target.value)} />
        </label>
      </section>

      <section className="card">
        <h3 className="mb-1 font-semibold">Execution</h3>
        <Toggle label="Delete source after verified copy" hint="Source is only ever removed after that specific item was verified." v={s.deleteSourceAfterCopy} on={(b) => set('deleteSourceAfterCopy', b)} />
        <Toggle label="Paranoid mode (SHA-256 verify)" hint="Hashes both copies. Much slower, reads every byte." v={s.paranoidHash} on={(b) => set('paranoidHash', b)} />
        <Toggle label="Permanently delete instead of using the Recycle Bin" hint="Off by default. When on, Ignore items are gone for good." v={s.permanentDelete} on={(b) => set('permanentDelete', b)} />
        <Toggle label="Purge node_modules & co. in Company projects" hint="Fast permanent delete of regenerable folders inside handed-over projects." v={s.purgeCompanyRegen} on={(b) => set('purgeCompanyRegen', b)} />
        <Toggle label="Remove folders left empty after the run" v={s.cleanEmptyDirs} on={(b) => set('cleanEmptyDirs', b)} />
      </section>
    </div>
  );
}
