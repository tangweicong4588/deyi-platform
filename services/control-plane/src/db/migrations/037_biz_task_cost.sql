-- 037_biz_task_cost.sql —— V4.5 执行成本归因。
--
-- biz_task_cost_links: 业务任务 ↔ 执行 trace 的关联（成本归因的边）。
--   kind: agent_run | ai_assist_run | pipeline_run（后两种按需扩展）
--   trace_id: 网关计量口径（model_calls.trace_id）；任务成本 = 其下 trace 的网关计量之和。

CREATE TABLE IF NOT EXISTS biz_task_cost_links (
  id TEXT PRIMARY KEY,                          -- btcl_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL REFERENCES biz_tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                           -- agent_run | ai_assist_run | ...
  ref_id TEXT NOT NULL,                         -- 被链接实体的 id（run id / assist run id …）
  trace_id TEXT NOT NULL,                       -- model_calls.trace_id
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (task_id, kind, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_btcl_task ON biz_task_cost_links(tenant_id, task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_btcl_trace ON biz_task_cost_links(trace_id);
