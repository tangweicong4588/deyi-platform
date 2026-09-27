/**
 * F4 平台运营后台 API（全部平台 operator 接口，Bearer 携带 OPERATOR_TOKEN）。
 * 注意：合规导出返回裸文件流（非 {data} 信封），用 fetchRaw 拿 Response 自行处理。
 */
import { get, post, patch, fetchRaw } from './client';

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended' | 'purged';
  plan: string;
  quotas: Record<string, number | null>;
  created_at: number;
  updated_at: number;
  purged_at?: number | null;
}

export interface ProvisionResult {
  tenant: Tenant;
  project: { id: string; name: string };
  actor: { id: string; name: string };
  /** secret 只返回一次，调用方负责只展示一次 */
  apiKey: { id: string; name: string; prefix: string; key: string };
}

export interface OffboardDryRun {
  phase: 'dryRun';
  tenant_id: string;
  tenant_status: string;
  counts: Record<string, number>;
  total_rows_to_delete: number;
  kept: { billing_invoices: number; anchors: number; note: string };
  export_manifest: {
    filename: string;
    format: string;
    event_count: number;
    truncated: boolean;
    content_sha256: string;
    chain_verification: unknown;
    latest_anchor: unknown;
  };
  confirm_token: string;
  confirm_token_ttl_ms: number;
}

export interface OffboardConfirm {
  phase: 'confirm';
  tenant_id: string;
  already_purged?: boolean;
  purged_at?: number;
  deleted_tables?: Record<string, number>;
  audit?: { wiped_events: number; checkpoint_id: string; offboard_event_id: string };
  vectors?: Record<string, unknown>;
  artifact_blobs?: Record<string, unknown>;
}

export interface AuditManifest {
  filename: string;
  format: string;
  event_count: number;
  truncated: boolean;
  content_sha256: string;
  chain_verification: unknown;
  latest_anchor: unknown;
}

export interface AnchorStatus {
  anchored: boolean;
  [k: string]: unknown;
}

export interface SweepResult {
  dry_run: boolean;
  tenants: number;
  results?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

export interface Readiness {
  status: 'ready' | 'not-ready';
  checks?: Record<string, unknown>;
  adapters?: Record<string, unknown>;
  error?: string;
}

const base = (tenantId: string) => `/v1/admin/tenants/${tenantId}`;

export const opsApi = {
  // ---------- 租户生命周期 ----------
  listTenants: (token: string) => get<Tenant[]>('/v1/admin/tenants', { token }),
  createTenant: (token: string, body: { name: string; slug?: string; plan?: string }) =>
    post<Tenant>('/v1/admin/tenants', body, { token }),
  provisionTenant: (
    token: string,
    body: { name: string; slug?: string; plan?: string; adminName?: string; adminEmail?: string; projectName?: string },
  ) => post<ProvisionResult>('/v1/admin/tenants/provision', body, { token }),
  patchTenant: (token: string, tenantId: string, body: { name?: string; slug?: string; plan?: string; quotas?: Record<string, number | null> }) =>
    patch<Tenant>(`${base(tenantId)}`, body, { token }),
  suspendTenant: (token: string, tenantId: string) => post<Tenant>(`${base(tenantId)}/suspend`, {}, { token }),
  resumeTenant: (token: string, tenantId: string) => post<Tenant>(`${base(tenantId)}/resume`, {}, { token }),

  // ---------- 销户 ----------
  offboardDryRun: (token: string, tenantId: string) =>
    post<OffboardDryRun>(`${base(tenantId)}/offboard`, { phase: 'dryRun' }, { token }),
  offboardConfirm: (token: string, tenantId: string, confirmToken: string) =>
    post<OffboardConfirm>(`${base(tenantId)}/offboard`, { phase: 'confirm', confirm_token: confirmToken }, { token }),

  // ---------- 审计与合规 ----------
  /** 合规导出：返回裸 Response，调用方从 x-audit-manifest 头解析 manifest。 */
  exportCompliance: (
    token: string,
    tenantId: string,
    opts: { format?: 'jsonl' | 'csv'; from?: number; to?: number } = {},
  ) => {
    const qs = new URLSearchParams();
    qs.set('format', opts.format ?? 'jsonl');
    if (opts.from) qs.set('from', String(opts.from));
    if (opts.to) qs.set('to', String(opts.to));
    return fetchRaw(`${base(tenantId)}/compliance/export?${qs}`, { token });
  },
  parseManifest: (res: Response): AuditManifest | null => {
    const b64 = res.headers.get('x-audit-manifest');
    if (!b64) return null;
    try {
      // 浏览器安全 base64 解码（含中文 manifest 先按 UTF-8 还原）
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return JSON.parse(new TextDecoder('utf-8').decode(bytes));
    } catch {
      return null;
    }
  },
  anchorStatus: (token: string, tenantId: string) => get<AnchorStatus>(`${base(tenantId)}/evidence/anchor`, { token }),
  verifyAnchors: (token: string, tenantId: string) =>
    get<{ anchored: boolean; [k: string]: unknown }>(`${base(tenantId)}/evidence/anchor/verify`, { token }),
  anchorAll: (token: string) => post<{ anchored: boolean; [k: string]: unknown }>('/v1/admin/anchor-all', {}, { token }),

  // ---------- 平台运维 ----------
  retentionSweep: (token: string, body: { tenantId?: string; dryRun?: boolean } = {}) =>
    post<SweepResult>('/v1/admin/retention/sweep', body, { token }),
  healthz: () => get<Record<string, unknown>>('/healthz'),
  readyz: () => get<Readiness>('/readyz'),
};
