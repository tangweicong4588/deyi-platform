/**
 * modules/gateway/ratelimit/contract.mjs —— V2.15：限流后端契约断言。
 * memory 与 redis 两个后端跑同一套断言，保证语义一致。
 * 用 node:assert + 可注入的 now() 实现时间确定性。
 */
import assert from 'node:assert';

/**
 * @param {() => { now: () => number, setNow: (ms:number)=>void, limiter }} make
 *   make 返回带可控时间的 limiter 工厂
 * @param {string} name 后端名（用于断言信息）
 */
export async function runLimiterContract(make, name) {
  const tag = (m) => `[${name}] ${m}`;

  // 1. 不限流：rpm 非法值直接放行
  {
    const { limiter } = make();
    for (const rpm of [null, 0, -5, NaN]) {
      const r = await limiter.check('k1', rpm);
      assert.equal(r.allowed, true, tag(`rpm=${rpm} 应放行`));
      assert.equal(r.limited, false, tag(`rpm=${rpm} limited=false`));
      assert.equal(r.remaining, null, tag(`rpm=${rpm} remaining=null`));
    }
    await limiter.close();
  }

  // 2. 基本消耗：rpm=5，连续 5 次放行，第 6 次拒绝
  {
    const { limiter, now, setNow } = make();
    setNow(1_000_000);
    for (let i = 0; i < 5; i++) {
      const r = await limiter.check('k2', 5);
      assert.equal(r.allowed, true, tag(`第${i + 1}次应放行`));
      assert.equal(r.limited, true);
      assert.equal(r.remaining, 4 - i, tag(`第${i + 1}次 remaining`));
    }
    const denied = await limiter.check('k2', 5);
    assert.equal(denied.allowed, false, tag('第6次应拒绝'));
    assert.equal(denied.remaining, 0);
    assert.ok(denied.retryAfterMs > 0, tag('拒绝应带 retryAfterMs'));
    // retryAfterMs 口径：补满 1 个 token 需要的时间 = (1/5)*60000 = 12000ms
    assert.equal(denied.retryAfterMs, 12_000, tag('retryAfterMs 口径'));
    void now;
    await limiter.close();
  }

  // 3. 随时间回补：rpm=60（每秒 1 个），30 秒后回满 30 个
  {
    const { limiter, setNow } = make();
    setNow(2_000_000);
    await limiter.check('k3', 60); // 剩 59
    setNow(2_000_000 + 30_000);
    const r = await limiter.check('k3', 60);
    assert.equal(r.allowed, true);
    // 59 + 30 = 89 → 上限 60 → 消耗 1 → 剩 59
    assert.equal(r.remaining, 59, tag('回补后应封顶'));
    await limiter.close();
  }

  // 4. bucket 隔离：不同 key 互不影响
  {
    const { limiter, setNow } = make();
    setNow(3_000_000);
    await limiter.check('ka', 1);
    const b = await limiter.check('kb', 1);
    assert.equal(b.allowed, true, tag('不同 bucket 应隔离'));
    const a2 = await limiter.check('ka', 1);
    assert.equal(a2.allowed, false, tag('同 bucket 应继续限流'));
    await limiter.close();
  }

  // 5. throttle：窗口内只允许一次
  {
    const { limiter, setNow } = make();
    setNow(4_000_000);
    assert.equal(await limiter.throttle('th1', 60_000), true, tag('首次应允许'));
    assert.equal(await limiter.throttle('th1', 60_000), false, tag('窗口内应节流'));
    assert.equal(await limiter.throttle('th2', 60_000), true, tag('不同 key 应允许'));
    setNow(4_000_000 + 60_001);
    assert.equal(await limiter.throttle('th1', 60_000), true, tag('窗口过后应允许'));
    await limiter.close();
  }
}
