/**
 * modules/gateway/ratelimit.mjs —— V2.6：网关速率限制（token bucket）。
 *
 * - 按 bucketKey（租户 + key/actor）做内存 token bucket：容量 = rpm， refill 速率 = rpm/分钟。
 * - rpm 为 null/<=0 时不限流。
 * - 诚实边界：内存实现只对单实例有效；多实例部署必须换 Redis 集中计数
 *   （checkRateLimit 是纯函数式小接口，替换时只需改本文件）。
 * - bucket 上限保护：超过 20000 个时淘汰 10 分钟未活动的，防止内存无限增长。
 */
const buckets = new Map(); // bucketKey -> { tokens, updatedAt }

function trim() {
  if (buckets.size <= 20000) return;
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, b] of buckets) {
    if (b.updatedAt < cutoff) buckets.delete(k);
    if (buckets.size <= 15000) break;
  }
}

export function checkRateLimit(bucketKey, rpm) {
  rpm = Number(rpm);
  if (!Number.isFinite(rpm) || rpm <= 0) return { allowed: true, limited: false, remaining: null };
  const now = Date.now();
  let b = buckets.get(bucketKey);
  if (!b) { b = { tokens: rpm, updatedAt: now }; buckets.set(bucketKey, b); trim(); }
  const elapsed = Math.max(0, now - b.updatedAt);
  b.tokens = Math.min(rpm, b.tokens + (elapsed / 60_000) * rpm);
  b.updatedAt = now;
  if (b.tokens < 1) {
    const retryAfterMs = Math.max(1, Math.ceil(((1 - b.tokens) / rpm) * 60_000));
    return { allowed: false, limited: true, remaining: 0, retryAfterMs };
  }
  b.tokens -= 1;
  return { allowed: true, limited: true, remaining: Math.floor(b.tokens), retryAfterMs: 0 };
}

export const __internal = {
  clear: () => buckets.clear(),
  size: () => buckets.size,
};
