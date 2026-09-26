-- 001_kernel.sql —— 内核：租户 / 项目 / 主体 / API Key / 角色绑定
-- 约定：主键全部为平台 ID（ten_/prj_/usr_/key_/...），时间戳为 INTEGER 毫秒。

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',   -- active | suspended
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_projects_tenant ON projects(tenant_id);

CREATE TABLE IF NOT EXISTS actors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  kind TEXT NOT NULL,                        -- user | service
  external_id TEXT,                          -- Keycloak sub（接入 Keycloak 后回填）
  name TEXT NOT NULL,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_actors_tenant ON actors(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_actors_external ON actors(tenant_id, external_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT REFERENCES projects(id),  -- NULL = 租户级 key
  actor_id TEXT NOT NULL REFERENCES actors(id),
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,                      -- key 前缀（明文，用于快速定位候选）
  key_hash TEXT NOT NULL,                    -- sha256 hex（key 本体永不落盘）
  scopes TEXT NOT NULL DEFAULT '[]',         -- JSON 数组
  status TEXT NOT NULL DEFAULT 'active',     -- active | revoked
  expires_at INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);

CREATE TABLE IF NOT EXISTS role_bindings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  actor_id TEXT NOT NULL REFERENCES actors(id),
  project_id TEXT REFERENCES projects(id),  -- NULL = 租户级角色
  role TEXT NOT NULL,                        -- admin | operator | viewer
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, actor_id, project_id, role)
);
CREATE INDEX IF NOT EXISTS idx_roles_actor ON role_bindings(tenant_id, actor_id);
