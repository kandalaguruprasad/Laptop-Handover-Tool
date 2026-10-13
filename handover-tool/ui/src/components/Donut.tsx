import { useState } from 'react';

export interface Slice { label: string; value: number; color: string; onClick?: () => void; hint?: string }
export const PALETTE = ['#38bdf8', '#4ade80', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c', '#2dd4bf', '#f87171', '#94a3b8'];

function arc(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number) {
  const p = (r: number, a: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = p(r1, a0), [x1, y1] = p(r1, a1), [x2, y2] = p(r0, a1), [x3, y3] = p(r0, a0);
  return `M${x0},${y0} A${r1},${r1} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${r0},${r0} 0 ${large} 0 ${x3},${y3} Z`;
}

/** SVG donut chart with hover tooltips, optional click, centre text and a legend. */
export function Donut({ slices, size = 220, center, fmt, legend = true }: { slices: Slice[]; size?: number; center?: { title: string; sub?: string }; fmt: (n: number) => string; legend?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  const c = size / 2; const r1 = size / 2 - 4; const r0 = r1 * 0.62;
  let a = -Math.PI / 2;
  const arcs = slices.filter((s) => s.value > 0).map((s) => {
    const span = (s.value / total) * Math.PI * 2; const a0 = a; a += span;
    return { s, d: span >= Math.PI * 2 - 1e-6 ? arc(c, c, r0, r1, a0, a0 + Math.PI * 2 - 0.0001) : arc(c, c, r0, r1, a0, a0 + span) };
  });
  const h = hover !== null ? arcs[hover] : null;
  return (
    <div className="flex flex-wrap items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        {arcs.map((x, i) => (
          <path key={i} d={x.d} fill={x.s.color} opacity={hover === null || hover === i ? 1 : 0.45} className={x.s.onClick ? 'cursor-pointer' : ''}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onClick={x.s.onClick}>
            <title>{`${x.s.label}: ${fmt(x.s.value)} (${Math.round((x.s.value / total) * 100)}%)`}</title>
          </path>
        ))}
        <text x={c} y={c - 4} textAnchor="middle" className="fill-zinc-100" style={{ fontSize: 20, fontWeight: 600 }}>{h ? fmt(h.s.value) : center?.title}</text>
        <text x={c} y={c + 16} textAnchor="middle" className="fill-zinc-400" style={{ fontSize: 11 }}>{h ? `${Math.round((h.s.value / total) * 100)}% · ${h.s.label.slice(0, 22)}` : center?.sub}</text>
      </svg>
      {legend && (
        <div className="min-w-[12rem] flex-1 space-y-1 text-xs">
          {slices.filter((s) => s.value > 0).map((s, i) => (
            <div key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onClick={s.onClick} className={`flex items-center gap-2 rounded px-1 ${s.onClick ? 'cursor-pointer hover:bg-zinc-800' : ''}`} title={s.hint}>
              <span className="inline-block h-3 w-3 shrink-0 rounded-sm" style={{ background: s.color }} />
              <span className="min-w-0 flex-1 truncate">{s.label}</span>
              <span className="text-zinc-400">{fmt(s.value)}</span>
              <span className="w-9 text-right text-zinc-500">{Math.round((s.value / total) * 100)}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Top N slices + "Other". */
export function topSlices(items: { label: string; value: number; onClick?: () => void; hint?: string }[], n = 8): Slice[] {
  const sorted = [...items].sort((x, y) => y.value - x.value);
  const head = sorted.slice(0, n).map((x, i) => ({ ...x, color: PALETTE[i % (PALETTE.length - 1)] }));
  const rest = sorted.slice(n).reduce((a, x) => a + x.value, 0);
  return rest > 0 ? [...head, { label: `Other (${sorted.length - n} more)`, value: rest, color: PALETTE[8] }] : head;
}
