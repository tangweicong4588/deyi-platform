-- 003_knowledge.sql —— 知识平面真相源（PostgreSQL/SQLite 共用）。
-- Qdrant 只存派生向量索引，point ID 由平台 fact/chunk ID 派生，绝不反向引用。

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,                          -- doc_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'upload',        -- upload | api | share
  mime TEXT NOT NULL DEFAULT 'text/markdown',
  data_class TEXT NOT NULL DEFAULT 'internal',  -- public | internal | confidential
  status TEXT NOT NULL DEFAULT 'processing',    -- processing | ready | failed
  fail_reason TEXT,
  raw_content TEXT,                             -- 原始上传内容（支持重解析生成新版本；大文件场景由对象存储替代）
  created_by TEXT REFERENCES actors(id),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(tenant_id, project_id, status);

CREATE TABLE IF NOT EXISTS canonical_docs (
  id TEXT PRIMARY KEY,                          -- cnd_
  document_id TEXT NOT NULL REFERENCES documents(id),
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,                     -- 版本链：同一 document 按 version 递增
  content TEXT NOT NULL,                        -- 解析后的 markdown 真相
  content_hash TEXT NOT NULL,                   -- sha256(content)，去重/变更检测
  parse_engine TEXT NOT NULL DEFAULT 'builtin', -- docling | builtin
  created_at BIGINT NOT NULL,
  UNIQUE(document_id, version)
);
CREATE INDEX IF NOT EXISTS idx_cnd_doc ON canonical_docs(document_id, version);

CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,                          -- fct_（chunk 级事实单元）
  canonical_doc_id TEXT NOT NULL REFERENCES canonical_docs(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,                        -- chunk 原文（检索返回的引用真相）
  source_span TEXT NOT NULL DEFAULT '{}',       -- JSON {start,end}：在 canonical content 中的字符偏移
  embedding_model TEXT NOT NULL DEFAULT 'deyi-embedding',
  status TEXT NOT NULL DEFAULT 'active',        -- active | superseded（被新版本替代）
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_doc ON facts(document_id, status);

-- 资源级读权限：document 级（fact 继承其 document 的 ACL）
CREATE TABLE IF NOT EXISTS acl_entries (
  id TEXT PRIMARY KEY,                          -- acl_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  resource_kind TEXT NOT NULL,                  -- 目前只用 'document'
  resource_id TEXT NOT NULL,
  grantee_kind TEXT NOT NULL,                   -- 'project' | 'actor'
  grantee_id TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'read',
  created_by TEXT REFERENCES actors(id),
  created_at BIGINT NOT NULL,
  UNIQUE(resource_kind, resource_id, grantee_kind, grantee_id, permission)
);
CREATE INDEX IF NOT EXISTS idx_acl_grantee ON acl_entries(tenant_id, grantee_kind, grantee_id);
CREATE INDEX IF NOT EXISTS idx_acl_resource ON acl_entries(resource_kind, resource_id);
