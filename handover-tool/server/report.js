'use strict';
const fs = require('fs');
const path = require('path');
const { planToCsv } = require('./plan');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return `${n.toFixed(i ? 1 : 0)} ${u[i]}`; };

function reportHtml(plan, extra = {}) {
  const by = {}; for (const o of plan.ops) { const k = o.tag + ' / ' + o.status; by[k] = (by[k] || 0) + 1; }
  const failed = plan.ops.filter((o) => o.status === 'failed');
  const rows = plan.ops.slice(0, 20000).map((o) => `<tr class="${esc(o.status)}"><td>${esc(o.name)}</td><td>${esc(o.tag)}</td><td>${esc(o.action)}</td><td>${esc(o.src)}</td><td>${esc(o.dst || (o.action === 'recycle' ? 'Recycle Bin' : ''))}</td><td>${fmt(o.bytes)}</td><td>${esc(o.status)}</td><td>${esc(o.error || '')}</td></tr>`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Laptop handover report</title>
<style>body{font:14px system-ui;margin:24px;background:#111;color:#ddd}table{border-collapse:collapse;width:100%}td,th{border:1px solid #333;padding:4px 8px;text-align:left;vertical-align:top;word-break:break-all}.failed{background:#3a1515}.source-removed td:last-child{color:#7c7}h1,h2{font-weight:600}</style></head><body>
<h1>Laptop handover report</h1>
<p>Generated ${new Date().toISOString()} · mode ${esc(plan.mode)} · plan ${esc(plan.id)}</p>
<h2>Summary</h2><ul>${Object.entries(by).map(([k, v]) => `<li>${esc(k)}: ${v}</li>`).join('')}</ul>
<p>Company: ${plan.sum.company.items} items (${fmt(plan.sum.company.bytes)}) · Mine: ${plan.sum.mine.items} (${fmt(plan.sum.mine.bytes)}) · Ignore: ${plan.sum.ignore.items} (${fmt(plan.sum.ignore.bytes)}) · Undecided (untouched): ${plan.undecided}</p>
<p>Empty folders removed: ${extra.emptyDirsRemoved || 0} · Failed: ${failed.length}</p>
${failed.length ? `<h2>Failures</h2><ul>${failed.map((o) => `<li>${esc(o.src)} — ${esc(o.error)}</li>`).join('')}</ul>` : ''}
<h2>Items</h2><table><tr><th>Item</th><th>Tag</th><th>Action</th><th>Source</th><th>Destination</th><th>Size</th><th>Status</th><th>Error</th></tr>
${rows}</table>${plan.ops.length > 20000 ? '<p>Truncated — see manifest.csv for all rows.</p>' : ''}</body></html>`;
}

/** Writes report.html + manifest.csv to the app data folder and (if present) <disk>\\Laptop_Backup. */
function writeReports(plan, dataDir, extra = {}) {
  const html = reportHtml(plan, extra);
  const csv = '﻿' + planToCsv(plan);
  const targets = [dataDir];
  if (plan.destRoot && fs.existsSync(plan.destRoot)) targets.push(plan.destRoot);
  const written = [];
  for (const dir of targets) {
    try {
      fs.writeFileSync(path.join(dir, 'report.html'), html);
      fs.writeFileSync(path.join(dir, 'manifest.csv'), csv);
      written.push(dir);
    } catch { /* destination may be gone */ }
  }
  return written;
}

module.exports = { reportHtml, writeReports };
