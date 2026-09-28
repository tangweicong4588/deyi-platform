/**
 * modules/gateway/ratelimit/redis.mjs —— V2.15：Redis 后端（多实例共享计数）。
 *
 * - 懒连接：第一次调用时连接；Redis 缺席/连接失败 → 降级为内存后端并告警一次
 *   （onDegraded 回调，默认记 logger.warn），不阻塞启动。
 * - 运行时 EVAL 失败 → 当次调用回退内存（fail-open：保可用，降级期间为单实例语义），
 *   并记 warn；连接恢复后自动切回 Redis（下次调用重新 ensureClient）。
 * - client 工厂可注入（测试用 fake）；默认用 resp.mjs 的最小 RESP 客户端。
 */
import { connectResp, RespError } from './resp.mjs';
import { createMemoryLimiter } from './memory.mjs';
import { RATE_LIMIT_SCRIPT, RATE_LIMIT_SHA, THROTTLE_SCRIPT, THROTTLE_SHA, BUCKET_TTL_MS } from './lua.mjs';

export function createRedisLimiter({
  url,
  now = Date.now,
  connectTimeoutMs = 2000,
  createClient = connectResp,
  onDegraded = null,
} = {}) {
  if (!url) throw new Error('Redis 后端需要 url（REDIS_URL）');
  const memory = createMemoryLimiter({ now });
  let client = null;      // 成功连接后的 client
  let degraded = false;   // 已降级为内存（本次进程内持续，直到连接恢复）
  let tried = false;      // 是否尝试过连接（用于测试断言）
  let warned = false;

  const warnOnce = (msg, extra) => {
    if (warned) return;
    warned = true;
    if (onDegraded) { try { onDegraded(msg, extra); } catch { /* ignore */ } }
  };

  async function ensureClient() {
    if (client || degraded) return client;
    tried = true;
    try {
      client = await createClient(url, { connectTimeoutMs });
      await client.ping();
      degraded = false;
      return client;
    } catch (e) {
      degraded = true;
      client = null;
      warnOnce('Redis 不可用，限流降级为内存后端（单实例语义）', { error: String(e?.message || e).slice(0, 200) });
      return null;
    }
  }

  /** EVALSHA，遇 NOSCRIPT 自动回退 EVAL。 */
  async function runScript(c, sha, script, keys, argv) {
    try {
      return await c.evalsha(sha, keys, argv);
    } catch (e) {
      if (e instanceof RespError && /NOSCRIPT/.test(e.message)) {
        return await c.eval(script, keys, argv);
      }
      throw e;
    }
  }

  /** 失败时回退内存；返回 { usedFallback: true } 标记以便测试断言 */
  async function withFallback(fn) {
    const c = await ensureClient();
    if (!c) return { fallback: true };
    try {
      return { result: await fn(c) };
    } catch (e) {
      // 连接断了：下次调用重连，本次回退内存
      try { await c.close(); } catch { /* ignore */ }
      client = null;
      degraded = false; // 允许下次重连
      warnOnce('Redis 调用失败，本次限流回退内存后端', { error: String(e?.message || e).slice(0, 200) });
      return { fallback: true };
    }
  }

  async function check(bucketKey, rpm) {
    rpm = Number(rpm);
    if (!Number.isFinite(rpm) || rpm <= 0) {
      return { allowed: true, limited: false, remaining: null, retryAfterMs: 0 };
    }
    const perMs = rpm / 60_000;
    const out = await withFallback((c) =>
      runScript(c, RATE_LIMIT_SHA, RATE_LIMIT_SCRIPT, [bucketKey],
        [String(rpm), String(perMs), String(now()), String(BUCKET_TTL_MS)]));
    if (out.fallback) return memory.check(bucketKey, rpm);
    const [allowed, remaining, retryAfterMs] = out.result;
    return {
      allowed: allowed === 1,
      limited: true,
      remaining: Number(remaining),
      retryAfterMs: Number(retryAfterMs),
    };
  }

  async function throttle(key, windowMs) {
    const out = await withFallback((c) =>
      runScript(c, THROTTLE_SHA, THROTTLE_SCRIPT, [key], [String(windowMs)]));
    if (out.fallback) return memory.throttle(key, windowMs);
    return out.result === 1;
  }

  return {
    backend: 'redis',
    check,
    throttle,
    close: async () => {
      if (client) { try { await client.close(); } catch { /* ignore */ } client = null; }
      await memory.close();
    },
    __internal: {
      /** 测试用：是否已尝试连接且处于降级状态 */
      isDegraded: () => tried && (degraded || client === null),
      clear: () => memory.__internal.clear(),
    },
  };
}
