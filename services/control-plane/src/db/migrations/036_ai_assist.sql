-- 036_ai_assist.sql —— V3.5 AI 生产力 Agent。
--
-- ai_assist_runs: 对一次变更运行 AI 助手（代码评审 / 测试用例生成 / 变更风险评估）
--   的记录：报告正文 + token/成本消耗（按 agent run 的 trace_id 从 model_calls 归因）。

CREATE TABLE IF NOT EXISTS ai_assist_runs (
  id TEXT PRIMARY KEY,                          -- aia_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  change_package_id TEXT NOT NULL REFERENCES change_packages(id),
  kind TEXT NOT NULL,                           -- review | testgen | risk
  agent_id TEXT NOT NULL REFERENCES agents(id),
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  template_key TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'simulated',       -- live | simulated
  status TEXT NOT NULL,                         -- succeeded | failed
  report TEXT,                                 -- 报告正文（成功时）
  error TEXT,                                  -- 失败原因（失败时）
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aia_change
  ON ai_assist_runs(tenant_id, change_package_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aia_run
  ON ai_assist_runs(run_id);
