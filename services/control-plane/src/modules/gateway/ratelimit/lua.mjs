/**
 * modules/gateway/ratelimit/lua.mjs —— V2.15：Redis 原子限流 Lua 脚本。
 *
 * 两个脚本都保证"读-算-写"在一个原子步骤内完成，多实例共享同一计数。
 * key 格式：由调用方传入（网关：`gw:<tenantId>:<keyId|actorId>`；
 * 告警采样：`alert:<tenantId>:<intent>`）。
 */
import { createHash } from 'node:crypto';

/**
 * token bucket。
 * KEYS[1] bucket key
 * ARGV[1] capacity（rpm）
 * ARGV[2] refill tokens per millisecond（rpm / 60000）
 * ARGV[3] now_ms
 * ARGV[4] ttl_ms（空闲过期，与内存版 10 分钟淘汰对齐）
 * 返回 {allowed(0/1), remaining(取整), retry_after_ms}
 */
export const RATE_LIMIT_SCRIPT = `
local d = redis.call('HMGET', KEYS[1], 'tokens', 'updated_at')
local cap = tonumber(ARGV[1])
local per_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local tokens = tonumber(d[1])
if tokens == nil then tokens = cap end
local updated = tonumber(d[2])
if updated == nil then updated = now end
local elapsed = now - updated
if elapsed < 0 then elapsed = 0 end
tokens = math.min(cap, tokens + elapsed * per_ms)
local allowed = 0
local retry_after = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry_after = math.ceil((1 - tokens) / per_ms)
  if retry_after < 1 then retry_after = 1 end
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'updated_at', now)
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]))
return {allowed, math.floor(tokens), retry_after}
`.trim();

/**
 * 固定窗口节流（告警采样用）。
 * KEYS[1] key
 * ARGV[1] window_ms
 * 返回 1=允许执行（本次拿到窗口），0=被节流
 */
export const THROTTLE_SCRIPT = `
local ok = redis.call('SET', KEYS[1], '1', 'NX', 'PX', tonumber(ARGV[1]))
if ok then return 1 else return 0 end
`.trim();

export const RATE_LIMIT_SHA = createHash('sha1').update(RATE_LIMIT_SCRIPT).digest('hex');
export const THROTTLE_SHA = createHash('sha1').update(THROTTLE_SCRIPT).digest('hex');

/** 空闲过期：与内存版 10 分钟淘汰对齐 */
export const BUCKET_TTL_MS = 10 * 60_000;
