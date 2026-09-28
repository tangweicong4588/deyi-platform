/**
 * modules/gateway/ratelimit/index.mjs —— V2.15：限流器单例。
 * RATELIMIT_BACKEND=memory（默认）| redis；REDIS_URL 缺席时 redis 后端会降级内存并告警。
 */
import { config } from '../../../kernel/config.mjs';
import { logger } from '../../../kernel/logging.mjs';
import { createMemoryLimiter } from './memory.mjs';
import { createRedisLimiter } from './redis.mjs';

let singleton = null;

export function getRateLimiter() {
  if (singleton) return singleton;
  const backend = (config.RATELIMIT_BACKEND || 'memory').toLowerCase();
  if (backend === 'redis') {
    singleton = createRedisLimiter({
      url: config.REDIS_URL,
      onDegraded: (msg, extra) => logger.warn(`ratelimit: ${msg}`, extra),
    });
  } else {
    singleton = createMemoryLimiter();
  }
  return singleton;
}

/** 测试用：重置单例 */
export function __resetRateLimiter() {
  singleton = null;
}

/** 旧模块兼容：tests/gateway-limits.test.mjs 用的 __internal.clear() */
export const __internal = {
  clear: () => getRateLimiter().__internal?.clear?.(),
};
