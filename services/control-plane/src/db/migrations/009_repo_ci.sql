-- 009_repo_ci.sql —— V1.0-C 仓库与 CI 适配：PR 登记表 + 事实快照 kind 区分
--
-- 设计说明：
-- 1. pull_requests（pr_）是平台对"草稿 PR"的登记簿，不是远端 PR 的镜像：
--    平台只创建 draft PR（Agent 自批自合是硬禁令，路由层不提供 merge 端点），
--    merged/closed 只能由外部事件/轮询同步进来。
-- 2. fact_snapshots 加 kind 列：'manual'（V1.0-B 手动登记）/ 'snapshot'（V1.0-C
--    Gitea 适配器自动采集的 RepoSnapshot）。现有行默认为 manual。
-- 3. 密钥铁律：本表不存任何凭据；repo 凭证只走 repo_bindings.credential_ref。

CREATE TABLE IF NOT EXISTS pull_requests (
  id TEXT PRIMARY KEY,                          -- pr_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  change_package_id TEXT NOT NULL REFERENCES change_packages(id),
  repo_binding_id TEXT NOT NULL REFERENCES repo_bindings(id),
  provider TEXT NOT NULL,                       -- gitea|gitlab|local
  repo TEXT NOT NULL DEFAULT '',                -- owner/name（本地模式为路径标识）
  number INTEGER,                               -- 远端 PR 编号（fake 本地递增；live 由远端返回）
  url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','open','merged','closed')),
  head_branch TEXT NOT NULL DEFAULT '',
  base_branch TEXT NOT NULL DEFAULT '',
  head_commit TEXT NOT NULL DEFAULT '',
  simulated INTEGER NOT NULL DEFAULT 0,         -- 1=fake/未接真 Gitea，绝不伪装
  created_by TEXT REFERENCES actors(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- 同一仓库绑定下远端 PR 编号唯一（防重复登记）
CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_binding_number
  ON pull_requests(repo_binding_id, number)
  WHERE number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_chg_active
  ON pull_requests(change_package_id)
  WHERE status IN ('draft','open');
CREATE INDEX IF NOT EXISTS idx_pr_change_package
  ON pull_requests(change_package_id);

-- 事实快照来源区分：manual=人工登记 / snapshot=Gitea 自动采集
ALTER TABLE fact_snapshots ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual';
