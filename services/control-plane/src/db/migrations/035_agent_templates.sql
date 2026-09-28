-- 035_agent_templates.sql —— V4.4 业务场景模板。
--
-- agent_templates:           Agent 场景模板（参数化 prompt + 工具 + 流程）
--   tenant_id NULL = 平台内置模板（全租户可见，开箱即用）；
--   tenant_id 非 NULL = 租户自定义模板（租户级市场，本租户可见）。
--   key 在作用域内唯一（COALESCE 处理 NULL 租户）。
-- agent_template_instances:  模板实例化记录（模板 → 落地的 Agent）

CREATE TABLE IF NOT EXISTS agent_templates (
  id TEXT PRIMARY KEY,                          -- agt_
  tenant_id TEXT REFERENCES tenants(id),        -- NULL = 平台内置
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'custom',      -- support|review|analytics|custom
  params_schema TEXT NOT NULL DEFAULT '[]',     -- JSON：[{name,type,required,default,options,description}]
  definition_template TEXT NOT NULL DEFAULT '{}', -- JSON：Agent 定义模板，[[param]] 为实例化时参数占位
  created_by TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  archived_at BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_templates_scope_key
  ON agent_templates(COALESCE(tenant_id, ''), key);
CREATE INDEX IF NOT EXISTS idx_agent_templates_cat
  ON agent_templates(category, archived_at);

CREATE TABLE IF NOT EXISTS agent_template_instances (
  id TEXT PRIMARY KEY,                          -- agi_
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  template_id TEXT NOT NULL REFERENCES agent_templates(id),
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  params TEXT NOT NULL DEFAULT '{}',            -- JSON：实例化时解析后的参数
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agi_tenant
  ON agent_template_instances(tenant_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agi_template
  ON agent_template_instances(template_id);
