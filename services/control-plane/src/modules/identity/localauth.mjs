/**
 * modules/identity/localauth.mjs —— V2.10：自研轻量身份服务。
 *
 * 替代 Keycloak 的重量级方案，覆盖：
 * - 本地用户：租户内 username + scrypt 密码哈希（见 passwords.mjs）
 * - TOTP 二次验证（见 totp.mjs；totp_secret 以 AES-256-GCM 信封存于 totp_secret_enc，
 *   V2.16；历史明文列 lazy 迁移，见 readTotpSecret）
 * - 会话：短期 access JWT（15min，HS256）+ 可轮换 refresh token（7d，库中只存 sha256）
 * - 登录失败锁定：15min 内 5 次失败 → 锁定 15min；登录尝试记 login_attempts（审计+锁定依据）
 * - 登录成功/失败/锁定走审计链（tryAudit，best-effort）
 *
 * 多实例边界：内存中无状态（除 OIDC 的 state/nonce 在 oidc.mjs），会话/锁定全在 DB，
 * 可直接多副本部署。
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { db } from '../../db/index.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { newId, nowMs } from '../../kernel/ids.mjs';
import { config } from '../../kernel/config.mjs';
import { getIdP } from './idp.mjs';
import { getTenant, getTenantBySlug, createActor, getActor } from './store.mjs';
import { hashPassword, verifyPassword, assertPasswordPolicy } from './passwords.mjs';
import { generateTotpSecret, verifyTotp, otpauthUrl } from './totp.mjs';
import { tryAudit } from '../evidence/audit.mjs';
import { kms, registerEncryptedField } from '../../kernel/kms.mjs';

// V2.16：totp_secret 落库加密（key 轮换 sweep 注册）
registerEncryptedField({ table: 'local_credentials', fieldCol: 'totp_secret_enc' });

export const ACCESS_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TTL_MS = 7 * 24 * 3600 * 1000;
export const MAX_ATTEMPTS = 5;
export const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
export const LOCK_MS = 15 * 60 * 1000;

// 用户名规则：3–64 位，字母数字/下划线/点/横线
const USERNAME_RE = /^[a-zA-Z0-9_.\-]{3,64}$/;

function sha256hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function auditLogin(tenantId, actorId, action, payload) {
  return tryAudit({
    tenantId, actorId: actorId || undefined, action,
    resourceKind: 'auth', resourceId: actorId || 'unknown', payload,
  }).catch(() => {});
}

/** 按 id（ten_…）或 slug 解析租户 */
export async function resolveTenant(ref) {
  if (typeof ref !== 'string' || !ref) throw Errors.badRequest('tenant 必填');
  if (ref.startsWith('ten_')) {
    const t = await getTenant(ref).catch(() => null);
    if (!t) throw Errors.notFound('租户不存在');
    return t;
  }
  const t = await getTenantBySlug(ref);
  if (!t) throw Errors.notFound('租户不存在');
  return t;
}

const getCred = async (tenantId, username, h = db()) => {
  const rows = await h.query(
    'SELECT * FROM local_credentials WHERE tenant_id=? AND username=?', [tenantId, username]);
  return rows[0] || null;
};

/**
 * V2.16：读取 TOTP secret（统一走密文列）。
 * - totp_secret_enc 存在 → 解密；篡改/解密失败返回 null（登录路径按"验证码错误" 401 处理，不泄露内部错误）。
 * - 仅有历史明文 totp_secret → lazy 迁移：best-effort 加密回写（KMS 未配置时跳过迁移，登录仍可用）；
 *   迁移失败（503）不阻塞登录。
 * 返回 secret 明文或 null。
 */
async function readTotpSecret(cred) {
  if (!cred) return null;
  if (cred.totp_secret_enc) {
    try {
      return kms.decrypt(cred.totp_secret_enc);
    } catch (e) {
      if (e?.details?.code === 'FIELD_DECRYPT_FAILED') return null; // 篡改 → 视为无效
      throw e;
    }
  }
  if (cred.totp_secret) {
    const plaintext = cred.totp_secret;
    try {
      const enc = kms.encrypt(plaintext);
      await db().run('UPDATE local_credentials SET totp_secret_enc=?, totp_secret=NULL, updated_at=? WHERE id=?',
        [enc, nowMs(), cred.id]);
      cred.totp_secret_enc = enc;
      cred.totp_secret = null;
    } catch (e) {
      if (e?.details?.code !== 'FIELD_ENCRYPTION_UNCONFIGURED') throw e;
      // KMS 未配置：跳过迁移，登录仍用明文（新 setup 已 fail-closed，此处保可用）
    }
    return plaintext;
  }
  return null;
}

/** 管理路径（setup/enable 已鉴权）用的严格读取：解密失败直接抛 500，不吞错。 */
async function readTotpSecretStrict(cred) {
  if (cred?.totp_secret_enc) return kms.decrypt(cred.totp_secret_enc);
  return readTotpSecret(cred);
}

/** 创建本地用户：actor（user）+ 凭证。调用方负责鉴权（租户 admin / operator）。 */
export async function createLocalUser(tenantId, { username, password, name, email = null }) {
  if (!USERNAME_RE.test(username || '')) throw Errors.badRequest('用户名非法（3–64 位：字母/数字/_/./-）');
  assertPasswordPolicy(password);
  const tenant = await getTenant(tenantId).catch(() => null);
  if (!tenant) throw Errors.notFound('租户不存在');
  if (tenant.status !== 'active') throw Errors.forbidden('租户已停用');
  return db().transaction(async (tx) => {
    const actor = await createActor(tenantId, { kind: 'user', name: name || username, email }, tx);
    const id = newId('lcr');
    try {
      await tx.query(
        `INSERT INTO local_credentials(id,tenant_id,actor_id,username,password_hash,totp_enabled,created_at,updated_at)
         VALUES (?,?,?,?,?,0,?,?)`,
        [id, tenantId, actor.id, username, await hashPassword(password), nowMs(), nowMs()]);
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) throw Errors.conflict(`用户名已存在: ${username}`);
      throw e;
    }
    await auditLogin(tenantId, actor.id, 'auth.user.created', { username });
    return { actor, credentialId: id, username };
  });
}

/** 未知用户时的等时 dummy 校验（防用户枚举时序侧信道） */
let dummyHash = null;
async function dummyVerify(password) {
  dummyHash ||= await hashPassword('dummy-password-for-timing');
  await verifyPassword(password, dummyHash);
}

async function recordAttempt(tenantId, username, success, ip) {
  await db().query(
    'INSERT INTO login_attempts(id,tenant_id,username,success,ip,created_at) VALUES (?,?,?,?,?,?)',
    [newId('lat'), tenantId, username, success ? 1 : 0, ip || null, nowMs()]);
}

async function isLocked(tenantId, username) {
  const since = nowMs() - ATTEMPT_WINDOW_MS;
  const rows = await db().query(
    `SELECT COUNT(*) AS c FROM login_attempts
     WHERE tenant_id=? AND username=? AND success=0 AND created_at>=?`,
    [tenantId, username, since]);
  return (rows[0]?.c || 0) >= MAX_ATTEMPTS;
}

function issueTokens(tenant, actor, { ip, userAgent } = {}) {
  const idp = getIdP();
  if (!idp) throw Errors.internal('身份服务未配置（AUTH_JWT_SECRET 缺失）');
  return db().transaction(async (tx) => {
    const jti = newId('ses');
    const now = nowMs();
    const accessToken = idp.signAccessToken({
      jti, typ: 'access',
      sub: actor.id, actor_id: actor.id, tenant_id: tenant.id, tenant_slug: tenant.slug,
      name: actor.name,
      iat: Math.floor(now / 1000), exp: Math.floor((now + ACCESS_TTL_MS) / 1000),
    });
    const refreshToken = `dyr_${randomBytes(32).toString('base64url')}`;
    await tx.query(
      `INSERT INTO auth_sessions(id,tenant_id,actor_id,refresh_hash,expires_at,ip,user_agent,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [jti, tenant.id, actor.id, sha256hex(refreshToken), now + REFRESH_TTL_MS,
       ip || null, userAgent || null, now]);
    return {
      accessToken, refreshToken,
      expiresIn: Math.floor(ACCESS_TTL_MS / 1000),
      tokenType: 'Bearer',
      actor: { id: actor.id, name: actor.name, kind: actor.kind },
      tenant: { id: tenant.id, slug: tenant.slug },
    };
  });
}

/**
 * 密码登录。成功返回会话；失败抛 401（并记录）；锁定中抛 423。
 * TOTP 已启用时必须同时传 totpCode，否则抛 401 code=TOTP_REQUIRED。
 */
export async function loginWithPassword({ tenant, username, password, totpCode, ip, userAgent }) {
  const t = await resolveTenant(tenant);
  if (t.status !== 'active') throw Errors.forbidden('租户已停用');
  if (await isLocked(t.id, username)) {
    await auditLogin(t.id, null, 'auth.login.locked', { username, ip });
    throw Errors.locked('登录失败次数过多，账户已临时锁定');
  }
  const cred = await getCred(t.id, username);
  const ok = cred ? await verifyPassword(password || '', cred.password_hash) : await dummyVerify(password || '');
  if (!ok || !cred) {
    await recordAttempt(t.id, username, false, ip);
    await auditLogin(t.id, cred?.actor_id, 'auth.login.failed', { username, ip, reason: 'bad-credential' });
    throw Errors.unauthorized('用户名或密码错误');
  }
  const actor = await getActor(t.id, cred.actor_id).catch(() => null);
  if (!actor || actor.status !== 'active') {
    await recordAttempt(t.id, username, false, ip);
    throw Errors.unauthorized('主体无效');
  }
  if (cred.totp_enabled) {
    const totpSecret = await readTotpSecret(cred);
    if (!verifyTotp(totpSecret || '', totpCode || '')) {
      const e = Errors.unauthorized(totpCode ? '二次验证码错误' : '需要二次验证码');
      e.details = { ...(e.details || {}), code: 'TOTP_REQUIRED' };
      throw e;
    }
  }
  await recordAttempt(t.id, username, true, ip);
  const out = await issueTokens(t, actor, { ip, userAgent });
  await auditLogin(t.id, actor.id, 'auth.login.success', { username, ip });
  return out;
}

/** refresh 轮换：旧 refresh 立即作废，签发新会话 */
export async function refreshSession(refreshToken, { ip, userAgent } = {}) {
  if (!refreshToken) throw Errors.unauthorized('缺少 refresh token');
  const hash = sha256hex(refreshToken);
  const rows = await db().query('SELECT * FROM auth_sessions WHERE refresh_hash=?', [hash]);
  const s = rows[0];
  if (!s || s.revoked_at || s.expires_at < nowMs()) throw Errors.unauthorized('refresh token 无效或已过期');
  const tenant = await getTenant(s.tenant_id).catch(() => null);
  const actor = tenant ? await getActor(tenant.id, s.actor_id).catch(() => null) : null;
  if (!tenant || tenant.status !== 'active' || !actor || actor.status !== 'active') {
    throw Errors.unauthorized('租户或主体无效');
  }
  await db().run('UPDATE auth_sessions SET revoked_at=? WHERE id=?', [nowMs(), s.id]);
  await auditLogin(tenant.id, actor.id, 'auth.session.rotated', { sessionId: s.id });
  return issueTokens(tenant, actor, { ip, userAgent });
}

/** 登出：作废 refresh token（access token 自然过期，15min） */
export async function revokeSession(refreshToken) {
  if (!refreshToken) return { revoked: false };
  const r = await db().run('UPDATE auth_sessions SET revoked_at=? WHERE refresh_hash=? AND revoked_at IS NULL',
    [nowMs(), sha256hex(refreshToken)]);
  return { revoked: (r.changes || 0) > 0 };
}

/** TOTP 注册第一步：生成 secret（未启用，需第二步确认） */
export async function setupTotp(tenantId, actorId) {
  const cred = (await db().query(
    'SELECT * FROM local_credentials WHERE tenant_id=? AND actor_id=?', [tenantId, actorId]))[0];
  if (!cred) throw Errors.notFound('本地凭证不存在');
  const secret = generateTotpSecret();
  // V2.16：只存密文（无 KMS key 时 fail-closed，不落明文）
  const enc = kms.encrypt(secret);
  await db().run('UPDATE local_credentials SET totp_secret_enc=?, totp_secret=NULL, totp_enabled=0, updated_at=? WHERE id=?',
    [enc, nowMs(), cred.id]);
  const actor = await getActor(tenantId, actorId).catch(() => null);
  return {
    secret,
    otpauthUrl: otpauthUrl(secret, {
      issuer: config.OIDC_TOTP_ISSUER || 'Deyi',
      account: `${cred.username}`,
    }),
    actorName: actor?.name,
  };
}

/** TOTP 注册第二步：用一次有效验证码启用 */
export async function enableTotp(tenantId, actorId, code) {
  const cred = (await db().query(
    'SELECT * FROM local_credentials WHERE tenant_id=? AND actor_id=?', [tenantId, actorId]))[0];
  const pending = await readTotpSecretStrict(cred);
  if (!cred || !pending) throw Errors.badRequest('请先 setup 生成 secret');
  if (!verifyTotp(pending, code || '')) throw Errors.badRequest('验证码错误');
  await db().run('UPDATE local_credentials SET totp_enabled=1, updated_at=? WHERE id=?', [nowMs(), cred.id]);
  await auditLogin(tenantId, actorId, 'auth.totp.enabled', {});
  return { enabled: true };
}

/** 关闭 TOTP：需验证密码 */
export async function disableTotp(tenantId, actorId, password) {
  const cred = (await db().query(
    'SELECT * FROM local_credentials WHERE tenant_id=? AND actor_id=?', [tenantId, actorId]))[0];
  if (!cred) throw Errors.notFound('本地凭证不存在');
  if (!await verifyPassword(password || '', cred.password_hash)) throw Errors.unauthorized('密码错误');
  await db().run('UPDATE local_credentials SET totp_secret=NULL, totp_secret_enc=NULL, totp_enabled=0, updated_at=? WHERE id=?',
    [nowMs(), cred.id]);
  await auditLogin(tenantId, actorId, 'auth.totp.disabled', {});
  return { enabled: false };
}

/** 供 OIDC/JIT 等已认证路径直接签发会话（不走密码校验） */
export function issueSessionFor(tenant, actor, opts) {
  return issueTokens(tenant, actor, opts);
}

/** 测试/运维钩子 */
export const __internal = { isLocked, getCred, sha256hex };
