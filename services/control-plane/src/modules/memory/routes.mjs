/**
 * modules/memory/routes.mjs —— V2.2-A：记忆服务 API。
 *
 * 认证：租户成员（authenticate + tenantScope）可 remember/recall 自己的记忆；
 * promote 提案成员可建；approve/reject 需租户 admin+；operator 可跨租户。
 */
import { sendJson } from '../../kernel/http.mjs';
import { authenticate, tenantScope, requireTenantRole, requireOperator } from '../identity/middleware.mjs';
import {
  remember, recall, forgetMemory, linkMemories,
  proposePromotion, approvePromotion, rejectPromotion, listPromotions, sweepExpired,
  reindexMemories,
} from './service.mjs';

const ok = (res, data, status = 200) => sendJson(res, status, { data });

const member = [authenticate, tenantScope];
const admin = [authenticate, tenantScope, requireTenantRole('admin')];

export function registerMemoryRoutes(app) {
  const R = (p) => `/v1/tenants/:tenantId/memory${p}`;

  // 写入记忆
  app.post(R(''), ...member, async (req, res) => {
    const { projectId, kind, content, visibility, importance, tags, ttlMs } = req.body || {};
    ok(res, await remember(req.params.tenantId, { projectId, kind, content, visibility, importance, tags, ttlMs }), 201);
  });
  // 召回：mode=auto（默认，语义优先、失败回退关键词）/semantic/keyword
  app.get(R('/recall'), ...member, async (req, res) => {
    const q = req.query || {};
    ok(res, await recall(req.params.tenantId, {
      q: q.q, kind: q.kind, projectId: q.projectId, limit: q.limit, mode: q.mode,
    }));
  });
  // 遗忘（硬删）
  app.delete(R('/:memoryId'), ...member, async (req, res) => {
    ok(res, await forgetMemory(req.params.tenantId, req.params.memoryId));
  });
  // 关联边
  app.post(R('/:memoryId/links'), ...member, async (req, res) => {
    const { dstId, relation } = req.body || {};
    ok(res, await linkMemories(req.params.tenantId, req.params.memoryId, dstId, relation), 201);
  });
  // 事实提升：建提案（成员）/ 审批（admin）
  app.post(R('/:memoryId/promote'), ...member, async (req, res) => {
    ok(res, await proposePromotion(req.params.tenantId, req.params.memoryId, { projectId: req.body?.projectId }), 201);
  });
  app.get(R('/promotions'), ...admin, async (req, res) => {
    ok(res, await listPromotions(req.params.tenantId, { status: req.query?.status, limit: req.query?.limit }));
  });
  app.post(R('/promotions/:promotionId/approve'), ...admin, async (req, res) => {
    ok(res, await approvePromotion(req.params.tenantId, req.params.promotionId));
  });
  app.post(R('/promotions/:promotionId/reject'), ...admin, async (req, res) => {
    ok(res, await rejectPromotion(req.params.tenantId, req.params.promotionId, { reason: req.body?.reason }));
  });

  // TTL 扫荡（operator 手动触发；未来可接定时任务）
  app.post('/v1/admin/memory/sweep', authenticate, requireOperator, async (req, res) => {
    ok(res, await sweepExpired(req.body?.tenantId || null));
  });
  // 向量索引重建（operator；Qdrant 是可重建派生数据）
  app.post('/v1/admin/memory/reindex', authenticate, requireOperator, async (req, res) => {
    ok(res, await reindexMemories({ tenantId: req.body?.tenantId || null }));
  });
}
