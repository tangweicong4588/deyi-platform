# 审计故障 Runbook（audit-failure）

审计链（`audit_events` + `audit_heads`）是平台的合规底线：append-only、
哈希链、租户级单调序号。本手册覆盖：写入失败、验链断裂、尾部截断、
检查点不一致四类故障的诊断与恢复。

> 威胁模型先说清楚：哈希链 + 检查点防的是**运维事故 / 部分恢复 / 程序 bug**
> 导致的丢失与错乱。能直接写库的恶意 DBA 连检查点也能改——防恶意篡改需要
> 外部锚定（见第 5 节），不要对哈希链抱有它不具备的期望。

## 1. 快速诊断

```bash
# 验链（operator）：对某租户全链验
curl -s -X POST -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H 'Content-Type: application/json' -d '{}' \
  "http://<host>:8080/v1/admin/tenants/<tenantId>/evidence/audit/verify" | jq .
# 返回 { ok:true, checked, head } 或 { ok:false, brokenAt:{ seq, reason, expected, actual } }
```

brokenAt 的几种典型 reason 及含义：

| reason | 含义 | 紧急度 |
|---|---|---|
| `prev_hash 与前一事件 hash 不连续` | 中间事件丢失/被改（seq=N 的前一条对不上） | 高 |
| `事件内容被篡改（重算 hash 不一致）` | 某条事件的 payload 被改 | 高 |
| `尾部截断：检查点 head_seq=N，但链上最大 seq=M` | 最后 (N-M) 条事件丢失 | 高 |
| `缺少前序事件，无法确定链起点` | 区间验链的起点前没有事件（通常不是故障） | 低 |

## 2. 审计写入失败（append 抛错）

症状：业务接口返回 500 且日志含 `audit.append` 相关错误；或 tryAudit 的 warn 激增。

排查顺序：

1. **DB 是否可达**：`audit.append` 在事务内执行，DB 抖动会直接抛错。
   先看 `/readyz` 的 database 项，再看控制面日志的 DB 错误。
2. **append-only 触发器**：`audit_events` 有防 UPDATE/DELETE 触发器。
   任何试图 UPDATE/DELETE 审计表的操作都会被拒绝——这是设计，不是 bug。
   检查是否有迁移/脚本误碰了审计表。
3. **audit_heads 表是否存在**：迁移 016 之前的数据靠回填；若迁移未执行，
   append 会因缺表失败。`SELECT * FROM audit_heads LIMIT 1;` 验证。

恢复：

- 写入失败期间，业务写操作本身也会失败（审计是同步前置），不会出现
  "业务成功了但审计没记" 的静默丢失——先修 DB，再重放业务操作。
- 若失败期间有外部系统已执行成功（如网关上游调用），按该域的 outbox
  补记流程处理（网关计量见 `gateway_usage_outbox` + `POST /v1/admin/metering/reconcile`）。

## 3. 验链断裂（中间事件丢失/篡改）

1. 用 brokenAt.seq 定位：`SELECT * FROM audit_events WHERE tenant_id=? AND seq IN (N-1, N, N+1);`
2. **先判断是"丢"还是"改"**：
   - `prev_hash 不连续` → 丢（中间少了事件）；
   - `重算 hash 不一致` → 改（内容被动过）。
3. 常见根因（按概率）：
   - 从过期备份恢复了 DB（备份时间点之后的事件全丢）；
   - 手动删数据 / 清表脚本误伤；
   - 双写：有人绕过 append 直接 INSERT（seq 冲突或 prev_hash 错）。
4. 恢复步骤：
   - 冻结写入：先停掉产生该租户审计事件的业务流量，避免链继续分叉。
   - 从备份恢复**丢失的事件行**（按 id 精确补，不要整表覆盖——会丢掉备份之后的新事件）。
   - 补回后重新验链；若备份里也没有，标记为"不可恢复断裂"并走第 4 节的
     事件对账，尽量从业务表反推缺失事件。
   - 恢复后检查 `audit_heads`：补回的事件若 seq 大于检查点，检查点会在
     下一次 append 时自动追上；若检查点反而更大，先验链确认尾部完整再说。

## 4. 尾部截断（检查点比链长）

这是 L-11 专门加的检测：`audit_heads.head_seq > MAX(audit_events.seq)`。

1. 确认不是"检查点超前"的假阳性：检查点只在 append 同事务里更新，
   正常情况不可能超前。超前 = 尾部事件真丢了。
2. 根因同第 3 节（备份恢复、删表、TRUNCATE——注意 TRUNCATE 不触发
   行级触发器，append-only 防不住它，靠的就是这个检查点）。
3. 恢复：从备份按 id 补回丢失的尾部事件 → 验链 → 检查点自动对齐。
4. 若备份也没有丢失的事件：如实记录事故（丢了哪几条 seq、涉及哪些
   业务动作），用业务表（runner_runs / approvals / plans 等）反推补记
   **新的**审计事件（action 标注 `reconstructed`），不要伪造原事件的 hash。

## 5. 业务事件对账（兜底）

当审计链不可恢复断裂时，用业务表反推"应该有哪些审计事件"：

- 每个 runner_run / approval / plan / handover 的状态变迁都应有对应
  action 的审计事件（`tryAudit` 调用点即清单）。
- 对账脚本思路：按 trace_id / resource_id 左连接业务表与 audit_events，
  孤儿业务记录 = 丢失的审计事件候选。

## 6. 外部锚定（防恶意篡改，当前未实现）

生产建议：定时（如每小时）把各租户链头 `(tenant_id, head_seq, head_hash)`
写入外部不可变存储（对象存储 WORM / 区块链 / 银行级日志服务），验链时
三方比对。当前版本未实现，上线前按此节补齐或在风险评估中明确接受。
