-- 002_gateway.sql —— 模型网关：模型目录 / 预算 / 调用账本（CostLedger 明细）
-- 费用单位：cents（整数），费率单位：cents / 百万 tokens。

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,                          -- mdl_
  name TEXT NOT NULL UNIQUE,                    -- 平台侧模型名（白名单），如 deyi-default
  litellm_model TEXT NOT NULL,                  -- LiteLLM 侧 model_name
  fallback_litellm_models TEXT NOT NULL DEFAULT '[]',
  data_classes TEXT NOT NULL DEFAULT '["public","internal"]',
  cost_prompt_per_mtok_cents INTEGER NOT NULL DEFAULT 0,
  cost_completion_per_mtok_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',        -- active | disabled
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY,                          -- bdg_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT REFERENCES projects(id),     -- NULL = 租户级
  period TEXT NOT NULL DEFAULT 'monthly',       -- monthly | total
  cost_limit_cents INTEGER,                     -- NULL = 不限
  token_limit INTEGER,                          -- NULL = 不限
  used_cost_cents INTEGER NOT NULL DEFAULT 0,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  period_key TEXT NOT NULL,                     -- monthly: 2026-09；total: 'total'
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_budgets
  ON budgets(tenant_id, COALESCE(project_id, ''), period, period_key);
CREATE INDEX IF NOT EXISTS idx_budgets_tenant ON budgets(tenant_id);

CREATE TABLE IF NOT EXISTS model_calls (
  id TEXT PRIMARY KEY,                          -- call_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT REFERENCES projects(id),
  actor_id TEXT NOT NULL REFERENCES actors(id),
  trace_id TEXT NOT NULL,
  model TEXT NOT NULL,                          -- 平台模型名
  litellm_model TEXT,
  endpoint TEXT NOT NULL,                       -- chat.completions | embeddings
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,                         -- ok | error
  cached INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_tenant_time ON model_calls(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_calls_trace ON model_calls(trace_id);
