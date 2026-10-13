import { useCallback, useEffect, useState } from 'react';
import { api, useEvents, TOKEN } from './api';
import type { AppState } from './types';
import { Storage } from './screens/Storage';
import { Review } from './screens/Review';
import { Settings } from './screens/Settings';
import { Execute } from './screens/Execute';
import { Apps } from './screens/Apps';
import { Groups } from './screens/Groups';
import { Disk } from './screens/Disk';
import { SummaryBar } from './components/SummaryBar';

const SCREENS = ['Storage', 'Review', 'Execute', 'Apps', 'Company Groups', 'C Drive', 'Settings'] as const;
type Screen = (typeof SCREENS)[number];

export function App() {
  const [screen, setScreen] = useState<Screen>('Storage');
  const [state, setState] = useState<AppState | null>(null);
  const [version, setVersion] = useState(0); // bumps whenever server data changes
  const [err, setErr] = useState('');

  const refresh = useCallback(() => api<AppState>('/api/state').then(setState).catch((e) => setErr(String(e.message))), []);
  useEffect(() => { refresh(); }, [refresh]);
  useEvents((m) => {
    if (m.type === 'db-changed') { setVersion((v) => v + 1); refresh(); }
    else if (m.type === 'scan') setState((s) => (s ? { ...s, scan: m.state } : s));
  });

  if (!TOKEN) return <div className="p-8">Missing access token. Open the tool using the link printed by <code>start.bat</code>.</div>;
  if (err) return <div className="p-8 text-red-400">Cannot reach server: {err}</div>;
  if (!state) return <div className="p-8 text-zinc-400">Loading…</div>;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-zinc-800 px-4 py-2">
        <div className="font-semibold">Laptop Handover</div>
        <nav className="flex gap-1">
          {SCREENS.map((s) => (
            <button key={s} onClick={() => setScreen(s)}
              className={`rounded px-3 py-1 text-sm ${screen === s ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:bg-zinc-800'}`}>{s}</button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 text-xs">
          <span className={`rounded border px-2 py-0.5 ${state.mode === 'live' ? 'border-red-500 text-red-300' : state.mode === 'sandbox' ? 'border-amber-500 text-amber-300' : 'border-zinc-600 text-zinc-400'}`}>
            {state.mode === 'live' ? 'LIVE — destructive' : state.mode === 'sandbox' ? `SANDBOX ${state.sandbox}` : 'READ-ONLY'}
          </span>
        </div>
      </header>
      <SummaryBar summary={state.summary} />
      <main className="min-h-0 flex-1 overflow-auto">
        {screen === 'Storage' && <Storage state={state} version={version} refresh={refresh} />}
        {screen === 'Review' && <Review state={state} version={version} />}
        {screen === 'Execute' && <Execute state={state} version={version} />}
        {screen === 'Apps' && <Apps state={state} version={version} />}
        {screen === 'Company Groups' && <Groups state={state} version={version} />}
        {screen === 'C Drive' && <Disk state={state} version={version} />}
        {screen === 'Settings' && <Settings state={state} refresh={refresh} />}
      </main>
    </div>
  );
}
