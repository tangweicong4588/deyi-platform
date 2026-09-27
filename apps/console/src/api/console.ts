import { get, post, del } from './client';

/** F1 租户控制台业务 API（V4.1 任务 / 知识库 / V2.2 记忆 / V2.3 账单）。token 由调用方从 useAuth 传入。 */

// ---------- 业务任务 ----------
export interface BizTask {
  id: string;
  kind: 'ticket' | 'approval' | 'doc_task';
  title: string;
  description: string;
  status: string;
  priority: string;
  assignee_id: string | null;
  escalated: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}
export interface BizTaskDetail {
  task: BizTask;
  transitions: Array<{ id: string; from_status: string; to_status: string; actor_id: string; note: string | null; created_at: number }>;
}

const TP = (projectId: string, p = '') => `/v1/projects/${projectId}/tasks${p}`;

export const tasksApi = {
  list: (token: string, projectId: string, q?: { status?: string; kind?: string }) => {
    const qs = new URLSearchParams(q as Record<string, string>).toString();
    return get<BizTask[]>(TP(projectId) + (qs ? `?${qs}` : ''), { token });
  },
  create: (token: string, projectId: string, body: { kind: string; title: string; description?: string; priority?: string }) =>
    post<BizTask>(TP(projectId), body, { token }),
  get: (token: string, projectId: string, taskId: string) =>
    get<BizTaskDetail>(TP(projectId, `/${taskId}`), { token }),
  transition: (token: string, projectId: string, taskId: string, to: string, note?: string) =>
    post<BizTask>(TP(projectId, `/${taskId}/transition`), { to, note }, { token }),
  decide: (token: string, projectId: string, taskId: string, approved: boolean, note?: string) =>
    post<BizTask>(TP(projectId, `/${taskId}/decide`), { approved, note }, { token }),
};

// ---------- 知识库 ----------
export interface KnowledgeDoc {
  id: string;
  title: string;
  mime: string;
  status: string;
  version: number;
  created_at: number;
}
const KP = (projectId: string, p = '') => `/v1/projects/${projectId}/knowledge${p}`;

export const knowledgeApi = {
  list: (token: string, projectId: string) => get<KnowledgeDoc[]>(KP(projectId, '/documents'), { token }),
  ingest: (token: string, projectId: string, body: { title: string; content: string; mime?: string }) =>
    post<{ document: { id: string } }>(KP(projectId, '/documents'), body, { token }),
  search: (token: string, projectId: string, query: string, limit = 5) =>
    post<Array<{ docId: string; title: string; score: number; snippet: string }>>(
      KP(projectId, '/search'), { query, limit }, { token }),
};

// ---------- 记忆 ----------
export interface MemoryItem {
  id: string;
  kind: string;
  visibility: string;
  content: string;
  created_at: number;
}
const MP = (tenantId: string, p = '') => `/v1/tenants/${tenantId}/memory${p}`;

export const memoryApi = {
  remember: (token: string, tenantId: string, body: { content: string; kind?: 'episodic' | 'semantic'; visibility?: string; ttlDays?: number }) =>
    post<MemoryItem>(MP(tenantId), { kind: 'episodic', ...body }, { token }),
  recall: (token: string, tenantId: string, query: string, limit = 10) =>
    get<{ items: MemoryItem[]; mode: string }>(MP(tenantId, `/recall?q=${encodeURIComponent(query)}&limit=${limit}`), { token }),
  forget: (token: string, tenantId: string, memoryId: string) =>
    del<{ deleted: boolean }>(MP(tenantId, `/${memoryId}`), { token }),
};

// ---------- 用量 / 账单 ----------
export interface Invoice {
  id: string;
  period_key: string;
  status: string;
  total_cents: number; // 与后端 billing_invoices.total_cents 同口径
  currency: string;
  created_at: number;
}
const BP = (tenantId: string, p = '') => `/v1/tenants/${tenantId}/billing${p}`;

export const billingApi = {
  invoices: (token: string, tenantId: string) => get<Invoice[]>(BP(tenantId, '/invoices'), { token }),
};
