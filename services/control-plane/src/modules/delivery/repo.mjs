/**
 * modules/delivery/repo.mjs —— V1.0-C 仓库与 CI 适配：业务逻辑层。
 *
 * - collectRepoSnapshot：从 repo_binding 采集 RepoSnapshot（默认分支 head、
 *   分支列表、最近提交、open PR），落 fact_snapshots（kind='snapshot'），
 *   挂到 pipeline run 的 facts 阶段，满足"事实就绪"门禁的基线 commit 项。
 * - createControlledBranch：为变更包创建受控分支 dy/<chg_id>（分支名经白名单
 *   校验；分支一经创建不可覆盖）。
 * - createDraftPullRequest：创建草稿 PR 并登记 pull_requests（pr_）；
 *   平台只创建 draft，硬禁令：不提供 merge 能力。
 * - syncPullRequest：从远端轮询 PR 状态并同步登记（merged/closed 只能经此进入）。
 *
 * 密钥铁律：凭据经 adapters/credentials.mjs 从 vault 引用解析（fail-closed），
 * 只进 Authorization header；快照/日志/错误绝不含凭据。
 */
import { Errors } from '../../kernel/errors.mjs';
import { logger } from '../../kernel/logging.mjs';
import { tryAudit } from '../evidence/audit.mjs';
import { createRepoClient, sanitizeBranchName, getRepoAdapterStatus } from '../../adapters/gitea/client.mjs';
import { resolveToken } from '../../adapters/credentials.mjs';
import * as store from './store.mjs';
import * as svc from './service.mjs';
import { scanSecretKeys } from './pipeline.mjs';

export { getRepoAdapterStatus };

/** binding → 适配器客户端（凭据 fail-closed 解析） */
function clientFor(binding) {
  const token = resolveToken({ credentialRef: binding.credential_ref, bindingId: binding.id });
  return createRepoClient({ binding, token });
}

async function activeBinding(tenantId, projectId, repoBindingId = null) {
  let binding;
  if (repoBindingId) {
    binding = await svc.getRepoBinding(tenantId, projectId, repoBindingId);
  } else {
    const all = await store.listRepoBindings(tenantId, projectId);
    binding = all.find((b) => b.status === 'active') || null;
    if (!binding) throw Errors.badRequest('项目没有活跃的仓库绑定，请先绑定仓库', { code: 'NO_ACTIVE_REPO' });
  }
  if (binding.status !== 'active') throw Errors.badRequest(`仓库绑定已禁用: ${binding.id}`);
  return binding;
}

// ---------------------------------------------------------------- RepoSnapshot
/**
 * 采集 RepoSnapshot 并挂到 facts 阶段运行。
 * body: { repoBindingId?, pipelineRunId }（pipelineRunId 必须为 facts 阶段运行）
 */
export async function collectRepoSnapshot({ tenantId, projectId, actorId, repoBindingId = null, pipelineRunId }) {
  if (!pipelineRunId) throw Errors.badRequest('pipelineRunId 必填（快照必须挂到 facts 阶段运行）');
  const run = await svc.getPipelineRun(tenantId, projectId, pipelineRunId);
  if (run.stage !== 'facts') throw Errors.badRequest('RepoSnapshot 只能挂到 facts 阶段的运行');
  if (!['running', 'gated'].includes(run.status)) {
    throw Errors.badRequest(`facts 阶段状态 ${run.status} 不接受快照采集`);
  }
  const binding = await activeBinding(tenantId, projectId, repoBindingId);
  const client = clientFor(binding);

  const repo = await client.getRepo();
  const branches = (await client.listBranches(50)).slice(0, 50);
  const recentCommits = (await client.listCommits(repo.defaultBranch, 20)).slice(0, 20);
  const openPrs = (await client.listPulls({ state: 'open', limit: 20 })).slice(0, 20);
  const headCommit = repo.headCommit
    || (branches.find((b) => b.name === repo.defaultBranch) || {}).sha || '';

  const environment = {
    snapshot_kind: 'repo',
    provider: binding.provider,
    default_branch: repo.defaultBranch,
    branches: branches.map((b) => ({ name: b.name, sha: b.sha })),
    recent_commits: recentCommits,
    open_prs: openPrs.map((p) => ({ number: p.number, title: p.title, head: p.head, base: p.base })),
    simulated: !!repo.simulated,
    // 注意：remote_url 可能含本地路径，属非密元数据；凭据绝不进快照
  };
  scanSecretKeys(environment);

  const snp = await store.upsertFactSnapshot({
    tenantId, projectId, pipelineRunId: run.id,
    baselineCommit: headCommit,
    environment, dependencies: {}, unknownItems: [],
    recordedBy: actorId, kind: 'snapshot',
  });
  logger.info('repo snapshot collected', {
    binding_id: binding.id, run_id: run.id, baseline: String(headCommit).slice(0, 12),
    branches: branches.length, simulated: !!repo.simulated,
  });
  await tryAudit({
    tenantId, projectId, actorId, action: 'repo.snapshot.collect',
    resourceKind: 'pipeline_run', resourceId: run.id,
    payload: { binding_id: binding.id, baseline_commit: headCommit, simulated: !!repo.simulated },
  });
  return { snapshot: snp, simulated: !!repo.simulated };
}

// ---------------------------------------------------------------- 受控分支
/** 变更包受控分支名：dy/<chg_id>（chg_id 为平台生成 ID，仍过白名单防注入） */
export function controlledBranchName(changePackageId) {
  return sanitizeBranchName(`dy/${changePackageId}`);
}

export async function createControlledBranch({ tenantId, projectId, actorId, changePackageId,
  repoBindingId = null, baseBranch = null }) {
  const chg = await svc.getChangePackage(tenantId, projectId, changePackageId);
  if (!['draft', 'building'].includes(chg.status)) {
    throw Errors.badRequest(`变更包状态 ${chg.status} 不允许创建分支（仅 draft/building）`);
  }
  if (chg.branch) {
    // 幂等：已是受控分支则直接返回
    if (chg.branch === controlledBranchName(chg.id)) {
      return { change_package: chg, branch: chg.branch, base_commit: chg.base_commit, existed: true };
    }
    throw Errors.conflict(`变更包已有分支 ${chg.branch}，不允许覆盖`);
  }
  const binding = await activeBinding(tenantId, projectId, repoBindingId);
  const client = clientFor(binding);
  const base = baseBranch || binding.default_branch || 'main';
  sanitizeBranchName(base);
  const { sha: baseCommit } = await client.getBranchCommit(base);
  const branch = controlledBranchName(chg.id);
  const created = await client.createBranch({ branch, from: baseCommit });
  const out = await store.setChangePackageBranch(tenantId, chg.id, branch, baseCommit);
  logger.info('controlled branch created', {
    chg: chg.id, branch, base_commit: String(baseCommit).slice(0, 12), simulated: !!created.simulated,
  });
  await tryAudit({
    tenantId, projectId, actorId, action: 'repo.branch.create',
    resourceKind: 'change_package', resourceId: chg.id,
    payload: { branch, base_branch: base, base_commit: baseCommit, simulated: !!created.simulated },
  });
  return { change_package: out, branch, base_commit: baseCommit, simulated: !!created.simulated };
}

// ---------------------------------------------------------------- 草稿 PR
export async function createDraftPullRequest({ tenantId, projectId, actorId, changePackageId,
  repoBindingId = null, title = null, description = '' }) {
  const chg = await svc.getChangePackage(tenantId, projectId, changePackageId);
  if (!chg.branch) throw Errors.badRequest('变更包尚未创建受控分支，请先创建分支');
  // 幂等：已有 draft/open PR 直接返回，不重复创建
  const existed = await store.getActivePullRequest(tenantId, chg.id);
  if (existed) return { pull_request: existed, existed: true, simulated: existed.simulated };
  // 注意：repoBindingId 不传时取项目首个活跃绑定；若分支是用另一绑定建的，
  // PR 会落到默认绑定上——调用方（Agent 编排）应显式传递同一 binding。
  const binding = await activeBinding(tenantId, projectId, repoBindingId);
  const client = clientFor(binding);
  const prTitle = String(title || `变更包 ${chg.id}（草稿）`).slice(0, 200);
  const created = await client.createDraftPull({
    head: chg.branch, base: binding.default_branch || 'main',
    title: prTitle, body: description, draft: true, // 硬性 draft，适配器层二次强制
  });
  let pr;
  try {
    pr = await store.createPullRequest({
      tenantId, projectId, changePackageId: chg.id, repoBindingId: binding.id,
      provider: binding.provider, repo: created.repo || '',
      number: created.number ?? null, url: created.url || '', title: created.title || prTitle,
      status: 'draft', headBranch: chg.branch, baseBranch: binding.default_branch || 'main',
      headCommit: chg.head_commit || '', simulated: !!created.simulated, createdBy: actorId,
    });
  } catch (e) {
    // 并发双建：唯一索引 (change_package_id WHERE draft/open) 冲突 → 回读胜者
    //（远端可能多建了一个 PR，属竞态固有代价；fake 无影响，live 需人工清理孤儿 PR）
    if (String(e && e.message || '').toLowerCase().includes('unique')) {
      const winner = await store.getActivePullRequest(tenantId, chg.id);
      if (winner) {
        logger.warn('draft PR concurrent create, returning winner', { chg: chg.id, pr: winner.id });
        return { pull_request: winner, existed: true, simulated: winner.simulated };
      }
    }
    throw e;
  }
  logger.info('draft PR created', { chg: chg.id, pr: pr.id, number: created.number, simulated: pr.simulated });
  await tryAudit({
    tenantId, projectId, actorId, action: 'repo.pr.create',
    resourceKind: 'pull_request', resourceId: pr.id,
    payload: { change_package_id: chg.id, number: created.number, simulated: pr.simulated },
  });
  return { pull_request: pr, simulated: pr.simulated };
}

export async function getPullRequest(tenantId, projectId, prId) {
  const pr = await store.getPullRequest(tenantId, prId).catch(() => null);
  if (!pr || pr.project_id !== projectId) throw Errors.notFound('PR 不存在');
  return pr;
}

export async function listPullRequests(tenantId, projectId, { changePackageId } = {}) {
  if (changePackageId) await svc.getChangePackage(tenantId, projectId, changePackageId);
  return store.listPullRequests(tenantId, projectId, { changePackageId });
}

/**
 * 从远端同步 PR 状态（merged/closed 只能经此进入；平台无 merge 端点）。
 * 返回 { pull_request, external, changed, simulated }。
 */
export async function syncPullRequest({ tenantId, projectId, actorId, prId }) {
  const pr = await getPullRequest(tenantId, projectId, prId);
  if (['merged', 'closed'].includes(pr.status)) {
    return { pull_request: pr, external: null, changed: false, simulated: pr.simulated };
  }
  const binding = await activeBinding(tenantId, projectId, pr.repo_binding_id);
  const client = clientFor(binding);
  if (pr.number == null) {
    throw Errors.badRequest('该 PR 登记缺少远端编号，无法同步', { code: 'PR_NO_NUMBER' });
  }
  const ext = await client.getPullStatus(pr.number);
  let out = pr;
  let changed = false;
  if (ext.status !== pr.status) {
    out = await store.setPullRequestStatus(tenantId, pr.id, ext.status,
      { url: ext.url || null, headCommit: null });
    changed = true;
    logger.info('PR status synced', { pr: pr.id, from: pr.status, to: ext.status, simulated: !!ext.simulated });
    await tryAudit({
      tenantId, projectId, actorId, action: 'repo.pr.sync',
      resourceKind: 'pull_request', resourceId: pr.id,
      payload: { from: pr.status, to: ext.status, simulated: !!ext.simulated },
    });
  }
  return { pull_request: out, external: ext, changed, simulated: !!ext.simulated };
}
