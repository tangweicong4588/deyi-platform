/**
 * modules/knowledge/routes.mjs —— 知识平面 HTTP 立面。
 *
 * POST /v1/projects/:projectId/knowledge/documents          ingest（operator+，同步解析）
 * GET  /v1/projects/:projectId/knowledge/documents          列表（viewer+）
 * POST /v1/projects/:projectId/knowledge/documents/:docId/reparse  新版本（operator+）
 * POST /v1/projects/:projectId/knowledge/documents/:docId/share    显式共享（operator+）
 * POST /v1/projects/:projectId/knowledge/search             检索（viewer+，ACL 预过滤）
 *
 * 鉴权链：authenticate → 项目归属（租户隔离）→ Key 项目绑定检查 → 角色等级 →
 * 策略 decide（knowledge.read/knowledge.ingest，留 receipt 供审计）。
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

const DATA_CLASSES = new Set(['public', 'internal', 'confidential']);

/**
 * 项目作用域解析 + 鉴权：
 * - 非 operator：项目必须属于调用方租户（查不到 → 403，不泄露跨租户存在性）；
 *   Key 若绑定了项目，则必须与 URL 项目一致（否则跨项目拒绝）。
 * - operator（平台运维）：可操作任意租户项目，视为租户 admin（显式打日志）。
 * - 角色等级：viewer+ 可读，operator+ 可写。
 */
async function scopedProject(req, minRank, opName) {
  const c = ctx();
  const pid = req.params.projectId;
  let project = null;
  let roles = c.roles || [];
  if (c.authKind === 'operator') {
    const rows = await db().query('SELECT * FROM projects WHERE id=?', [pid]);
    project = rows[0] || null;
    roles = [{ project_id: null, role: 'admin' }];
    logger.warn('knowledge operator access', { op: opName, projectId: pid, tenant_id: project?.tenant_id });
  } else {
    if (!c.tenantId) throw Errors.unauthorized();
    project = await getProject(c.tenantId, pid).catch(() => null);
    if (c.projectId && c.projectId !== pid) {
      throw Errors.forbidden('禁止跨项目操作知识');
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
    // Key 绑定了项目时，用绑定项目做跨项目判断；否则不带（读/写都在 URL 项目作用域内已鉴权）
    project: c.projectId ? { id: c.projectId } : null,
    action, resource: resource || {},
    context: {},
  }));
  if (!receipt.allow) throw Errors.policyDenied(receipt.reason, { receipt });
  return receipt;
}

/**
 * 在租户上下文中执行业务：平台 operator 本身不归属租户，
 * 租户取自其已鉴权的 URL 项目归属（scopedProject 已解析），保持"租户来自认证凭证"铁律。
 */
function withTenant(tenantId, fn) {
  const c = ctx();
  if (c.authKind === 'operator' && !c.tenantId) {
    return runWithContext({ ...c, tenantId }, fn);
  }
  return fn();
}

export function registerKnowledgeRoutes(app) {
  // ---- ingest ----
  app.post('/v1/projects/:projectId/knowledge/documents', authenticate, async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'ingest');
    const { title, content, mime = 'text/markdown', dataClass = 'internal' } = req.body || {};
    if (dataClass && !DATA_CLASSES.has(dataClass)) throw Errors.badRequest('dataClass 非法');
    await policyCheck({
      actor, tenantId, project, c, action: 'knowledge.ingest',
      resource: { kind: 'knowledge', projectId: project.id },
    });
    const out = await withTenant(tenantId, () => svc.ingestDocument({
      tenantId, projectId: project.id, actorId: c.actorId,
      title, content, mime, dataClass,
    }));
    sendJson(res, 201, out);
  });

  // ---- list ----
  app.get('/v1/projects/:projectId/knowledge/documents', authenticate, async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 0, 'list');
    await policyCheck({
      actor, tenantId, project, c, action: 'knowledge.read',
      resource: { kind: 'knowledge', projectId: project.id },
    });
    sendJson(res, 200, { data: await svc.listDocuments(tenantId, project.id) });
  });

  // ---- reparse（新版本） ----
  app.post('/v1/projects/:projectId/knowledge/documents/:docId/reparse', authenticate, async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'reparse');
    await policyCheck({
      actor, tenantId, project, c, action: 'knowledge.ingest',
      resource: { kind: 'knowledge', projectId: project.id },
    });
    const { content, mime } = req.body || {};
    const out = await withTenant(tenantId, () => svc.reparseDocument({
      tenantId, projectId: project.id, documentId: req.params.docId, actorId: c.actorId, content, mime,
    }));
    sendJson(res, 200, out);
  });

  // ---- share（显式跨项目授权） ----
  app.post('/v1/projects/:projectId/knowledge/documents/:docId/share', authenticate, async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'share');
    await policyCheck({
      actor, tenantId, project, c, action: 'knowledge.ingest',
      resource: { kind: 'knowledge', projectId: project.id },
    });
    const { projectId: granteeProjectId } = req.body || {};
    if (!granteeProjectId) throw Errors.badRequest('projectId 必填');
    const entry = await svc.shareDocument({
      tenantId, projectId: project.id, documentId: req.params.docId,
      granteeProjectId, actorId: c.actorId,
    });
    sendJson(res, 201, { data: entry });
  });

  // ---- search（ACL 预过滤） ----
  app.post('/v1/projects/:projectId/knowledge/search', authenticate, async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 0, 'search');
    await policyCheck({
      actor, tenantId, project, c, action: 'knowledge.read',
      resource: { kind: 'knowledge', projectId: project.id },
    });
    const { query, limit } = req.body || {};
    const out = await withTenant(tenantId, () => svc.searchKnowledge({
      tenantId, projectId: project.id, query, limit: limit ?? 10,
    }));
    sendJson(res, 200, out);
  });
}
