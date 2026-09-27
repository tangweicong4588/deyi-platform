/**
 * modules/identity/idp.mjs —— V2.10：本地身份 IdP。
 *
 * V2.10 起移除 Keycloak 依赖（过重）。平台身份策略：
 * - 本平台签发的 access JWT：全部由本模块签发/验签（HS256；密钥来自
 *   AUTH_JWT_SECRET，开发/测试沿用 DEV_IDP_SECRET；生产未配 AUTH_JWT_SECRET
 *   则启动 fail-fast，见 kernel/config.mjs）。
 * - 外部身份：平台只做标准 OIDC Relying Party（见 oidc.mjs），不再自研 OIDC
 *   Provider，也不再保留任何 Keycloak 专用语义。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../kernel/config.mjs';
import { logger } from '../../kernel/logging.mjs';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url').toString('utf8');

export function getJwtSecret() {
  return config.AUTH_JWT_SECRET || config.DEV_IDP_SECRET || '';
}

function signJwt(payload, secret) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

function verifyJwt(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) {
    const e = new Error('JWT 格式错误'); e.status = 401; throw e;
  }
  const [h, p, sig] = parts;
  let header;
  try { header = JSON.parse(unb64u(h)); } catch { const e = new Error('JWT 头非法'); e.status = 401; throw e; }
  if (header.alg !== 'HS256') { const e = new Error(`不支持的 JWT 算法: ${header.alg}`); e.status = 401; throw e; }
  const want = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const got = Buffer.from(sig, 'base64url');
  if (want.length !== got.length || !timingSafeEqual(want, got)) {
    const e = new Error('JWT 签名无效'); e.status = 401; throw e;
  }
  let claims;
  try { claims = JSON.parse(unb64u(p)); } catch { const e = new Error('JWT 载荷非法'); e.status = 401; throw e; }
  if (claims.exp && claims.exp * 1000 < Date.now()) { const e = new Error('JWT 已过期'); e.status = 401; throw e; }
  return claims;
}

let cached = null;
let warned = false;

/** 本地 IdP：签发/验签本平台 access JWT。无密钥配置时返回 null（调用方按 500 处理）。 */
export function getIdP() {
  if (cached) return cached;
  const secret = getJwtSecret();
  if (!secret) {
    if (!warned) { logger.warn('idp: 未配置 AUTH_JWT_SECRET/DEV_IDP_SECRET，JWT 登录不可用'); warned = true; }
    return null;
  }
  cached = {
    kind: 'local',
    verifyJwt: (token) => verifyJwt(token, secret),
    signAccessToken: (claims) => signJwt(claims, secret),
    /** 兼容旧 dev 测试与本地调试：签发测试 token */
    issueDevToken: (actor, tenant, ttlMs = 3600_000) => signJwt({
      sub: actor.id, actor_id: actor.id, tenant_id: tenant.id,
      tenant_slug: tenant.slug, name: actor.name,
      iat: Math.floor(Date.now() / 1000), exp: Math.floor((Date.now() + ttlMs) / 1000),
    }, secret),
  };
  return cached;
}
