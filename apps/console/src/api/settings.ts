import { get, post, del } from './client';
import type { Me } from './auth';

/** 是否租户管理员（租户级 project_id=null 的绑定中 admin 及以上） */
export function isTenantAdmin(me: Me | null): boolean {
  if (!me) return false;
  const rank = (r: string) => ['viewer', 'operator', 'admin'].indexOf(r);
  return (me.roles ?? []).some((b) => b.project_id == null && rank(b.role) >= rank('admin'));
}

// ---------- API Key ----------

export interface ApiKey {
  id: string;
  tenant_id: string;
  project_id: string | null;
  actor_id: string;
  name: string;
  prefix: string;
  scopes: string[];
  status: string;
  expires_at: number | null;
  last_used_at: number | null;
  created_at: number;
  ip_allowlist: string[];
  note: string | null;
}

export interface IssuedKey extends ApiKey {
  /** secret 仅签发/轮换响应里出现一次，前端拿到后必须立即展示并提醒保存 */
  key?: string;
  secret?: string;
}

export interface RotateResult {
  oldKey: ApiKey;
  newKey: IssuedKey;
  graceUntil: number;
}

const K = (tenantId: string, p = '') => `/v1/admin/tenants/${tenantId}/api-keys${p}`;

export const apiKeysApi = {
  list: (token: string, tenantId: string) => get<ApiKey[]>(K(tenantId), { token }),
  issue: (token: string, tenantId: string, body: {
    actorId: string; name: string; projectId?: string | null; scopes?: string[];
    expiresAt?: number | null; ipAllowlist?: string[]; note?: string | null;
  }) => post<IssuedKey>(K(tenantId), body, { token }),
  update: (token: string, tenantId: string, keyId: string, body: { ipAllowlist?: string[]; note?: string | null }) =>
    // kernel/http 的 patch 透传：用 fetch 直调
    patchJson<ApiKey>(K(tenantId, `/${keyId}`), body, token),
  rotate: (token: string, tenantId: string, keyId: string, graceHours = 24) =>
    post<RotateResult>(K(tenantId, `/${keyId}/rotate`), { graceHours }, { token }),
  revoke: (token: string, tenantId: string, keyId: string) =>
    del<{ revoked: boolean }>(K(tenantId, `/${keyId}`), { token }),
};

async function patchJson<T>(path: string, body: unknown, token: string | null): Promise<T> {
  const { api } = await import('./client');
  return api<T>(path, { method: 'PATCH', body, token });
}

// ---------- 账单 ----------

export interface Invoice {
  id: string;
  tenant_id: string;
  period_key: string;
  status: 'draft' | 'finalized' | 'paid' | 'void';
  currency: string;
  plan: string;
  plan_fee_cents: number;
  usage_cost_cents: number;
  usage_tokens: number;
  usage_calls: number;
  total_cents: number;
  line_items: Array<{ type: string; label: string; amount_cents: number; needs_pricing?: boolean }>;
  created_at: number;
  finalized_at: number | null;
  paid_at: number | null;
  voided_at: number | null;
}

const B = (tenantId: string, p = '') => `/v1/tenants/${tenantId}/billing${p}`;

export const billingApi = {
  list: (token: string, tenantId: string, status?: string) =>
    get<Invoice[]>(B(tenantId, '/invoices') + (status ? `?status=${status}` : ''), { token }),
  get: (token: string, tenantId: string, id: string) => get<Invoice>(B(tenantId, `/invoices/${id}`), { token }),
  generate: (token: string, tenantId: string, periodKey?: string) =>
    post<Invoice>(B(tenantId, '/invoices'), periodKey ? { period_key: periodKey } : {}, { token }),
  finalize: (token: string, tenantId: string, id: string) =>
    post<Invoice>(B(tenantId, `/invoices/${id}/finalize`), {}, { token }),
  pay: (token: string, tenantId: string, id: string) =>
    post<Invoice>(B(tenantId, `/invoices/${id}/pay`), {}, { token }),
  void: (token: string, tenantId: string, id: string) =>
    post<Invoice>(B(tenantId, `/invoices/${id}/void`), {}, { token }),
};

// ---------- 配额 / 用量 ----------

export interface Budget {
  id: string;
  tenant_id: string;
  project_id: string | null;
  period: string;
  cost_limit_cents: number | null;
  token_limit: number | null;
  used_cost_cents: number;
  used_tokens: number;
  source: string;
  created_at: number;
  updated_at: number;
}

export interface UsageCall {
  id: string;
  model: string;
  tokens: number;
  cost_cents: number;
  status: string;
  created_at: number;
}

export const quotasApi = {
  budgets: (token: string, tenantId: string) =>
    get<Budget[]>(`/v1/admin/tenants/${tenantId}/budgets`, { token }),
  setBudget: (token: string, tenantId: string, body: {
    projectId?: string | null; period?: string; costLimitCents?: number | null; tokenLimit?: number | null;
  }) => putJson<Budget>(`/v1/admin/tenants/${tenantId}/budgets`, body, token),
  usage: (token: string, tenantId: string, limit = 50) =>
    get<UsageCall[]>(`/v1/admin/tenants/${tenantId}/usage?limit=${limit}`, { token }),
};

async function putJson<T>(path: string, body: unknown, token: string | null): Promise<T> {
  const { api } = await import('./client');
  return api<T>(path, { method: 'PUT', body, token });
}

// ---------- 展示工具 ----------

/** 分 → 元字符串 */
export const fmtMoney = (cents: number | null | undefined) =>
  cents == null ? '—' : `¥${(cents / 100).toFixed(2)}`;

export const fmtTime = (ts: number | null | undefined) =>
  ts == null ? '—' : new Date(ts).toLocaleString('zh-CN', { hour12: false });

export const fmtNum = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('zh-CN');

/** 当前账期 YYYY-MM（与后端网关账期同口径：本地时区） */
export function currentPeriodKey(d = new Date()): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}`;
}
