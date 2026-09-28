-- 034_sagas.sql —— V4.3 长流程与补偿（Saga）。
--
-- sagas：长流程定义（步骤编排 + 每步的补偿动作 + 超时/重试策略）。
-- saga_runs：一次执行；engine=local（控制面内同步驱动，开发/测试）或
--   temporal（提交 Temporal worker 异步执行，生产路径）。
-- saga_steps：执行历史（含补偿行 kind='compensate'），seq 全局有序，
--   既是执行记录也是重放/追溯（V3.4）的数据源。

CREATE TABLE IF NOT EXISTS sagas (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  definition TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_sagas_proj ON sagas(tenant_id, project_id);

CREATE TABLE IF NOT EXISTS saga_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  saga_id TEXT NOT NULL REFERENCES sagas(id),
  project_id TEXT NOT NULL,
  input TEXT NOT NULL DEFAULT '{}',
  engine TEXT NOT NULL DEFAULT 'local',
  status TEXT NOT NULL DEFAULT 'running',
  current_step INTEGER NOT NULL DEFAULT 0,
  replay_of TEXT,
  workflow_id TEXT,
  created_by TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  finished_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_saga_runs_saga ON saga_runs(saga_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saga_runs_tenant ON saga_runs(tenant_id, status);

CREATE TABLE IF NOT EXISTS saga_steps (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES saga_runs(id),
  seq BIGINT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'forward',
  step_key TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  output TEXT,
  error TEXT,
  started_at BIGINT,
  finished_at BIGINT,
  created_at BIGINT NOT NULL,
  UNIQUE (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_saga_steps_run ON saga_steps(run_id, seq);
