'use strict';
const fs = require('fs');
const path = require('path');
const { createRunner } = require('./runner');
const { isDone } = require('./executor');

function register({ app, route, json, readBody }) {
  app.runner = createRunner(app);

  route('GET', '/api/run', async (req, res) => json(res, app.runner.view()));

  route('POST', '/api/run/start', async (req, res) => {
    const b = await readBody(req);
    const plan = app.plan;
    if (!plan) return json(res, { error: 'Build a plan first.' }, 400);
    if (app.runner.active()) return json(res, { error: 'Already running.' }, 409);
    if (!app.guard.destructiveEnabled) return json(res, { error: 'Read-only mode: restart with --live (or --sandbox).' }, 403);
    if (plan.blockers.length) return json(res, { error: 'Plan has blockers: ' + plan.blockers.join(' | ') }, 400);
    if (b.confirm !== true) return json(res, { error: 'Confirmation required.' }, 400);
    // the preview the user confirmed must still match the tags in the DB
    const { key } = require('./platform');
    const stale = plan.ops.filter((o) => !isDone(o) && o.status === 'pending').find((o) => {
      const id = app.db.byPath.get(key(o.src));
      return id === undefined || app.db.items[id].tag !== o.tag;
    });
    if (stale) return json(res, { error: `Plan is stale (tags changed for ${stale.src}). Build the plan again.` }, 409);
    const pendingIgnore = plan.ops.filter((o) => o.tag === 'ignore' && !isDone(o)).length;
    if (pendingIgnore && b.deleteWord !== 'DELETE') return json(res, { error: 'Type DELETE to confirm deleting the Ignore set.' }, 400);
    json(res, { started: app.runner.start() });
  });

  route('POST', '/api/run/pause', async (req, res) => { app.runner.send({ type: 'pause' }); json(res, { ok: true }); });
  route('POST', '/api/run/resume', async (req, res) => { app.runner.send({ type: 'resume' }); json(res, { ok: true }); });
  route('POST', '/api/run/cancel', async (req, res) => { app.runner.send({ type: 'cancel' }); json(res, { ok: true }); });
  route('POST', '/api/run/retry', async (req, res) => {
    if (app.runner.active()) return json(res, { error: 'Already running.' }, 409);
    if (!app.plan) return json(res, { error: 'No plan.' }, 400);
    const b = await readBody(req);
    if (b.confirm !== true) return json(res, { error: 'Confirmation required.' }, 400);
    app.runner.retryFailed();
    json(res, { started: app.runner.start() });
  });

  route('GET', '/api/report', async (req, res) => {
    const f = path.join(app.dataDir, 'report.html');
    if (!fs.existsSync(f)) return json(res, { error: 'No report yet.' }, 404);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(f));
  });
}

module.exports = { register };
