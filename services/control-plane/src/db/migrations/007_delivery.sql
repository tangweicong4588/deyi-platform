-- 007_delivery.sql —— V1.0-A 交付域模型：需求 / 验收标准 / 仓库绑定 / 变更包 / 产物 / 流水线运行（静态模型）
-- 密钥铁律：repo_bindings 只有 credential_ref（vault 引用名），绝无明文字段。

CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,                          -- req_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'feature',         -- feature | bug | ops
  status TEXT NOT NULL DEFAULT 'draft',         -- draft|clarifying|ready|in_progress|verifying|done|cancelled
  scope_md TEXT NOT NULL DEFAULT '',
  non_goals_md TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'p2',          -- p0 | p1 | p2 | p3
  risk_level TEXT NOT NULL DEFAULT 'low',       -- low | medium | high
  repro TEXT NOT NULL DEFAULT '{}',             -- JSON：复现步骤/环境（bug 类）
  source_refs TEXT NOT NULL DEFAULT '[]',       -- JSON：来源引用（事实/工单/聊天记录）
  ontology_term_ids TEXT NOT NULL DEFAULT '[]', -- JSON：关联本体术语 ont_ id
  created_by TEXT REFERENCES actors(id),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requirements_project ON requirements(tenant_id, project_id, status);

CREATE TABLE IF NOT EXISTS acceptance_criteria (
  id TEXT PRIMARY KEY,                          -- ac_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  requirement_id TEXT NOT NULL REFERENCES requirements(id),
  given_md TEXT NOT NULL DEFAULT '',
  when_md TEXT NOT NULL DEFAULT '',
  then_md TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'auto',           -- auto | manual
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | passed | failed | waived
  evidence_ref TEXT,                            -- 证据引用（artifact id / 外部链接）
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ac_requirement ON acceptance_criteria(requirement_id);

CREATE TABLE IF NOT EXISTS repo_bindings (
  id TEXT PRIMARY KEY,                          -- rpo_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  provider TEXT NOT NULL,                       -- gitea | gitlab | local
  remote_url TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  credential_ref TEXT,                          -- vault 引用名；绝无明文列
  status TEXT NOT NULL DEFAULT 'active',        -- active | disabled
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_repo_bindings_project ON repo_bindings(tenant_id, project_id);

CREATE TABLE IF NOT EXISTS change_packages (
  id TEXT PRIMARY KEY,                          -- chg_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  requirement_id TEXT NOT NULL REFERENCES requirements(id),
  branch TEXT NOT NULL,
  base_commit TEXT NOT NULL DEFAULT '',
  head_commit TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',        -- draft|building|verifying|ready_for_review|handed_over|cancelled
  dod_checklist TEXT NOT NULL DEFAULT '{}',     -- JSON：DoD 项清单
  created_by TEXT REFERENCES actors(id),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_change_packages_req ON change_packages(requirement_id);
CREATE INDEX IF NOT EXISTS idx_change_packages_project ON change_packages(tenant_id, project_id, status);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,                          -- art_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  change_package_id TEXT NOT NULL REFERENCES change_packages(id),
  kind TEXT NOT NULL,                           -- diff|test_report|scan_report|sbom|image_manifest|preview|report
  content_hash TEXT NOT NULL,                   -- sha256 十六进制，必填
  uri TEXT NOT NULL DEFAULT '',
  signature TEXT,                               -- 可空；MVP 允许 null
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_package ON artifacts(change_package_id);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY,                          -- pipe_（静态模型；编排在 V1.0-B 接入）
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  change_package_id TEXT REFERENCES change_packages(id),
  stage TEXT NOT NULL,                          -- facts|requirements|clarify|develop|handover
  status TEXT NOT NULL DEFAULT 'pending',       -- pending|running|gated|passed|failed|cancelled
  gate_decision TEXT NOT NULL DEFAULT '{}',     -- JSON：门禁结论（通过/阻断+原因）
  started_at BIGINT,
  finished_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_package ON pipeline_runs(change_package_id);
