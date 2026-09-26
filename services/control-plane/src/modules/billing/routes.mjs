/**
 * modules/billing/routes.mjs —— V2.3：计费与账单 HTTP API。
 *
 * 租户面（admin）：
 *   POST   /v1/tenants/:tenantId/billing/invoices            生成/重算 draft 账单 {period_key}
 *   GET    /v1/tenants/:tenantId/billing/invoices            账单列表 ?status=&limit=
 *   GET    /v1/tenants/:tenantId/billing/invoices/:id        账单详情
 *   POST   /v1/tenants/:tenantId/billing/invoices/:id/finalize  定稿（冻结）
 *   POST   /v1/tenants/:tenantId/billing/invoices/:id/pay       标记已付（仅状态，不碰真实支付）
 *   POST   /v1/tenants/:tenantId/billing/invoices/:id/void      作废
 * 运营面（operator）：
 *   POST   /v1/admin/billing/run                              全租户跑批 {period_key}
 */
import { authenticate, tenantScope, requireTenantRole, requireOperator } from '../identity/middleware.mjs';
import { sendJson } from '../../kernel/http.mjs';
import {
  generateInvoice, finalizeInvoice, markInvoicePaid, voidInvoice,
  getInvoice, listInvoices, runBilling,
} from './service.mjs';

const ok = (res, data, status = 200) => sendJson(res, status, { data });

const admin = [authenticate, tenantScope, requireTenantRole('admin')];

export function registerBillingRoutes(app) {
  const R = (p) => `/v1/tenants/:tenantId/billing${p}`;

  app.post(R('/invoices'), ...admin, async (req, res) => {
    ok(res, await generateInvoice(req.params.tenantId, req.body?.period_key), 201);
  });
  app.get(R('/invoices'), ...admin, async (req, res) => {
    const q = req.query || {};
    ok(res, await listInvoices(req.params.tenantId, { status: q.status, limit: q.limit }));
  });
  app.get(R('/invoices/:id'), ...admin, async (req, res) => {
    ok(res, await getInvoice(req.params.tenantId, req.params.id));
  });
  app.post(R('/invoices/:id/finalize'), ...admin, async (req, res) => {
    ok(res, await finalizeInvoice(req.params.tenantId, req.params.id));
  });
  app.post(R('/invoices/:id/pay'), ...admin, async (req, res) => {
    ok(res, await markInvoicePaid(req.params.tenantId, req.params.id));
  });
  app.post(R('/invoices/:id/void'), ...admin, async (req, res) => {
    ok(res, await voidInvoice(req.params.tenantId, req.params.id));
  });

  app.post('/v1/admin/billing/run', authenticate, requireOperator, async (req, res) => {
    ok(res, await runBilling(req.body?.period_key));
  });
}
