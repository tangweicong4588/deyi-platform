-- 006_evidence.sql —— 证据平面真相源（PostgreSQL/SQLite 共用）。自研控制面资产。
--
-- 设计要点：
-- 1. audit_events 只能追加：service 层只暴露 append；DB 层再加触发器
--    （方言不同，触发器由 src/modules/evidence/audit.mjs 的 initEvidence() 按
--    后端类型创建，本文件只放跨方言 DDL）。
-- 2. 哈希链：hash = SHA256(prev_hash\ntenant_id\naction\nresource_kind\n
--    resource_id\ncanonical(payload)\ncreated_at)，创世块 prev_hash='GENESIS'。
--    seq 为租户内单调序号（链顺序与验签基准）。
-- 3. cost_ledger 是 model_calls 的物化聚合（加速用），记账以 model_calls 为准，
--    绝不重复记账。

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,                          -- evd_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT REFERENCES projects(id),
  actor_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  action TEXT NOT NULL,                         -- ontology.publish / tool.invoke / ...
  resource_kind TEXT NOT NULL,
  resource_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',           -- JSON（脱敏后）
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  seq BIGINT NOT NULL,                         -- 租户内单调序号
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_tenant_seq ON audit_events(tenant_id, seq);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON audit_events(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_trace ON audit_events(trace_id, action);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events(tenant_id, action, created_at);

CREATE TABLE IF NOT EXISTS evidence_packages (
  id TEXT PRIMARY KEY,                          -- pkg_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT REFERENCES projects(id),
  name TEXT NOT NULL,
  event_ids TEXT NOT NULL DEFAULT '[]',         -- JSON 数组（事件 id，按 seq 升序）
  merkle_root TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  anchored INTEGER NOT NULL DEFAULT 0,
  anchor_ref TEXT,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pkg_tenant ON evidence_packages(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS cost_ledger (
  id TEXT PRIMARY KEY,                          -- cst_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT REFERENCES projects(id),
  day TEXT NOT NULL,                            -- YYYY-MM-DD
  model TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  cost_cents BIGINT NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cost_ledger
  ON cost_ledger(tenant_id, COALESCE(project_id, ''), day, model);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_day ON cost_ledger(tenant_id, day);

CREATE TABLE IF NOT EXISTS anchors (
  id TEXT PRIMARY KEY,                          -- anc_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  chain_head_id TEXT NOT NULL,                  -- 锚定时链尾事件 id
  chain_head_hash TEXT NOT NULL,                -- 锚定时链尾 hash
  chain_head_seq INTEGER NOT NULL,
  method TEXT NOT NULL,                         -- http-anchor | manual
  ref TEXT,                                     -- 锚定服务返回的引用（token/tx）
  status TEXT NOT NULL DEFAULT 'ok',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_anchors_tenant ON anchors(tenant_id, created_at);
