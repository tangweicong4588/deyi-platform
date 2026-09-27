/**
 * modules/agents/routes.mjs —— Agent 编排运行时 HTTP 立面（V4.2）。
 *
 * Agent 注册/版本/执行/审批。鉴权链：authenticate → 项目归属 → 角色等级 →
 * 策略 decide（agent.read viewer+ / agent.write operator+）。
 */
import { sendJson } from '../../kernel/http.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { ctx, runWithContext } from '../../kernel/context.mjs';
import { authenticate, effectiveRank } from '../identity/middleware.mjs';
import { getProject } from '../identity/store.mjs';
import { decide, inputFromRequest } from '../policy/index.mjs';
import { db } from '../../db/index.mjs';
import * as a from './agents.mjs';

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
      throw Errors.forbidden('禁止跨项目操作 Agent 域');
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

export function registerAgentRoutes(app) {
  // 注册 Agent
  app.post(R('/agents'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1);
    await policyCheck({ actor, tenantId, project, action: 'agent.write', resource: { kind: 'agent' } });
    const b = req.body || {};
    const out = await withTenant(tenantId, () => a.registerAgent({
      tenantId, projectId: project.id, actorId: actor.id,
      key: b.key, name: b.name, description: b.description ?? null,
    }));
    sendJson(res, 201, { data: out });
  });

  // Agent 列表
  app.get(R('/agents'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0);
    await policyCheck({ actor, tenantId, project, action: 'agent.read', resource: { kind: 'agent' } });
    const out = await withTenant(tenantId, () => a.listAgents({ tenantId, projectId: project.id }));
    sendJson(res, 200, { data: out });
  });

  // Agent 详情（含版本列表）
  app.get(R('/agents/:agentId'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0);
    await policyCheck({ actor, tenantId, project, action: 'agent.read', resource: { kind: 'agent' } });
    const out = await withTenant(tenantId, () => a.getAgent({ tenantId, agentId: req.params.agentId }));
    sendJson(res, 200, { data: out });
  });

  // 发版（不可变版本快照）
  app.post(R('/agents/:agentId/versions'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1);
    await policyCheck({ actor, tenantId, project, action: 'agent.write', resource: { kind: 'agent' } });
    const out = await withTenant(tenantId, () => a.createAgentVersion({
      tenantId, projectId: project.id, actorId: actor.id,
      agentId: req.params.agentId, definition: (req.body || {}).definition,
    }));
    sendJson(res, 201, { data: out });
  });

  // 启动执行
  app.post(R('/agents/:agentId/runs'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1);
    await policyCheck({ actor, tenantId, project, action: 'agent.write', resource: { kind: 'agent_run' } });
    const b = req.body || {};
    const out = await withTenant(tenantId, () => a.startRun({
      tenantId, projectId: project.id, actorId: actor.id,
      agentId: req.params.agentId, version: b.version ?? null,
      input: b.input || {}, mode: b.mode || 'live',
      bizTaskId: b.biz_task_id || null, // V4.5：为任务执行时登记成本归因边
    }));
    sendJson(res, 201, { data: out });
  });

  // 执行记录列表
  app.get(R('/agents/:agentId/runs'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0);
    await policyCheck({ actor, tenantId, project, action: 'agent.read', resource: { kind: 'agent_run' } });
    const out = await withTenant(tenantId, () => a.listRuns({
      tenantId, projectId: project.id, agentId: req.params.agentId,
      status: req.query?.status || null, limit: req.query?.limit,
    }));
    sendJson(res, 200, { data: out });
  });

  // 执行记录详情（含步骤与审批单）
  app.get(R('/agent-runs/:runId'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0);
    await policyCheck({ actor, tenantId, project, action: 'agent.read', resource: { kind: 'agent_run' } });
    const out = await withTenant(tenantId, () => a.getRun({
      tenantId, projectId: project.id, runId: req.params.runId,
    }));
    sendJson(res, 200, { data: out });
  });

  // 审批决议（SoD：不能批自己的 run）
  app.post(R('/agent-runs/:runId/approve'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1);
    await policyCheck({ actor, tenantId, project, action: 'agent.write', resource: { kind: 'agent_approval' } });
    const b = req.body || {};
    if (typeof b.approved !== 'boolean') throw Errors.badRequest('approved 必须是布尔值');
    const out = await withTenant(tenantId, () => a.decideApproval({
      tenantId, projectId: project.id, actorId: actor.id,
      runId: req.params.runId, approved: b.approved, note: b.note ?? null,
    }));
    sendJson(res, 200, { data: out });
  });
}
