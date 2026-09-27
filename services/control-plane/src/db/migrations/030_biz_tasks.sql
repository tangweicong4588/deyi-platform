-- 030_biz_tasks.sql —— V4.1 业务任务域模型（工单/审批单/文档处理任务）。
-- biz_tasks：任务本体；kind=ticket|approval|doc_task；status=open|in_progress|
-- pending|resolved|closed|cancelled（终态 closed/cancelled）。
-- sla_due_at 为 NULL = 未设置 SLA；escalated=1 表示已超时升级（单级，V4.1）。
-- payload：kind 相关扩展（approval={decision,decided_by,decided_at}，
-- doc_task={document_id}），JSON。
-- biz_task_transitions：状态流转历史（审计链另有事件，此表供时间线查询）。
CREATE TABLE IF NOT EXISTS biz_tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,                              -- 'ticket' | 'approval' | 'doc_task'
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'normal',         -- 'low' | 'normal' | 'high' | 'urgent'
  requester_id TEXT NOT NULL REFERENCES actors(id),
  assignee_id TEXT REFERENCES actors(id),
  sla_due_at INTEGER,                              -- 毫秒时间戳，NULL=无 SLA
  sla_hours INTEGER,
  escalated INTEGER NOT NULL DEFAULT 0,
  escalated_at INTEGER,
  payload TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_biz_tasks_tp ON biz_tasks(tenant_id, project_id, status);
CREATE INDEX IF NOT EXISTS idx_biz_tasks_sla ON biz_tasks(tenant_id, sla_due_at);

CREATE TABLE IF NOT EXISTS biz_task_transitions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  task_id TEXT NOT NULL REFERENCES biz_tasks(id),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_biz_task_transitions_task ON biz_task_transitions(task_id);
