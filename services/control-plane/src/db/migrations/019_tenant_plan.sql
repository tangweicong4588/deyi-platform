-- 019_tenant_plan.sql —— V2.1-B：租户套餐与配额（SaaS 运营面）
-- plan: trial | professional | enterprise（应用层 TENANT_PLANS 定义默认配额）
-- quotas: JSON，租户级覆盖（如 {"max_projects": 10}），key 缺失时用计划默认
ALTER TABLE tenants ADD COLUMN plan TEXT NOT NULL DEFAULT 'trial';
ALTER TABLE tenants ADD COLUMN quotas TEXT NOT NULL DEFAULT '{}';
