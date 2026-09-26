-- 010_runner.sql —— V1.0-D 隔离 Runner：runner_runs 表
--
-- 设计说明：
-- 1. runner_runs（run_）记录每一次隔离 Runner 执行（step 构建/测试/扫描/打包），
--    是"另一名工程师在独立 Runner 上复现"（方案 p19 DoD）的证据底座。
--    run_ 前缀与 pipe_（流水线运行）区分，无冲突（已 grep 确认）。
-- 2. commands_json 存执行过的命令（数组形式，供 reproduce 原样重跑）；
--    workspace_ref 存工作区来源 {method, source}，复现时重新物化全新工作区。
-- 3. 日志落 log_text（脱敏+截断），log_uri 指向脱敏后的日志文件（file://）；
--    simulated=1 的行来自 fake 内存模拟，绝不能冒充真实执行（门禁/reproduce 会拒绝）。
-- 4. 密钥铁律：本表不存任何凭据明文；Runner 环境变量只接受 vault 引用（见 isolated.mjs）。

CREATE TABLE IF NOT EXISTS runner_runs (
  id TEXT PRIMARY KEY,                          -- run_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  change_package_id TEXT NOT NULL REFERENCES change_packages(id),
  step TEXT NOT NULL CHECK (step IN ('build','test','scan','package')),
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','passed','failed','timeout','killed')),
  exit_code INTEGER,
  signal TEXT,
  simulated INTEGER NOT NULL DEFAULT 0,         -- 1=fake 内存模拟
  commands_json TEXT NOT NULL DEFAULT '[]',
  env_json TEXT NOT NULL DEFAULT '{}',          -- 执行时的显式环境变量（已过密钥校验），复现保真用
  workspace_ref TEXT NOT NULL DEFAULT '{}',
  log_text TEXT NOT NULL DEFAULT '',
  log_uri TEXT NOT NULL DEFAULT '',
  limits_json TEXT NOT NULL DEFAULT '{}',
  artifacts_json TEXT NOT NULL DEFAULT '[]',    -- [{artifactId, kind, path, contentHash}]
  duration_ms INTEGER,
  created_by TEXT REFERENCES actors(id),
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runner_runs_chg ON runner_runs(change_package_id);
CREATE INDEX IF NOT EXISTS idx_runner_runs_tenant ON runner_runs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_runner_runs_step ON runner_runs(change_package_id, step, created_at);
