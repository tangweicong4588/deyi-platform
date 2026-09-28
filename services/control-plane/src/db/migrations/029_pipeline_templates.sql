-- 029_pipeline_templates.sql —— V3.1 流水线模板与复用。
-- pipeline_templates：参数化、版本化的生产模具；project_id 为 NULL = 租户级共享，
-- 非 NULL = 项目私有。status: active | archived（归档后不可再实例化/发版）。
-- pipeline_template_versions：definition 快照不可变，UNIQUE(template_id, version)。
-- pipeline_instances：一次实例化（绑定变更包 + 模板版本 + 解析后参数）。
-- pipeline_runs 增 instance_id/template_id/template_version：模板实例化的运行可回溯模具。
CREATE TABLE IF NOT EXISTS pipeline_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT REFERENCES projects(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL,                       -- 'private' | 'shared'
  params_schema TEXT NOT NULL DEFAULT '[]',       -- JSON：[{name,type,required,default,options?,description?}]
  stages TEXT NOT NULL DEFAULT '[]',              -- JSON：[{key,name?,config?}]，key 为五阶段之一
  current_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',          -- 'active' | 'archived'
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pipeline_templates_tenant ON pipeline_templates(tenant_id);

CREATE TABLE IF NOT EXISTS pipeline_template_versions (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES pipeline_templates(id),
  version INTEGER NOT NULL,
  definition TEXT NOT NULL,                       -- JSON：{params_schema, stages} 不可变快照
  change_note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(template_id, version)
);
CREATE INDEX IF NOT EXISTS idx_pipeline_template_versions_tpl ON pipeline_template_versions(template_id);

CREATE TABLE IF NOT EXISTS pipeline_instances (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  change_package_id TEXT NOT NULL REFERENCES change_packages(id),
  template_id TEXT NOT NULL REFERENCES pipeline_templates(id),
  template_version INTEGER NOT NULL,
  resolved_params TEXT NOT NULL DEFAULT '{}',     -- JSON：schema 校验+默认值合并后的参数
  resolved_definition TEXT NOT NULL DEFAULT '{}', -- JSON：实例化时刻的模板版本 definition 快照
  status TEXT NOT NULL DEFAULT 'active',          -- 'active' | 'cancelled'
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(change_package_id, template_id, template_version)
);
CREATE INDEX IF NOT EXISTS idx_pipeline_instances_pkg ON pipeline_instances(change_package_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_instances_tpl ON pipeline_instances(template_id);

ALTER TABLE pipeline_runs ADD COLUMN instance_id TEXT REFERENCES pipeline_instances(id);
ALTER TABLE pipeline_runs ADD COLUMN template_id TEXT;
ALTER TABLE pipeline_runs ADD COLUMN template_version INTEGER;
