-- 033_artifacts.sql —— V3.3 制品库：制品包 / 版本（内容寻址 blob）/ 关联。
--
-- 设计：
-- - artifact_packages：一条制品流（如某服务的容器镜像、某 CLI 的二进制分发），
--   归属项目，(tenant_id, project_id, name) 唯一。
-- - artifact_versions：不可变版本行。文件内容按 sha256 内容寻址存本地盘
--   （ARTIFACT_STORE_DIR/<h0:2>/<h2:4>/<hash>），DB 只存元数据；
--   同一内容多版本/多租户共享一份 blob（引用计数式清理）。
-- - artifact_links：版本与流水线运行 / 发布单 / 变更包的关联，供 V3.4 全链路追溯消费。
-- - retention_days：包级保留覆盖（天数），NULL = 走租户 retention_days_artifacts 策略。

CREATE TABLE IF NOT EXISTS artifact_packages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  description TEXT NOT NULL DEFAULT '',
  retention_days INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_artifact_packages_proj
  ON artifact_packages(tenant_id, project_id);

CREATE TABLE IF NOT EXISTS artifact_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  package_id TEXT NOT NULL REFERENCES artifact_packages(id),
  version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (package_id, version)
);
CREATE INDEX IF NOT EXISTS idx_artifact_versions_pkg
  ON artifact_versions(package_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifact_versions_hash
  ON artifact_versions(content_hash);
CREATE INDEX IF NOT EXISTS idx_artifact_versions_tenant_ctime
  ON artifact_versions(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS artifact_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  version_id TEXT NOT NULL REFERENCES artifact_versions(id),
  link_kind TEXT NOT NULL,
  link_id TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (version_id, link_kind, link_id)
);
CREATE INDEX IF NOT EXISTS idx_artifact_links_ver ON artifact_links(version_id);
CREATE INDEX IF NOT EXISTS idx_artifact_links_target ON artifact_links(tenant_id, link_kind, link_id);
