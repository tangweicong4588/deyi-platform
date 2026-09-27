/**
 * modules/identity/oidc.mjs —— V2.10：标准 OIDC Relying Party（Client）。
 *
 * 平台不做 OIDC Provider，只做客户端：对接客户已有 IdP（Entra ID/飞书/钉钉/Okta 等）。
 * 流程：OIDC discovery → authorization code + PKCE → state/nonce 校验 →
 *       JWKS 验签 ID token → claims 映射 → JIT 建账号 → 签发本平台会话。
 *
 * 多实例边界：state/nonce 暂存进程内存（10min 过期）。私有化单副本部署不受影响；
 * SaaS 多副本下回调可能落到不同实例——需在 V2.19（多 AZ/多实例就绪）前引入 Redis
 * 共享 state 存储，见 ROADMAP。
 */
import { randomBytes, createHash, createVerify, createPublicKey } from 'node:crypto';
import { config } from '../../kernel/config.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { nowMs } from '../../kernel/ids.mjs';
import { getTenant, getTenantBySlug, createActor, findActorByExternal } from './store.mjs';
import { issueSessionFor } from './localauth.mjs';
import { tryAudit } from '../evidence/audit.mjs';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url').toString('utf8');

// ---------- 配置 ----------
export function isOidcConfigured() {
  return Boolean(config.OIDC_ISSUER && config.OIDC_CLIENT_ID && config.OIDC_CLIENT_SECRET && config.OIDC_REDIRECT_URI);
}

function oidcCfg() {
  if (!isOidcConfigured()) throw Errors.badRequest('OIDC 未配置（OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET/REDIRECT_URI）');
  const iss = config.OIDC_ISSUER.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(iss)) throw Errors.badRequest('OIDC_ISSUER 非法');
  return {
    issuer: iss,
    clientId: config.OIDC_CLIENT_ID,
    clientSecret: config.OIDC_CLIENT_SECRET,
    redirectUri: config.OIDC_REDIRECT_URI,
    scopes: config.OIDC_SCOPES || 'openid profile email',
    defaultTenantId: config.OIDC_DEFAULT_TENANT_ID || null,
  };
}

// ---------- discovery / JWKS 缓存 ----------
let discCache = null; // { at, doc }
const jwksCache = new Map(); // jwksUri -> { at, keys }

async function getDiscovery() {
  const { issuer } = oidcCfg();
  if (discCache && nowMs() - discCache.at < 5 * 60_000) return discCache.doc;
  const url = `${issuer}/.well-known/openid-configuration`;
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw Errors.upstream(`OIDC discovery 失败: HTTP ${r.status}`);
  const doc = await r.json();
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw Errors.upstream('OIDC discovery 缺少必要端点');
  }
  discCache = { at: nowMs(), doc };
  return doc;
}

async function getJwks(jwksUri) {
  const c = jwksCache.get(jwksUri);
  if (c && nowMs() - c.at < 5 * 60_000) return c.keys;
  const r = await fetch(jwksUri, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw Errors.upstream(`OIDC JWKS 获取失败: HTTP ${r.status}`);
  const keys = (await r.json()).keys || [];
  jwksCache.set(jwksUri, { at: nowMs(), keys });
  return keys;
}

export const __internal = {
  clearCache: () => { discCache = null; jwksCache.clear(); pending.clear(); },
  /** 测试用：查看待处理的登录 state（含 nonce/codeVerifier） */
  peekPending: (state) => pending.get(state) || null,
};

// ---------- ID token 验签 ----------
const ALG_HASH = { RS256: 'RSA-SHA256', RS384: 'RSA-SHA384', RS512: 'RSA-SHA512', ES256: 'SHA256', ES384: 'SHA384', ES512: 'SHA512' };

// JWS raw(R||S) → DER（EC 签名用；沿用 OIDC 标准做法）
function rawToDer(raw, size) {
  if (raw.length !== size * 2) throw new Error('EC 签名长度非法');
  const strip = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; return b.slice(i); };
  let r = strip(raw.slice(0, size)), s = strip(raw.slice(size));
  if (r[0] & 0x80) r = Buffer.concat([Buffer.from([0]), r]);
  if (s[0] & 0x80) s = Buffer.concat([Buffer.from([0]), s]);
  return Buffer.concat([Buffer.from([0x30, 2 + r.length + 2 + s.length, 0x02, r.length]), r,
    Buffer.from([0x02, s.length]), s]);
}

function verifyIdTokenSignature(idToken, keys) {
  const [h, p, sigB64] = String(idToken).split('.');
  if (!h || !p || !sigB64) throw Errors.unauthorized('ID token 格式错误');
  let header;
  try { header = JSON.parse(unb64u(h)); } catch { throw Errors.unauthorized('ID token 头非法'); }
  const hashName = ALG_HASH[header.alg];
  if (!hashName) throw Errors.unauthorized(`不支持的 ID token 算法: ${header.alg}`);
  const key = keys.find((k) => !header.kid || k.kid === header.kid) || keys[0];
  if (!key) throw Errors.unauthorized('JWKS 中无可用密钥');
  const signingInput = `${h}.${p}`;
  const sig = Buffer.from(sigB64, 'base64url');
  try {
    const pub = createPublicKey({ key, format: 'jwk' });
    const der = header.alg.startsWith('ES') ? rawToDer(sig, { ES256: 32, ES384: 48, ES512: 66 }[header.alg]) : sig;
    if (!createVerify(hashName).update(signingInput).verify(pub, der)) {
      throw Errors.unauthorized('ID token 签名无效');
    }
  } catch (e) {
    if (e.status === 401) throw e;
    throw Errors.unauthorized(`ID token 验签失败: ${e.message}`);
  }
  return JSON.parse(unb64u(p));
}

async function verifyIdToken(idToken, expectedNonce) {
  const cfg = oidcCfg();
  const doc = await getDiscovery();
  const claims = verifyIdTokenSignature(idToken, await getJwks(doc.jwks_uri));
  if (claims.iss !== cfg.issuer && claims.iss !== doc.issuer) throw Errors.unauthorized('ID token iss 不匹配');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(cfg.clientId)) throw Errors.unauthorized('ID token aud 不匹配');
  if (claims.exp && claims.exp * 1000 < Date.now()) throw Errors.unauthorized('ID token 已过期');
  if (expectedNonce && claims.nonce !== expectedNonce) throw Errors.unauthorized('nonce 不匹配');
  if (!claims.sub) throw Errors.unauthorized('ID token 缺少 sub');
  return claims;
}

// ---------- 登录发起：PKCE + state/nonce ----------
const pending = new Map(); // state -> { nonce, codeVerifier, tenantId, expiresAt }

function sweepPending() {
  const now = nowMs();
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
}

/**
 * 生成 OIDC 登录跳转 URL。tenant：租户 id 或 slug（可选；也可由 IdP claims 映射）。
 * 返回 { url, state }。前端跳转浏览器到 url；回调 GET /v1/auth/oidc/callback?code&state。
 */
export async function buildLoginUrl({ tenant } = {}) {
  const cfg = oidcCfg();
  const doc = await getDiscovery();
  let tenantId = null;
  if (tenant) {
    const t = tenant.startsWith('ten_') ? await getTenant(tenant).catch(() => null) : await getTenantBySlug(tenant);
    if (!t) throw Errors.notFound('租户不存在');
    tenantId = t.id;
  }
  sweepPending();
  const state = `st_${randomBytes(16).toString('base64url')}`;
  const nonce = `n_${randomBytes(16).toString('base64url')}`;
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = b64u(createHash('sha256').update(codeVerifier).digest());
  pending.set(state, { nonce, codeVerifier, tenantId, expiresAt: nowMs() + 10 * 60_000 });
  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('scope', cfg.scopes);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString(), state };
}

// ---------- 回调：换 token → 验签 → 租户映射 → JIT → 本平台会话 ----------
function mapTenant(claims) {
  const cfg = oidcCfg();
  // 优先级：IdP claims 显式映射 > 配置默认租户
  const ref = claims['https://deyi/tenant_id'] || claims.tenant_id || claims.deyi_tenant;
  if (ref) {
    return (String(ref).startsWith('ten_') ? getTenant(ref).catch(() => null) : getTenantBySlug(ref))
      .then((t) => { if (!t) throw Errors.unauthorized('OIDC 租户映射无效'); return t; });
  }
  if (cfg.defaultTenantId) {
    return getTenant(cfg.defaultTenantId).catch(() => null)
      .then((t) => { if (!t) throw Errors.unauthorized('OIDC_DEFAULT_TENANT_ID 无效'); return t; });
  }
  throw Errors.unauthorized('OIDC 未映射到租户：IdP claims 需携带 tenant_id/deyi_tenant，或配置 OIDC_DEFAULT_TENANT_ID');
}

export async function handleOidcCallback({ code, state, ip, userAgent }) {
  if (!code || !state) throw Errors.badRequest('缺少 code/state');
  const p = pending.get(state);
  pending.delete(state);
  if (!p || p.expiresAt < nowMs()) throw Errors.unauthorized('state 无效或已过期');
  const cfg = oidcCfg();
  const doc = await getDiscovery();
  // 1. code 换 token
  const tr = await fetch(doc.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri,
      client_id: cfg.clientId, client_secret: cfg.clientSecret, code_verifier: p.codeVerifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!tr.ok) throw Errors.upstream(`OIDC token 交换失败: HTTP ${tr.status}`);
  const tokens = await tr.json();
  if (!tokens.id_token) throw Errors.upstream('OIDC token 响应缺少 id_token');
  // 2. 验签 ID token
  const claims = await verifyIdToken(tokens.id_token, p.nonce);
  // 3. 租户映射（回调 state 携带的 tenant 优先于 claims）
  const tenant = p.tenantId
    ? await getTenant(p.tenantId).catch(() => null)
    : await mapTenant(claims);
  if (!tenant || tenant.status !== 'active') throw Errors.unauthorized('租户无效或已停用');
  // 4. JIT：按 (tenant, sub) 找 actor，没有则建
  let actor = await findActorByExternal(tenant.id, claims.sub);
  if (!actor) {
    actor = await createActor(tenant.id, {
      kind: 'user',
      name: claims.name || claims.preferred_username || claims.email || claims.sub,
      email: claims.email || null,
      externalId: claims.sub,
    });
    await tryAudit({
      tenantId: tenant.id, actorId: actor.id, action: 'auth.oidc.jit',
      resourceKind: 'auth', resourceId: actor.id,
      payload: { sub: claims.sub, iss: claims.iss },
    }).catch(() => {});
  }
  // 5. 签发本平台会话
  const out = await issueSessionFor(tenant, actor, { ip, userAgent });
  await tryAudit({
    tenantId: tenant.id, actorId: actor.id, action: 'auth.oidc.login',
    resourceKind: 'auth', resourceId: actor.id, payload: { sub: claims.sub, ip },
  }).catch(() => {});
  return out;
}
