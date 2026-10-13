@echo off
title Laptop Handover Tool
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer was not found in PATH. Install it or run from a shell that has it.
  pause
  exit /b 1
)
echo Starting Laptop Handover Tool in LIVE mode ^(destructive actions need Preview + Confirm^)...
node --max-old-space-size=4096 server\index.js --live
pause
