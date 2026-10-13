'use strict';
// Plan + execution routes.
const { buildPlan, planToCsv } = require('./plan');
const { Journal } = require('./journal');
const { listDrives } = require('./drives');

function register({ app, route, json, readBody }) {
  const journal = new Journal(app.dataDir);
  app.journal = journal;
  app.plan = journal.load();

  const planView = (plan) => plan && ({
    id: plan.id, createdAt: plan.createdAt, sum: plan.sum, moves: plan.moves, space: plan.space, warnings: plan.warnings,
    blockers: plan.blockers, undecided: plan.undecided, destRoot: plan.destRoot, companyRoot: plan.companyRoot,
    settings: plan.settings, requiresDelete: plan.requiresDelete, mode: plan.mode, opCount: plan.ops.length,
    counts: countStatuses(plan),
  });
  const countStatuses = (plan) => { const c = {}; for (const o of plan.ops) c[o.status] = (c[o.status] || 0) + 1; return c; };
  app.planView = planView;

  route('POST', '/api/plan/build', async (req, res) => {
    if (app.runner && app.runner.active()) return json(res, { error: 'A run is in progress.' }, 409);
    if (!app.db.meta) return json(res, { error: 'Scan first.' }, 400);
    const drives = await listDrives();
    const plan = await buildPlan({ db: app.db, settings: app.settings, guard: app.guard, drives });
    if (app.plan && app.plan.ops.some((o) => o.status !== 'pending')) journal.archive();
    journal.savePlan(plan);
    app.plan = plan;
    json(res, planView(plan));
  });

  route('GET', '/api/plan', async (req, res) => json(res, { plan: planView(app.plan) }));

  route('GET', '/api/plan/ops', async (req, res, url) => {
    if (!app.plan) return json(res, { ops: [], total: 0 });
    const q = Object.fromEntries(url.searchParams);
    let ops = app.plan.ops;
    if (q.action) ops = ops.filter((o) => o.action === q.action);
    if (q.tag) ops = ops.filter((o) => o.tag === q.tag);
    if (q.status) ops = ops.filter((o) => o.status === q.status);
    const off = Number(q.offset) || 0; const lim = Math.min(500, Number(q.limit) || 100);
    json(res, { total: ops.length, ops: ops.slice(off, off + lim) });
  });

  route('GET', '/api/plan/csv', async (req, res) => {
    if (!app.plan) return json(res, { error: 'no plan' }, 404);
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="handover-plan.csv"' });
    res.end('﻿' + planToCsv(app.plan));
  });

  try { require('./run-routes').register({ app, route, json, readBody, journal }); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
}

module.exports = { register };
