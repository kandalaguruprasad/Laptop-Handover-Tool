# Decisions

Where the spec was silent I picked the simplest safe option. Everything here was decided without asking.

## Architecture
- **Zero runtime dependencies.** Plain `http`, `worker_threads`, `child_process`. So "production node_modules" is empty and nothing needs `npm install` on the laptop. Only the UI has dev dependencies (`ui/`), and its build output is committed in `public/`.
- **State = NDJSON/JSON files in `data/`** (no SQLite): `scan.ndjson` (one line per item), `tags.json` (path → tag, written atomically), `settings.json`, `plan.json` + `journal.ndjson`. `node:sqlite` needs Node 22+, `better-sqlite3` needs a native binary; neither is worth the risk on a locked-down laptop. The whole scan lives in memory (200k files ≈ 160 MB heap, reload < 1 s). `start.bat` raises the heap to 4 GB for 500k+ files.
- **Tags are keyed by path**, not scan row, so re-scans keep them. Tags for paths that no longer exist are dropped at re-scan.
- Scan and execution each run in a worker thread; progress goes to the UI over SSE.
- Server binds `127.0.0.1`, random token per launch (header `x-token` or `?token=` for `<img>`/SSE/download), and rejects non-loopback `Host` headers (DNS-rebinding). Thumbnails are served by **item id** from the scan DB only; no path ever comes from the client. Originals are served as thumbnails (browser downscales, lazy-loaded, files > 25 MB and cloud-synced files are not served).

## Safety model
- Three modes: **sandbox** (`--sandbox <dir>`: every write/delete must be inside that dir), **live** (`--live`, what `start.bat` passes), **read-only** (neither flag: scan/tag/preview only). Plain `node server/index.js` therefore can never delete anything.
- All destructive primitives are in `fsops.js` and call `guard.assertWritable()` first (refuses drive roots, Windows/Program Files/ProgramData/Recycle Bin/System Volume Information, anything outside the sandbox).
- Removal of a source additionally requires it to lie inside a scanned root and its op to be `verified` (journaled) in the same run; when resuming from `verified`, it is **re-verified** before anything is deleted.
- Running requires: no blockers, preview-confirm checkbox, `DELETE` typed when any Ignore item remains, and the plan must still match current tags (otherwise HTTP 409 "stale plan").
- Ignore/removal go to the Recycle Bin via PowerShell `Microsoft.VisualBasic.FileIO` with `OnlyErrorDialogs` (as specified). Files too large for the Recycle Bin are permanently deleted by Windows; the confirm screen says so. Permanent delete only with the setting.
- **Recycle Bin contents still occupy the laptop's disk** — empty it at the very end.
- Regenerable dirs are purged with the fast method (robocopy of an empty dir `/MIR`, then `rmdir`, falling back to `fs.rm`).

## Scanner
- Metadata only (`opendir` + `lstat`), never opens file contents. Symlinks/junctions skipped. OneDrive placeholders are ordinary `lstat` entries, so no hydration.
- "Hidden/system files skipped" is implemented by name: dot-files, `~$*`, `desktop.ini`, `thumbs.db`, `ntuser.*` (reading Windows attribute bits would need a process per file).
- `node_modules` is skipped **everywhere**, even outside a detected project (a stray one would otherwise add 100k junk rows). Other regenerable names apply only inside projects. `target`/`bin` only count with a sibling `Cargo.toml`/`pom.xml`/`.csproj`.
- Default scan roots: Desktop, Documents, Downloads, Pictures, Videos, Music, plus `OneDrive*`/`Dropbox*`/`Google Drive*` folders found in the profile. Other top-level profile folders are offered as one-click additions in Settings (not default, because the profile root also holds junk like `.vscode`, `.npm`, `AppData`).
- Project size/file count exclude regenerable dirs; "last modified" ignores `.git` internals. Git info: remote and branch are parsed from `.git/config`/`HEAD` (no process); dirty and unpushed counts use the `git` CLI (30 s timeout per command, skipped if git is missing). "Unpushed" = commits not reachable from any remote ref (`rev-list HEAD --not --remotes`), so it also works when no upstream is set. `GIT_CEILING_DIRECTORIES` stops git from discovering an enclosing repo.

## Suggestions
- Never applied automatically; shown as dashed chips (click one chip to accept it). Precedence for files: Ignore rules (`.exe .msi .iso .dmg .tmp .log`, old Downloads) → Mine rules (images/videos/documents under Pictures/Videos/Desktop/Documents). Git patterns are substring matches on a normalised remote (`git@github.com:acme/x.git` ≡ `https://github.com/acme/x`), Company wins over Mine.
- Duplicates: only on demand (same size → SHA-256); skips cloud-synced files and files < 1 KB. "Keep one" keeps an already-tagged (non-Ignore) copy, else the oldest; it never overrides an existing tag.

## Plan / execution
- Layout: Mine projects → `<Disk>\Laptop_Backup\Projects\<Name>`; Mine files → `<Disk>\Laptop_Backup\<Category>\<path relative to profile (or scan root name)>`; Company → `C:\Company_Handover\<Name>` and `...\Files\<relative path>`. Collisions get ` (2)`. If an identical copy already exists from an earlier run it is reused instead of creating ` (2)`.
- Order: Company → Mine → Ignore; projects one at a time (robocopy already uses 16 threads), loose files 8 at a time, Ignore files in batches of 200 per PowerShell call (start-up cost), projects in batches of 5.
- robocopy: `/E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /MT:16 /NP /XD <regenerable>` plus `/XJ /XJF /XJD` so it skips exactly what the verifier skips (symlinks/junctions). Output is streamed to `data\logs\robocopy-<op>.log` instead of `/LOG+:` (avoids quoting problems with paths containing spaces). Exit codes < 8 = success.
- Verification: folders = file count + total size (same regenerable exclusions on both sides); files = size + mtime (2.5 s tolerance for exFAT/FAT). `copyFile` copies then restores mtime. Paranoid = SHA-256 of every file.
- Company same volume → `rename` (instant; falls back to copy+verify+remove on `EXDEV`); regenerable dirs are then purged in the destination if the setting is on.
- Drive removed mid-copy: the destination is re-checked on every failure; if gone, the run **pauses** with a message, the op stays `copying`, and Resume redoes it. Locked files fail only that item (source untouched) and appear in the error list; Retry re-runs failed items with the same rules.
- Journal: `plan.json` + append-only `journal.ndjson` (fsync per entry); statuses `pending / copying / verified / source-removed / failed`. Restart replays it; finished ops are never re-run. Folders left empty by the run are removed (never a scan root) — setting.
- After a run, executed items are dropped from the review list; a re-scan reconciles the rest and keeps their tags.
- A `Mine` removal sends the (regenerable-purged) source to the Recycle Bin, as specified.

## Known limits (not tested on real Windows in this environment)
- The Windows-only code paths (robocopy, PowerShell Recycle Bin, drive listing via CIM) were written to spec but could only be exercised via Node fallbacks on Linux. Run `sandbox.bat` on the laptop first; it uses the real robocopy/PowerShell code against the fake tree.
- Paths over 260 chars: Node file APIs use `\\?\`, robocopy handles them natively, but the PowerShell Recycle Bin call may fail for them; those items show up in the error list rather than being deleted.
- Ignore files go to the Recycle Bin one by one, which is slow for 100k+ files (hours). Prefer tagging whole junk folders' *projects* Ignore, or delete obvious junk by hand first.
- Tagging a folder tags all scanned items under it, including projects.
