@echo off
title Laptop Handover Tool - SANDBOX
cd /d "%~dp0"
echo Creating a fake laptop under .\sandbox and starting the tool against it. Nothing real is touched.
node scripts\make-fixtures.js sandbox --force
node --max-old-space-size=4096 server\index.js --sandbox sandbox
pause
