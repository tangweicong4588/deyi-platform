/**
 * adapters/pipeline/gitlab.mjs —— GitLab Pipeline Adapter 扩展点（stub）。
 *
 * 方案 p23 可替代性：企业已有 GitLab 时按本接口实现后接入
 * adapters/pipeline/adapter.mjs 的 createPipelineAdapter 工厂：
 *
 *   triggerRun({ kind: 'build'|'test'|'scan', ref, branch?, commit?, changePackageId?, inputs? })
 *     → GitLab: POST /projects/:id/pipeline { ref, variables }
 *   getRunStatus(runId) → GitLab: GET /projects/:id/pipelines/:id
 *     status 映射：created/pending→queued；running→running；
 *     success→passed；failed→failed；canceled/skipped→cancelled
 *   listArtifacts(runId) → GitLab: GET /projects/:id/pipelines/:id/test_report 等
 *     或 jobs/:job_id/artifacts
 *
 * 注意：领域对象只用 Run/Artifact（见 adapter.mjs），不许把 GitLab 的 pipeline/job
 * ID 当成平台真相源；平台侧用 cir_ ID，GitLab ID 只存在映射字段里。
 */
import { Errors } from '../../kernel/errors.mjs';

export function createGitlabAdapter(/* { binding, token } */) {
  throw Errors.badRequest(
    'GitLab Pipeline Adapter 尚未实现：按 adapters/pipeline/adapter.mjs 的 PipelineAdapter 接口实现后接入',
    { code: 'ADAPTER_NOT_IMPLEMENTED' },
  );
}
