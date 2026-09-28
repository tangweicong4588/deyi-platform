-- 026_readiness_probe.sql —— V2.11 就绪探针写探测表。
-- /readyz 每次 live upsert 这一单行，证明数据库可写（不只是 SELECT 1 连通）。
-- 与业务表无关，无触发器、无审计；PG / SQLite 双库通用。
CREATE TABLE IF NOT EXISTS readiness_probe (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  checked_at BIGINT NOT NULL
);
