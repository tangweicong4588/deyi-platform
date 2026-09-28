/**
 * modules/gateway/ratelimit/memory.mjs —— V2.15：内存后端（单实例）。
 * 从旧 ratelimit.mjs 迁移而来，语义保持一致；新增 throttle（固定窗口节流）。
 *
 * 契约（与 redis.mjs 一致）：
 * - check(bucketKey, rpm) -> { allowed, limited, remaining, retryAfterMs }
 * - throttle(key, windowMs) -> boolean（true=允许执行）
 * - close()（内存版无操作）
 */
export function createMemoryLimiter({ now = Date.now } = {}) {
  const buckets = new Map(); // bucketKey -> { tokens, updatedAt }
  const throttleAt = new Map(); // key -> 上次允许执行的时间戳

  function trim() {
    if (buckets.size <= 20000) return;
    const cutoff = now() - 10 * 60_000;
    for (const [k, b] of buckets) {
      if (b.updatedAt < cutoff) buckets.delete(k);
      if (buckets.size <= 15000) break;
    }
  }

  async function check(bucketKey, rpm) {
    rpm = Number(rpm);
    if (!Number.isFinite(rpm) || rpm <= 0) {
      return { allowed: true, limited: false, remaining: null, retryAfterMs: 0 };
    }
    const t = now();
    let b = buckets.get(bucketKey);
    if (!b) { b = { tokens: rpm, updatedAt: t }; buckets.set(bucketKey, b); trim(); }
    const elapsed = Math.max(0, t - b.updatedAt);
    b.tokens = Math.min(rpm, b.tokens + (elapsed / 60_000) * rpm);
    b.updatedAt = t;
    if (b.tokens < 1) {
      const retryAfterMs = Math.max(1, Math.ceil(((1 - b.tokens) / rpm) * 60_000));
      return { allowed: false, limited: true, remaining: 0, retryAfterMs };
    }
    b.tokens -= 1;
    return { allowed: true, limited: true, remaining: Math.floor(b.tokens), retryAfterMs: 0 };
  }

  async function throttle(key, windowMs) {
    const t = now();
    const last = throttleAt.get(key);
    if (last !== undefined && t - last < windowMs) return false;
    throttleAt.set(key, t);
    return true;
  }

  return {
    backend: 'memory',
    check,
    throttle,
    close: async () => {},
    __internal: {
      clear: () => { buckets.clear(); throttleAt.clear(); },
      size: () => buckets.size,
    },
  };
}
