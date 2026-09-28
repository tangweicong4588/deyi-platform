-- 032_agents.sql —— V4.2 Agent 编排运行时。
--
-- agents:           Agent 注册（租户+项目隔离，key 在项目内唯一）
-- agent_versions:   不可变版本快照（definition JSON，版本递增）
-- agent_runs:       执行实例（状态机：running/waiting_approval/succeeded/failed/cancelled）
-- agent_run_steps:  节点执行记录（可查、可审计）
-- agent_approvals:  HITL 审批单（SoD：发起人不能自批）

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  archived_at BIGINT,
  UNIQUE (tenant_id, project_id, key)
);
CREATE INDEX IF NOT EXISTS idx_agents_tenant ON agents(tenant_id, project_id);

CREATE TABLE IF NOT EXISTS agent_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  definition TEXT NOT NULL,              -- 不可变 JSON 快照
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (agent_id, version)
);
CREATE INDEX IF NOT EXISTS idx_agent_versions_agent ON agent_versions(agent_id, version);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  agent_version_id TEXT NOT NULL REFERENCES agent_versions(id),
  version INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'live',     -- live | simulated（simulated 为显式编排演练，结果标注）
  status TEXT NOT NULL DEFAULT 'running',-- running|waiting_approval|succeeded|failed|cancelled
  current_node TEXT,
  state TEXT NOT NULL DEFAULT '{}',      -- 累积上下文（JSON）
  input TEXT NOT NULL DEFAULT '{}',
  output TEXT,
  error TEXT,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  finished_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(tenant_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(tenant_id, status);

CREATE TABLE IF NOT EXISTS agent_run_steps (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,               -- llm | tool | hitl
  status TEXT NOT NULL DEFAULT 'ok',     -- ok | failed | skipped | waiting | approved | rejected
  input TEXT,
  output TEXT,                           -- 脱敏后的节点输出（密钥只存 sha256）
  started_at BIGINT NOT NULL,
  finished_at BIGINT,
  created_at BIGINT NOT NULL,
  UNIQUE (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_steps_run ON agent_run_steps(run_id, seq);

CREATE TABLE IF NOT EXISTS agent_approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',-- pending|approved|rejected
  payload TEXT,                          -- 呈交审批人阅读的上下文摘要（JSON，脱敏）
  requested_by TEXT NOT NULL,
  requested_at BIGINT NOT NULL,
  decided_by TEXT,
  decided_at BIGINT,
  note TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_approvals_run ON agent_approvals(run_id);
