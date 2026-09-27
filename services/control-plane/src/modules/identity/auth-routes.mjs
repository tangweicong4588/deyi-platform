/**
 * modules/identity/auth-routes.mjs —— V2.10：自研身份服务 HTTP 路由。
 *
 * 公开端点（无鉴权，靠登录锁定防暴力破解）：
 * - POST /v1/auth/login            密码登录 { tenant, username, password, totpCode? }
 * - POST /v1/auth/refresh          refresh 轮换 { refreshToken }
 * - POST /v1/auth/logout           作废 refresh { refreshToken }
 * - GET  /v1/auth/oidc/login       跳转外部 IdP（302）
 * - GET  /v1/auth/oidc/callback    OIDC 回调，换本平台会话
 *
 * 需认证：
 * - POST /v1/auth/totp/setup|enable|disable   本人 TOTP 管理
 * - POST /v1/admin/tenants/:tenantId/users    租户 admin 创建本地用户
 */
import { sendJson } from '../../kernel/http.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { ctx } from '../../kernel/context.mjs';
import { authenticate, tenantScope, requireTenantRole } from './middleware.mjs';
import {
  createLocalUser, loginWithPassword, refreshSession, revokeSession,
  setupTotp, enableTotp, disableTotp,
} from './localauth.mjs';
import { buildLoginUrl, handleOidcCallback } from './oidc.mjs';

const ok = (res, data, status = 200) => sendJson(res, status, { data });

function clientMeta(req) {
  return {
    ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null,
    userAgent: req.headers['user-agent'] || null,
  };
}

export function registerAuthRoutes(app) {
  // ---------- 公开：密码登录 ----------
  app.post('/v1/auth/login', async (req, res) => {
    const { tenant, username, password, totpCode } = req.body || {};
    if (!tenant || !username || !password) throw Errors.badRequest('tenant/username/password 必填');
    ok(res, await loginWithPassword({ tenant, username, password, totpCode, ...clientMeta(req) }));
  });

  // ---------- 公开：refresh 轮换 ----------
  app.post('/v1/auth/refresh', async (req, res) => {
    const { refreshToken } = req.body || {};
    ok(res, await refreshSession(refreshToken, clientMeta(req)));
  });

  // ---------- 公开：登出 ----------
  app.post('/v1/auth/logout', async (req, res) => {
    const { refreshToken } = req.body || {};
    ok(res, await revokeSession(refreshToken));
  });

  // ---------- 公开：OIDC 登录发起 ----------
  app.get('/v1/auth/oidc/login', async (req, res) => {
    const { url } = await buildLoginUrl({ tenant: req.query?.tenant });
    res.writeHead(302, { location: url });
    res.end();
  });

  // ---------- 公开：OIDC 回调 ----------
  app.get('/v1/auth/oidc/callback', async (req, res) => {
    const { code, state } = req.query || {};
    ok(res, await handleOidcCallback({ code, state, ...clientMeta(req) }));
  });

  // ---------- 本人：TOTP 管理 ----------
  app.post('/v1/auth/totp/setup', authenticate, async (req, res) => {
    const c = ctx();
    ok(res, await setupTotp(c.tenantId, c.actorId));
  });

  app.post('/v1/auth/totp/enable', authenticate, async (req, res) => {
    const c = ctx();
    const { code } = req.body || {};
    ok(res, await enableTotp(c.tenantId, c.actorId, code));
  });

  app.post('/v1/auth/totp/disable', authenticate, async (req, res) => {
    const c = ctx();
    const { password } = req.body || {};
    ok(res, await disableTotp(c.tenantId, c.actorId, password));
  });

  // ---------- 租户 admin：创建本地用户 ----------
  app.post('/v1/admin/tenants/:tenantId/users',
    authenticate, tenantScope, requireTenantRole('admin'), async (req, res) => {
      const { username, password, name, email } = req.body || {};
      if (!username || !password) throw Errors.badRequest('username/password 必填');
      ok(res, await createLocalUser(req.params.tenantId, { username, password, name, email }), 201);
    });
}
