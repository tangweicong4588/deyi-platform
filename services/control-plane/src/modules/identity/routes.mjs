/**
 * modules/identity/routes.mjs —— 身份管理面路由。
 *
 * 管理面（/v1/admin）与租户面（/v1）分离：
 * - 平台运维（OPERATOR_TOKEN）：租户 CRUD。
 * - 租户 admin：项目 / 主体 / Key / 角色管理（只能管自己租户）。
 * - 租户面：/v1/me、/v1/projects（任意已认证身份）。
 */
import { sendJson } from '../../kernel/http.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { ctx } from '../../kernel/context.mjs';
import { assertId } from '../../kernel/ids.mjs';
import {
  createTenant, listTenants, getTenant, setTenantStatus, updateTenant, getTenantQuotas,
  createProject, listProjects,
  createActor, getActor,
  createApiKeyRow, listApiKeys, revokeApiKey, rotateApiKey,
  bindRole, getRoleBindings,
} from './store.mjs';
import { provisionTenant } from './provision.mjs';
import { dryRunOffboard, confirmOffboard } from './offboard.mjs';
import { mintKey } from './keys.mjs';
import { tryAudit } from '../evidence/audit.mjs';
import {
  authenticate, requireOperator, requireTenantRole, requireScope, tenantScope,
} from './middleware.mjs';

const ok = (res, data, status = 200) => sendJson(res, status, { data });

export function registerIdentityRoutes(app) {
  // ---------- 平台运维：租户 ----------
  app.post('/v1/admin/tenants', authenticate, requireOperator, async (req, res) => {
    const { name, slug, plan, quotas } = req.body || {};
    if (!name) throw Errors.badRequest('name 必填');
    ok(res, await createTenant({ name, slug, plan, quotas }), 201);
  });
  app.get('/v1/admin/tenants', authenticate, requireOperator, async (req, res) => {
    ok(res, await listTenants());
  });
  // V2.1-B：原子开通——租户+默认项目+管理员+admin 角色+API Key，同一事务
  app.post('/v1/admin/tenants/provision', authenticate, requireOperator, async (req, res) => {
    const out = await provisionTenant(req.body || {});
    await tryAudit({
      tenantId: out.tenant.id, projectId: out.project.id, actorId: out.actor.id,
      action: 'tenant.provision', resourceKind: 'tenant', resourceId: out.tenant.id,
      payload: { plan: out.tenant.plan, project_id: out.project.id, actor_id: out.actor.id },
    });
    ok(res, out, 201);
  });
  // V2.1-B：租户资料/套餐/配额更新
  app.patch('/v1/admin/tenants/:tenantId', authenticate, requireOperator, async (req, res) => {
    const { name, slug, plan, quotas } = req.body || {};
    const tenant = await updateTenant(req.params.tenantId, { name, slug, plan, quotas });
    await tryAudit({
      tenantId: tenant.id, actorId: ctx().actorId,
      action: 'tenant.update', resourceKind: 'tenant', resourceId: tenant.id,
      payload: { plan: tenant.plan, quotas: getTenantQuotas(tenant) },
    });
    ok(res, tenant);
  });
  // V2.1-B：停用 / 恢复。停用后该租户所有 API Key/JWT 立即 401（verifyApiKey/中间件已强制）。
  app.post('/v1/admin/tenants/:tenantId/suspend', authenticate, requireOperator, async (req, res) => {
    const tenant = await setTenantStatus(req.params.tenantId, 'suspended');
    await tryAudit({
      tenantId: tenant.id, actorId: ctx().actorId,
      action: 'tenant.suspend', resourceKind: 'tenant', resourceId: tenant.id, payload: {},
    });
    ok(res, tenant);
  });
  app.post('/v1/admin/tenants/:tenantId/resume', authenticate, requireOperator, async (req, res) => {
    const tenant = await setTenantStatus(req.params.tenantId, 'active');
    await tryAudit({
      tenantId: tenant.id, actorId: ctx().actorId,
      action: 'tenant.resume', resourceKind: 'tenant', resourceId: tenant.id, payload: {},
    });
    ok(res, tenant);
  });
  // V2.12：租户 offboard（销户），provision 的反操作。两阶段：
  // phase=dryRun → 统计 + 合规包 manifest + confirm_token（不删除）；
  // phase=confirm → 校验 token 后执行清除（幂等）。
  app.post('/v1/admin/tenants/:tenantId/offboard', authenticate, requireOperator, async (req, res) => {
    const { phase, confirm_token: confirmToken } = req.body || {};
    if (phase === 'dryRun') {
      ok(res, await dryRunOffboard(req.params.tenantId, { actorId: ctx().actorId }));
    } else if (phase === 'confirm') {
      ok(res, await confirmOffboard(req.params.tenantId, confirmToken, { actorId: ctx().actorId }));
    } else {
      throw Errors.badRequest("phase 非法：用 'dryRun' 或 'confirm'");
    }
  });

  // ---------- 租户 admin：项目 ----------
  app.post('/v1/admin/tenants/:tenantId/projects',
    authenticate, tenantScope, requireTenantRole('admin'), async (req, res) => {
      const { name, slug } = req.body || {};
      if (!name) throw Errors.badRequest('name 必填');
      ok(res, await createProject(req.params.tenantId, { name, slug }), 201);
    });

  // ---------- 租户 admin：主体 ----------
  app.post('/v1/admin/tenants/:tenantId/actors',
    authenticate, tenantScope, requireTenantRole('admin'), async (req, res) => {
      const { kind, name, email } = req.body || {};
      ok(res, await createActor(req.params.tenantId, { kind, name, email }), 201);
    });

  // ---------- 租户 admin：API Key（secret 仅返回一次） ----------
  app.post('/v1/admin/tenants/:tenantId/api-keys',
    authenticate, tenantScope, requireTenantRole('admin'), requireScope('identity.keys'), async (req, res) => {
      const { actorId, name, projectId = null, scopes = [], expiresAt = null } = req.body || {};
      if (!actorId || !name) throw Errors.badRequest('actorId / name 必填');
      assertId('usr', actorId);
      const { secret, prefix, keyHash } = mintKey();
      const row = await createApiKeyRow({
        tenantId: req.params.tenantId, projectId, actorId, name, prefix, keyHash, scopes, expiresAt,
      });
      await tryAudit({
        tenantId: req.params.tenantId, actorId: ctx().actorId, traceId: ctx().traceId,
        action: 'identity.apikey.created', resourceKind: 'api_key', resourceId: row.id,
        payload: { name, scopes: row.scopes, projectId, expiresAt },
      });
      // L-1 安全 review：响应里剔除 key_hash（持有者不需要它，避免进日志/审计）
      const { key_hash: _dropped, ...safeRow } = row;
      ok(res, { ...safeRow, key: secret }, 201); // key 只出现在这一次响应里
    });
  // V2.5：轮换（宽限期内双 key 可用，secret 仅返回一次）
  app.post('/v1/admin/tenants/:tenantId/api-keys/:keyId/rotate',
    authenticate, tenantScope, requireTenantRole('admin'), requireScope('identity.keys'), async (req, res) => {
      assertId('key', req.params.keyId);
      const { graceHours = 24 } = req.body || {};
      const r = await rotateApiKey(req.params.tenantId, req.params.keyId, { graceHours });
      await tryAudit({
        tenantId: req.params.tenantId, actorId: ctx().actorId, traceId: ctx().traceId,
        action: 'identity.apikey.rotated', resourceKind: 'api_key', resourceId: r.oldKey.id,
        payload: { newKeyId: r.newKey.id, graceUntil: r.graceUntil },
      });
      ok(res, r, 201);
    });
  app.get('/v1/admin/tenants/:tenantId/api-keys',
    authenticate, tenantScope, requireTenantRole('admin'), async (req, res) => {
      ok(res, await listApiKeys(req.params.tenantId)); // 列表不含 hash/secret
    });
  app.delete('/v1/admin/tenants/:tenantId/api-keys/:keyId',
    authenticate, tenantScope, requireTenantRole('admin'), requireScope('identity.keys'), async (req, res) => {
      await revokeApiKey(req.params.tenantId, req.params.keyId);
      await tryAudit({
        tenantId: req.params.tenantId, actorId: ctx().actorId, traceId: ctx().traceId,
        action: 'identity.apikey.revoked', resourceKind: 'api_key', resourceId: req.params.keyId,
      });
      ok(res, { revoked: true });
    });

  // ---------- 租户 admin：角色绑定 ----------
  app.post('/v1/admin/tenants/:tenantId/role-bindings',
    authenticate, tenantScope, requireTenantRole('admin'), async (req, res) => {
      const { actorId, projectId = null, role } = req.body || {};
      if (!actorId || !role) throw Errors.badRequest('actorId / role 必填');
      ok(res, await bindRole(req.params.tenantId, actorId, projectId, role), 201);
    });

  // ---------- 租户面 ----------
  app.get('/v1/me', authenticate, async (req, res) => {
    const c = ctx();
    const actor = c.authKind === 'operator'
      ? { id: 'operator', kind: 'service', name: 'platform-operator' }
      : await getActor(c.tenantId, c.actorId);
    const tenant = c.tenantId ? await getTenant(c.tenantId) : null;
    ok(res, {
      actor: actor && { id: actor.id, kind: actor.kind, name: actor.name, email: actor.email },
      tenant: tenant && { id: tenant.id, name: tenant.name, slug: tenant.slug },
      authKind: c.authKind,
      roles: c.roles,
    });
  });
  app.get('/v1/projects', authenticate, async (req, res) => {
    const c = ctx();
    if (c.authKind === 'operator') return ok(res, []);
    if (!c.tenantId) throw Errors.unauthorized();
    ok(res, await listProjects(c.tenantId));
  });
}
