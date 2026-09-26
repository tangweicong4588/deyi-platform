/**
 * modules/identity/keys.mjs —— API Key 签发与校验。
 *
 * 安全规则：
 * - Key 本体永不落盘：库里只存 prefix（定位）+ sha256(key)（校验）。
 * - 签发时 secret 只返回一次；服务端不保留、不打日志。
 * - 校验用 timingSafeEqual，比对失败不区分"前缀不存在 / hash 不对"（统一定位到 401）。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { findApiKeyCandidates, touchKeyLastUsed } from './store.mjs';
import { Errors } from '../../kernel/errors.mjs';

const KEY_PREFIX = 'dyk_';

function sha256hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** 生成一次 key：{ secret（仅此一次）, prefix, keyHash } */
export function mintKey() {
  const secret = KEY_PREFIX + randomBytes(24).toString('base64url');
  return { secret, prefix: secret.slice(0, 12), keyHash: sha256hex(secret) };
}

/**
 * 校验 key，返回 { key, tenant, actor }。
 * 任何失败都抛 Errors.unauthorized()（不泄露是哪一步失败）。
 */
export async function verifyApiKey(secret, { getTenant, getActor }) {
  const fail = () => { throw Errors.unauthorized('无效的 API Key'); };
  if (typeof secret !== 'string' || !secret.startsWith(KEY_PREFIX) || secret.length < 20) fail();
  const prefix = secret.slice(0, 12);
  const candidates = await findApiKeyCandidates(prefix);
  const want = Buffer.from(sha256hex(secret), 'hex');
  let hit = null;
  for (const c of candidates) {
    let got;
    try { got = Buffer.from(c.key_hash, 'hex'); } catch { continue; }
    if (got.length === want.length && timingSafeEqual(got, want)) { hit = c; break; }
  }
  if (!hit) fail();
  if (hit.expires_at && hit.expires_at < Date.now()) fail();
  const tenant = await getTenant(hit.tenant_id);
  if (!tenant || tenant.status !== 'active') fail();
  const actor = await getActor(hit.tenant_id, hit.actor_id);
  if (!actor || actor.status !== 'active') fail();
  // last_used 更新失败不影响认证本身
  touchKeyLastUsed(hit.id).catch(() => {});
  return { key: hit, tenant, actor };
}
