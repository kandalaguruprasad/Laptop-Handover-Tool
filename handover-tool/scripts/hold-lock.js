'use strict';
// Windows only: holds an exclusive lock on a file so you can see the "locked file" path in the Execute screen.
//   node scripts/hold-lock.js sandbox\\profile\\Documents\\locked\\in-use.docx [seconds]
const { spawn } = require('child_process');
const path = require('path');
const file = path.resolve(process.argv[2] || '');
const secs = Number(process.argv[3]) || 600;
if (process.platform !== 'win32') { console.log('Only meaningful on Windows (other platforms do not lock open files).'); process.exit(0); }
const ps = `$f=[IO.File]::Open('${file.replace(/'/g, "''")}','Open','ReadWrite','None'); Write-Host 'LOCKED'; Start-Sleep ${secs}; $f.Close()`;
const c = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
console.log(`Holding ${file} for ${secs}s. Ctrl+C to release.`);
c.on('exit', () => process.exit(0));
