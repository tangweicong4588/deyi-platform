/**
 * modules/identity/idp.mjs —— 身份提供者适配器（JWT 路径）。
 *
 * 契约（两种实现，调用方只认这个形状）：
 *   { kind: 'keycloak' | 'dev', verifyJwt(token) -> claims { sub, tenantSlug?, name?, email? } }
 *
 * - KEYCLOAK_URL 设了 → Keycloak OIDC：用 JWKS 验签，sub 映射到 actor.external_id。
 * - 否则 DEV_IDP_SECRET 设了 → 内置开发 IdP（HS256），**生产禁用**（config 已 fail-fast）。
 * - 两个都没设 → JWT 登录不可用（只剩 API Key）。
 */
import { createHmac, createHash } from 'node:crypto';
import { config } from '../../kernel/config.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { logger } from '../../kernel/logging.mjs';

function b64urlDecode(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// ---------- 内置开发 IdP（HS256，自包含） ----------
function devIdp() {
  const secret = config.DEV_IDP_SECRET;
  const sign = (payload) => {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
    return `${h}.${p}.${sig}`;
  };
  return {
    kind: 'dev',
    /** 仅开发/测试用：给 actor 签一个 token */
    issueDevToken: (actor, tenant, ttlMs = 3600_000) => sign({
      sub: actor.external_id || actor.id,
      actor_id: actor.id,
      tenant_id: tenant.id,
      tenant_slug: tenant.slug,
      name: actor.name,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor((Date.now() + ttlMs) / 1000),
    }),
    verifyJwt: async (token) => {
      const parts = String(token).split('.');
      if (parts.length !== 3) throw Errors.unauthorized('非法 JWT');
      const [h, p, sig] = parts;
      const want = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
      const a = Buffer.from(sig); const b = Buffer.from(want);
      if (a.length !== b.length || !a.equals(b)) throw Errors.unauthorized('JWT 签名无效');
      let claims;
      try { claims = JSON.parse(b64urlDecode(p)); } catch { throw Errors.unauthorized('非法 JWT'); }
      if (claims.exp && claims.exp * 1000 < Date.now()) throw Errors.unauthorized('JWT 已过期');
      return claims;
    },
  };
}

// ---------- Keycloak OIDC（JWKS 验签，ES256/RS256） ----------
const jwksCache = { at: 0, keys: [] };

async function getKeycloakJwks() {
  if (Date.now() - jwksCache.at < 300_000 && jwksCache.keys.length) return jwksCache.keys;
  const url = `${config.KEYCLOAK_URL.replace(/\/$/, '')}/realms/${config.KEYCLOAK_REALM}/protocol/openid-connect/certs`;
  const res = await fetch(url);
  if (!res.ok) throw Errors.upstream(`Keycloak JWKS 获取失败: ${res.status}`);
  const jwks = await res.json();
  jwksCache.at = Date.now();
  jwksCache.keys = jwks.keys || [];
  return jwksCache.keys;
}

function keycloakIdp() {
  return {
    kind: 'keycloak',
    verifyJwt: async (token) => {
      const { createVerify } = await import('node:crypto');
      const [hB64, pB64, sigB64] = String(token).split('.');
      if (!hB64 || !pB64 || !sigB64) throw Errors.unauthorized('非法 JWT');
      let header, claims;
      try {
        header = JSON.parse(b64urlDecode(hB64));
        claims = JSON.parse(b64urlDecode(pB64));
      } catch { throw Errors.unauthorized('非法 JWT'); }
      const keys = await getKeycloakJwks();
      const jwk = keys.find((k) => k.kid === header.kid) || keys[0];
      if (!jwk) throw Errors.unauthorized('Keycloak 公钥未找到');
      const keyObj = (await import('node:crypto')).createPublicKey({ key: jwk, format: 'jwk' });
      const ok = createVerify('SHA256')
        .update(`${hB64}.${pB64}`)
        .verify(keyObj, Buffer.from(sigB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
      if (!ok) throw Errors.unauthorized('JWT 签名无效');
      if (claims.exp && claims.exp * 1000 < Date.now()) throw Errors.unauthorized('JWT 已过期');
      const expectedIss = `${config.KEYCLOAK_URL.replace(/\/$/, '')}/realms/${config.KEYCLOAK_REALM}`;
      if (claims.iss && claims.iss !== expectedIss) throw Errors.unauthorized('JWT 签发者不符');
      return claims; // sub / preferred_username / email
    },
  };
}

let cached = null;
/** 取 IdP（无配置返回 null） */
export function getIdP() {
  if (cached) return cached;
  if (config.KEYCLOAK_URL) {
    logger.info('idp: keycloak', { url: config.KEYCLOAK_URL });
    cached = keycloakIdp();
  } else if (config.DEV_IDP_SECRET) {
    if (config.isProd) throw new Error('生产禁止内置 IdP（config 应已拦截）');
    logger.warn('idp: 内置开发 IdP（仅开发/测试，生产必须 Keycloak）');
    cached = devIdp();
  } else {
    logger.warn('idp: 未配置，JWT 登录不可用（仅 API Key）');
    cached = null;
  }
  return cached;
}
