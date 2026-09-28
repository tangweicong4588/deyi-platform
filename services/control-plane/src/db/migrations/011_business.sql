-- 011_business.sql —— V2.0-A 业务意图与计划：意图 / 计划 / 业务动作
--
-- 设计说明：
-- 1. 三张表都是平台领域对象，主键用平台 ID（bint_ / bplan_ / bact_），租户隔离。
-- 2. 本阶段只建模+计划，不触发真实执行：business_actions.status 的
--    executing/done/failed/compensated 是为 V2.0-B 预留的状态位。
-- 3. raw_text 落库前由 service 层做长度上限（4000）+ 密钥形状脱敏，
--    本表不存任何外部系统敏感原文（dry-run 只存 external_ref 与脱敏摘要）。
-- 4. args JSON 禁止密钥明文字段（service 层沿用 P6 rejectPlaintextSecrets 模式校验）。
-- 5. idempotency_key 在计划时生成（sha256(plan_id:seq)），执行时沿用；
--    租户内唯一，防止同一计划被重复提交。

CREATE TABLE IF NOT EXISTS business_intents (
  id TEXT PRIMARY KEY,                          -- bint_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  raw_text TEXT NOT NULL DEFAULT '',            -- 已脱敏+截断的用户原始意图
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','planned','approved','executing','done','rejected','cancelled')),
  created_by TEXT REFERENCES actors(id),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bint_tenant ON business_intents(tenant_id, project_id, created_at);

CREATE TABLE IF NOT EXISTS business_plans (
  id TEXT PRIMARY KEY,                          -- bplan_
  intent_id TEXT NOT NULL REFERENCES business_intents(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','dryrun_passed','dryrun_blocked','approved','rejected')),
  risk_estimate TEXT NOT NULL DEFAULT '{}',     -- 风险估计 {actions,total_amount_cents,max_risk,approval_required,reversible_all,impact_scope}
  ontology_gaps TEXT NOT NULL DEFAULT '[]',     -- 未映射本体概念 [{concept, candidate_term_id}]
  dryrun_report TEXT NOT NULL DEFAULT '{}',     -- 最近一次 dry-run 明细
  created_by TEXT REFERENCES actors(id),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bplan_intent ON business_plans(intent_id);
CREATE INDEX IF NOT EXISTS idx_bplan_tenant ON business_plans(tenant_id, project_id, created_at);

CREATE TABLE IF NOT EXISTS business_actions (
  id TEXT PRIMARY KEY,                          -- bact_
  plan_id TEXT NOT NULL REFERENCES business_plans(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  seq BIGINT NOT NULL,                         -- 计划内顺序
  tool_ref TEXT,                                -- P6 已注册工具 ID（tool_）；未注册时为 NULL，dry-run 阻断
  tool_name TEXT NOT NULL DEFAULT '',           -- 逻辑工具名（模板声明，便于排查）
  args TEXT NOT NULL DEFAULT '{}',              -- 动作参数（已过密钥校验）
  idempotency_key TEXT NOT NULL,                -- 计划时生成，执行时沿用
  ontology_term_ids TEXT NOT NULL DEFAULT '[]', -- 已命中的已发布本体术语 ID（只含已发布）
  preconditions TEXT NOT NULL DEFAULT '[]',     -- 前置条件清单 [{kind, detail, passed}]
  expected_effect TEXT NOT NULL DEFAULT '{}',   -- dry-run 预期影响 {target_system,objects,amount_cents,reversible,compensation_available,approval_required}
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','dryrun_ok','dryrun_blocked','approved','executing','done','failed','compensated')),
  dryrun_reasons TEXT NOT NULL DEFAULT '[]',    -- 阻断原因清单
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_bact_plan ON business_actions(plan_id, seq);
