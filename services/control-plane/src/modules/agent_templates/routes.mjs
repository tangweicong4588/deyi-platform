/**
 * modules/agent_templates/routes.mjs —— 业务场景模板 HTTP 立面（V4.4）。
 *
 * 模板市场（平台内置 + 租户自定义）、模板详情、创建自定义模板、
 * 从模板实例化可运行的业务 Agent、实例化记录。
 * 鉴权链：authenticate → 项目归属 → 角色等级 →
 * 策略 decide（agent.read viewer+ / agent.write operator+，复用 Agent 域）。
 */
import { sendJson } from '../../kernel/http.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { ctx, runWithContext } from '../../kernel/context.mjs';
import { authenticate, effectiveRank, requireScope } from '../identity/middleware.mjs';
import { getProject } from '../identity/store.mjs';
import { decide, inputFromRequest } from '../policy/index.mjs';
import { db } from '../../db/index.mjs';
import * as t from './templates.mjs';

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
      throw Errors.forbidden('禁止跨项目操作场景模板');
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

async function policyCheck({ actor, tenantId, project, action }) {
  const receipt = await decide(inputFromRequest({
    actor,
    tenant: { id: tenantId, status: 'active' },
    project: { id: project.id },
    action, resource: { kind: 'agent_template' },
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

export function registerAgentTemplateRoutes(app) {
  // 模板市场：平台内置 + 本租户自定义
  app.get(R('/agent-templates'), authenticate, requireScope('agent.read'), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0);
    await policyCheck({ actor, tenantId, project, action: 'agent.read' });
    const out = await withTenant(tenantId, () => t.listTemplates({
      tenantId, category: req.query?.category || null,
    }));
    sendJson(res, 200, { data: out });
  });

  // 模板详情（含 params_schema 与定义模板）
  app.get(R('/agent-templates/:templateId'), authenticate, requireScope('agent.read'), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0);
    await policyCheck({ actor, tenantId, project, action: 'agent.read' });
    const out = await withTenant(tenantId, () => t.getTemplate({ tenantId, templateId: req.params.templateId }));
    sendJson(res, 200, { data: out });
  });

  // 创建租户自定义模板（operator+）
  app.post(R('/agent-templates'), authenticate, requireScope('agent.write'), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1);
    await policyCheck({ actor, tenantId, project, action: 'agent.write' });
    const out = await withTenant(tenantId, () => t.createTemplate({
      tenantId, actorId: actor.id, body: req.body || {},
    }));
    sendJson(res, 201, { data: out });
  });

  // 从模板实例化一个可运行的业务 Agent（operator+）
  app.post(R('/agent-templates/:templateId/instantiate'), authenticate, requireScope('agent.write'), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1);
    await policyCheck({ actor, tenantId, project, action: 'agent.write' });
    const b = req.body || {};
    const out = await withTenant(tenantId, () => t.instantiateTemplate({
      tenantId, projectId: project.id, actorId: actor.id,
      templateId: req.params.templateId, params: b.params || {},
      agentKey: b.agent_key || null, agentName: b.agent_name || null,
    }));
    sendJson(res, 201, { data: out });
  });

  // 实例化记录
  app.get(R('/agent-template-instances'), authenticate, requireScope('agent.read'), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0);
    await policyCheck({ actor, tenantId, project, action: 'agent.read' });
    const out = await withTenant(tenantId, () => t.listInstances({ tenantId, projectId: project.id }));
    sendJson(res, 200, { data: out });
  });
}
