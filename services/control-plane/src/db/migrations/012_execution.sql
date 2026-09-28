-- 012_execution.sql —— V2.0-B 授权执行：短期授权 / 执行记录 / 计划审批记录 / 对账队列
--
-- 设计说明：
-- 1. credential_grants（grant_）：执行前签发的短期授权，TTL 默认 15 分钟，scope 限定到
--    本次动作的工具+参数哈希；单次使用后立即失效（used），过期/滥用拒绝。
--    长期密钥绝不进执行链路（密钥只走 tool_credentials.vault_ref）。
-- 2. action_executions（bxn_）：BusinessAction 的执行记录。外部系统响应只存 external_ref
--    与脱敏摘要（result_summary），敏感原文禁止落库。
--    幂等键沿用 business_actions.idempotency_key，租户内唯一：重复执行直接返回首次结果。
-- 3. plan_approvals（bpar_）：计划审批记录（审批人≠创建人，V2.0-A 语义），高风险动作
--    执行时的硬检查依据；一并作为 P6 执行审批自动放行的授权来源（审计可追溯）。
-- 4. reconciliation_items（brec_）：对账队列。动作失败且不可补偿、或补偿本身失败时
--    进入 open 状态，等待人工处理（V2.0-C 对账域的表先行建模，本阶段只写入不消费）。

CREATE TABLE IF NOT EXISTS credential_grants (
  id TEXT PRIMARY KEY,                          -- grant_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  action_id TEXT NOT NULL REFERENCES business_actions(id),
  scope TEXT NOT NULL DEFAULT '{}',             -- {tool_id, tool_action, args_hash}，执行时逐项核对
  expires_at BIGINT NOT NULL,                  -- 短期 TTL（默认 15 分钟）
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','used','expired','revoked')),
  used_at BIGINT,
  created_by TEXT REFERENCES actors(id),
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grant_action ON credential_grants(action_id, status);
CREATE INDEX IF NOT EXISTS idx_grant_tenant ON credential_grants(tenant_id, expires_at);

CREATE TABLE IF NOT EXISTS action_executions (
  id TEXT PRIMARY KEY,                          -- bxn_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  action_id TEXT NOT NULL REFERENCES business_actions(id),
  grant_id TEXT REFERENCES credential_grants(id),
  idempotency_key TEXT NOT NULL,                -- 沿用 business_actions.idempotency_key
  external_ref TEXT,                            -- 外部系统返回的业务引用（订单号/流水号等），非敏感
  result_summary TEXT NOT NULL DEFAULT '{}',    -- 脱敏后的结果摘要（JSON，截断 4K）
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','succeeded','failed','compensated','reconciling')),
  started_at BIGINT NOT NULL,
  finished_at BIGINT,
  created_at BIGINT NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_bxn_action ON action_executions(action_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bxn_tenant ON action_executions(tenant_id, project_id, created_at);

CREATE TABLE IF NOT EXISTS plan_approvals (
  id TEXT PRIMARY KEY,                          -- bpar_
  plan_id TEXT NOT NULL REFERENCES business_plans(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  approver_id TEXT NOT NULL REFERENCES actors(id),
  decided_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (plan_id)                               -- 一个计划只保留最新一次审批记录
);
CREATE INDEX IF NOT EXISTS idx_bpar_plan ON plan_approvals(plan_id);

CREATE TABLE IF NOT EXISTS reconciliation_items (
  id TEXT PRIMARY KEY,                          -- brec_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  action_id TEXT REFERENCES business_actions(id),
  execution_id TEXT REFERENCES action_executions(id),
  reason TEXT NOT NULL DEFAULT '',              -- 进入对账的原因（已脱敏）
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','acknowledged','resolved')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brec_tenant ON reconciliation_items(tenant_id, status, created_at);
