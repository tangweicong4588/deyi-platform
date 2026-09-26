-- 022_billing.sql —— V2.3：多租户计费与账单。
-- 账单是财务快照：finalize 后总额与行项目冻结（不可变）；真相源是 model_calls
-- 与 tenants.plan，账单只记录快照 + 状态机。
CREATE TABLE IF NOT EXISTS billing_invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  period_key TEXT NOT NULL,                    -- 'YYYY-MM'（与网关账期同本地时区口径）
  status TEXT NOT NULL DEFAULT 'draft',       -- draft | finalized | paid | void
  currency TEXT NOT NULL DEFAULT 'CNY',
  plan TEXT NOT NULL,                          -- 出账时套餐快照
  plan_fee_cents INTEGER NOT NULL DEFAULT 0,
  usage_cost_cents INTEGER NOT NULL DEFAULT 0,
  usage_tokens INTEGER NOT NULL DEFAULT 0,
  usage_calls INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  line_items_json TEXT NOT NULL DEFAULT '[]', -- [{type, label, amount_cents, ...}]
  created_at INTEGER NOT NULL,
  finalized_at INTEGER,
  paid_at INTEGER,
  voided_at INTEGER,
  UNIQUE (tenant_id, period_key)               -- 一账期一账单：幂等生成
);
CREATE INDEX IF NOT EXISTS idx_billing_invoices_tenant
  ON billing_invoices(tenant_id, period_key);
CREATE INDEX IF NOT EXISTS idx_billing_invoices_status
  ON billing_invoices(status, period_key);
