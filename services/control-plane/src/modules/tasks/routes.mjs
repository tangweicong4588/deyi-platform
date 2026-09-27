/**
 * modules/tasks/routes.mjs —— 业务任务域 HTTP 立面（V4.1）。
 *
 * 工单 / 审批单 / 文档处理任务：创建、状态流转、改派、审批决议、SLA 扫描。
 * 鉴权链：authenticate → 项目归属（租户隔离）→ 角色等级 →
 * 策略 decide（tasks.read viewer+ / tasks.write operator+）。
 */
import { sendJson } from '../../kernel/http.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { ctx, runWithContext } from '../../kernel/context.mjs';
import { authenticate, effectiveRank, requireScope } from '../identity/middleware.mjs';
import { getProject } from '../identity/store.mjs';
import { decide, inputFromRequest } from '../policy/index.mjs';
import { db } from '../../db/index.mjs';
import * as t from './task.mjs';
import { tryAudit } from '../evidence/audit.mjs';
import { getTaskCost } from './cost.mjs';

async function scopedProject(req, minRank, opName) {
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
      throw Errors.forbidden('禁止跨项目操作任务域');
    }
  }
  if (!project || project.status !== 'active') throw Errors.forbidden('项目不存在或无权访问');
  if (effectiveRank(roles, project.id) < minRank) {
    // V4.6：角色门槛拒绝记审计（越权发起可查）
    await tryAudit({
      tenantId: project.tenant_id, projectId: project.id, actorId: c.actorId,
      action: 'biz_task.access.denied',
      resourceKind: 'biz_task', resourceId: null,
      payload: { op: opName || null, reason: `需要项目 ${minRank >= 1 ? 'operator' : 'viewer'} 及以上角色` },
    });
    throw Errors.forbidden(minRank >= 1 ? '需要项目 operator 及以上角色' : '需要项目 viewer 及以上角色');
  }
  const tenantId = project.tenant_id;
  const actor = { id: c.actorId, kind: c.actorKind, status: 'active', roles };
  return { c, project, tenantId, actor, roles };
}

async function policyCheck({ actor, tenantId, project, action, resource }) {
  const receipt = await decide(inputFromRequest({
    actor,
    tenant: { id: tenantId, status: 'active' },
    project: { id: project.id },
    action, resource: resource || {},
    context: {},
  }));
  if (!receipt.allow) {
    // V4.6：越权尝试记审计，满足"审计可查"
    await tryAudit({
      tenantId, projectId: project.id, actorId: actor.id, action: 'biz_task.access.denied',
      resourceKind: (resource && resource.kind) || 'biz_task', resourceId: (resource && resource.id) || null,
      payload: { policy_action: action, reason: receipt.reason },
    });
    throw Errors.policyDenied(receipt.reason, { receipt });
  }
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

export function registerTaskRoutes(app) {
  app.post(R('/tasks'), authenticate, requireScope('tasks.write'), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'task.create');
    await policyCheck({ actor, tenantId, project, action: 'tasks.write', resource: { kind: 'biz_task' } });
    const out = await withTenant(tenantId, () => t.createTask({
      tenantId, projectId: project.id, actorId: actor.id, body: req.body || {},
    }));
    sendJson(res, 201, { data: out });
  });

  app.get(R('/tasks'), authenticate, requireScope('tasks.read'), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'task.list');
    await policyCheck({ actor, tenantId, project, action: 'tasks.read', resource: { kind: 'biz_task' } });
    const { status, kind, assigneeId, escalated } = req.query || {};
    sendJson(res, 200, {
      data: await t.listTasks(tenantId, project.id, {
        status, kind, assigneeId,
        escalated: escalated === undefined ? undefined : escalated === 'true',
      }),
    });
  });

  app.get(R('/tasks/:taskId'), authenticate, requireScope('tasks.read'), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'task.get');
    await policyCheck({ actor, tenantId, project, action: 'tasks.read', resource: { kind: 'biz_task' } });
    sendJson(res, 200, { data: await t.getTask(tenantId, project.id, req.params.taskId) });
  });

  // V4.5：任务成本视图（viewer+）——任务成本 == 其下 trace 的网关计量之和
  app.get(R('/tasks/:taskId/cost'), authenticate, requireScope('tasks.read'), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'task.cost');
    await policyCheck({ actor, tenantId, project, action: 'tasks.read', resource: { kind: 'biz_task' } });
    const out = await withTenant(tenantId, () => getTaskCost({ tenantId, projectId: project.id, taskId: req.params.taskId }));
    sendJson(res, 200, { data: out });
  });

  app.post(R('/tasks/:taskId/transition'), authenticate, requireScope('tasks.write'), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'task.transition');
    await policyCheck({ actor, tenantId, project, action: 'tasks.write', resource: { kind: 'biz_task' } });
    const { to, note } = req.body || {};
    if (!to) throw Errors.badRequest('to 必填');
    const out = await withTenant(tenantId, () => t.transitionTask({
      tenantId, projectId: project.id, actorId: actor.id,
      taskId: req.params.taskId, to, note,
    }));
    sendJson(res, 200, { data: out });
  });

  app.post(R('/tasks/:taskId/assign'), authenticate, requireScope('tasks.write'), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'task.assign');
    await policyCheck({ actor, tenantId, project, action: 'tasks.write', resource: { kind: 'biz_task' } });
    const out = await withTenant(tenantId, () => t.assignTask({
      tenantId, projectId: project.id, actorId: actor.id,
      taskId: req.params.taskId, assigneeId: (req.body || {}).assigneeId || null,
    }));
    sendJson(res, 200, { data: out });
  });

  app.post(R('/tasks/:taskId/decide'), authenticate, requireScope('tasks.write'), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'task.decide');
    await policyCheck({ actor, tenantId, project, action: 'tasks.write', resource: { kind: 'biz_task' } });
    const { approved, note } = req.body || {};
    if (approved === undefined) throw Errors.badRequest('approved 必填（布尔值）');
    const out = await withTenant(tenantId, () => t.decideTask({
      tenantId, projectId: project.id, actorId: actor.id,
      taskId: req.params.taskId, approved: !!approved, note,
    }));
    sendJson(res, 200, { data: out });
  });

  app.post(R('/tasks/sla-sweep'), authenticate, requireScope('tasks.write'), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'task.sla-sweep');
    await policyCheck({ actor, tenantId, project, action: 'tasks.write', resource: { kind: 'biz_task' } });
    const out = await withTenant(tenantId, () => t.slaSweep({
      tenantId, projectId: project.id, actorId: actor.id,
    }));
    sendJson(res, 200, { data: out });
  });
}
