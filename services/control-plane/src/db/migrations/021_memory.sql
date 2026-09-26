-- 021_memory.sql —— V2.2-A：记忆服务（自研服务层 + PG 真相源）
--
-- 架构决策（见 GOAL.md V2.2-A）：记忆治理（分层/可见性/TTL/遗忘/提升/审计）由控制面
-- 自研实现；向量召回走 Qdrant 派生索引（V2.2-B）；Mem0/Graphiti 保留为外部记忆引擎
-- 扩展点（adapters/memory）。PostgreSQL 是真相源，Qdrant 索引可重建。
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT REFERENCES projects(id),
  actor_id TEXT NOT NULL,                 -- 记忆所有者（private 可见性只对 owner 可见）
  kind TEXT NOT NULL CHECK (kind IN ('episodic','semantic')),
  content TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'project' CHECK (visibility IN ('private','project')),
  importance REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  tags TEXT,                              -- JSON 数组
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','promoted','forgotten')),
  expires_at INTEGER,                     -- TTL；NULL=不过期
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_memories_tenant ON memories(tenant_id, status);
CREATE INDEX idx_memories_lookup ON memories(tenant_id, project_id, kind, status);

-- 时序/语义关联（Graphiti 知识图谱的轻量实现：记忆之间的关系边）
CREATE TABLE memory_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  src_memory_id TEXT NOT NULL REFERENCES memories(id),
  dst_memory_id TEXT NOT NULL REFERENCES memories(id),
  relation TEXT NOT NULL CHECK (relation IN ('relates_to','contradicts','supersedes')),
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, src_memory_id, dst_memory_id, relation)
);
CREATE INDEX idx_memory_links_src ON memory_links(src_memory_id);

-- 事实提升：记忆 → 知识库必须经人工确认（防幻觉记忆污染业务真相源）。
-- promote 只建 pending 提案；approve 后才 ingest 为 knowledge document。
CREATE TABLE memory_promotions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT REFERENCES projects(id),
  memory_id TEXT NOT NULL REFERENCES memories(id),
  content TEXT NOT NULL,                  -- 提升时的内容快照
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  proposed_by TEXT NOT NULL,
  reviewed_by TEXT,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);
CREATE INDEX idx_memory_promotions_tenant ON memory_promotions(tenant_id, status);
