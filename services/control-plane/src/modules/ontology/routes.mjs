/**
 * modules/ontology/routes.mjs —— 本体平面 HTTP 立面。
 *
 * POST /v1/projects/:projectId/ontology/terms                       提交候选（operator+）
 * GET  /v1/projects/:projectId/ontology/terms?status=&kind=         列表（viewer+）
 * GET  /v1/projects/:projectId/ontology/terms/:termId               详情（viewer+，含版本链）
 * POST /v1/projects/:projectId/ontology/terms/:termId/review        转评审（operator+）
 * POST /v1/projects/:projectId/ontology/terms/:termId/publish       发布（operator+，走策略 ontology.publish）
 * POST /v1/projects/:projectId/ontology/terms/:termId/reject        驳回（operator+）
 * POST /v1/projects/:projectId/ontology/terms/:termId/deprecate     废止（operator+）
 * GET  /v1/projects/:projectId/ontology/terms/:termId/impact        影响分析（viewer+）
 * GET  /v1/projects/:projectId/ontology/conflicts?status=           冲突列表（viewer+）
 * POST /v1/projects/:projectId/ontology/conflicts/:conflictId/resolve 裁决（operator+）
 *
 * 鉴权链：authenticate → 项目归属（租户隔离）→ Key 项目绑定检查 → 角色等级 →
 * 策略 decide（发布动作用 ontology.publish，resource kind ontology_term，
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
    logger.warn('ontology operator access', { op: opName, projectId: pid, tenant_id: project?.tenant_id });
  } else {
    if (!c.tenantId) throw Errors.unauthorized();
    project = await getProject(c.tenantId, pid).catch(() => null);
    if (c.projectId && c.projectId !== pid) {
      throw Errors.forbidden('禁止跨项目操作本体');
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

async function policyCheck({ actor, tenantId, project, c, action, resource }) {
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

/** 术语必须属于 URL 项目（防跨项目 ID 枚举） */
async function scopedTerm(req, tenantId, project) {
  const t = await svc.store.getTerm(tenantId, req.params.termId).catch(() => null);
  if (!t || t.project_id !== project.id) throw Errors.notFound('本体术语不存在');
  return t;
}

/** 冲突必须属于 URL 项目（防跨项目 ID 枚举；格式非法 → 404 不泄露） */
async function scopedConflict(tenantId, project, conflictId) {
  const c = await svc.store.getConflict(tenantId, conflictId).catch(() => null);
  if (!c || c.project_id !== project.id) throw Errors.notFound('冲突不存在');
  return c;
}

export function registerOntologyRoutes(app) {
  // ---- 提交候选 ----
  app.post('/v1/projects/:projectId/ontology/terms', authenticate, async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'submit');
    await policyCheck({
      actor, tenantId, project, c, action: 'ontology.write',
      resource: { kind: 'ontology_term', projectId: project.id },
    });
    const { name, kind, definition, evidence, supersedesId } = req.body || {};
    const out = await withTenant(tenantId, () => svc.submitCandidate({
      tenantId, projectId: project.id, name, kind, definition,
      evidence, supersedesId, actorId: c.actorId,
    }));
    sendJson(res, 201, out);
  });

  // ---- 列表 ----
  app.get('/v1/projects/:projectId/ontology/terms', authenticate, async (req, res) => {
    const { project, tenantId } = await scopedProject(req, 0, 'list');
    const { status, kind } = req.query || {};
    sendJson(res, 200, {
      data: await svc.store.listTerms(tenantId, project.id, { status, kind }),
    });
  });

  // ---- 详情（含版本链） ----
  app.get('/v1/projects/:projectId/ontology/terms/:termId', authenticate, async (req, res) => {
    const { project, tenantId } = await scopedProject(req, 0, 'get');
    const term = await scopedTerm(req, tenantId, project);
    sendJson(res, 200, {
      data: term, chain: await svc.store.versionChain(tenantId, term.id),
    });
  });

  // ---- 转评审 ----
  app.post('/v1/projects/:projectId/ontology/terms/:termId/review', authenticate, async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'review');
    await scopedTerm(req, tenantId, project);
    await policyCheck({
      actor, tenantId, project, c, action: 'ontology.write',
      resource: { kind: 'ontology_term', projectId: project.id },
    });
    const out = await withTenant(tenantId, () => svc.startReview({ tenantId, termId: req.params.termId }));
    sendJson(res, 200, out);
  });

  // ---- 发布（特权：走 ontology.publish 策略，operator+ 且带 review_required 义务） ----
  app.post('/v1/projects/:projectId/ontology/terms/:termId/publish', authenticate, async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'publish');
    await scopedTerm(req, tenantId, project);
    const receipt = await policyCheck({
      actor, tenantId, project, c, action: 'ontology.publish',
      resource: { kind: 'ontology_term', id: req.params.termId, projectId: project.id },
    });
    if (!receipt.obligations.includes('review_required')) {
      // 纵深防御：策略若某天不再要求评审，发布仍拒绝（术语必须走完 in_review 状态机）
      throw Errors.policyDenied('本体发布必须经过评审', { receipt });
    }
    const out = await withTenant(tenantId, () => svc.publishTerm({
      tenantId, termId: req.params.termId, actorId: c.actorId,
    }));
    logger.info('ontology publish receipt', {
      term: req.params.termId, obligations: receipt.obligations, by: c.actorId,
    });
    sendJson(res, 200, out);
  });

  // ---- 驳回 ----
  app.post('/v1/projects/:projectId/ontology/terms/:termId/reject', authenticate, async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'reject');
    await scopedTerm(req, tenantId, project);
    await policyCheck({
      actor, tenantId, project, c, action: 'ontology.write',
      resource: { kind: 'ontology_term', projectId: project.id },
    });
    const { reason } = req.body || {};
    sendJson(res, 200, {
      data: await withTenant(tenantId, () => svc.rejectTerm({ tenantId, termId: req.params.termId, reason })),
    });
  });

  // ---- 废止 ----
  app.post('/v1/projects/:projectId/ontology/terms/:termId/deprecate', authenticate, async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'deprecate');
    await scopedTerm(req, tenantId, project);
    await policyCheck({
      actor, tenantId, project, c, action: 'ontology.write',
      resource: { kind: 'ontology_term', projectId: project.id },
    });
    sendJson(res, 200, {
      data: await withTenant(tenantId, () => svc.deprecateTerm({ tenantId, termId: req.params.termId, actorId: c.actorId })),
    });
  });

  // ---- 影响分析 ----
  app.get('/v1/projects/:projectId/ontology/terms/:termId/impact', authenticate, async (req, res) => {
    const { project, tenantId } = await scopedProject(req, 0, 'impact');
    await scopedTerm(req, tenantId, project);
    sendJson(res, 200, await withTenant(tenantId, () => svc.impactAnalysis({
      tenantId, projectId: project.id, termId: req.params.termId,
    })));
  });

  // ---- 冲突列表 ----
  app.get('/v1/projects/:projectId/ontology/conflicts', authenticate, async (req, res) => {
    const { project, tenantId } = await scopedProject(req, 0, 'conflicts');
    const { status } = req.query || {};
    sendJson(res, 200, {
      data: await svc.store.listConflicts(tenantId, project.id, { status }),
    });
  });

  // ---- 冲突裁决 ----
  app.post('/v1/projects/:projectId/ontology/conflicts/:conflictId/resolve', authenticate, async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'resolve-conflict');
    await scopedConflict(tenantId, project, req.params.conflictId);
    await policyCheck({
      actor, tenantId, project, c, action: 'ontology.write',
      resource: { kind: 'ontology_conflict', projectId: project.id },
    });
    const { strategy, note } = req.body || {};
    const out = await withTenant(tenantId, () => svc.resolveConflict({
      tenantId, conflictId: req.params.conflictId, strategy, note, actorId: c.actorId,
    }));
    sendJson(res, 200, out);
  });
}
