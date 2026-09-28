/**
 * scripts/live/redis-live-check.mjs —— Phase 6：Redis 真实联调。
 * 用法：REDIS_URL=redis://127.0.0.1:6379 node scripts/live/redis-live-check.mjs
 *
 * 验证 V2.15 的 Lua 限流脚本在真实 Redis 上的语义：
 * - token bucket：客户端传 now_ms（ARGV），可用 fake 时间精确断言（与契约同口径）
 * - throttle：Redis 服务端 PX 过期，fake 时间跳不过去，改用真实短窗口 + 真实 sleep 验证
 */
import assert from 'node:assert';

process.env.DEV_IDP_SECRET = 'dev-live-check';
process.env.BOOTSTRAP_ENABLED = 'false';

const { createRedisLimiter } = await import('../../src/modules/gateway/ratelimit/redis.mjs');

const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const tag = (m) => `[redis(live)] ${m}`;
let t = 1_000_000;
let n = 0;
const make = () => {
  const id = `live${Date.now().toString(36)}${n++}`;
  const limiter = createRedisLimiter({ url, now: () => t, onDegraded: () => {} });
  return {
    setNow: (v) => { t = v; },
    limiter: {
      check: (k, rpm) => limiter.check(`${id}:${k}`, rpm),
      throttle: (k, w) => limiter.throttle(`${id}:${k}`, w),
      close: () => limiter.close(),
    },
  };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. 非法 rpm 直接放行
{
  const { limiter } = make();
  for (const rpm of [null, 0, -5, NaN]) {
    const r = await limiter.check('k1', rpm);
    assert.equal(r.allowed, true, tag(`rpm=${rpm} 应放行`));
  }
  await limiter.close();
}
// 2. 基本消耗：rpm=5，5 次放行，第 6 次拒绝 + retryAfterMs 口径
{
  const { limiter, setNow } = make();
  setNow(1_000_000);
  for (let i = 0; i < 5; i++) {
    const r = await limiter.check('k2', 5);
    assert.equal(r.allowed, true, tag(`第${i + 1}次应放行`));
    assert.equal(r.remaining, 4 - i, tag(`第${i + 1}次 remaining`));
  }
  const denied = await limiter.check('k2', 5);
  assert.equal(denied.allowed, false, tag('第6次应拒绝'));
  assert.equal(denied.remaining, 0);
  assert.equal(denied.retryAfterMs, 12_000, tag('retryAfterMs=(1/5)*60000'));
  await limiter.close();
}
// 3. 随时间回补
{
  const { limiter, setNow } = make();
  setNow(2_000_000);
  await limiter.check('k3', 60);
  setNow(2_030_000);
  const r = await limiter.check('k3', 60);
  assert.equal(r.allowed, true);
  assert.equal(r.remaining, 59, tag('回补后应封顶'));
  await limiter.close();
}
// 4. 不同 key 隔离
{
  const { limiter, setNow } = make();
  setNow(3_000_000);
  await limiter.check('ka', 1);
  const r = await limiter.check('kb', 1);
  assert.equal(r.allowed, true, tag('不同 key 不共享桶'));
  await limiter.close();
}
// 5. throttle：真实短窗口 + 真实 sleep（服务端 PX 过期语义）
{
  const { limiter } = make();
  assert.equal(await limiter.throttle('th1', 200), true, tag('throttle 首次应允许'));
  assert.equal(await limiter.throttle('th1', 200), false, tag('窗口内应节流'));
  assert.equal(await limiter.throttle('th2', 200), true, tag('不同 key 应允许'));
  await sleep(260);
  assert.equal(await limiter.throttle('th1', 200), true, tag('窗口过后应允许'));
  await limiter.close();
}

console.log('REDIS LIVE CHECK: 全部通过（真实 Redis，Lua token-bucket + throttle 语义一致）');
process.exit(0);
