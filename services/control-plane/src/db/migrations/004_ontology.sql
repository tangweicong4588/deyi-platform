-- 004_ontology.sql —— 本体平面真相源（PostgreSQL/SQLite 共用）。自研控制面资产。
-- 状态机（service 层强制，非法跃迁拒绝）：
--   candidate → in_review → published → deprecated
--   candidate/in_review → rejected → in_review（驳回后可重新评审）
--   in_review → candidate（打回）
--   deprecated 为终态；变更只能发新版本（supersedes_id 版本链）

CREATE TABLE IF NOT EXISTS ontology_terms (
  id TEXT PRIMARY KEY,                          -- ont_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,                      -- 归一化（小写/去空白）供冲突检测
  kind TEXT NOT NULL CHECK (kind IN ('concept','relation','attribute')),
  definition TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate','in_review','published','deprecated','rejected')),
  version INTEGER NOT NULL DEFAULT 1,
  supersedes_id TEXT REFERENCES ontology_terms(id),  -- 版本链：新版本指向被替代的旧版本
  evidence TEXT NOT NULL DEFAULT '[]',          -- JSON [{fact_id, doc_id}]
  created_by TEXT REFERENCES actors(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ont_project ON ontology_terms(tenant_id, project_id, status);
CREATE INDEX IF NOT EXISTS idx_ont_name ON ontology_terms(tenant_id, project_id, name_norm, status);
CREATE INDEX IF NOT EXISTS idx_ont_supersedes ON ontology_terms(supersedes_id);

CREATE TABLE IF NOT EXISTS ontology_conflicts (
  id TEXT PRIMARY KEY,                          -- ocf_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  term_id TEXT NOT NULL REFERENCES ontology_terms(id),
  conflicting_term_id TEXT NOT NULL REFERENCES ontology_terms(id),
  reason TEXT NOT NULL,                         -- duplicate_name | overlapping_definition
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution TEXT,                              -- JSON {strategy: keep|merge|supersede, note}
  resolved_by TEXT REFERENCES actors(id),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ocf_term ON ontology_conflicts(term_id, status);
CREATE INDEX IF NOT EXISTS idx_ocf_project ON ontology_conflicts(tenant_id, project_id, status);
