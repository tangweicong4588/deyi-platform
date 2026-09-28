/**
 * tests/ratelimit.test.mjs —— V2.15 Redis 集中式限流/计数。
 *
 * - 同一契约断言跑 memory 与 redis 两套后端（验收要求）。
 * - redis 后端用注入的 fake client：它按 lua.mjs 脚本的逐行语义执行相同算术
 *   （文档级镜像；真实 Redis 联调需外部环境，见 docs/ratelimit-redis.md）。
 * - 降级路径：连接失败 → 内存 fallback + 告警一次；运行时失败 → 当次回退。
 * - EVALSHA 遇 NOSCRIPT → 回退 EVAL。
 *
 * 运行：node --test tests/ratelimit.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
const shaOf = (s) => createHash('sha1').update(s).digest('hex');

process.env.DEV_IDP_SECRET = 'x'.repeat(32);
process.env.BOOTSTRAP_ENABLED = 'false';

const { createMemoryLimiter } = await import('../src/modules/gateway/ratelimit/memory.mjs');
const { createRedisLimiter } = await import('../src/modules/gateway/ratelimit/redis.mjs');
const { runLimiterContract } = await import('../src/modules/gateway/ratelimit/contract.mjs');
const { RespError } = await import('../src/modules/gateway/ratelimit/resp.mjs');
const lua = await import('../src/modules/gateway/ratelimit/lua.mjs');

/**
 * Fake Redis client：按 Lua 脚本语义执行。
 * - hashes: key -> { tokens, updated_at }（RATE_LIMIT_SCRIPT 的 HMGET/HSET/PEXPIRE）
 * - strings: key -> { v, exp }（THROTTLE_SCRIPT 的 SET NX PX）
 */
function createFakeRedis({ now } = {}) {
  const hashes = new Map();
  const strings = new Map();
  const scripts = new Map(); // sha -> script（eval 注册）
  let down = false;
  let evalshaCalls = 0;

  const bySha = (sha) => {
    for (const [, script] of scripts) if (shaOf(script) === sha) return script;
    return null;
  };

  const execRateLimit = (keys, argv) => {
    const [key] = keys;
    const cap = Number(argv[0]);
    const perMs = Number(argv[1]);
    const t = Number(argv[2]);
    let h = hashes.get(key);
    let tokens = h ? h.tokens : cap;
    let updated = h ? h.updatedAt : t;
    const elapsed = Math.max(0, t - updated);
    tokens = Math.min(cap, tokens + elapsed * perMs);
    let allowed = 0, retryAfter = 0;
    if (tokens >= 1) { tokens -= 1; allowed = 1; }
    else { retryAfter = Math.max(1, Math.ceil((1 - tokens) / perMs)); }
    hashes.set(key, { tokens, updatedAt: t });
    return [allowed, Math.floor(tokens), retryAfter];
  };

  const execThrottle = (keys, argv) => {
    const [key] = keys;
    const windowMs = Number(argv[0]);
    const t = now();
    const cur = strings.get(key);
    if (cur && t < cur.exp) return 0;
    strings.set(key, { v: '1', exp: t + windowMs });
    return 1;
  };

  const exec = (script, keys, argv) => {
    if (script === lua.RATE_LIMIT_SCRIPT) return execRateLimit(keys, argv);
    if (script === lua.THROTTLE_SCRIPT) return execThrottle(keys, argv);
    throw new RespError('ERR unknown script');
  };

  return {
    ping: async () => { if (down) throw new RespError('连接已关闭'); return 'PONG'; },
    evalsha: async (sha, keys, argv) => {
      evalshaCalls++;
      if (down) throw new RespError('连接已关闭');
      const script = bySha(sha);
      if (!script) throw new RespError('NOSCRIPT No matching script. Please use EVAL.');
      return exec(script, keys, argv);
    },
    eval: async (script, keys, argv) => {
      if (down) throw new RespError('连接已关闭');
      scripts.set(shaOf(script), script);
      return exec(script, keys, argv);
    },
    close: async () => {},
    __test: {
      down: () => { down = true; },
      up: () => { down = false; },
      evalshaCalls: () => evalshaCalls,
      clear: () => { hashes.clear(); strings.clear(); },
    },
  };
}

const memMake = () => {
  let t = 0;
  return { now: () => t, setNow: (v) => { t = v; }, limiter: createMemoryLimiter({ now: () => t }) };
};

const redisMake = (fakeOpts) => () => {
  let t = 0;
  const fake = createFakeRedis({ now: () => t, ...fakeOpts });
  const limiter = createRedisLimiter({
    url: 'redis://fake:6379',
    now: () => t,
    createClient: async () => fake,
    onDegraded: () => {},
  });
  return { now: () => t, setNow: (v) => { t = v; }, limiter, fake };
};

test('V2.15 契约：memory 后端', async () => {
  await runLimiterContract(memMake, 'memory');
});

test('V2.15 契约：redis 后端（fake client，Lua 语义镜像）', async () => {
  const made = [];
  const make = () => { const m = redisMake()(); made.push(m); return m; };
  await runLimiterContract(make, 'redis');
  // 确保真的走了 fake（而非静默 fallback 到内存，否则契约断言失去意义）
  assert.ok(made.some((m) => m.fake.__test.evalshaCalls() > 0), 'fake 应被实际调用');
});

test('V2.15 redis：EVALSHA 命中（非 NOSCRIPT 路径）', async () => {
  const { limiter, fake, setNow } = redisMake()();
  setNow(1000);
  await limiter.check('a', 10);
  assert.ok(fake.__test.evalshaCalls() >= 1, '应走 EVALSHA');
  await limiter.close();
});

test('V2.15 redis：NOSCRIPT 时回退 EVAL 且结果正确', async () => {
  let t = 5000;
  // fake2：evalsha 永远报 NOSCRIPT，迫使 limiter 走 EVAL
  const base = createFakeRedis({ now: () => t });
  const noscript = {
    ...base,
    evalsha: async () => { throw new RespError('NOSCRIPT No matching script. Please use EVAL.'); },
  };
  const limiter = createRedisLimiter({
    url: 'redis://fake:6379', now: () => t,
    createClient: async () => noscript, onDegraded: () => {},
  });
  const r1 = await limiter.check('b', 2);
  assert.equal(r1.allowed, true);
  assert.equal(r1.remaining, 1);
  await limiter.check('b', 2);
  const r3 = await limiter.check('b', 2);
  assert.equal(r3.allowed, false, '第3次应拒绝（EVAL 路径计数生效）');
  await limiter.close();
});

test('V2.15 redis 缺席：连接失败降级内存 + 告警一次', async () => {
  let t = 9000;
  const warnings = [];
  const limiter = createRedisLimiter({
    url: 'redis://127.0.0.1:1', now: () => t,
    createClient: async () => { throw new Error('ECONNREFUSED'); },
    onDegraded: (msg) => warnings.push(msg),
  });
  const r1 = await limiter.check('c', 1);
  assert.equal(r1.allowed, true);
  assert.equal(r1.remaining, 0);
  const r2 = await limiter.check('c', 1);
  assert.equal(r2.allowed, false, '降级后内存语义仍限流');
  assert.equal(limiter.__internal.isDegraded(), true);
  assert.equal(warnings.length, 1, '告警只发一次');
  await limiter.close();
});

test('V2.15 redis：运行时断开当次回退内存，下次重连', async () => {
  let t = 12000;
  const fake = createFakeRedis({ now: () => t });
  const warnings = [];
  const limiter = createRedisLimiter({
    url: 'redis://fake:6379', now: () => t,
    createClient: async () => fake, onDegraded: (m) => warnings.push(m),
  });
  const ok = await limiter.check('d', 100);
  assert.equal(ok.allowed, true);
  fake.__test.down(); // 模拟连接断开
  const fb = await limiter.check('d2', 1);
  assert.equal(fb.allowed, true, '断开时回退内存仍放行');
  assert.equal(warnings.length, 1);
  fake.__test.up();
  const ok2 = await limiter.check('d3', 100);
  assert.equal(ok2.allowed, true, '恢复后应重连成功');
  assert.equal(limiter.__internal.isDegraded(), false);
  await limiter.close();
});

test('V2.15 redis：throttle 走 Redis 语义', async () => {
  const { limiter, setNow } = redisMake()();
  setNow(20000);
  assert.equal(await limiter.throttle('alert:t1:ratelimit.hit', 60_000), true);
  assert.equal(await limiter.throttle('alert:t1:ratelimit.hit', 60_000), false);
  setNow(20000 + 60_001);
  assert.equal(await limiter.throttle('alert:t1:ratelimit.hit', 60_000), true);
  await limiter.close();
});
