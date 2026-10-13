export function fmtBytes(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}
export function fmtDate(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
export const TAG_LABEL: Record<string, string> = { company: 'Company', mine: 'Mine', ignore: 'Ignore' };
export const TAG_CLASS: Record<string, string> = {
  company: 'bg-sky-500/20 text-sky-300 border-sky-500/50',
  mine: 'bg-green-500/20 text-green-300 border-green-500/50',
  ignore: 'bg-red-500/20 text-red-300 border-red-500/50',
};
export const TAB_LABEL: Record<string, string> = {
  projects: 'Projects', images: 'Images', videos: 'Videos', documents: 'Documents', audio: 'Audio',
  archives: 'Archives', installers: 'Installers', other: 'Other', all: 'All',
};
export const TAB_ICON: Record<string, string> = { projects: '📁', images: '🖼️', videos: '🎬', documents: '📄', audio: '🎵', archives: '🗜️', installers: '⚙️', other: '📎' };
