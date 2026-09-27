import { get, post } from './client';

/** F3 软件生产控制台（Track A：流水线/发布/制品库/效能看板）。token 由调用方从 useAuth 传入。 */

const DP = (projectId: string, p = '') => `/v1/projects/${projectId}/delivery${p}`;
const RP = (projectId: string, p = '') => `/v1/projects/${projectId}${p}`;

// ---------- 流水线模板 ----------
export interface PipelineTemplate {
  id: string; name: string; description: string | null;
  visibility: 'private' | 'shared'; project_id: string | null;
  current_version: number | null; archived_at: number | null;
  created_at: number;
}
export interface PipelineInstance {
  id: string; template_id: string; template_version: number;
  change_package_id: string; status: string; created_at: number;
}
export const pipelinesApi = {
  listTemplates: (token: string, projectId: string) =>
    get<PipelineTemplate[]>(DP(projectId, '/pipeline-templates'), { token }),
  createTemplate: (token: string, projectId: string, body: { name: string; description?: string; visibility?: string; paramsSchema?: unknown[]; stages?: Array<{ key: string; name?: string }> }) =>
    post<PipelineTemplate>(DP(projectId, '/pipeline-templates'), body, { token }),
  getTemplate: (token: string, projectId: string, templateId: string) =>
    get<{ template: PipelineTemplate; versions: Array<{ version: number; definition: unknown; created_at: number }> }>(DP(projectId, `/pipeline-templates/${templateId}`), { token }),
  publishVersion: (token: string, projectId: string, templateId: string, body: { stages: Array<{ key: string; name?: string }>; changeNote?: string }) =>
    post<{ version: number }>(DP(projectId, `/pipeline-templates/${templateId}/versions`), body, { token }),
  instantiate: (token: string, projectId: string, templateId: string, body: { changePackageId: string; version?: number; params?: Record<string, unknown> }) =>
    post<{ instance: PipelineInstance; created: boolean }>(DP(projectId, `/pipeline-templates/${templateId}/instantiate`), body, { token }),
  getInstance: (token: string, projectId: string, instanceId: string) =>
    get<{ instance: PipelineInstance; runs: unknown[] }>(DP(projectId, `/pipeline-instances/${instanceId}`), { token }),
  listRuns: (token: string, projectId: string) =>
    get<Array<{ id: string; change_package_id: string; status: string; created_at: number }>>(DP(projectId, '/pipeline-runs'), { token }),
  listChangePackages: (token: string, projectId: string) =>
    get<Array<{ id: string; title: string; status: string }>>(DP(projectId, '/change-packages'), { token }),
};

// ---------- 发布管理 ----------
export interface DeployEnvironment { id: string; key: string; name: string; requires_approval: number }
export interface Release {
  id: string; environment_id: string; version: string; strategy: string;
  status: string; requires_approval: boolean;
  approval: { decision?: string; approver_id?: string | null; requested_by?: string } | null;
  created_at: number; updated_at: number;
}
export interface ReleaseDetail {
  release: Release;
  steps: Array<{ seq: number; kind: string; label: string; status: string }>;
}
export const releasesApi = {
  listEnvironments: (token: string, projectId: string) =>
    get<DeployEnvironment[]>(RP(projectId, '/deploy-environments'), { token }),
  ensureEnvironments: (token: string, projectId: string) =>
    post<DeployEnvironment[]>(RP(projectId, '/deploy-environments/ensure-defaults'), {}, { token }),
  listReleases: (token: string, projectId: string) =>
    get<Release[]>(RP(projectId, '/releases'), { token }),
  createRelease: (token: string, projectId: string, body: { environment_key: string; version: string; strategy: string; strategy_config: unknown; change_package_id?: string }) =>
    post<Release>(RP(projectId, '/releases'), body, { token }),
  getRelease: (token: string, projectId: string, releaseId: string) =>
    get<ReleaseDetail>(RP(projectId, `/releases/${releaseId}`), { token }),
  requestApproval: (token: string, projectId: string, releaseId: string, approverId?: string) =>
    post<Release>(RP(projectId, `/releases/${releaseId}/request-approval`), approverId ? { approverId } : {}, { token }),
  approve: (token: string, projectId: string, releaseId: string, note?: string) =>
    post<Release>(RP(projectId, `/releases/${releaseId}/approve`), { approved: true, note }, { token }),
  reject: (token: string, projectId: string, releaseId: string, note?: string) =>
    post<Release>(RP(projectId, `/releases/${releaseId}/reject`), { approved: false, note }, { token }),
  start: (token: string, projectId: string, releaseId: string, mode?: string) =>
    post<ReleaseDetail>(RP(projectId, `/releases/${releaseId}/start`), mode ? { mode } : {}, { token }),
  rollback: (token: string, projectId: string, releaseId: string) =>
    post<ReleaseDetail>(RP(projectId, `/releases/${releaseId}/rollback`), {}, { token }),
};

// ---------- 制品库 ----------
export interface ArtifactPackage { id: string; name: string; kind: string; created_at: number }
export interface ArtifactVersion { version: string; content_hash: string; size_bytes: number; pinned: boolean; created_at: number }
export const artifactsApi = {
  listPackages: (token: string, projectId: string) =>
    get<ArtifactPackage[]>(RP(projectId, '/artifact-packages'), { token }),
  createPackage: (token: string, projectId: string, body: { name: string; kind?: string }) =>
    post<ArtifactPackage>(RP(projectId, '/artifact-packages'), body, { token }),
  listVersions: (token: string, projectId: string, packageId: string) =>
    get<ArtifactVersion[]>(RP(projectId, `/artifact-packages/${packageId}/versions`), { token }),
  uploadVersion: (token: string, projectId: string, packageId: string, file: File, version?: string) =>
    post<ArtifactVersion>(RP(projectId, `/artifact-packages/${packageId}/versions`) +
      `?version=${encodeURIComponent(version ?? (file.name.replace(/\.[^.]+$/, '') || 'v1'))}&filename=${encodeURIComponent(file.name)}`, file, {
      token, rawBody: true, headers: { 'content-type': 'application/octet-stream' },
    }),
  downloadUrl: (projectId: string, packageId: string, version: string) =>
    `/v1/projects/${projectId}/artifact-packages/${packageId}/versions/${version}/download`,
};

// ---------- 效能看板 ----------
export interface DoraReport {
  methodology: string;
  window: { from: number; to: number };
  deployment_frequency: { per_day: number; count: number; window_days: number };
  lead_time: { median_hours: number | null; p90_hours: number | null; count: number; excluded_no_change_package: number };
  change_failure_rate: { rate: number; failed: number; total: number };
  time_to_restore: { median_hours: number | null; count: number; unrecovered: number };
}
export interface TraceChain {
  requirement?: { id: string; title: string } | null;
  change_package?: { id: string; title: string } | null;
  pipeline_runs?: Array<{ id: string; status: string }>;
  artifact_versions?: Array<{ id: string; version: string }>;
  releases?: Array<{ id: string; version: string; status: string }>;
  timeline: Array<{ ts: number; kind: string; label: string; id?: string }>;
}
export interface TraceResult {
  seed: { kind: string; id: string };
  chains: TraceChain[];
}
export const doraApi = {
  getReport: (token: string, projectId: string, q?: { from?: number; to?: number }) => {
    const qs = new URLSearchParams(q as Record<string, string>).toString();
    return get<DoraReport>(RP(projectId, '/dora') + (qs ? `?${qs}` : ''), { token });
  },
  trace: (token: string, projectId: string, seedKind: string, seedId: string) =>
    get<TraceResult>(RP(projectId, `/trace?seed_kind=${encodeURIComponent(seedKind)}&seed_id=${encodeURIComponent(seedId)}`), { token }),
};
