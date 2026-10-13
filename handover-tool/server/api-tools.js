'use strict';
// Routes for the two extra tabs: Apps (uninstall / leftovers / downloaded installers) and Company Groups.
const { createAppsService } = require('./apps');
const { createGroupsService } = require('./groups');
const { createDiskService } = require('./disk');

function register({ app, route, json, readBody }) {
  const apps = createAppsService(app);
  const groups = createGroupsService(app);
  app.appsService = apps; app.groupsService = groups;
  const needLive = (res) => { if (!app.guard.destructiveEnabled) { json(res, { error: 'Read-only mode: restart with --live (or --sandbox).' }, 403); return true; } return false; };
  const execBusy = (res) => { if (app.runner && app.runner.active()) { json(res, { error: 'The Execute run is in progress; wait for it to finish.' }, 409); return true; } return false; };

  // ---------------- Apps ----------------
  route('GET', '/api/apps', async (req, res) => json(res, apps.state()));
  route('POST', '/api/apps/scan', async (req, res) => { await apps.scan(); json(res, apps.state()); });
  route('POST', '/api/apps/preview', async (req, res) => {
    const b = await readBody(req);
    json(res, { items: await apps.preview(Array.isArray(b.ids) ? b.ids.slice(0, 200) : []) });
  });
  route('POST', '/api/apps/run', async (req, res) => {
    const b = await readBody(req);
    if (needLive(res)) return;
    if (b.word !== 'UNINSTALL') return json(res, { error: 'Type UNINSTALL to confirm.' }, 400);
    if (!Array.isArray(b.items) || !b.items.length) return json(res, { error: 'Nothing selected.' }, 400);
    try { apps.startRun(b.items.map((i) => ({ id: String(i.id), leftovers: Array.isArray(i.leftovers) ? i.leftovers.map(String) : [] })), { permanent: !!b.permanent }); }
    catch (e) { return json(res, { error: e.message }, 409); }
    json(res, { started: true });
  });
  route('GET', '/api/apps/run', async (req, res) => json(res, { job: apps.jobView() }));
  route('POST', '/api/apps/run/cancel', async (req, res) => { apps.cancel(); json(res, { ok: true }); });

  route('POST', '/api/installers/scan', async (req, res) => json(res, await apps.scanInstallers()));
  route('GET', '/api/installers', async (req, res) => json(res, apps.installers()));
  route('POST', '/api/installers/delete', async (req, res) => {
    const b = await readBody(req);
    if (needLive(res)) return;
    if (b.word !== 'DELETE') return json(res, { error: 'Type DELETE to confirm.' }, 400);
    const results = await apps.deleteInstallers(Array.isArray(b.ids) ? b.ids.map(String) : [], { permanent: !!(b.permanent || app.settings.permanentDelete) });
    json(res, { results, installers: apps.installers() });
  });

  // ---------------- C Drive ----------------
  const disk = createDiskService(app);
  app.diskService = disk;
  const wrap = (fn) => async (req, res, url) => { try { json(res, await fn(req, res, url)); } catch (e) { json(res, { error: String(e.message || e) }, 400); } };
  route('GET', '/api/disk', wrap(async () => disk.state()));
  route('POST', '/api/disk/scan', async (req, res) => json(res, { started: disk.start() }));
  route('POST', '/api/disk/cancel', async (req, res) => { disk.cancel(); json(res, { ok: true }); });
  route('GET', '/api/disk/list', wrap(async (req, res, url) => disk.list(url.searchParams.get('path') || '')));
  route('GET', '/api/disk/top', wrap(async () => ({ files: disk.topFiles() })));
  route('GET', '/api/disk/categories', wrap(async () => ({ categories: disk.categories() })));
  route('GET', '/api/disk/quick', wrap(async () => ({ items: disk.quickWins() })));
  route('POST', '/api/disk/delete', async (req, res) => {
    const b = await readBody(req);
    if (needLive(res) || execBusy(res)) return;
    if (b.word !== 'DELETE') return json(res, { error: 'Type DELETE to confirm.' }, 400);
    if (!Array.isArray(b.paths) || !b.paths.length) return json(res, { error: 'Nothing selected.' }, 400);
    try { disk.startClean(b.paths.slice(0, 5000).map(String), { permanent: !!b.permanent }); } catch (e) { return json(res, { error: e.message }, 409); }
    json(res, { started: true });
  });
  route('GET', '/api/disk/clean', async (req, res) => json(res, { job: disk.cleanView() }));
  route('POST', '/api/disk/clean/cancel', async (req, res) => { disk.cancelClean(); json(res, { ok: true }); });
  route('POST', '/api/disk/empty-bin', async (req, res) => {
    const b = await readBody(req);
    if (needLive(res) || execBusy(res)) return;
    if (b.word !== 'EMPTY') return json(res, { error: 'Type EMPTY to confirm.' }, 400);
    try { json(res, await disk.emptyRecycleBin()); } catch (e) { json(res, { error: String(e.message || e) }, 400); }
  });

  // ---------------- Company Groups ----------------
  route('GET', '/api/groups', async (req, res) => json(res, groups.view()));
  route('POST', '/api/groups/scan', async (req, res) => {
    const b = await readBody(req);
    json(res, { started: await groups.scan(b.root === 'files' ? 'files' : 'company') });
  });
  route('POST', '/api/groups/dismiss', async (req, res) => { const b = await readBody(req); groups.dismiss(String(b.key)); json(res, groups.view()); });
  route('POST', '/api/groups/plan', async (req, res) => { const b = await readBody(req); json(res, groups.plan(b.groups)); });
  route('POST', '/api/groups/apply', async (req, res) => {
    const b = await readBody(req);
    if (needLive(res) || execBusy(res)) return;
    if (b.confirm !== true) return json(res, { error: 'Confirmation required.' }, 400);
    try { const log = groups.apply(b.groups); await groups.scan(groups.view().rootKind); json(res, { log }); }
    catch (e) { json(res, { error: e.message }, 400); }
  });
  route('POST', '/api/groups/undo', async (req, res) => {
    if (needLive(res) || execBusy(res)) return;
    try { const r = groups.undo(); await groups.scan(groups.view().rootKind); json(res, r); } catch (e) { json(res, { error: e.message }, 400); }
  });
}

module.exports = { register };
