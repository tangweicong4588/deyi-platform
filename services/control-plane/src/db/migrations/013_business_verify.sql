-- 013_business_verify.sql —— V2.0-C 验证与对账。
--
-- 设计说明：
-- 1. 验证是"执行后"的独立步骤，验证失败 ≠ 执行失败：action_executions 加
--    verify_status（unverified=已执行未验证 / verified / mismatched / unverifiable）
--    + verify_result（JSON，比对明细）+ verified_at，execution.status 原样保留。
-- 2. reconciliation_items 状态机扩展为 open→investigating→resolved|escalated→closed，
--    旧值 acknowledged（V2.0-B 写入语义=已受理）迁移为 investigating；resolved 在新
--    语义下是"已决议、待关闭"，需显式 close。
--    新增：source（execute=执行失败入队 / verify=验证差异入队）、assignee（升级处理人）、
--    resolution（JSON 决议：decided_by/decided_at/note/evidence_ref）、decided_at、closed_at。
--    SQLite 不支持直接改 CHECK：重建表迁移数据（PG 路径同理可用）。
-- 3. 事件消费（webhook/轮询）不在本阶段做：验证手段为只读工具 read-back，
--    事件消费留扩展点（见 verify.mjs 头注）。

ALTER TABLE action_executions ADD COLUMN verify_status TEXT NOT NULL DEFAULT 'unverified'
  CHECK (verify_status IN ('unverified','verified','mismatched','unverifiable'));
ALTER TABLE action_executions ADD COLUMN verify_result TEXT NOT NULL DEFAULT '{}';
ALTER TABLE action_executions ADD COLUMN verified_at BIGINT;

CREATE TABLE reconciliation_items_new (
  id TEXT PRIMARY KEY,                          -- brec_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  action_id TEXT REFERENCES business_actions(id),
  execution_id TEXT REFERENCES action_executions(id),
  reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'execute'
    CHECK (source IN ('execute','verify')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','investigating','resolved','escalated','closed')),
  assignee TEXT,                                -- escalate 指定的处理人（actor id）
  resolution TEXT NOT NULL DEFAULT '{}',        -- {decided_by,decided_at,note,evidence_ref}
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  decided_at BIGINT,
  closed_at BIGINT
);
INSERT INTO reconciliation_items_new
  (id,tenant_id,project_id,action_id,execution_id,reason,source,status,assignee,
   resolution,created_at,updated_at,decided_at,closed_at)
  SELECT id,tenant_id,project_id,action_id,execution_id,reason,'execute',
         CASE status WHEN 'acknowledged' THEN 'investigating' ELSE status END,
         NULL,'{}',created_at,updated_at,NULL,NULL
  FROM reconciliation_items;
DROP TABLE reconciliation_items;
ALTER TABLE reconciliation_items_new RENAME TO reconciliation_items;
CREATE INDEX IF NOT EXISTS idx_brec_tenant ON reconciliation_items(tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_brec_execution ON reconciliation_items(execution_id, status);
