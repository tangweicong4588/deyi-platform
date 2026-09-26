/**
 * modules/business/routes.mjs —— 业务意图与计划 HTTP 立面（V2.0-A）。
 *
 * 鉴权链：authenticate → 项目归属（租户隔离）→ 角色等级 →
 * 策略 decide（business.read viewer+ / business.write operator+，与 P2 规则及
 * deploy/opa 策略包语义一致）。
 *
 * 注意：本阶段只建模+计划。路由层没有任何触发真实执行的路径；
 * 动作执行入口在 V2.0-B 才开放。
 */
import { sendJson } from '../../kernel/http.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { ctx, runWithContext } from '../../kernel/context.mjs';
import { authenticate, effectiveRank } from '../identity/middleware.mjs';
import { getProject } from '../identity/store.mjs';
import { decide, inputFromRequest } from '../policy/index.mjs';
import { db } from '../../db/index.mjs';
import * as plan from './plan.mjs';
import * as store from './store.mjs';

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
      throw Errors.forbidden('禁止跨项目操作业务意图域');
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

export function registerBusinessRoutes(app) {
  // ---- intents ----
  app.post(R('/business/intents'), authenticate, async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'intent.create');
    await policyCheck({ actor, tenantId, project, action: 'business.write', resource: { kind: 'business_intent' } });
    const body = req.body || {};
    const out = await withTenant(tenantId, () => plan.createIntent({
      tenantId, projectId: project.id, rawText: body.raw_text, actorId: c.actorId,
    }));
    sendJson(res, 201, { data: out });
  });

  app.get(R('/business/intents'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'intent.list');
    await policyCheck({ actor, tenantId, project, action: 'business.read', resource: { kind: 'business_intent' } });
    const q = req.query || {};
    sendJson(res, 200, { data: await store.listIntents(tenantId, project.id, { status: q.status }) });
  });

  app.get(R('/business/intents/:intentId'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'intent.get');
    await policyCheck({ actor, tenantId, project, action: 'business.read', resource: { kind: 'business_intent' } });
    const intent = await store.getIntent(tenantId, req.params.intentId);
    if (!intent || intent.project_id !== project.id) throw Errors.notFound('业务意图不存在');
    sendJson(res, 200, { data: { intent, plans: await store.listPlansByIntent(tenantId, intent.id) } });
  });

  app.post(R('/business/intents/:intentId/plan'), authenticate, async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'plan.generate');
    await policyCheck({ actor, tenantId, project, action: 'business.write', resource: { kind: 'business_plan' } });
    const out = await withTenant(tenantId, () => plan.generatePlan({
      tenantId, projectId: project.id, intentId: req.params.intentId, actorId: c.actorId,
    }));
    sendJson(res, 201, { data: out });
  });

  // ---- plans ----
  app.get(R('/business/plans/:planId'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'plan.get');
    await policyCheck({ actor, tenantId, project, action: 'business.read', resource: { kind: 'business_plan' } });
    const p = await store.getPlan(tenantId, req.params.planId);
    if (!p || p.project_id !== project.id) throw Errors.notFound('业务计划不存在');
    sendJson(res, 200, { data: p });
  });

  app.get(R('/business/plans/:planId/actions'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'plan.actions');
    await policyCheck({ actor, tenantId, project, action: 'business.read', resource: { kind: 'business_plan' } });
    const p = await store.getPlan(tenantId, req.params.planId);
    if (!p || p.project_id !== project.id) throw Errors.notFound('业务计划不存在');
    sendJson(res, 200, { data: await store.listActions(tenantId, p.id) });
  });

  app.post(R('/business/plans/:planId/dryrun'), authenticate, async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'plan.dryrun');
    await policyCheck({ actor, tenantId, project, action: 'business.write', resource: { kind: 'business_plan' } });
    const out = await withTenant(tenantId, () => plan.dryRun({
      tenantId, projectId: project.id, planId: req.params.planId, actorId: c.actorId,
    }));
    sendJson(res, 200, { data: out });
  });

  app.post(R('/business/plans/:planId/approve'), authenticate, async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'plan.approve');
    await policyCheck({ actor, tenantId, project, action: 'business.write', resource: { kind: 'business_plan' } });
    const out = await withTenant(tenantId, () => plan.approvePlan({
      tenantId, projectId: project.id, planId: req.params.planId, actorId: c.actorId,
    }));
    sendJson(res, 200, { data: out });
  });

  app.post(R('/business/plans/:planId/reject'), authenticate, async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'plan.reject');
    await policyCheck({ actor, tenantId, project, action: 'business.write', resource: { kind: 'business_plan' } });
    const out = await withTenant(tenantId, () => plan.rejectPlan({
      tenantId, projectId: project.id, planId: req.params.planId, actorId: c.actorId,
      reason: (req.body || {}).reason,
    }));
    sendJson(res, 200, { data: out });
  });
}
