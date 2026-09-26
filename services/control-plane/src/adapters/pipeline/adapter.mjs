/**
 * adapters/pipeline/adapter.mjs —— Pipeline Adapter 领域中立接口（方案 p23）。
 *
 * 可替代性：企业已有 GitLab/Jenkins/Tekton 时，平台通过本接口对接；
 * 领域模型只识别 Run / Gate / Artifact / Evidence，不绑定具体 CI 产品。
 *
 * interface PipelineAdapter {
 *   // 触发一次 CI 运行（构建/测试/扫描）。ref 通常是分支名或 commit sha。
 *   triggerRun({ kind: 'build'|'test'|'scan', ref, branch?, commit?, changePackageId?, inputs? })
 *     => Promise<Run>
 *   // 轮询运行状态（调用方自己决定轮询节奏；适配器不做长轮询）。
 *   getRunStatus(runId) => Promise<Run>
 *   // 列出该运行产出的制品（供 develop 阶段门禁与证据链消费）。
 *   listArtifacts(runId) => Promise<Artifact[]>
 * }
 *
 * Run      = { id: 'cir_…', kind, ref, status: 'queued'|'running'|'passed'|'failed'|'cancelled',
 *              url?, conclusion?, startedAt?, finishedAt?, simulated }
 * Artifact = { id, kind, name, uri, size?, contentHash? }
 * Gate     = 门禁语义由调用方（delivery/pipeline.mjs）实现，适配器只返回事实；
 * Evidence = 制品/运行记录进入 P7 证据链时由调用方组装（artifacts 表 / evidence 包）。
 *
 * 选择实现：createPipelineAdapter({ provider: 'gitea-actions'|'gitlab'|'jenkins', binding, token })。
 * gitlab/jenkins 为扩展点 stub：按本接口实现后接入工厂即可。
 */
import { Errors } from '../../kernel/errors.mjs';
import { newId } from '../../kernel/ids.mjs';
import { config } from '../../kernel/config.mjs';
import { createGiteaActionsAdapter } from './gitea-actions.mjs';
import { createGitlabAdapter } from './gitlab.mjs';
import { createJenkinsAdapter } from './jenkins.mjs';

export const CI_RUN_KINDS = new Set(['build', 'test', 'scan']);
export const CI_RUN_STATUSES = new Set(['queued', 'running', 'passed', 'failed', 'cancelled']);

export function newRunId() { return newId('cir'); }

/** Run 形状校验（各实现返回前自查；测试断言也用它） */
export function assertRunShape(run) {
  if (!run || typeof run !== 'object') throw Errors.internal('PipelineAdapter 返回了非法 Run');
  if (!CI_RUN_KINDS.has(run.kind)) throw Errors.internal(`Run.kind 非法: ${run.kind}`);
  if (!CI_RUN_STATUSES.has(run.status)) throw Errors.internal(`Run.status 非法: ${run.status}`);
  return run;
}

export function createPipelineAdapter({ provider, binding, token }) {
  if (!binding) throw Errors.badRequest('repo binding 必填');
  switch (provider) {
    case 'gitea-actions': return createGiteaActionsAdapter({ binding, token });
    case 'gitlab': return createGitlabAdapter({ binding, token });
    case 'jenkins': return createJenkinsAdapter({ binding, token });
    default:
      throw Errors.badRequest(
        `pipeline provider 非法: ${provider}（支持 gitea-actions/gitlab/jenkins）`,
        { code: 'UNKNOWN_CI_PROVIDER' });
  }
}

/** /readyz 上报 */
export function getPipelineAdapterStatus() {
  return config.GITEA_URL ? 'gitea-actions(live)' : 'gitea-actions(fake/fallback)';
}
