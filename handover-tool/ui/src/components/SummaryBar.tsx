import type { Summary } from '../types';
import { fmtBytes } from '../util';

const CELLS: [keyof Summary['by'], string, string][] = [
  ['company', 'Company', 'text-sky-300'], ['mine', 'Mine', 'text-green-300'],
  ['ignore', 'Ignore', 'text-red-300'], ['undecided', 'Undecided', 'text-amber-300'],
];

export function SummaryBar({ summary }: { summary: Summary }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-zinc-800 bg-zinc-900 px-4 py-1.5 text-xs">
      {CELLS.map(([k, label, cls]) => (
        <div key={k} className="flex items-baseline gap-1.5">
          <span className={`font-semibold ${cls}`}>{label}</span>
          <span className="text-zinc-200">{summary.by[k].n.toLocaleString()}</span>
          <span className="text-zinc-500">{fmtBytes(summary.by[k].bytes)}</span>
        </div>
      ))}
      {!summary.scanned && <span className="text-zinc-500">No scan yet — go to Storage and start one.</span>}
    </div>
  );
}
