/**
 * modules/dev_assist/routes.mjs —— AI 生产力 Agent HTTP 立面（V3.5）。
 *
 * 对一次变更运行 AI 助手（代码评审 / 测试用例生成 / 变更风险评估），
 * 报告与 token/成本消耗可查。
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
import * as a from './assist.mjs';

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
      throw Errors.forbidden('禁止跨项目操作 AI 助手');
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
    action, resource: { kind: 'agent' },
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

export function registerDevAssistRoutes(app) {
  // 对一次变更运行 AI 助手（operator+）
  app.post(R('/change-packages/:changePackageId/ai-assist'), authenticate, requireScope('agent.write'), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1);
    await policyCheck({ actor, tenantId, project, action: 'agent.write' });
    const b = req.body || {};
    const out = await withTenant(tenantId, () => a.runAssist({
      tenantId, projectId: project.id, actorId: actor.id,
      changePackageId: req.params.changePackageId,
      kinds: b.kinds, diff: b.diff, mode: b.mode || 'simulated', params: b.params || {},
      bizTaskId: b.biz_task_id || null, // V4.5：为任务执行时登记成本归因边
    }));
    sendJson(res, 201, { data: out });
  });

  // 查询某变更的 AI 助手运行记录（含报告与消耗，viewer+）
  app.get(R('/change-packages/:changePackageId/ai-assist'), authenticate, requireScope('agent.read'), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0);
    await policyCheck({ actor, tenantId, project, action: 'agent.read' });
    const out = await withTenant(tenantId, () => a.listAssistRuns({
      tenantId, projectId: project.id, changePackageId: req.params.changePackageId,
      kind: req.query?.kind || null,
    }));
    sendJson(res, 200, { data: out });
  });
}
