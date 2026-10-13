import { useCallback, useEffect, useState } from 'react';
import { api, csvUrl, TOKEN, useEvents } from '../api';
import type { AppState } from '../types';
import { fmtBytes, fmtDur, TAG_CLASS, TAG_LABEL } from '../util';

interface Warn { level: 'info' | 'warn' | 'danger'; text: string }
interface PlanView {
  id: string; createdAt: number; sum: Record<string, { items: number; bytes: number; projects: number; files: number }>; moves: number;
  space: { volume: string; required: number; free: number | null }[]; warnings: Warn[]; blockers: string[]; undecided: number;
  destRoot: string; companyRoot: string; requiresDelete: boolean; mode: string; opCount: number; counts: Record<string, number>;
  settings: { deleteSourceAfterCopy: boolean; paranoidHash: boolean; permanentDelete: boolean };
}
interface Op { id: string; name: string; tag: string; action: string; src: string; dst: string | null; bytes: number; status: string; error: string | null }
interface RunView {
  phase: string; pausedReason: string; startedAt: number; error: string | null; active: { id: string; name: string; since: number }[];
  totalOps: number; doneOps: number; totalBytes: number; doneBytes: number; counts: Record<string, number>;
  errors: { id: string; name: string; tag: string; src: string; dst: string | null; error: string; attempts: number }[];
  errorCount: number; eta: number | null; emptyDirsRemoved: number; reports: string[]; interrupted: boolean;
}

const WARN_CLASS = { info: 'text-zinc-400', warn: 'text-amber-300', danger: 'text-red-300 font-medium' };

export function Execute({ state, version }: { state: AppState; version: number }) {
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [run, setRun] = useState<RunView | null>(null);
  const [ops, setOps] = useState<{ total: number; ops: Op[] }>({ total: 0, ops: [] });
  const [opTag, setOpTag] = useState('');
  const [opPage, setOpPage] = useState(0);
  const [reviewed, setReviewed] = useState(false);
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const loadPlan = useCallback(() => api<{ plan: PlanView | null }>('/api/plan').then((r) => setPlan(r.plan)), []);
  const loadRun = useCallback(() => api<RunView>('/api/run').then(setRun), []);
  useEffect(() => { loadPlan(); loadRun(); }, [loadPlan, loadRun, version]);
  useEvents((m) => { if (m.type === 'run') setRun(m.state); });
  useEffect(() => {
    if (!plan) return;
    api<{ total: number; ops: Op[] }>(`/api/plan/ops?limit=100&offset=${opPage * 100}${opTag ? `&tag=${opTag}` : ''}`).then(setOps);
  }, [plan, opTag, opPage, run?.doneOps]);

  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(''); try { await fn(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const build = () => act(async () => { setPlan(await api('/api/plan/build', { body: {} })); setReviewed(false); setWord(''); setOpPage(0); loadRun(); });

  const sum = state.summary.by;
  const stale = !!plan && (['company', 'mine', 'ignore'] as const).some((t) => sum[t].n !== plan.sum[t].items);
  const running = run && (run.phase === 'running' || run.phase === 'paused');
  const ignore = plan?.sum.ignore;
  const needWord = !!plan?.requiresDelete;
  const canRun = !!plan && !plan.blockers.length && !stale && reviewed && (!needWord || word === 'DELETE') && !running && state.mode !== 'readonly';
  const remaining = run && run.totalOps > 0 ? run.totalOps - run.doneOps - run.errorCount : plan ? plan.opCount : 0;
  const hasRun = !!run && (run.phase !== 'idle' || run.doneOps > 0 || run.errorCount > 0);

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">Execute</h2>
        <button className="btn btn-primary" disabled={busy || !!running || !state.summary.scanned} onClick={build}>{plan ? 'Rebuild plan' : 'Build plan'}</button>
        <span className="text-xs text-zinc-500">Build plan → preview → confirm → run. Nothing is touched until you press Run.</span>
      </div>
      {state.mode === 'readonly' && <div className="rounded border border-amber-600 p-3 text-amber-300">Server is read-only. Restart it with <code>--live</code> (start.bat does this) to execute.</div>}
      {err && <div className="rounded border border-red-700 p-3 text-red-300">{err}</div>}

      {plan && (
        <>
          {stale && <div className="rounded border border-amber-600 bg-amber-500/10 p-3 text-amber-300">Tags changed since this plan was built. Rebuild the plan before running.</div>}
          <section className="grid gap-3 md:grid-cols-3">
            {(['company', 'mine', 'ignore'] as const).map((t) => (
              <div key={t} className="card">
                <div className={`mb-1 inline-block rounded border px-2 py-0.5 text-xs ${TAG_CLASS[t]}`}>{TAG_LABEL[t]}</div>
                <div className="text-2xl font-semibold">{plan.sum[t].items.toLocaleString()}</div>
                <div className="text-xs text-zinc-400">{plan.sum[t].projects} projects · {plan.sum[t].files.toLocaleString()} files · {fmtBytes(plan.sum[t].bytes)}</div>
                <div className="mt-2 text-xs text-zinc-500 break-all">
                  {t === 'company' && <>→ {plan.companyRoot}{plan.moves > 0 && ` (${plan.moves} instant same-volume moves)`}</>}
                  {t === 'mine' && <>→ {plan.destRoot || '(no destination)'} · verified, then source removed{plan.settings.deleteSourceAfterCopy ? '' : ' (OFF: sources kept)'}</>}
                  {t === 'ignore' && <>→ {plan.settings.permanentDelete ? 'PERMANENT DELETE' : 'Recycle Bin'}; regenerable folders purged first</>}
                </div>
              </div>
            ))}
          </section>

          {plan.space.length > 0 && (
            <section className="card text-sm">
              <h3 className="mb-2 font-semibold">Free-space check</h3>
              {plan.space.map((s) => (
                <div key={s.volume} className={s.free !== null && s.free < s.required ? 'text-red-300' : ''}>
                  {s.volume}: need {fmtBytes(s.required)} · free {s.free === null ? 'unknown' : fmtBytes(s.free)}
                </div>
              ))}
            </section>
          )}

          {(plan.blockers.length > 0 || plan.warnings.length > 0) && (
            <section className="card space-y-1 text-sm">
              {plan.blockers.map((b, i) => <div key={'b' + i} className="font-medium text-red-400">⛔ BLOCKED: {b}</div>)}
              {plan.warnings.map((w, i) => <div key={i} className={WARN_CLASS[w.level]}>{w.level === 'danger' ? '🛑' : w.level === 'warn' ? '⚠️' : 'ℹ️'} {w.text}</div>)}
            </section>
          )}

          <section className="card">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">Preview ({plan.opCount.toLocaleString()} operations)</h3>
              <select className="input text-xs" value={opTag} onChange={(e) => { setOpTag(e.target.value); setOpPage(0); }}>
                <option value="">All</option><option value="company">Company</option><option value="mine">Mine</option><option value="ignore">Ignore</option>
              </select>
              <a className="btn ml-auto text-xs" href={csvUrl()} download>Export CSV</a>
            </div>
            <div className="max-h-96 overflow-auto text-xs">
              <table className="w-full">
                <thead className="sticky top-0 bg-zinc-900 text-left text-zinc-500"><tr><th className="p-1">Item</th><th>Tag</th><th>Action</th><th>Source → Destination</th><th className="text-right">Size</th><th>Status</th></tr></thead>
                <tbody>
                  {ops.ops.map((o) => (
                    <tr key={o.id} className="border-t border-zinc-800 align-top">
                      <td className="p-1 font-medium">{o.name}</td>
                      <td><span className={`rounded border px-1 ${TAG_CLASS[o.tag]}`}>{TAG_LABEL[o.tag]}</span></td>
                      <td>{o.action}</td>
                      <td className="break-all text-zinc-400">{o.src}<br />{o.dst ? `→ ${o.dst}` : '→ Recycle Bin'}</td>
                      <td className="whitespace-nowrap text-right">{fmtBytes(o.bytes)}</td>
                      <td className={o.status === 'failed' ? 'text-red-400' : ''}>{o.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs text-zinc-500">
              <button className="btn" disabled={opPage === 0} onClick={() => setOpPage(opPage - 1)}>Prev</button>
              <span>{ops.total ? opPage * 100 + 1 : 0}–{Math.min(ops.total, opPage * 100 + 100)} of {ops.total.toLocaleString()}</span>
              <button className="btn" disabled={(opPage + 1) * 100 >= ops.total} onClick={() => setOpPage(opPage + 1)}>Next</button>
            </div>
          </section>

          {!running && remaining <= 0 && (
            <div className="card text-sm text-zinc-300">Nothing left to run in this plan. Re-scan, tag again and build a new plan for more. Remember to empty the Recycle Bin when you are completely done.</div>
          )}
          {!running && remaining > 0 && (
            <section className="card space-y-3 border-red-900/50">
              <h3 className="font-semibold">Confirm</h3>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
                <span>I reviewed the preview above and want to run exactly this plan.</span>
              </label>
              {needWord && ignore && (
                <div className="space-y-1">
                  <div className="font-medium text-red-300">
                    {ignore.files.toLocaleString()} files{ignore.projects ? ` and ${ignore.projects} projects` : ''} / {fmtBytes(ignore.bytes)} will go to the {plan.settings.permanentDelete ? 'PERMANENT DELETE (no Recycle Bin)' : 'Recycle Bin'}.
                  </div>
                  <div className="text-xs text-zinc-500">Windows permanently deletes items that are too big for the Recycle Bin instead of recycling them. Type <code>DELETE</code> to continue.</div>
                  <input className="input w-40" value={word} onChange={(e) => setWord(e.target.value)} placeholder="DELETE" />
                </div>
              )}
              <button className="btn btn-danger" disabled={!canRun || busy}
                onClick={() => act(async () => { await api('/api/run/start', { body: { confirm: true, deleteWord: word } }); setReviewed(false); setWord(''); loadRun(); })}>
                {run?.interrupted ? 'Resume interrupted run' : 'Run plan'}
              </button>
            </section>
          )}
        </>
      )}

      {hasRun && run && <RunPanel run={run} act={act} loadRun={loadRun} />}
    </div>
  );
}

function RunPanel({ run, act, loadRun }: { run: RunView; act: (f: () => Promise<unknown>) => void; loadRun: () => void }) {
  const pct = run.totalBytes ? Math.min(100, Math.round((run.doneBytes / run.totalBytes) * 100)) : run.totalOps ? Math.round((run.doneOps / run.totalOps) * 100) : 0;
  const live = run.phase === 'running' || run.phase === 'paused';
  const post = (p: string, body: object = {}) => act(async () => { await api(p, { body }); loadRun(); });
  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-semibold">Progress — <span className="capitalize">{run.phase}</span></h3>
        {live && (run.phase === 'paused'
          ? <button className="btn btn-primary" onClick={() => post('/api/run/resume')}>Resume</button>
          : <button className="btn" onClick={() => post('/api/run/pause')}>Pause</button>)}
        {live && <button className="btn btn-danger" onClick={() => { if (confirm('Cancel the run? Finished items stay done; unfinished items can be resumed later.')) post('/api/run/cancel'); }}>Cancel</button>}
        {!live && run.reports.length > 0 && <a className="btn" target="_blank" href={`/api/report?token=${TOKEN}`}>Open report</a>}
      </div>
      {run.pausedReason && run.phase === 'paused' && <div className="rounded border border-amber-600 p-2 text-amber-300">{run.pausedReason}</div>}
      {run.error && <div className="text-red-400">Run error: {run.error}</div>}
      <div className="h-3 overflow-hidden rounded bg-zinc-800"><div className="h-full bg-sky-500 transition-all" style={{ width: `${pct}%` }} /></div>
      <div className="text-sm text-zinc-300">
        {run.doneOps.toLocaleString()} / {run.totalOps.toLocaleString()} items · {fmtBytes(run.doneBytes)} / {fmtBytes(run.totalBytes)} ({pct}%)
        {run.eta !== null && live && ` · ETA ${fmtDur(run.eta)}`}
        {run.errorCount > 0 && <span className="text-red-400"> · {run.errorCount} failed</span>}
        {!live && run.emptyDirsRemoved > 0 && ` · ${run.emptyDirsRemoved} empty folders removed`}
      </div>
      {live && run.active.length > 0 && (
        <div className="text-xs text-zinc-400">Now: {run.active.slice(0, 8).map((a) => a.name).join(' · ')}{run.active.length > 8 ? ` +${run.active.length - 8}` : ''}</div>
      )}
      {run.errors.length > 0 && (
        <div>
          <div className="mb-1 flex items-center gap-3">
            <span className="font-medium text-red-300">Errors ({run.errorCount})</span>
            {!live && <button className="btn text-xs" onClick={() => { if (confirm('Retry all failed items? (Same safety rules apply.)')) post('/api/run/retry', { confirm: true }); }}>Retry failed</button>}
          </div>
          <div className="max-h-64 overflow-auto text-xs">
            {run.errors.map((e) => (
              <div key={e.id} className="border-t border-zinc-800 py-1">
                <span className="font-medium">{e.name}</span> <span className="text-zinc-500">({e.tag})</span> — <span className="text-red-300">{e.error}</span>
                <div className="break-all text-zinc-500">{e.src}</div>
              </div>
            ))}
          </div>
          <div className="mt-1 text-xs text-zinc-500">Locked/in-use files are skipped and never deleted. Close the program using them, then Retry.</div>
        </div>
      )}
    </section>
  );
}
