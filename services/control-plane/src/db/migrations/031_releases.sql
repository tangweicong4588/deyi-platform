-- 031_releases.sql —— V3.2 多环境发布与部署策略。
-- deploy_environments：项目级环境（dev/staging/prod 或自定义 key）。
-- releases：发布单；strategy=canary|blue_green|rolling；status=draft|
-- pending_approval|approved|rejected|deploying|succeeded|failed|rolled_back。
-- strategy_config：canary={steps:[10,50,100]}；blue_green={}；
-- rolling={batches:N}；另可带 simulate_fail_at（simulated 模式测试钩子，显式）。
-- approval：JSON {required,requested_by,requested_at,decided_by,decided_at,
-- decision,note,source}，source='manual'（V4.2 HITL 落地后可为 'hitl'）。
-- release_steps：按序执行的步骤；kind=deploy|health_check|promote|rollback|
-- verify；result 显式标注 simulated（绝不伪造真实执行）。
CREATE TABLE IF NOT EXISTS deploy_environments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (project_id, key)
);

CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  environment_id TEXT NOT NULL REFERENCES deploy_environments(id),
  change_package_id TEXT,
  version TEXT NOT NULL,
  strategy TEXT NOT NULL,                          -- 'canary' | 'blue_green' | 'rolling'
  strategy_config TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  requires_approval INTEGER NOT NULL DEFAULT 0,
  approval TEXT,                                   -- JSON，NULL=未发起审批
  deploy_spec TEXT NOT NULL DEFAULT '{}',           -- {commands:[[argv...]], env:{}}
  health_check_spec TEXT NOT NULL DEFAULT '{}',     -- {commands:[[argv...]]}
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_releases_tp ON releases(tenant_id, project_id, status);
CREATE INDEX IF NOT EXISTS idx_releases_env ON releases(environment_id);

CREATE TABLE IF NOT EXISTS release_steps (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  release_id TEXT NOT NULL REFERENCES releases(id),
  seq BIGINT NOT NULL,
  kind TEXT NOT NULL,                              -- deploy|health_check|promote|rollback|verify
  label TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '{}',               -- {percentage}|{slot}|{batch}
  status TEXT NOT NULL DEFAULT 'pending',           -- pending|running|succeeded|failed|skipped
  result TEXT NOT NULL DEFAULT '{}',               -- {simulated, exit_code, ...}
  started_at BIGINT,
  finished_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_release_steps_rel ON release_steps(release_id, seq);
