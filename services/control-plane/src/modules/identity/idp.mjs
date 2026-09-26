/**
 * modules/identity/idp.mjs —— 身份提供者适配器（JWT 路径）。
 *
 * 契约（两种实现，调用方只认这个形状）：
 *   { kind: 'keycloak' | 'dev', verifyJwt(token) -> claims { sub, tenantSlug?, name?, email? } }
 *
 * - KEYCLOAK_URL 设了 → Keycloak OIDC：用 JWKS 验签，sub 映射到 actor.external_id。
 * - 否则 DEV_IDP_SECRET 设了 → 内置开发 IdP（HS256），**生产禁用**（config 已 fail-fast）。
 * - 两个都没设 → JWT 登录不可用（只剩 API Key）。
 *
 * 注意：Keycloak live 适配器尚未与真实 Keycloak 联调，JWKS/OIDC 交互合同基于
 * OIDC 标准推断；生产上线前必须用真实 Keycloak 做端到端验证。
 */
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
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
      // 恒定时间比较（L-7 安全 review：原来用 a.equals(b)）
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw Errors.unauthorized('JWT 签名无效');
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
  // M-3 安全 review：原来 fetch 无超时，Keycloak 挂起会导致认证请求无限挂起
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw Errors.upstream(`Keycloak JWKS 获取失败: ${res.status}`);
  const jwks = await res.json();
  jwksCache.at = Date.now();
  jwksCache.keys = jwks.keys || [];
  return jwksCache.keys;
}

// Keycloak JWT 签名算法白名单（拒绝 none / HS256 等算法混淆）
// alg → 验签哈希映射（batch1 遗留修复：原来硬编码 SHA256，RS384/512、ES384/512 会验签失败）
const KC_ALG_HASH = {
  RS256: 'SHA256', RS384: 'SHA384', RS512: 'SHA512',
  ES256: 'SHA256', ES384: 'SHA384', ES512: 'SHA512',
};
const KC_ALLOWED_ALG = new Set(Object.keys(KC_ALG_HASH));
// exp 时钟偏差容忍（秒）
const CLOCK_SKEW_S = 30;

/**
 * JWS ECDSA 签名是 raw R||S 定长拼接；node createVerify 要 DER 编码。
 * batch1 遗留修复：原来 ES256/384/512 在白名单里但没做这个转换，ES 签名永远验不过
 * （报"签名无效"，fail-closed 但原因误导）。现在按 alg 的坐标长度正确转 DER。
 */
function derEncodeEcdsaSig(raw, coordLen, what = 'JWT') {
  if (raw.length !== coordLen * 2) throw Errors.unauthorized(`${what} ECDSA 签名长度无效`);
  const ints = [raw.subarray(0, coordLen), raw.subarray(coordLen)].map((p) => {
    let i = 0;
    while (i < p.length - 1 && p[i] === 0) i++; // 去前导零
    let v = p.subarray(i);
    if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0x00]), v]); // 高位置 1 则补 0x00 防负数
    return Buffer.concat([Buffer.from([0x02, v.length]), v]);
  });
  const body = Buffer.concat(ints);
  // DER 长度编码：短式（<128）/ 长式
  const lenBytes = body.length < 128
    ? Buffer.from([body.length])
    : Buffer.from([0x81, body.length]);
  return Buffer.concat([Buffer.from([0x30]), lenBytes, body]);
}
const ES_COORD_LEN = { ES256: 32, ES384: 48, ES512: 66 }; // P-256/384/521

/**
 * Keycloak JWT 签名验签核心（batch1 回归测试入口）：header 解析 → 算法白名单 →
 * JWKS 选钥 → 验签，返回 { header, claims }。验签失败抛 401。
 * keys 由调用方传入（生产走 getKeycloakJwks，测试可注入）。
 */
async function verifyKeycloakSignature(token, keys) {
  const { createVerify, createPublicKey } = await import('node:crypto');
  const [hB64, pB64, sigB64] = String(token).split('.');
  if (!hB64 || !pB64 || !sigB64) throw Errors.unauthorized('非法 JWT');
  let header, claims;
  try {
    header = JSON.parse(b64urlDecode(hB64));
    claims = JSON.parse(b64urlDecode(pB64));
  } catch { throw Errors.unauthorized('非法 JWT'); }
  if (!KC_ALLOWED_ALG.has(header.alg)) throw Errors.unauthorized('JWT 签名算法不在白名单');
  const jwk = (keys || []).find((k) => k.kid === header.kid) || (keys || [])[0];
  if (!jwk) throw Errors.unauthorized('Keycloak 公钥未找到');
  const keyObj = createPublicKey({ key: jwk, format: 'jwk' });
  let sig = Buffer.from(sigB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (header.alg.startsWith('ES')) sig = derEncodeEcdsaSig(sig, ES_COORD_LEN[header.alg]);
  const ok = createVerify(KC_ALG_HASH[header.alg])
    .update(`${hB64}.${pB64}`)
    .verify(keyObj, sig);
  if (!ok) throw Errors.unauthorized('JWT 签名无效');
  return { header, claims };
}

/** 测试钩子：验签核心 + 算法映射（验签路径与生产完全一致） */
export const __internal = { verifyKeycloakSignature, KC_ALG_HASH, KC_ALLOWED_ALG };

function keycloakIdp() {
  return {
    kind: 'keycloak',
    verifyJwt: async (token) => {
      const { claims } = await verifyKeycloakSignature(token, await getKeycloakJwks());
      const nowS = Math.floor(Date.now() / 1000);
      if (claims.exp && claims.exp < nowS - CLOCK_SKEW_S) throw Errors.unauthorized('JWT 已过期');
      if (claims.nbf && claims.nbf > nowS + CLOCK_SKEW_S) throw Errors.unauthorized('JWT 尚未生效');
      // H-2 安全 review：原来 iss 缺失即放行、aud 完全不校验（受众混淆风险）
      const expectedIss = `${config.KEYCLOAK_URL.replace(/\/$/, '')}/realms/${config.KEYCLOAK_REALM}`;
      if (claims.iss !== expectedIss) throw Errors.unauthorized('JWT 签发者不符');
      if (config.KEYCLOAK_AUDIENCE) {
        const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (!auds.includes(config.KEYCLOAK_AUDIENCE)) throw Errors.unauthorized('JWT 受众不符');
      }
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
