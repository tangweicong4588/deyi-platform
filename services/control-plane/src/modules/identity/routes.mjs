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
  createTenant, listTenants, getTenant,
  createProject, listProjects,
  createActor, getActor,
  createApiKeyRow, listApiKeys, revokeApiKey,
  bindRole, getRoleBindings,
} from './store.mjs';
import { mintKey } from './keys.mjs';
import {
  authenticate, requireOperator, requireTenantRole, tenantScope,
} from './middleware.mjs';

const ok = (res, data, status = 200) => sendJson(res, status, { data });

export function registerIdentityRoutes(app) {
  // ---------- 平台运维：租户 ----------
  app.post('/v1/admin/tenants', authenticate, requireOperator, async (req, res) => {
    const { name, slug } = req.body || {};
    if (!name) throw Errors.badRequest('name 必填');
    ok(res, await createTenant({ name, slug }), 201);
  });
  app.get('/v1/admin/tenants', authenticate, requireOperator, async (req, res) => {
    ok(res, await listTenants());
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
    authenticate, tenantScope, requireTenantRole('admin'), async (req, res) => {
      const { actorId, name, projectId = null, scopes = [], expiresAt = null } = req.body || {};
      if (!actorId || !name) throw Errors.badRequest('actorId / name 必填');
      assertId('usr', actorId);
      const { secret, prefix, keyHash } = mintKey();
      const row = await createApiKeyRow({
        tenantId: req.params.tenantId, projectId, actorId, name, prefix, keyHash, scopes, expiresAt,
      });
      ok(res, { ...row, key: secret }, 201); // key 只出现在这一次响应里
    });
  app.get('/v1/admin/tenants/:tenantId/api-keys',
    authenticate, tenantScope, requireTenantRole('admin'), async (req, res) => {
      ok(res, await listApiKeys(req.params.tenantId)); // 列表不含 hash/secret
    });
  app.delete('/v1/admin/tenants/:tenantId/api-keys/:keyId',
    authenticate, tenantScope, requireTenantRole('admin'), async (req, res) => {
      await revokeApiKey(req.params.tenantId, req.params.keyId);
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
