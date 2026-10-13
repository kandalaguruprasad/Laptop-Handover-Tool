export type Tag = 'company' | 'mine' | 'ignore';
export type GitInfo = { remote: string | null; branch: string | null; dirty: number | null; unpushed: number | null } | null;

export interface Item {
  id: number; kind: 'f' | 'p'; p: string; n: string; e: string; s: number; m: number; c: string; d: string;
  tag: Tag | null; sug: Tag | null; cloud: boolean; stack?: string; git?: GitInfo; fc?: number;
}
export interface GroupRow { t: 'g'; folder: string; count: number; bytes: number; tags: { company: number; mine: number; ignore: number; none: number } }
export type Row = Item | GroupRow;
export const isGroup = (r: Row): r is GroupRow => (r as GroupRow).t === 'g';

export interface Filter {
  tab: string; q: string; tag: string; minSize: string; maxSize: string; from: string; to: string; ext: string;
  group: boolean; sort: string; dir: 'asc' | 'desc';
}

export interface Settings {
  scanRoots: string[]; includeAppData: boolean; regenDirs: string[]; companyPatterns: string[]; minePatterns: string[];
  destDisk: string; permanentDelete: boolean; deleteSourceAfterCopy: boolean; paranoidHash: boolean;
  companyFolder: string; purgeCompanyRegen: boolean; downloadsOlderThanDays: number; cleanEmptyDirs: boolean; profileRoot: string;
}

export interface TabStat { n: number; bytes: number; undecided: number; suggested: number }
export interface Summary {
  by: Record<'company' | 'mine' | 'ignore' | 'undecided', { n: number; bytes: number }>;
  tabs: Record<string, TabStat>; scanned: boolean; meta: any; undo: { label: string; count: number; steps: number } | null;
}
export interface ScanState { running: boolean; stats: any; current: string; error: string | null; startedAt: number; lastDone: number | null }
export interface AppState { mode: 'sandbox' | 'live' | 'readonly'; sandbox: string | null; settings: Settings; scan: ScanState; summary: Summary; platform: string; dataDir: string }
export interface Drive { path: string; label: string; fs: string; total: number; free: number; used: number; removable: boolean; system: boolean }
