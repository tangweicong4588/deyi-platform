/**
 * adapters/pipeline/jenkins.mjs —— Jenkins Pipeline Adapter 扩展点（stub）。
 *
 * 方案 p23 可替代性：企业已有 Jenkins 时按本接口实现后接入
 * adapters/pipeline/adapter.mjs 的 createPipelineAdapter 工厂：
 *
 *   triggerRun({ kind: 'build'|'test'|'scan', ref, ... })
 *     → Jenkins: POST /job/{name}/buildWithParameters?{branch=ref...}（需 crumb）
 *     返回 queue item → 轮询 queue 查 executable.number 得 build 号
 *   getRunStatus(runId) → Jenkins: GET /job/{name}/{n}/api/json
 *     building=true→running；result: SUCCESS→passed / FAILURE→failed / ABORTED→cancelled
 *   listArtifacts(runId) → Jenkins: GET /job/{name}/{n}/api/json?tree=artifacts[*]
 *
 * 注意：领域对象只用 Run/Artifact（见 adapter.mjs）；Jenkins 的 queueId/build 号
 * 只存在映射字段里，平台真相源是 cir_ ID。
 */
import { Errors } from '../../kernel/errors.mjs';

export function createJenkinsAdapter(/* { binding, token } */) {
  throw Errors.badRequest(
    'Jenkins Pipeline Adapter 尚未实现：按 adapters/pipeline/adapter.mjs 的 PipelineAdapter 接口实现后接入',
    { code: 'ADAPTER_NOT_IMPLEMENTED' },
  );
}
