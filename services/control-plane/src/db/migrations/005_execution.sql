-- 005_execution.sql —— 执行平面真相源（PostgreSQL/SQLite 共用）。自研控制面资产。
--
-- 状态机（service 层强制，非法跃迁拒绝）：
--   executions: pending_approval → approved|rejected → running → succeeded|failed|compensated
--               (低/中风险直接: approved → running → ...)
--   approvals:  pending → approved|rejected（终态）
--   compensations: pending → done|failed（按 seq 逆序执行）
--
-- 密钥铁律：tool_credentials 只存 vault_ref 引用名，无任何明文字段；
-- executions 只存脱敏 args（args_redacted）+ 原始 args 的 sha256（args_hash）。

CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY,                          -- tool_
  tenant_id TEXT REFERENCES tenants(id),        -- NULL = 平台级工具（所有租户可见）
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mcp','http','builtin')),
  endpoint TEXT,                                -- mcp/http 的服务地址；builtin 为 NULL
  config TEXT NOT NULL DEFAULT '{}',            -- JSON：超时/重试/auth 方案（绝不含密钥明文）
  risk_level TEXT NOT NULL DEFAULT 'low'
    CHECK (risk_level IN ('low','medium','high')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','disabled')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES actors(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tools_tenant_name
  ON tools(COALESCE(tenant_id, ''), name);
CREATE INDEX IF NOT EXISTS idx_tools_tenant ON tools(tenant_id, status);

-- 凭证引用注册表：只有引用名，没有明文列（schema 层面保证）
CREATE TABLE IF NOT EXISTS tool_credentials (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL REFERENCES tools(id),
  vault_ref TEXT NOT NULL,                      -- 如 TOOL_X_API_KEY，运行时从环境解析
  created_at INTEGER NOT NULL,
  UNIQUE(tool_id, vault_ref)
);

CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,                          -- exe_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  actor_id TEXT NOT NULL REFERENCES actors(id),
  trace_id TEXT NOT NULL,
  tool_id TEXT NOT NULL REFERENCES tools(id),
  action TEXT NOT NULL,                         -- 工具方法名（MCP tool 名 / http 动作 / builtin 名）
  args_hash TEXT NOT NULL,                      -- sha256(原始 args JSON，用于审计比对)
  args_redacted TEXT NOT NULL DEFAULT '{}',     -- 脱敏后 args（secret 字段打码）
  status TEXT NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('pending_approval','approved','rejected','running','succeeded','failed','compensated')),
  approval_id TEXT,
  idempotency_key TEXT,                         -- 租户内唯一（幂等去重）
  result_ref TEXT,                              -- JSON：结果摘要（脱敏、截断）
  engine TEXT,                                  -- temporal | local(fallback)
  error TEXT,                                   -- 失败原因（脱敏、截断）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_exec_idem
  ON executions(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_exec_project ON executions(tenant_id, project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_exec_tool ON executions(tool_id);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,                          -- apr_
  execution_id TEXT NOT NULL UNIQUE REFERENCES executions(id),
  requested_by TEXT NOT NULL REFERENCES actors(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected')),
  decided_by TEXT REFERENCES actors(id),
  reason TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);

CREATE TABLE IF NOT EXISTS compensations (
  id TEXT PRIMARY KEY,                          -- cmp_
  execution_id TEXT NOT NULL REFERENCES executions(id),
  seq INTEGER NOT NULL,                         -- 注册顺序；执行时逆序
  tool_id TEXT NOT NULL REFERENCES tools(id),
  action TEXT NOT NULL,
  args_redacted TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','done','failed')),
  error TEXT,
  created_at INTEGER NOT NULL,
  executed_at INTEGER,
  UNIQUE(execution_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_cmp_exec ON compensations(execution_id, seq);
