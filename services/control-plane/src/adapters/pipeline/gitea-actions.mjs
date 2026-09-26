/**
 * adapters/pipeline/gitea-actions.mjs —— Gitea Actions 实现。
 *
 * - live：GITEA_URL 已配置且 binding.provider=gitea → 真 Actions REST API。
 *   契约说明（推断，未联调真 Gitea，见 GOAL.md 风险）：
 *   - 触发：POST /api/v1/repos/{owner}/{repo}/actions/workflows/{file}/dispatches
 *     { ref, inputs } → 204（Gitea/GitHub 风格 dispatch 不直接返回 run id，
 *     触发后按 ref 轮询 runs 列表取最新一条作为 runId）。
 *   - 状态：GET .../actions/runs/{id} → { status, conclusion } 映射到
 *     queued/running/passed/failed/cancelled。
 *   - 制品：GET .../actions/runs/{id}/artifacts → { artifacts: [...] }。
 * - fallback：内存 fake，状态随轮询推进 queued→running→passed，
 *   明确标记 simulated:true。
 * - workflow 文件选择：inputs.workflow 优先，否则按 kind 映射
 *   build→build.yml / test→test.yml / scan→scan.yml（企业可在 inputs 覆盖）。
 */
import { config } from '../../kernel/config.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { logger } from '../../kernel/logging.mjs';
import { parseOwnerRepo } from '../gitea/client.mjs';
import { newRunId, assertRunShape, CI_RUN_KINDS } from './adapter.mjs';

const WORKFLOW_BY_KIND = { build: 'build.yml', test: 'test.yml', scan: 'scan.yml' };

function scrub(token, text) {
  if (!token || !text) return text;
  return String(text).split(token).join('***');
}

async function afetch(baseUrl, token, path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  const url = baseUrl.replace(/\/$/, '') + path;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `token ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw Errors.upstream(`Gitea Actions 请求失败: ${method} ${path}（${e.name || 'network'}）`,
      { code: 'GITEA_ACTIONS_UNREACHABLE' });
  }
  if (!res.ok) {
    const text = scrub(token, await res.text().catch(() => ''));
    logger.warn('gitea actions api error', { method, path, status: res.status });
    throw Errors.upstream(`Gitea Actions API 错误: ${method} ${path} → ${res.status} ${text.slice(0, 200)}`,
      { code: 'GITEA_ACTIONS_API_ERROR', status: res.status });
  }
  if (res.status === 204) return null;
  return res.json().catch(() => ({}));
}

// ---------------------------------------------------------------- live
class GiteaActionsLive {
  constructor({ binding, token }) {
    this.binding = binding;
    this.token = token;
    this.baseUrl = config.GITEA_URL.replace(/\/$/, '');
    const { owner, repo } = parseOwnerRepo(binding.remote_url);
    this.owner = owner;
    this.repoName = repo;
  }
  _p(p) { return `/api/v1/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repoName)}${p}`; }

  _checkKind(kind) {
    if (!CI_RUN_KINDS.has(kind)) throw Errors.badRequest(`CI kind 非法: ${kind}`);
  }

  async triggerRun({ kind, ref, inputs = {}, changePackageId = null }) {
    this._checkKind(kind);
    if (!ref || !String(ref).trim()) throw Errors.badRequest('ref（分支或 commit）必填');
    const workflow = String(inputs.workflow || WORKFLOW_BY_KIND[kind]);
    const { workflow: _w, ...rest } = inputs;
    await afetch(this.baseUrl, this.token,
      this._p(`/actions/workflows/${encodeURIComponent(workflow)}/dispatches`),
      { method: 'POST', body: { ref: String(ref), inputs: rest } });
    // dispatch 不返回 run id：按 ref 查最新 workflow_dispatch 运行
    const runs = await afetch(this.baseUrl, this.token,
      this._p(`/actions/runs?event=workflow_dispatch&branch=${encodeURIComponent(String(ref))}&limit=1`));
    const latest = Array.isArray(runs?.workflow_runs) ? runs.workflow_runs[0]
      : Array.isArray(runs) ? runs[0] : null;
    if (!latest) {
      throw Errors.upstream('dispatch 已提交但未找到对应运行（Actions 契约为推断，需联调确认）',
        { code: 'GITEA_RUN_NOT_FOUND' });
    }
    return assertRunShape(this._toRun(latest, { kind, ref, changePackageId }));
  }

  async getRunStatus(runId) {
    const id = encodeURIComponent(String(runId));
    const r = await afetch(this.baseUrl, this.token, this._p(`/actions/runs/${id}`));
    return assertRunShape(this._toRun(r, {}));
  }

  async listArtifacts(runId) {
    const id = encodeURIComponent(String(runId));
    const body = await afetch(this.baseUrl, this.token, this._p(`/actions/runs/${id}/artifacts`));
    const list = Array.isArray(body?.artifacts) ? body.artifacts : [];
    return list.map((a) => ({
      id: `cirart_${a.id}`, kind: 'report', name: a.name || `artifact-${a.id}`,
      uri: `${this.baseUrl}${this._p(`/actions/runs/${id}/artifacts/${a.id}`)}`,
      size: a.size_in_bytes ?? null, simulated: false,
    }));
  }

  _toRun(r, { kind, ref, changePackageId }) {
    const st = String(r.status || '').toLowerCase();
    const conclusion = String(r.conclusion || '').toLowerCase();
    let status = 'running';
    if (st === 'queued' || st === 'waiting' || st === 'pending') status = 'queued';
    else if (st === 'in_progress' || st === 'running') status = 'running';
    else if (st === 'completed' || st === 'success' || st === 'failure') {
      status = conclusion === 'success' ? 'passed'
        : conclusion === 'cancelled' || conclusion === 'canceled' ? 'cancelled' : 'failed';
    }
    // kind 只认触发时传入的值；远端 workflow 名不可信（回退 build，保证 Run 形状合法）
    const safeKind = CI_RUN_KINDS.has(kind) ? kind : 'build';
    return {
      id: `cir_gitea_${r.id}`, kind: safeKind, ref: ref || r.head_branch || '',
      status, url: r.html_url || '', conclusion: conclusion || null,
      startedAt: r.run_started_at ? Date.parse(r.run_started_at) : null,
      finishedAt: r.updated_at ? Date.parse(r.updated_at) : null,
      changePackageId: changePackageId || null, simulated: false,
    };
  }
}

// ---------------------------------------------------------------- fake
const fakeRuns = new Map(); // runId -> { run, polls }

const FAKE_ARTIFACTS = {
  build: [{ kind: 'sbom', name: 'sbom.json' }],
  test: [{ kind: 'test_report', name: 'test-report.json' }],
  scan: [{ kind: 'scan_report', name: 'scan-report.json' }],
};

class GiteaActionsFake {
  constructor({ binding }) {
    this.binding = binding;
    // 仅测试用：模拟外部 CI 结果（失败路径等）
    this._testHook = {
      setRunStatus: (runId, status) => {
        const rec = fakeRuns.get(String(runId));
        if (!rec) throw Errors.notFound('fake CI 运行不存在');
        rec.run.status = status;
        if (['passed', 'failed', 'cancelled'].includes(status)) rec.run.finishedAt = Date.now();
        return rec.run;
      },
    };
  }
  async triggerRun({ kind, ref, branch = null, commit = null, changePackageId = null, inputs = {} }) {
    if (!CI_RUN_KINDS.has(kind)) throw Errors.badRequest(`CI kind 非法: ${kind}`);
    if (!ref || !String(ref).trim()) throw Errors.badRequest('ref（分支或 commit）必填');
    const id = newRunId();
    const run = {
      id, kind, ref: String(ref), branch, commit, changePackageId,
      status: 'queued', url: `fake://ci/${id}`,
      inputs: { workflow: inputs.workflow || WORKFLOW_BY_KIND[kind] },
      startedAt: Date.now(), finishedAt: null, simulated: true,
    };
    fakeRuns.set(id, { run, polls: 0 });
    logger.info('ci fake trigger', { run_id: id, kind, ref: String(ref).slice(0, 60) });
    return assertRunShape({ ...run });
  }
  /** 每次轮询推进一格：queued→running→passed（确定性，便于测试） */
  async getRunStatus(runId) {
    const rec = fakeRuns.get(String(runId));
    if (!rec) throw Errors.notFound('fake CI 运行不存在');
    const { run } = rec;
    if (run.status === 'queued') { run.status = 'running'; }
    else if (run.status === 'running') { run.status = 'passed'; run.finishedAt = Date.now(); }
    rec.polls++;
    return assertRunShape({ ...run });
  }
  async listArtifacts(runId) {
    const rec = fakeRuns.get(String(runId));
    if (!rec) throw Errors.notFound('fake CI 运行不存在');
    if (rec.run.status !== 'passed') return [];
    return (FAKE_ARTIFACTS[rec.run.kind] || []).map((a, i) => ({
      id: `${rec.run.id}_art${i}`, kind: a.kind, name: a.name,
      uri: `fake://ci/${rec.run.id}/${a.name}`, size: 128, simulated: true,
    }));
  }
}

/** 工厂：binding.provider=gitea 且 GITEA_URL 配置 → live；否则 fake */
export function createGiteaActionsAdapter({ binding, token }) {
  if (binding.provider === 'gitea' && config.GITEA_URL) {
    logger.info('pipeline adapter: gitea-actions(live)');
    return new GiteaActionsLive({ binding, token });
  }
  logger.info('pipeline adapter: gitea-actions(fake/fallback)', { provider: binding.provider });
  return new GiteaActionsFake({ binding });
}
