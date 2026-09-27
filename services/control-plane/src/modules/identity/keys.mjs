/**
 * modules/identity/keys.mjs —— API Key 签发与校验。
 *
 * 安全规则：
 * - Key 本体永不落盘：库里只存 prefix（定位）+ sha256(pepper:key)（校验）。
 * - 签发时 secret 只返回一次；服务端不保留、不打日志。
 * - 校验用 timingSafeEqual，比对失败不区分"前缀不存在 / hash 不对"（统一定位到 401）。
 * - API_KEY_PEPPER：服务端 pepper 纵深防御。轮换流程：新 pepper 设为 API_KEY_PEPPER，
 *   旧 pepper 移入 API_KEY_PEPPER_PREVIOUS（逗号分隔，可多个）；校验按
 *   当前→历史→无 pepper（最老格式）依次尝试。确认旧 key 全部轮换/过期后，再从
 *   PREVIOUS 移除。无 pepper 版（sha256(secret)）永远保留为最后兜底，保证
 *   pepper 启用前的历史 key 不受影响。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../../kernel/config.mjs';
import { findApiKeyCandidates, touchKeyLastUsed } from './store.mjs';
import { Errors } from '../../kernel/errors.mjs';

const KEY_PREFIX = 'dyk_';

function sha256hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** 参与校验的 pepper 列表：当前 → 历史轮换 → ''（pepper 启用前的旧格式） */
let pepperChainOverride = null; // 仅测试用：模拟 A→B 轮换时的链
function pepperChain() {
  if (pepperChainOverride) return [...pepperChainOverride];
  const chain = [];
  const cur = config.API_KEY_PEPPER || '';
  chain.push(cur);
  const prev = String(config.API_KEY_PEPPER_PREVIOUS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of prev) if (!chain.includes(p)) chain.push(p);
  if (!chain.includes('')) chain.push('');
  return chain;
}
// 无 pepper 时与历史格式完全一致（sha256(secret)），保证已签发 key 不受影响
const hashOf = (secret, pepper) => sha256hex(pepper ? `${pepper}:${secret}` : secret);

/** 生成一次 key：{ secret（仅此一次）, prefix, keyHash } */
export function mintKey() {
  const secret = KEY_PREFIX + randomBytes(24).toString('base64url');
  return { secret, prefix: secret.slice(0, 12), keyHash: hashOf(secret, pepperChain()[0]) };
}

/** 测试钩子：覆盖 pepper 链（模拟轮换），传 null 恢复走 config */
export const __internal = { setPepperChain: (c) => { pepperChainOverride = c; } };

// ---------- V2.5：细粒度 scope ----------
// 语义：key.scopes 为空数组 = 不限制（向后兼容，所有历史 key 不受影响）；
// 一旦设置了 scopes，该 key 只能访问对应 scope 的路由（requireScope 中间件强制）。
export const KEY_SCOPES = [
  'gateway.chat', 'gateway.embeddings',
  'knowledge.read', 'knowledge.write',
  'memory.read', 'memory.write',
  'billing.read', 'billing.write',
  'evidence.read', 'evidence.write',
  'identity.keys', // key 管理：签发/轮换/吊销
];

export function assertValidScopes(scopes) {
  if (!Array.isArray(scopes)) throw Errors.badRequest('scopes 必须为数组');
  const bad = scopes.filter((s) => !KEY_SCOPES.includes(s));
  if (bad.length) {
    throw Errors.badRequest(`非法 scope：${bad.join(',')}（可用：${KEY_SCOPES.join(',')}）`,
      { code: 'INVALID_SCOPE' });
  }
  return [...new Set(scopes)];
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
  // 按 pepper 链校验：当前 → 历史轮换 → 无 pepper（旧格式）。timingSafeEqual 恒定时间比对。
  const wants = pepperChain().map((p) => Buffer.from(hashOf(secret, p), 'hex'));
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
