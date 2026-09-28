# 限流后端：Redis 集中式限流（V2.15）

## 目标

多实例部署时，网关速率限制与告警采样节流需要跨实例共享计数，否则每个实例各自为政，
实际放行量 = rpm × 实例数。

## 架构

```
gateway/routes.mjs (rateLimitGuard) ──┐
notify/alerts.mjs (采样节流) ─────────┤─▶ getRateLimiter() ─▶ memory | redis
                                                   │               │
                                                   │               └─▶ Lua 原子脚本（EVALSHA→EVAL）
                                                   └─▶ 进程内存 token bucket
```

- 后端抽象：`src/modules/gateway/ratelimit/`（`memory.mjs` / `redis.mjs`），同一契约
  （`contract.mjs`，两套后端跑同一套断言）。
- Redis 脚本见 `lua.mjs`：
  - `RATE_LIMIT_SCRIPT`：token bucket，HMGET/HSET + PEXPIRE，返回
    `{allowed, remaining, retry_after_ms}`；
  - `THROTTLE_SCRIPT`：`SET key 1 NX PX window`，告警采样用。
- Redis 客户端为内置最小 RESP2 实现（`resp.mjs`，零新依赖）；生产如需集群/哨兵，
  替换 `createRedisLimiter` 的 `createClient` 工厂即可。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `RATELIMIT_BACKEND` | `memory` | `memory`（单实例）\| `redis`（多实例共享） |
| `REDIS_URL` | `` | `redis://[[user]:pass@]host:port[/db]`；`RATELIMIT_BACKEND=redis` 时使用 |

## 降级语义（fail-open，有告警）

1. 启动/首次调用时 Redis 不可达 → 降级为内存后端（单实例语义），`onDegraded`
   记 warn **一次**（默认走 logger），不阻塞启动。
2. 运行时单次 EVAL 失败 → 当次调用回退内存，下次调用自动重连。
3. 告警采样节流的限流器若抛错 → 回退进程内存 Map（`alerts.mjs` 内兜底）。

降级是 fail-open（保可用），降级期间多实例语义退化为单实例——这是有意的设计，
已在 warn 日志中明确，运维应据此告警跟进 Redis 恢复。

## 语义口径（两后端一致）

- `check(bucketKey, rpm)`：rpm 非法（null/0/负数）= 不限流；
  token bucket 容量 = rpm，回补速率 = rpm/分钟；bucket 空闲 10 分钟过期。
- `retryAfterMs`：补满 1 个 token 所需毫秒数（`ceil((1-tokens)/rpm*60000)`）。
- `throttle(key, windowMs)`：窗口内第一次返回 true，其余 false。

## 验证边界

- 开发机无 Redis：`tests/ratelimit.test.mjs` 用注入的 fake client 按 Lua 脚本逐行语义
  执行相同算术（文档级镜像），并断言 fake 被真实调用（防静默 fallback 假阳性）。
- 真实 Redis 联调需外部环境：部署后执行
  `RATELIMIT_BACKEND=redis REDIS_URL=redis://… node smoke` 验证 EVALSHA 路径与多实例共享。
- Lua 脚本本身未在真实 Redis 上执行过语法校验——上线前必须在 staging Redis 跑一遍
  `tests/ratelimit.test.mjs` 的等价手工用例（或 `redis-cli --eval`）。
