# Laptop Handover Tool
1. Double-click `start.bat` (Node 18+ only; no install, no admin, no internet). It opens http://127.0.0.1 with a per-launch token.
2. Storage -> Scan. Settings -> add your git patterns (Company / Mine) and the hard-disk destination.
3. Review: tag items Company / Mine / Ignore (keys C / M / I), Accept suggestions, "Group by folder" for photo dumps.
4. Execute -> Build plan -> read the preview -> tick confirm (+ type DELETE if anything is Ignore) -> Run. Untagged items are never touched.
5. REAL-RUN CHECKLIST: Scan -> tag a few -> Preview -> run ONE tiny test item first -> check the result -> then the rest -> empty the Recycle Bin.
6. Practice first: `sandbox.bat` runs everything against a fake laptop tree (`npm test` runs the automated tests).
7. Safety: a source is removed only after that item verified; Ignore goes to the Recycle Bin; a crash/restart resumes from the journal.
8. Output: `report.html` + `manifest.csv` in `data\` and `<disk>\Laptop_Backup\`. Design notes and trade-offs: `DECISIONS.md`.
