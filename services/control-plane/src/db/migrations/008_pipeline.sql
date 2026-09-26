-- 008_pipeline.sql —— V1.0-B 五阶段流水线编排：事实快照 / 澄清记录 / 门禁例外审批
--
-- 设计说明：
-- 1. pipeline_runs（007 建）在本阶段被编排激活；为防并发 startPipeline 双写，
--    加部分唯一索引 (change_package_id, stage)。
-- 2. fact_snapshots 是手动登记的事实基线（repo snapshot 真实现在 V1.0-C 的
--    Gitea 适配器，本阶段只建模+手动登记）。
-- 3. gate_exceptions 复用 P6 审批机制语义：pending→approved/rejected、原子 CAS、
--    decided_by FK、operator+ 决议、审计链落事件。P6 的 approvals 表是工具执行
--    耦合（execution_id NOT NULL），门禁例外走独立表更干净，生命周期保证一致。
-- 4. 密钥铁律：environment/dependencies JSON 只存非密配置，service 层做递归
--    疑似密钥键扫描，命中直接 400。

-- 并发 startPipeline 防双写（changePackageId 为 NULL 的旧静态记录不受影响）
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_runs_pkg_stage
  ON pipeline_runs(change_package_id, stage)
  WHERE change_package_id IS NOT NULL;

-- 事实快照：基线 commit / 环境 JSON / 关键依赖 JSON / 未知项清单 JSON
CREATE TABLE IF NOT EXISTS fact_snapshots (
  id TEXT PRIMARY KEY,                          -- snp_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id),
  baseline_commit TEXT NOT NULL DEFAULT '',
  environment TEXT NOT NULL DEFAULT '{}',       -- JSON：环境配置（非密）
  dependencies TEXT NOT NULL DEFAULT '{}',      -- JSON：关键依赖版本
  unknown_items TEXT NOT NULL DEFAULT '[]',     -- JSON：未知项清单（空数组=已确认无未知项）
  recorded_by TEXT REFERENCES actors(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- 每个 facts 阶段运行只认一条快照（登记即覆盖）
CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_snapshots_run
  ON fact_snapshots(pipeline_run_id);

-- 澄清记录：只问"会改变实现或验收"的问题；答案可转为验收标准
CREATE TABLE IF NOT EXISTS clarifications (
  id TEXT PRIMARY KEY,                          -- clf_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id),
  requirement_id TEXT REFERENCES requirements(id),
  question TEXT NOT NULL,
  answer TEXT,                                  -- NULL/空 = 未回答
  impacts_implementation INTEGER NOT NULL DEFAULT 0, -- 1=回答会改变实现或验收
  created_by TEXT REFERENCES actors(id),
  answered_by TEXT REFERENCES actors(id),
  created_at INTEGER NOT NULL,
  answered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_clarifications_run
  ON clarifications(pipeline_run_id);

-- 门禁例外审批：门禁阻断（gated）后的人工放行通道
CREATE TABLE IF NOT EXISTS gate_exceptions (
  id TEXT PRIMARY KEY,                          -- gex_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id),
  stage TEXT NOT NULL,                          -- facts|requirements|clarify|develop|handover
  missing_items TEXT NOT NULL DEFAULT '[]',     -- JSON：本次例外覆盖的缺失门禁项
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected')),
  requested_by TEXT NOT NULL REFERENCES actors(id),
  decided_by TEXT REFERENCES actors(id),
  decided_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gate_exceptions_run
  ON gate_exceptions(pipeline_run_id, status);
