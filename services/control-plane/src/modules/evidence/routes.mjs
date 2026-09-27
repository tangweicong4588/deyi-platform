/**
 * modules/evidence/routes.mjs —— 证据平面 API。
 *
 * 全部挂在 /v1/admin/tenants/:tenantId 下，经 tenantScope 做租户隔离：
 * - 审计查询/证据包下载/锚定状态：viewer+
 * - 验链/打包/触发锚定：operator+
 * - 成本账本：admin（与 budgets/usage 口径一致）
 */
import { sendJson } from '../../kernel/http.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { ctx } from '../../kernel/context.mjs';
import { db } from '../../db/index.mjs';
import { authenticate, tenantScope, requireTenantRole, requireOperator } from '../identity/middleware.mjs';
import { verifyChain } from './audit.mjs';
import { buildPackage, verifyPackage, downloadPackage } from './packages.mjs';
import { anchorChain, getAnchorStatus, verifyAnchors, anchorAllTenants } from './anchor.mjs';
import { exportAudit } from './compliance.mjs';
import { queryCost } from './cost.mjs';

export function registerEvidenceRoutes(app) {
  const base = '/v1/admin/tenants/:tenantId/evidence';

  // 审计事件查询
  app.get(base + '/audit', authenticate, tenantScope, requireTenantRole('viewer'),
    async (req, res) => {
      const { action, from, to, limit = '100', offset = '0' } = req.query;
      const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
      const off = Math.max(Number(offset) || 0, 0);
      const conds = ['tenant_id=?'];
      const params = [req.params.tenantId];
      if (action) { conds.push('action=?'); params.push(action); }
      if (from) { conds.push('created_at>=?'); params.push(Number(from)); }
      if (to) { conds.push('created_at<=?'); params.push(Number(to)); }
      const rows = await db().query(
        `SELECT id, tenant_id, project_id, actor_id, trace_id, action, resource_kind,
                resource_id, payload, prev_hash, hash, seq, created_at
         FROM audit_events WHERE ${conds.join(' AND ')}
         ORDER BY seq DESC LIMIT ${n} OFFSET ${off}`,
        params);
      sendJson(res, 200, { data: rows });
    });

  // 验链（按 seq 范围）
  app.post(base + '/audit/verify', authenticate, tenantScope, requireTenantRole('operator'),
    async (req, res) => {
      const { from = 1, to = null } = req.body || {};
      sendJson(res, 200, { data: await verifyChain(req.params.tenantId, { from: Number(from) || 1, to: to ? Number(to) : null }) });
    });

  // 打包
  app.post(base + '/packages', authenticate, tenantScope, requireTenantRole('operator'),
    async (req, res) => {
      const { name, projectId = null, eventIds = null, from = null, to = null } = req.body || {};
      const pkg = await buildPackage({
        tenantId: req.params.tenantId, projectId, name, eventIds, from, to,
        createdBy: ctx().actorId,
      });
      sendJson(res, 201, { data: pkg });
    });

  // 验包
  app.post(base + '/packages/:packageId/verify', authenticate, tenantScope, requireTenantRole('operator'),
    async (req, res) => {
      sendJson(res, 200, { data: await verifyPackage(req.params.tenantId, req.params.packageId) });
    });

  // 下载证据包
  app.get(base + '/packages/:packageId/download', authenticate, tenantScope, requireTenantRole('viewer'),
    async (req, res) => {
      const bundle = await downloadPackage(req.params.tenantId, req.params.packageId);
      res.setHeader('content-disposition', `attachment; filename="evidence-${req.params.packageId}.json"`);
      sendJson(res, 200, bundle);
    });

  // 锚定状态 / 触发锚定
  app.get(base + '/anchor', authenticate, tenantScope, requireTenantRole('viewer'),
    async (req, res) => sendJson(res, 200, { data: await getAnchorStatus(req.params.tenantId) }));
  // 锚定验证（V2.4）：锚定后链被改写即检出 broken
  app.get(base + '/anchor/verify', authenticate, tenantScope, requireTenantRole('operator'),
    async (req, res) => sendJson(res, 200, { data: await verifyAnchors(req.params.tenantId) }));

  // 合规导出（V2.4）：审计事件 JSONL/CSV 下载 + manifest（sha256 + 导出时刻链验证结论）
  app.get('/v1/admin/tenants/:tenantId/compliance/export',
    authenticate, tenantScope, requireTenantRole('admin'),
    async (req, res) => {
      const { from = null, to = null, format = 'jsonl' } = req.query;
      const out = await exportAudit(req.params.tenantId, {
        from: from ? Number(from) : null, to: to ? Number(to) : null, format,
      });
      res.setHeader('content-type', out.contentType);
      res.setHeader('content-disposition', `attachment; filename="${out.filename}"`);
      res.setHeader('x-audit-manifest',
        Buffer.from(JSON.stringify(out.manifest), 'utf8').toString('base64'));
      res.end(out.content);
    });

  // 全租户锚定跑批（V2.4，平台 operator）
  app.post('/v1/admin/anchor-all', authenticate, requireOperator,
    async (req, res) => sendJson(res, 200, {
      data: await anchorAllTenants({ actorId: ctx().actorId }),
    }));
  app.post(base + '/anchor', authenticate, tenantScope, requireTenantRole('operator'),
    async (req, res) => {
      try {
        sendJson(res, 200, { data: await anchorChain(req.params.tenantId, { actorId: ctx().actorId }) });
      } catch (e) {
        throw Errors.upstream(`锚定失败：${e.message}`);
      }
    });

  // 成本账本
  app.get('/v1/admin/tenants/:tenantId/cost', authenticate, tenantScope, requireTenantRole('admin'),
    async (req, res) => {
      const { from = null, to = null, groupBy = 'day' } = req.query;
      try {
        sendJson(res, 200, { data: await queryCost(req.params.tenantId, { from, to, groupBy }) });
      } catch (e) {
        throw Errors.badRequest(e.message);
      }
    });
}
