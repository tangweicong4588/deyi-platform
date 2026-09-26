/**
 * modules/delivery/store.mjs —— 交付域真相源 CRUD（带租户隔离条件）。
 * 状态机在 service.mjs，这里只做数据访问。
 */
import { newId, nowMs, assertId } from '../../kernel/ids.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { db } from '../../db/index.mjs';

export const REQ_KINDS = new Set(['feature', 'bug', 'ops']);
export const REQ_STATUSES = new Set(['draft', 'clarifying', 'ready', 'in_progress', 'verifying', 'done', 'cancelled']);
export const PRIORITIES = new Set(['p0', 'p1', 'p2', 'p3']);
export const RISK_LEVELS = new Set(['low', 'medium', 'high']);
export const AC_KINDS = new Set(['auto', 'manual']);
export const AC_STATUSES = new Set(['pending', 'passed', 'failed', 'waived']);
export const REPO_PROVIDERS = new Set(['gitea', 'gitlab', 'local']);
export const CHG_STATUSES = new Set(['draft', 'building', 'verifying', 'ready_for_review', 'handed_over', 'cancelled']);
export const ART_KINDS = new Set(['diff', 'test_report', 'scan_report', 'sbom', 'image_manifest', 'preview', 'report']);
export const PIPE_STAGES = new Set(['facts', 'requirements', 'clarify', 'develop', 'handover']);
export const PIPE_STATUSES = new Set(['pending', 'running', 'gated', 'passed', 'failed', 'cancelled']);

const parseJson = (s, fb) => { try { const v = JSON.parse(s); return v ?? fb; } catch { return fb; } };
const str = (v) => String(v ?? '');

const normReq = (r) => r && {
  ...r,
  repro: parseJson(r.repro, {}),
  source_refs: parseJson(r.source_refs, []),
  ontology_term_ids: parseJson(r.ontology_term_ids, []),
};
const normAc = (r) => r && { ...r };
const normChg = (r) => r && { ...r, dod_checklist: parseJson(r.dod_checklist, {}) };
const normPipe = (r) => r && { ...r, gate_decision: parseJson(r.gate_decision, {}) };

// ---------- requirements ----------
export async function createRequirement({ tenantId, projectId, title, kind = 'feature', scopeMd = '',
  nonGoalsMd = '', priority = 'p2', riskLevel = 'low', repro = {}, sourceRefs = [], ontologyTermIds = [], createdBy }) {
  const row = {
    id: newId('req'), tenant_id: tenantId, project_id: projectId,
    title: str(title).trim(), kind, status: 'draft',
    scope_md: str(scopeMd), non_goals_md: str(nonGoalsMd),
    priority, risk_level: riskLevel,
    repro: JSON.stringify(repro || {}), source_refs: JSON.stringify(sourceRefs || []),
    ontology_term_ids: JSON.stringify(ontologyTermIds || []),
    created_by: createdBy || null, created_at: nowMs(), updated_at: nowMs(),
  };
  await db().query(
    `INSERT INTO requirements(id,tenant_id,project_id,title,kind,status,scope_md,non_goals_md,
     priority,risk_level,repro,source_refs,ontology_term_ids,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [row.id, row.tenant_id, row.project_id, row.title, row.kind, row.status, row.scope_md,
     row.non_goals_md, row.priority, row.risk_level, row.repro, row.source_refs,
     row.ontology_term_ids, row.created_by, row.created_at, row.updated_at]);
  return normReq(row);
}

export async function getRequirement(tenantId, id) {
  assertId('req', id);
  const rows = await db().query('SELECT * FROM requirements WHERE id=? AND tenant_id=?', [id, tenantId]);
  return normReq(rows[0]) || null;
}

export async function listRequirements(tenantId, projectId, { status, kind } = {}) {
  let sql = 'SELECT * FROM requirements WHERE tenant_id=? AND project_id=?';
  const args = [tenantId, projectId];
  if (status) { sql += ' AND status=?'; args.push(status); }
  if (kind) { sql += ' AND kind=?'; args.push(kind); }
  sql += ' ORDER BY updated_at DESC';
  return (await db().query(sql, args)).map(normReq);
}

export async function updateRequirement(tenantId, id, patch) {
  const sets = [];
  const args = [];
  const allowed = ['title', 'kind', 'scope_md', 'non_goals_md', 'priority', 'risk_level',
    'repro', 'source_refs', 'ontology_term_ids'];
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    let v = patch[k];
    if (['repro', 'source_refs', 'ontology_term_ids'].includes(k)) v = JSON.stringify(v ?? (k === 'repro' ? {} : []));
    sets.push(`${k}=?`);
    args.push(v);
  }
  if (!sets.length) return getRequirement(tenantId, id);
  sets.push('updated_at=?');
  args.push(nowMs(), id, tenantId);
  await db().query(`UPDATE requirements SET ${sets.join(',')} WHERE id=? AND tenant_id=?`, args);
  return getRequirement(tenantId, id);
}

export async function setRequirementStatus(tenantId, id, status) {
  await db().query('UPDATE requirements SET status=?, updated_at=? WHERE id=? AND tenant_id=?',
    [status, nowMs(), id, tenantId]);
  return getRequirement(tenantId, id);
}

// ---------- acceptance criteria ----------
export async function createAC({ tenantId, requirementId, givenMd = '', whenMd = '', thenMd = '', kind = 'auto' }) {
  const row = {
    id: newId('ac'), tenant_id: tenantId, requirement_id: requirementId,
    given_md: str(givenMd), when_md: str(whenMd), then_md: str(thenMd),
    kind, status: 'pending', evidence_ref: null, created_at: nowMs(), updated_at: nowMs(),
  };
  await db().query(
    `INSERT INTO acceptance_criteria(id,tenant_id,requirement_id,given_md,when_md,then_md,kind,status,evidence_ref,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [row.id, row.tenant_id, row.requirement_id, row.given_md, row.when_md, row.then_md,
     row.kind, row.status, row.evidence_ref, row.created_at, row.updated_at]);
  return normAc(row);
}

export async function getAC(tenantId, id) {
  assertId('ac', id);
  const rows = await db().query('SELECT * FROM acceptance_criteria WHERE id=? AND tenant_id=?', [id, tenantId]);
  return normAc(rows[0]) || null;
}

export async function listACs(tenantId, requirementId) {
  const rows = await db().query(
    'SELECT * FROM acceptance_criteria WHERE tenant_id=? AND requirement_id=? ORDER BY created_at',
    [tenantId, requirementId]);
  return rows.map(normAc);
}

export async function setACStatus(tenantId, id, status, evidenceRef = null) {
  await db().query(
    'UPDATE acceptance_criteria SET status=?, evidence_ref=COALESCE(?, evidence_ref), updated_at=? WHERE id=? AND tenant_id=?',
    [status, evidenceRef, nowMs(), id, tenantId]);
  return getAC(tenantId, id);
}

/** 需求是否全部 AC 已通过/豁免（无 AC 视为未就绪） */
export async function allACsAccepted(tenantId, requirementId) {
  const acs = await listACs(tenantId, requirementId);
  return acs.length > 0 && acs.every((a) => a.status === 'passed' || a.status === 'waived');
}

// ---------- repo bindings ----------
export async function createRepoBinding({ tenantId, projectId, provider, remoteUrl, defaultBranch = 'main', credentialRef = null }) {
  const row = {
    id: newId('rpo'), tenant_id: tenantId, project_id: projectId,
    provider, remote_url: str(remoteUrl).trim(), default_branch: str(defaultBranch) || 'main',
    credential_ref: credentialRef ? str(credentialRef) : null,
    status: 'active', created_at: nowMs(), updated_at: nowMs(),
  };
  await db().query(
    `INSERT INTO repo_bindings(id,tenant_id,project_id,provider,remote_url,default_branch,credential_ref,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [row.id, row.tenant_id, row.project_id, row.provider, row.remote_url, row.default_branch,
     row.credential_ref, row.status, row.created_at, row.updated_at]);
  return row;
}

export async function getRepoBinding(tenantId, id) {
  assertId('rpo', id);
  const rows = await db().query('SELECT * FROM repo_bindings WHERE id=? AND tenant_id=?', [id, tenantId]);
  return rows[0] || null;
}

export async function listRepoBindings(tenantId, projectId) {
  return db().query(
    'SELECT * FROM repo_bindings WHERE tenant_id=? AND project_id=? ORDER BY created_at',
    [tenantId, projectId]);
}

export async function setRepoBindingStatus(tenantId, id, status) {
  await db().query('UPDATE repo_bindings SET status=?, updated_at=? WHERE id=? AND tenant_id=?',
    [status, nowMs(), id, tenantId]);
  return getRepoBinding(tenantId, id);
}

// ---------- change packages ----------
export async function createChangePackage({ tenantId, projectId, requirementId, branch, baseCommit = '', headCommit = '', dodChecklist = {}, createdBy }) {
  const row = {
    id: newId('chg'), tenant_id: tenantId, project_id: projectId, requirement_id: requirementId,
    branch: str(branch).trim(), base_commit: str(baseCommit), head_commit: str(headCommit),
    status: 'draft', dod_checklist: JSON.stringify(dodChecklist || {}),
    created_by: createdBy || null, created_at: nowMs(), updated_at: nowMs(),
  };
  await db().query(
    `INSERT INTO change_packages(id,tenant_id,project_id,requirement_id,branch,base_commit,head_commit,status,dod_checklist,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [row.id, row.tenant_id, row.project_id, row.requirement_id, row.branch, row.base_commit,
     row.head_commit, row.status, row.dod_checklist, row.created_by, row.created_at, row.updated_at]);
  return normChg(row);
}

export async function getChangePackage(tenantId, id) {
  assertId('chg', id);
  const rows = await db().query('SELECT * FROM change_packages WHERE id=? AND tenant_id=?', [id, tenantId]);
  return normChg(rows[0]) || null;
}

export async function listChangePackages(tenantId, projectId, { requirementId } = {}) {
  let sql = 'SELECT * FROM change_packages WHERE tenant_id=? AND project_id=?';
  const args = [tenantId, projectId];
  if (requirementId) { sql += ' AND requirement_id=?'; args.push(requirementId); }
  sql += ' ORDER BY updated_at DESC';
  return (await db().query(sql, args)).map(normChg);
}

export async function setChangePackageStatus(tenantId, id, status, headCommit = null) {
  await db().query(
    'UPDATE change_packages SET status=?, head_commit=COALESCE(?, head_commit), updated_at=? WHERE id=? AND tenant_id=?',
    [status, headCommit, nowMs(), id, tenantId]);
  return getChangePackage(tenantId, id);
}

/** 受控分支落库（V1.0-C）：branch 只能写一次（dy/<chg_id>），不许覆盖已有分支 */
export async function setChangePackageBranch(tenantId, id, branch, baseCommit) {
  const upd = await db().run(
    `UPDATE change_packages SET branch=?, base_commit=?, updated_at=?
     WHERE id=? AND tenant_id=? AND (branch IS NULL OR branch='')`,
    [branch, baseCommit, nowMs(), id, tenantId]);
  if (upd.changes === 0) throw Errors.conflict('变更包已有分支，不允许覆盖（分支一经创建不可改）');
  return getChangePackage(tenantId, id);
}

// ---------- artifacts ----------
export async function createArtifact({ tenantId, changePackageId, kind, contentHash, uri = '', signature = null }) {
  const row = {
    id: newId('art'), tenant_id: tenantId, change_package_id: changePackageId,
    kind, content_hash: str(contentHash).toLowerCase(), uri: str(uri),
    signature: signature ? str(signature) : null, created_at: nowMs(),
  };
  await db().query(
    'INSERT INTO artifacts(id,tenant_id,change_package_id,kind,content_hash,uri,signature,created_at) VALUES (?,?,?,?,?,?,?,?)',
    [row.id, row.tenant_id, row.change_package_id, row.kind, row.content_hash, row.uri, row.signature, row.created_at]);
  return row;
}

export async function listArtifacts(tenantId, changePackageId) {
  return db().query(
    'SELECT * FROM artifacts WHERE tenant_id=? AND change_package_id=? ORDER BY created_at',
    [tenantId, changePackageId]);
}

// ---------- pipeline runs（静态模型） ----------
export async function createPipelineRun({ tenantId, projectId, changePackageId = null, stage }) {
  const row = {
    id: newId('pipe'), tenant_id: tenantId, project_id: projectId,
    change_package_id: changePackageId, stage, status: 'pending',
    gate_decision: '{}', started_at: null, finished_at: null, created_at: nowMs(),
  };
  await db().query(
    `INSERT INTO pipeline_runs(id,tenant_id,project_id,change_package_id,stage,status,gate_decision,started_at,finished_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [row.id, row.tenant_id, row.project_id, row.change_package_id, row.stage, row.status,
     row.gate_decision, row.started_at, row.finished_at, row.created_at]);
  return normPipe(row);
}

export async function getPipelineRun(tenantId, id) {
  assertId('pipe', id);
  const rows = await db().query('SELECT * FROM pipeline_runs WHERE id=? AND tenant_id=?', [id, tenantId]);
  return normPipe(rows[0]) || null;
}

export async function listPipelineRuns(tenantId, projectId, { changePackageId } = {}) {
  let sql = 'SELECT * FROM pipeline_runs WHERE tenant_id=? AND project_id=?';
  const args = [tenantId, projectId];
  if (changePackageId) { sql += ' AND change_package_id=?'; args.push(changePackageId); }
  sql += ' ORDER BY created_at DESC';
  return (await db().query(sql, args)).map(normPipe);
}

export async function setPipelineRun(tenantId, id, { status, gateDecision, startedAt, finishedAt }) {
  const sets = [];
  const args = [];
  if (status !== undefined) { sets.push('status=?'); args.push(status); }
  if (gateDecision !== undefined) { sets.push('gate_decision=?'); args.push(JSON.stringify(gateDecision)); }
  if (startedAt !== undefined) { sets.push('started_at=?'); args.push(startedAt); }
  if (finishedAt !== undefined) { sets.push('finished_at=?'); args.push(finishedAt); }
  if (!sets.length) return getPipelineRun(tenantId, id);
  args.push(id, tenantId);
  await db().query(`UPDATE pipeline_runs SET ${sets.join(',')} WHERE id=? AND tenant_id=?`, args);
  return getPipelineRun(tenantId, id);
}

// ---------- fact_snapshots（snp_）：事实阶段手动登记的基线 ----------
const normSnp = (r) => r && {
  ...r,
  kind: r.kind || 'manual',
  environment: parseJson(r.environment, {}),
  dependencies: parseJson(r.dependencies, {}),
  unknown_items: parseJson(r.unknown_items, []),
};

/** 登记即覆盖：每个 facts 阶段运行只认一条快照 */
export async function upsertFactSnapshot({ tenantId, projectId, pipelineRunId, baselineCommit,
  environment = {}, dependencies = {}, unknownItems = [], recordedBy, kind = 'manual' }) {
  if (!['manual', 'snapshot'].includes(kind)) throw Errors.badRequest(`事实快照 kind 非法: ${kind}`);
  const now = nowMs();
  const row = await getFactSnapshot(tenantId, pipelineRunId).catch(() => null);
  if (row) {
    await db().query(
      `UPDATE fact_snapshots SET baseline_commit=?, environment=?, dependencies=?, unknown_items=?,
        kind=?, recorded_by=?, updated_at=? WHERE id=? AND tenant_id=?`,
      [baselineCommit, JSON.stringify(environment), JSON.stringify(dependencies),
        JSON.stringify(unknownItems), kind, recordedBy, now, row.id, tenantId]);
    return getFactSnapshot(tenantId, pipelineRunId);
  }
  const id = newId('snp');
  await db().query(
    `INSERT INTO fact_snapshots(id,tenant_id,project_id,pipeline_run_id,baseline_commit,environment,
      dependencies,unknown_items,kind,recorded_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, projectId, pipelineRunId, baselineCommit, JSON.stringify(environment),
      JSON.stringify(dependencies), JSON.stringify(unknownItems), kind, recordedBy, now, now]);
  return getFactSnapshot(tenantId, pipelineRunId);
}

export async function getFactSnapshot(tenantId, pipelineRunId) {
  const rows = await db().query(
    'SELECT * FROM fact_snapshots WHERE tenant_id=? AND pipeline_run_id=?', [tenantId, pipelineRunId]);
  return normSnp(rows[0]) || null;
}

// ---------- pull_requests（pr_）：草稿 PR 登记簿（平台只创建 draft） ----------
const normPr = (r) => r && { ...r, simulated: r.simulated === 1 };

export const PR_STATUSES = new Set(['draft', 'open', 'merged', 'closed']);
// 外部事件可跳过 open（人工在远端直接合入/关闭 draft PR 是真实场景）；
// 平台自身永不执行合入（无 merge 端点），merged/closed 只能经 sync 进入。
const PR_TRANSITIONS = {
  draft: ['open', 'closed', 'merged'],
  open: ['merged', 'closed'],
  merged: [],
  closed: [],
};

export async function createPullRequest({ tenantId, projectId, changePackageId, repoBindingId,
  provider, repo = '', number = null, url = '', title = '', status = 'draft',
  headBranch = '', baseBranch = '', headCommit = '', simulated = false, createdBy }) {
  if (!PR_STATUSES.has(status)) throw Errors.badRequest(`PR status 非法: ${status}`);
  // 平台创建的 PR 只能是 draft（硬禁令：自批自合禁止）
  if (status !== 'draft') throw Errors.badRequest('平台只允许登记草稿 PR', { code: 'DRAFT_REQUIRED' });
  const id = newId('pr');
  const now = nowMs();
  await db().query(
    `INSERT INTO pull_requests(id,tenant_id,project_id,change_package_id,repo_binding_id,provider,
      repo,number,url,title,status,head_branch,base_branch,head_commit,simulated,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, projectId, changePackageId, repoBindingId, provider, repo, number, url, title,
      status, headBranch, baseBranch, headCommit, simulated ? 1 : 0, createdBy || null, now, now]);
  return getPullRequest(tenantId, id);
}

export async function getPullRequest(tenantId, id) {
  assertId('pr', id);
  const rows = await db().query('SELECT * FROM pull_requests WHERE id=? AND tenant_id=?', [id, tenantId]);
  return normPr(rows[0]) || null;
}

/** 变更包的现存 PR（draft/open 视为有效，用于创建幂等） */
export async function getActivePullRequest(tenantId, changePackageId) {
  const rows = await db().query(
    `SELECT * FROM pull_requests WHERE tenant_id=? AND change_package_id=?
     AND status IN ('draft','open') ORDER BY created_at DESC`,
    [tenantId, changePackageId]);
  return normPr(rows[0]) || null;
}

export async function listPullRequests(tenantId, projectId, { changePackageId } = {}) {
  let sql = 'SELECT * FROM pull_requests WHERE tenant_id=? AND project_id=?';
  const args = [tenantId, projectId];
  if (changePackageId) { sql += ' AND change_package_id=?'; args.push(changePackageId); }
  sql += ' ORDER BY created_at DESC';
  return (await db().query(sql, args)).map(normPr);
}

/**
 * PR 状态推进（只允许外部同步：draft→open/closed，open→merged/closed）。
 * 平台不提供 merge 端点，merged/closed 只能经 syncPullRequest 从远端同步进来。
 */
export async function setPullRequestStatus(tenantId, id, to, { url = null, headCommit = null } = {}) {
  if (!PR_STATUSES.has(to)) throw Errors.badRequest(`PR status 非法: ${to}`);
  const cur = await getPullRequest(tenantId, id);
  if (!cur) throw Errors.notFound('PR 登记不存在');
  if (cur.status === to) return cur;
  if (!(PR_TRANSITIONS[cur.status] || []).includes(to)) {
    throw Errors.badRequest(`PR 非法状态跃迁: ${cur.status} → ${to}`, { code: 'INVALID_TRANSITION' });
  }
  await db().query(
    `UPDATE pull_requests SET status=?, url=COALESCE(?, url), head_commit=COALESCE(?, head_commit),
      updated_at=? WHERE id=? AND tenant_id=?`,
    [to, url, headCommit, nowMs(), id, tenantId]);
  return getPullRequest(tenantId, id);
}
// ---------- clarifications（clf_）：澄清问题与回答 ----------
const normClf = (r) => r && { ...r, impacts_implementation: r.impacts_implementation === 1 };

export async function createClarification({ tenantId, projectId, pipelineRunId, requirementId = null,
  question, impactsImplementation = false, createdBy }) {
  const id = newId('clf');
  const now = nowMs();
  await db().query(
    `INSERT INTO clarifications(id,tenant_id,project_id,pipeline_run_id,requirement_id,question,
      answer,impacts_implementation,created_by,answered_by,created_at,answered_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, projectId, pipelineRunId, requirementId, question, null,
      impactsImplementation ? 1 : 0, createdBy, null, now, null]);
  return getClarification(tenantId, id);
}

export async function getClarification(tenantId, id) {
  assertId('clf', id);
  const rows = await db().query(
    'SELECT * FROM clarifications WHERE id=? AND tenant_id=?', [id, tenantId]);
  return normClf(rows[0]) || null;
}

export async function listClarifications(tenantId, pipelineRunId) {
  const rows = await db().query(
    'SELECT * FROM clarifications WHERE tenant_id=? AND pipeline_run_id=? ORDER BY created_at',
    [tenantId, pipelineRunId]);
  return rows.map(normClf);
}

export async function answerClarification(tenantId, id, { answer, answeredBy }) {
  const now = nowMs();
  await db().query(
    'UPDATE clarifications SET answer=?, answered_by=?, answered_at=? WHERE id=? AND tenant_id=?',
    [answer, answeredBy, now, id, tenantId]);
  return getClarification(tenantId, id);
}

// ---------- gate_exceptions（gex_）：门禁例外审批（复用 P6 审批语义） ----------
const normGex = (r) => r && { ...r, missing_items: parseJson(r.missing_items, []) };

export async function createGateException({ tenantId, projectId, pipelineRunId, stage,
  missingItems = [], reason = '', requestedBy }) {
  const id = newId('gex');
  const now = nowMs();
  await db().query(
    `INSERT INTO gate_exceptions(id,tenant_id,project_id,pipeline_run_id,stage,missing_items,reason,
      status,requested_by,decided_by,decided_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, projectId, pipelineRunId, stage, JSON.stringify(missingItems), reason,
      'pending', requestedBy, null, null, now]);
  return getGateException(tenantId, id);
}

export async function getGateException(tenantId, id) {
  assertId('gex', id);
  const rows = await db().query(
    'SELECT * FROM gate_exceptions WHERE id=? AND tenant_id=?', [id, tenantId]);
  return normGex(rows[0]) || null;
}

export async function listGateExceptions(tenantId, pipelineRunId, { status } = {}) {
  let sql = 'SELECT * FROM gate_exceptions WHERE tenant_id=? AND pipeline_run_id=?';
  const args = [tenantId, pipelineRunId];
  if (status) { sql += ' AND status=?'; args.push(status); }
  sql += ' ORDER BY created_at';
  return (await db().query(sql, args)).map(normGex);
}

/** 原子 CAS：只有 pending 的例外单能被决议（防并发双重决议，复用 P6 decideApproval 模式） */
export async function decideGateException(tenantId, id, { approved, decidedBy, reason }) {
  const now = nowMs();
  const upd = await db().run(
    `UPDATE gate_exceptions SET status=?, decided_by=?, reason=?, decided_at=?
     WHERE id=? AND tenant_id=? AND status='pending'`,
    [approved ? 'approved' : 'rejected', decidedBy, reason || null, now, id, tenantId]);
  if (upd.changes === 0) throw Errors.conflict('例外审批单已被处理（可能并发决议）');
  return getGateException(tenantId, id);
}
