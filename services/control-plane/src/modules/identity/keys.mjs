/**
 * modules/identity/keys.mjs —— API Key 签发与校验。
 *
 * 安全规则：
 * - Key 本体永不落盘：库里只存 prefix（定位）+ sha256(pepper:key)（校验）。
 * - 签发时 secret 只返回一次；服务端不保留、不打日志。
 * - 校验用 timingSafeEqual，比对失败不区分"前缀不存在 / hash 不对"（统一定位到 401）。
 * - API_KEY_PEPPER：服务端 pepper 纵深防御；轮换后旧 key（无 pepper 版）仍兼容校验。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../../kernel/config.mjs';
import { findApiKeyCandidates, touchKeyLastUsed } from './store.mjs';
import { Errors } from '../../kernel/errors.mjs';

const KEY_PREFIX = 'dyk_';

function sha256hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

const pepperOf = () => config.API_KEY_PEPPER || '';
// 无 pepper 时与历史格式完全一致（sha256(secret)），保证已签发 key 不受影响
const hashOf = (secret, pepper) => sha256hex(pepper ? `${pepper}:${secret}` : secret);

/** 生成一次 key：{ secret（仅此一次）, prefix, keyHash } */
export function mintKey() {
  const secret = KEY_PREFIX + randomBytes(24).toString('base64url');
  return { secret, prefix: secret.slice(0, 12), keyHash: hashOf(secret, pepperOf()) };
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
  // 先按当前 pepper 校验，兼容 pepper 设置前的旧 key（无 pepper 版）
  const pepper = pepperOf();
  const wants = [Buffer.from(hashOf(secret, pepper), 'hex')];
  if (pepper) wants.push(Buffer.from(hashOf(secret, ''), 'hex')); // = sha256(secret)，旧格式
  let hit = null;
  for (const c of candidates) {
    let got;
    try { got = Buffer.from(c.key_hash, 'hex'); } catch { continue; }
    if (wants.some((w) => got.length === w.length && timingSafeEqual(got, w))) { hit = c; break; }
  }
  if (!hit) fail();
  if (hit.expires_at && hit.expires_at < Date.now()) fail();
  const tenant = await getTenant(hit.tenant_id);
  if (!tenant || tenant.status !== 'active') fail();
  const actor = await getActor(hit.tenant_id, hit.actor_id);
  if (!actor || actor.status !== 'active') fail();
  // last_used 更新失败不影响认证本身（L-4：await + try/catch，避免浮动 promise）
  try { await touchKeyLastUsed(hit.tenant_id, hit.id); } catch { /* 忽略 */ }
  return { key: hit, tenant, actor };
}
