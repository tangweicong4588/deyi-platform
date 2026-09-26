/**
 * modules/execution/routes.mjs —— 执行平面 HTTP 立面。
 *
 * POST /v1/projects/:projectId/tools                          注册工具（operator+，走 tool.register 策略）
 * GET  /v1/projects/:projectId/tools                          工具列表（viewer+，不含任何密钥）
 * POST /v1/projects/:projectId/tools/:toolId/invoke            调用（Idempotency-Key 头；高风险→审批流）
 * GET  /v1/projects/:projectId/executions                     执行列表（viewer+）
 * GET  /v1/projects/:projectId/executions/:executionId         执行详情（viewer+）
 * POST /v1/projects/:projectId/approvals/:approvalId/approve    审批通过（operator+）
 * POST /v1/projects/:projectId/approvals/:approvalId/reject     审批驳回（operator+）
 *
 * 鉴权链：authenticate → 项目归属（租户隔离，operator 特殊处理）→ Key 项目绑定检查 →
 * 角色等级 → 策略 decide（tool.invoke 风险分级 / tool.register operator+，
 * 与 P2 规则及 deploy/opa 策略包语义一致）。
 */
import { sendJson } from '../../kernel/http.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { ctx, runWithContext } from '../../kernel/context.mjs';
import { authenticate, effectiveRank } from '../identity/middleware.mjs';
import { getProject } from '../identity/store.mjs';
import { decide, inputFromRequest } from '../policy/index.mjs';
import { db } from '../../db/index.mjs';
import { logger } from '../../kernel/logging.mjs';
import * as svc from './service.mjs';

async function scopedProject(req, minRank, opName) {
  const c = ctx();
  const pid = req.params.projectId;
  let project = null;
  let roles = c.roles || [];
  if (c.authKind === 'operator') {
    const rows = await db().query('SELECT * FROM projects WHERE id=?', [pid]);
    project = rows[0] || null;
    roles = [{ project_id: null, role: 'admin' }];
    logger.warn('execution operator access', { op: opName, projectId: pid, tenant_id: project?.tenant_id });
  } else {
    if (!c.tenantId) throw Errors.unauthorized();
    project = await getProject(c.tenantId, pid).catch(() => null);
    if (c.projectId && c.projectId !== pid) {
      throw Errors.forbidden('禁止跨项目操作');
    }
  }
  if (!project || project.status !== 'active') throw Errors.forbidden('项目不存在或无权访问');
  if (effectiveRank(roles, project.id) < minRank) {
    throw Errors.forbidden(minRank >= 1 ? '需要项目 operator 及以上角色' : '需要项目 viewer 及以上角色');
  }
  const tenantId = project.tenant_id;
  const actor = { id: c.actorId, kind: c.actorKind, status: 'active', roles };
  return { c, project, tenantId, actor, roles };
}

/** operator 运维时把 tenantId 注入上下文（service 内部读 ctx 拿 roles/actorKind） */
function withTenant(tenantId, fn) {
  const c = ctx();
  if (c.authKind === 'operator' && !c.tenantId) {
    return runWithContext({ ...c, tenantId }, fn);
  }
  return fn();
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

/** 工具必须属于本租户视角（平台级工具对所有租户可见；跨租户一律 404） */
async function scopedTool(tenantId, toolId) {
  const t = await svc.getTool(tenantId, toolId).catch(() => null);
  if (!t) throw Errors.notFound('工具不存在');
  return t;
}

export function registerExecutionRoutes(app) {
  // ---- 注册工具 ----
  app.post('/v1/projects/:projectId/tools', authenticate, async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'register-tool');
    await policyCheck({
      actor, tenantId, project, action: 'tool.register', resource: { kind: 'tool' },
    });
    const { name, kind, endpoint, config, riskLevel, credentials, validate, platform } = req.body || {};
    if (platform && c.authKind !== 'operator') {
      throw Errors.forbidden('平台级工具只能由平台运维注册');
    }
    const out = await withTenant(tenantId, () => svc.registerTool({
      tenantId, projectId: project.id, actorId: c.actorId,
      name, kind, endpoint, toolConfig: config || {}, riskLevel: riskLevel || 'low',
      credentials: credentials || [], validate: !!validate, platform: !!platform && c.authKind === 'operator',
    }));
    sendJson(res, 201, out);
  });

  // ---- 工具列表 ----
  app.get('/v1/projects/:projectId/tools', authenticate, async (req, res) => {
    const { tenantId } = await scopedProject(req, 0, 'list-tools');
    sendJson(res, 200, { data: await svc.listTools(tenantId) });
  });

  // ---- 调用工具 ----
  app.post('/v1/projects/:projectId/tools/:toolId/invoke', authenticate, async (req, res) => {
    const { project, tenantId, c } = await scopedProject(req, 0, 'invoke');
    const tool = await scopedTool(tenantId, req.params.toolId);
    const { action, args, compensations } = req.body || {};
    const idempotencyKey = req.headers['idempotency-key'] || null;
    const out = await withTenant(tenantId, () => svc.invokeTool({
      tenantId, projectId: project.id, actorId: c.actorId, traceId: c.traceId,
      toolId: tool.id, action, args: args || {}, idempotencyKey,
      compensations: compensations || [],
    }));
    sendJson(res, 200, out);
  });

  // ---- 执行列表 ----
  app.get('/v1/projects/:projectId/executions', authenticate, async (req, res) => {
    const { project, tenantId } = await scopedProject(req, 0, 'list-executions');
    const { status, toolId, limit } = req.query || {};
    sendJson(res, 200, {
      data: await svc.listExecutions(tenantId, project.id, { status, toolId, limit }),
    });
  });

  // ---- 执行详情 ----
  app.get('/v1/projects/:projectId/executions/:executionId', authenticate, async (req, res) => {
    const { project, tenantId } = await scopedProject(req, 0, 'get-execution');
    const exe = await svc.getExecution(tenantId, project.id, req.params.executionId);
    if (!exe) throw Errors.notFound('执行记录不存在');
    const cmps = await db().query(
      'SELECT id,seq,tool_id,action,status,error,executed_at FROM compensations WHERE execution_id=? ORDER BY seq',
      [exe.id]);
    sendJson(res, 200, { data: exe, compensations: cmps });
  });

  // ---- 审批 ----
  const decideRoute = (approved) => async (req, res) => {
    const { project, tenantId, c, roles } = await scopedProject(req, 1, approved ? 'approve' : 'reject');
    const { reason } = req.body || {};
    const out = await withTenant(tenantId, () => svc.decideApproval({
      tenantId, projectId: project.id, approvalId: req.params.approvalId,
      actorId: c.actorId, roles, approved, reason,
    }));
    sendJson(res, 200, out);
  };
  app.post('/v1/projects/:projectId/approvals/:approvalId/approve', authenticate, decideRoute(true));
  app.post('/v1/projects/:projectId/approvals/:approvalId/reject', authenticate, decideRoute(false));
}
