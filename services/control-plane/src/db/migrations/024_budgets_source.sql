-- 024_budgets_source.sql —— V2.6：预算行来源标记。
-- source：'manual'（管理员手工设置，PUT /budgets）| 'plan'（套餐配额自动落地）。
-- 语义：ensurePlanBudget 只管理 source='plan' 的行；手工行优先级更高，不会被套餐同步覆盖。
ALTER TABLE budgets ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
