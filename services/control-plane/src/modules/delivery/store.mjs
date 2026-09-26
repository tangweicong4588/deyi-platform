/**
 * modules/delivery/store.mjs —— 交付域真相源 CRUD（带租户隔离条件）。
 * 状态机在 service.mjs，这里只做数据访问。
 */
import { newId, nowMs, assertId } from '../../kernel/ids.mjs';
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
