/**
 * modules/notify/routes.mjs —— V2.1-C：通知通道管理（租户 admin+，operator 可跨租户）。
 */
import { Errors } from '../../kernel/errors.mjs';
import { sendJson } from '../../kernel/http.mjs';
import { authenticate, tenantScope, requireTenantRole } from '../identity/middleware.mjs';
import {
  createChannel, listChannels, updateChannel, deleteChannel,
  sendNotification, listDeliveries,
} from './service.mjs';

const ok = (res, data, status = 200) => sendJson(res, status, { data });

const admin = [authenticate, tenantScope, requireTenantRole('admin')];

export function registerNotifyRoutes(app) {
  const R = (p) => `/v1/tenants/:tenantId/notify${p}`;

  app.post(R('/channels'), ...admin, async (req, res) => {
    const { kind, name, target, secretRef } = req.body || {};
    ok(res, await createChannel(req.params.tenantId, { kind, name, target, secretRef }), 201);
  });
  app.get(R('/channels'), ...admin, async (req, res) => {
    ok(res, await listChannels(req.params.tenantId));
  });
  app.patch(R('/channels/:channelId'), ...admin, async (req, res) => {
    const { name, target, secretRef, status } = req.body || {};
    ok(res, await updateChannel(req.params.tenantId, req.params.channelId, { name, target, secretRef, status }));
  });
  app.delete(R('/channels/:channelId'), ...admin, async (req, res) => {
    await deleteChannel(req.params.tenantId, req.params.channelId);
    ok(res, { deleted: true });
  });
  // 连通性测试：真实发一条 notify.test（只打目标通道）
  app.post(R('/channels/:channelId/test'), ...admin, async (req, res) => {
    const ch = (await listChannels(req.params.tenantId)).find((x) => x.id === req.params.channelId);
    if (!ch) throw Errors.notFound('通知通道不存在');
    if (ch.status !== 'active') throw Errors.badRequest('通道已停用，先启用再测试');
    const out = await sendNotification({
      tenantId: req.params.tenantId,
      channelId: ch.id,
      intent: 'notify.test',
      title: '通知通道连通性测试',
      body: `通道 ${ch.name} 连通性测试，请忽略。`,
      extra: { channel_id: ch.id },
    });
    ok(res, out);
  });
  // 投递账本（运营可见）
  app.get(R('/deliveries'), ...admin, async (req, res) => {
    ok(res, await listDeliveries(req.params.tenantId, { limit: req.query?.limit }));
  });
}
