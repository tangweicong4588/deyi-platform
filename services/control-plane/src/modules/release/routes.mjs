/**
 * modules/release/routes.mjs —— 发布域 HTTP 立面（V3.2）。
 *
 * 环境管理、发布单 CRUD、发布审批（SoD）、启动执行（simulated/runner）、手动回滚。
 * 鉴权链：authenticate → 项目归属 → 角色等级 →
 * 策略 decide（release.read viewer+ / release.write operator+）。
 */
import { sendJson } from '../../kernel/http.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { ctx, runWithContext } from '../../kernel/context.mjs';
import { authenticate, effectiveRank } from '../identity/middleware.mjs';
import { getProject } from '../identity/store.mjs';
import { decide, inputFromRequest } from '../policy/index.mjs';
import { db } from '../../db/index.mjs';
import * as r from './release.mjs';

async function scopedProject(req, minRank) {
  const c = ctx();
  const pid = req.params.projectId;
  let project = null;
  let roles = c.roles || [];
  if (c.authKind === 'operator') {
    const rows = await db().query('SELECT * FROM projects WHERE id=?', [pid]);
    project = rows[0] || null;
    roles = [{ project_id: null, role: 'admin' }];
  } else {
    if (!c.tenantId) throw Errors.unauthorized();
    project = await getProject(c.tenantId, pid).catch(() => null);
    if (c.projectId && c.projectId !== pid) {
      throw Errors.forbidden('禁止跨项目操作发布域');
    }
  }
  if (!project || project.status !== 'active') throw Errors.forbidden('项目不存在或无权访问');
  if (effectiveRank(roles, project.id) < minRank) {
    throw Errors.forbidden(minRank >= 1 ? '需要项目 operator 及以上角色' : '需要项目 viewer 及以上角色');
  }
  const tenantId = project.tenant_id;
  const actor = { id: c.actorId, kind: c.actorKind, status: 'active', roles };
  return { c, project, tenantId, actor };
}

async function policyCheck({ actor, tenantId, project, action, resource }) {
  const receipt = await decide(inputFromRequest({
    actor,
    tenant: { id: tenantId, status: 'active' },
    project: { id: project.id },
    action, resource: resource || {},
    context: {},
  }));
  if (!receipt.allow) throw Errors.policyDenied(receipt.reason, { receipt });
  return receipt;
}

function withTenant(tenantId, fn) {
  const c = ctx();
  if (c.authKind === 'operator' && !c.tenantId) {
    return runWithContext({ ...c, tenantId }, fn);
  }
  return fn();
}

const R = (p) => `/v1/projects/:projectId${p}`;

export function registerReleaseRoutes(app) {
  app.post(R('/deploy-environments/ensure-defaults'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1);
    await policyCheck({ actor, tenantId, project, action: 'release.write', resource: { kind: 'deploy_environment' } });
    const out = await withTenant(tenantId, () => r.ensureDefaultEnvironments(tenantId, project.id, actor.id));
    sendJson(res, 200, { data: out });
  });

  app.post(R('/deploy-environments'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1);
    await policyCheck({ actor, tenantId, project, action: 'release.write', resource: { kind: 'deploy_environment' } });
    const out = await withTenant(tenantId, () => r.createEnvironment(tenantId, project.id, actor.id, req.body || {}));
    sendJson(res, 201, { data: out });
  });

  app.get(R('/deploy-environments'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0);
    await policyCheck({ actor, tenantId, project, action: 'release.read', resource: { kind: 'deploy_environment' } });
    sendJson(res, 200, { data: await r.listEnvironments(tenantId, project.id) });
  });

  app.post(R('/releases'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1);
    await policyCheck({ actor, tenantId, project, action: 'release.write', resource: { kind: 'release' } });
    const out = await withTenant(tenantId, () => r.createRelease({
      tenantId, projectId: project.id, actorId: actor.id, body: req.body || {},
    }));
    sendJson(res, 201, { data: out });
  });

  app.get(R('/releases'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0);
    await policyCheck({ actor, tenantId, project, action: 'release.read', resource: { kind: 'release' } });
    const { status, environment_key } = req.query || {};
    sendJson(res, 200, { data: await r.listReleases(tenantId, project.id, { status, environment_key }) });
  });

  app.get(R('/releases/:releaseId'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0);
    await policyCheck({ actor, tenantId, project, action: 'release.read', resource: { kind: 'release' } });
    sendJson(res, 200, { data: await r.getRelease(tenantId, project.id, req.params.releaseId) });
  });

  app.post(R('/releases/:releaseId/request-approval'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1);
    await policyCheck({ actor, tenantId, project, action: 'release.write', resource: { kind: 'release' } });
    const out = await withTenant(tenantId, () => r.requestApproval({
      tenantId, projectId: project.id, actorId: actor.id, releaseId: req.params.releaseId,
    }));
    sendJson(res, 200, { data: out });
  });

  app.post(R('/releases/:releaseId/approve'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1);
    await policyCheck({ actor, tenantId, project, action: 'release.write', resource: { kind: 'release' } });
    const out = await withTenant(tenantId, () => r.decideApproval({
      tenantId, projectId: project.id, actorId: actor.id,
      releaseId: req.params.releaseId, approved: true, note: (req.body || {}).note,
    }));
    sendJson(res, 200, { data: out });
  });

  app.post(R('/releases/:releaseId/reject'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1);
    await policyCheck({ actor, tenantId, project, action: 'release.write', resource: { kind: 'release' } });
    const out = await withTenant(tenantId, () => r.decideApproval({
      tenantId, projectId: project.id, actorId: actor.id,
      releaseId: req.params.releaseId, approved: false, note: (req.body || {}).note,
    }));
    sendJson(res, 200, { data: out });
  });

  app.post(R('/releases/:releaseId/start'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1);
    await policyCheck({ actor, tenantId, project, action: 'release.write', resource: { kind: 'release' } });
    const out = await withTenant(tenantId, () => r.startRelease({
      tenantId, projectId: project.id, actorId: actor.id,
      releaseId: req.params.releaseId, mode: (req.body || {}).mode || 'simulated',
    }));
    sendJson(res, 200, { data: out });
  });

  app.post(R('/releases/:releaseId/rollback'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1);
    await policyCheck({ actor, tenantId, project, action: 'release.write', resource: { kind: 'release' } });
    const out = await withTenant(tenantId, () => r.rollbackRelease({
      tenantId, projectId: project.id, actorId: actor.id,
      releaseId: req.params.releaseId, mode: (req.body || {}).mode || 'simulated',
    }));
    sendJson(res, 200, { data: out });
  });
}
