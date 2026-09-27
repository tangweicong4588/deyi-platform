/**
 * modules/identity/middleware.mjs —— 认证与鉴权中间件。
 *
 * 认证顺序：OPERATOR_TOKEN（平台运维）→ dyk_ API Key → JWT（本地身份服务签发）。
 * 上下文 tenantId/actorId 只从凭证派生；requireRole 只认 role_bindings。
 */
import { runWithContext, ctx } from '../../kernel/context.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { config } from '../../kernel/config.mjs';
import { timingSafeEqual } from 'node:crypto';
import { verifyApiKey } from './keys.mjs';
import {
  getTenant, getActor, findActorByExternal, createActor,
  getRoleBindings, roleRank,
} from './store.mjs';
import { getIdP } from './idp.mjs';
import { logger } from '../../kernel/logging.mjs';

async function fromApiKey(secret) {
  const { key, tenant, actor } = await verifyApiKey(secret, { getTenant, getActor });
  const bindings = await getRoleBindings(tenant.id, actor.id);
  return {
    authKind: 'api_key', tenantId: tenant.id, actorId: actor.id, actorKind: actor.kind,
    projectId: key.project_id || null, roles: bindings,
    keyId: key.id, keyScopes: Array.isArray(key.scopes) ? key.scopes : [],
  };
}

async function fromJwt(token) {
  const idp = getIdP();
  if (!idp) throw Errors.unauthorized('JWT 登录未配置');
  const claims = await idp.verifyJwt(token);
  // 租户：优先 claims 里的 tenant_id，回退按 slug 找
  let tenant = null;
  if (claims.tenant_id) tenant = await getTenant(claims.tenant_id).catch(() => null);
  if (!tenant) throw Errors.unauthorized('JWT 未绑定有效租户');
  if (tenant.status !== 'active') throw Errors.unauthorized('租户已停用');
  // 主体：优先 actor_id，回退 external_id(sub)，都没有则自动开通（无角色，需管理员授权）
  let actor = null;
  if (claims.actor_id) actor = await getActor(tenant.id, claims.actor_id).catch(() => null);
  if (!actor && claims.sub) actor = await findActorByExternal(tenant.id, String(claims.sub));
  if (!actor && claims.sub) {
    actor = await createActor(tenant.id, {
      kind: 'user',
      name: claims.name || claims.preferred_username || 'sso-user',
      email: claims.email || null,
      externalId: String(claims.sub),
    });
    logger.info('identity: sso auto-provision', { tenant: tenant.slug, sub: claims.sub });
  }
  if (!actor || actor.status !== 'active') throw Errors.unauthorized('主体无效');
  const bindings = await getRoleBindings(tenant.id, actor.id);
  return {
    authKind: 'jwt', tenantId: tenant.id, actorId: actor.id, actorKind: actor.kind,
    projectId: null, roles: bindings,
  };
}

/** 认证中间件：解析出身份并重建请求上下文（不抛 500，失败即 401） */
export async function authenticate(req, res, next) {
  const header = req.headers['authorization'] || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) throw Errors.unauthorized('缺少 Authorization: Bearer');
  const token = m[1].trim();

  let resolved;
  // L-3 安全 review：OPERATOR_TOKEN 用恒定时间比较（防时序侧信道）
  const opToken = config.OPERATOR_TOKEN;
  const isOperator = !!opToken && token.length === opToken.length &&
    timingSafeEqual(Buffer.from(token), Buffer.from(opToken));
  if (isOperator) {
    resolved = { authKind: 'operator', tenantId: null, actorId: 'operator', actorKind: 'service', projectId: null, roles: [] };
  } else if (token.startsWith('dyk_')) {
    resolved = await fromApiKey(token);
  } else {
    resolved = await fromJwt(token);
  }
  const traceId = ctx().traceId;
  await runWithContext({ traceId, ...resolved }, () => next());
}
// V2.9：鉴权标记，供 OpenAPI 规范生成读取（不影响运行时语义）
authenticate.authInfo = { kind: 'authenticated' };

/** 平台运维（OPERATOR_TOKEN） */
export async function requireOperator(req, res, next) {
  if (ctx().authKind !== 'operator') throw Errors.forbidden('需要平台运维权限');
  await next();
}
requireOperator.authInfo = { kind: 'operator' };

/** 计算在某项目下的有效角色等级（取租户级与项目级的最大值） */
export function effectiveRank(bindings, projectId = null) {
  let rank = -1;
  for (const b of bindings) {
    if (b.project_id === null || (projectId && b.project_id === projectId)) {
      rank = Math.max(rank, roleRank(b.role));
    }
  }
  return rank;
}

/** 要求租户级最低角色（admin 路由用） */
export function requireTenantRole(minRole) {
  const min = roleRank(minRole);
  const fn = async (req, res, next) => {
    const c = ctx();
    if (c.authKind === 'operator') return next();
    if (!c.tenantId) throw Errors.unauthorized();
    if (effectiveRank(c.roles, null) < min) throw Errors.forbidden(`需要租户级 ${minRole} 角色`);
    await next();
  };
  fn.authInfo = { kind: 'tenantRole', role: minRole }; // V2.9：OpenAPI 标记
  return fn;
}

/**
 * V2.5：key 级细粒度权限守卫。
 * - operator（平台运维）与 JWT（走 IdP/角色体系）不受 key scope 限制；
 * - API Key 未设置 scopes（空数组）= 不限制，向后兼容所有历史 key；
 * - 一旦设置 scopes，key 必须拥有任一所列 scope 才能进入该路由。
 */
export function requireScope(...scopes) {
  const fn = async (req, res, next) => {
    const c = ctx();
    if (c.authKind !== 'api_key') return next();
    const ks = c.keyScopes || [];
    if (ks.length === 0) return next(); // 未设置 = 不限制（向后兼容）
    if (!scopes.some((s) => ks.includes(s))) {
      throw Errors.forbidden(`API Key 缺少所需 scope（需要其一：${scopes.join(' / ')}）`,
        { code: 'INSUFFICIENT_SCOPE' });
    }
    await next();
  };
  fn.authInfo = { kind: 'scopes', scopes: [...scopes] }; // V2.9：OpenAPI 标记
  return fn;
}

/**
 * 租户隔离守卫：路由含 :tenantId 时，operator 放行，其余必须与自身租户一致。
 * 放到 authenticate 之后、业务 handler 之前。
 */
export async function tenantScope(req, res, next) {
  const c = ctx();
  const tid = req.params?.tenantId;
  if (tid && c.authKind !== 'operator' && c.tenantId !== tid) {
    throw Errors.forbidden('跨租户访问被拒绝');
  }
  await next();
}
tenantScope.authInfo = { kind: 'tenantScope' }; // V2.9：OpenAPI 标记
