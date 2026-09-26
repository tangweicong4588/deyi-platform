/**
 * modules/delivery/service.mjs —— 交付域业务逻辑：状态机强制 + 跨实体校验。
 *
 * 需求状态机：draft → clarifying → ready → in_progress → verifying → done
 *             clarifying ⇄ draft（打回澄清）；verifying → in_progress（验证不通过打回）
 *             cancelled 可从非 done 的任何状态进入。
 * AC 状态机：pending → passed | failed | waived；failed/passed/waived → pending（重测/重开）
 * 变更包：draft → building → verifying → ready_for_review → handed_over
 * 流水线：pending → running → gated → passed | failed；running → failed
 */
import { Errors } from '../../kernel/errors.mjs';
import { tryAudit } from '../evidence/audit.mjs';
import * as store from './store.mjs';

const REQ_TRANSITIONS = {
  draft: ['clarifying', 'cancelled'],
  clarifying: ['ready', 'draft', 'cancelled'],
  ready: ['in_progress', 'cancelled'],
  in_progress: ['verifying', 'cancelled'],
  verifying: ['done', 'in_progress', 'cancelled'],
  done: [],
  cancelled: [],
};
const AC_TRANSITIONS = {
  pending: ['passed', 'failed', 'waived'],
  passed: ['pending'],
  failed: ['pending'],
  waived: ['pending'],
};
const CHG_TRANSITIONS = {
  draft: ['building', 'cancelled'],
  building: ['verifying', 'cancelled'],
  verifying: ['ready_for_review', 'cancelled'],
  ready_for_review: ['handed_over', 'cancelled'],
  handed_over: [],
  cancelled: [],
};
const PIPE_TRANSITIONS = {
  pending: ['running', 'cancelled'],
  running: ['gated', 'failed', 'cancelled'],
  gated: ['passed', 'failed', 'cancelled'],
  passed: [],
  failed: ['pending'], // 失败后可重跑（新状态回到 pending）
  cancelled: [],
};

const checkTransition = (map, from, to, label) => {
  if (!(map[from] || []).includes(to)) {
    throw Errors.badRequest(`${label} 非法状态跃迁: ${from} → ${to}`, { code: 'INVALID_TRANSITION' });
  }
};

const HASH_RE = /^[0-9a-f]{64}$/i;
/** repo binding 请求体里禁止出现任何疑似明文凭据字段（密钥铁律） */
const SECRET_FIELD_RE = /(password|passwd|secret|token|api[_-]?key|credential|private[_-]?key)/i;
export function rejectPlaintextSecrets(body) {
  if (!body || typeof body !== 'object') return;
  for (const k of Object.keys(body)) {
    const norm = String(k).toLowerCase().replace(/[_-]/g, '');
    if (norm === 'credentialref') continue; // vault 引用是合法字段
    if (SECRET_FIELD_RE.test(k)) {
      throw Errors.badRequest(`禁止提交明文凭据字段: ${k}（请使用 credential_ref 引用 vault）`, { code: 'PLAINTEXT_SECRET' });
    }
  }
}

// ---------- requirements ----------
export async function createRequirement({ tenantId, projectId, actorId, body }) {
  const { title, kind = 'feature', scopeMd, nonGoalsMd, priority = 'p2', riskLevel = 'low',
    repro, sourceRefs, ontologyTermIds } = body || {};
  if (!title || !String(title).trim()) throw Errors.badRequest('title 必填');
  if (!store.REQ_KINDS.has(kind)) throw Errors.badRequest(`kind 非法: ${kind}`);
  if (!store.PRIORITIES.has(priority)) throw Errors.badRequest(`priority 非法: ${priority}`);
  if (!store.RISK_LEVELS.has(riskLevel)) throw Errors.badRequest(`riskLevel 非法: ${riskLevel}`);
  return store.createRequirement({
    tenantId, projectId, title, kind, scopeMd, nonGoalsMd, priority,
    riskLevel, repro, sourceRefs, ontologyTermIds, createdBy: actorId,
  });
}

export async function getRequirement(tenantId, projectId, id) {
  const r = await store.getRequirement(tenantId, id).catch(() => null);
  if (!r || r.project_id !== projectId) throw Errors.notFound('需求不存在');
  return r;
}

export async function patchRequirement(tenantId, projectId, id, actorId, body) {
  const r = await getRequirement(tenantId, projectId, id);
  const patch = {};
  if (body.title !== undefined) {
    if (!String(body.title).trim()) throw Errors.badRequest('title 不能为空');
    patch.title = String(body.title).trim();
  }
  if (body.kind !== undefined) {
    if (!store.REQ_KINDS.has(body.kind)) throw Errors.badRequest(`kind 非法: ${body.kind}`);
    patch.kind = body.kind;
  }
  if (body.priority !== undefined) {
    if (!store.PRIORITIES.has(body.priority)) throw Errors.badRequest(`priority 非法: ${body.priority}`);
    patch.priority = body.priority;
  }
  if (body.riskLevel !== undefined) {
    if (!store.RISK_LEVELS.has(body.riskLevel)) throw Errors.badRequest(`riskLevel 非法: ${body.riskLevel}`);
    patch.risk_level = body.riskLevel;
  }
  for (const [src, dst] of [['scopeMd', 'scope_md'], ['nonGoalsMd', 'non_goals_md']]) {
    if (body[src] !== undefined) patch[dst] = String(body[src]);
  }
  if (body.repro !== undefined) patch.repro = body.repro || {};
  if (body.sourceRefs !== undefined) patch.source_refs = body.sourceRefs || [];
  if (body.ontologyTermIds !== undefined) patch.ontology_term_ids = body.ontologyTermIds || [];
  return store.updateRequirement(tenantId, id, patch);
}

export async function transitionRequirement(tenantId, projectId, id, to) {
  const r = await getRequirement(tenantId, projectId, id);
  if (!store.REQ_STATUSES.has(to)) throw Errors.badRequest(`status 非法: ${to}`);
  checkTransition(REQ_TRANSITIONS, r.status, to, '需求');
  // 门禁：进入 verifying 要求全部 AC 已通过/豁免
  if (to === 'verifying' && !(await store.allACsAccepted(tenantId, id))) {
    throw Errors.badRequest('存在未通过的验收标准，无法进入验证阶段', { code: 'AC_NOT_ACCEPTED' });
  }
  const out = await store.setRequirementStatus(tenantId, id, to);
  // 需求发布（ready）接入 P7 审计链（best-effort）
  if (to === 'ready') {
    await tryAudit({
      tenantId, projectId, action: 'requirement.publish',
      resourceKind: 'requirement', resourceId: id,
      payload: { status: 'ready', kind: r.kind, priority: r.priority },
    });
  }
  return out;
}

// ---------- acceptance criteria ----------
export async function addAC(tenantId, projectId, requirementId, body) {
  await getRequirement(tenantId, projectId, requirementId); // 归属校验
  const { givenMd = '', whenMd = '', thenMd = '', kind = 'auto' } = body || {};
  if (!store.AC_KINDS.has(kind)) throw Errors.badRequest(`kind 非法: ${kind}`);
  if (!String(thenMd).trim()) throw Errors.badRequest('then（期望结果）必填');
  return store.createAC({ tenantId, requirementId, givenMd, whenMd, thenMd, kind });
}

export async function getAC(tenantId, projectId, requirementId, acId) {
  await getRequirement(tenantId, projectId, requirementId);
  const a = await store.getAC(tenantId, acId).catch(() => null);
  if (!a || a.requirement_id !== requirementId) throw Errors.notFound('验收标准不存在');
  return a;
}

export async function transitionAC(tenantId, projectId, requirementId, acId, to, evidenceRef) {
  const a = await getAC(tenantId, projectId, requirementId, acId);
  if (!store.AC_STATUSES.has(to)) throw Errors.badRequest(`status 非法: ${to}`);
  checkTransition(AC_TRANSITIONS, a.status, to, '验收标准');
  return store.setACStatus(tenantId, acId, to, evidenceRef || null);
}

// ---------- repo bindings ----------
export async function bindRepo(tenantId, projectId, body) {
  rejectPlaintextSecrets(body);
  const { provider, remoteUrl, defaultBranch = 'main', credentialRef = null } = body || {};
  if (!store.REPO_PROVIDERS.has(provider)) throw Errors.badRequest(`provider 非法: ${provider}`);
  if (!remoteUrl || !String(remoteUrl).trim()) throw Errors.badRequest('remoteUrl 必填');
  return store.createRepoBinding({ tenantId, projectId, provider, remoteUrl, defaultBranch, credentialRef });
}

export async function getRepoBinding(tenantId, projectId, id) {
  const b = await store.getRepoBinding(tenantId, id).catch(() => null);
  if (!b || b.project_id !== projectId) throw Errors.notFound('仓库绑定不存在');
  return b;
}

// ---------- change packages ----------
export async function createChangePackage({ tenantId, projectId, actorId, body }) {
  const { requirementId, branch, baseCommit = '', headCommit = '', dodChecklist = {} } = body || {};
  if (!requirementId) throw Errors.badRequest('requirementId 必填');
  await getRequirement(tenantId, projectId, requirementId); // 归属校验
  if (!branch || !String(branch).trim()) throw Errors.badRequest('branch 必填');
  return store.createChangePackage({
    tenantId, projectId, requirementId, branch, baseCommit, headCommit, dodChecklist, createdBy: actorId,
  });
}

export async function getChangePackage(tenantId, projectId, id) {
  const c = await store.getChangePackage(tenantId, id).catch(() => null);
  if (!c || c.project_id !== projectId) throw Errors.notFound('变更包不存在');
  return c;
}

export async function transitionChangePackage(tenantId, projectId, id, to, headCommit) {
  const c = await getChangePackage(tenantId, projectId, id);
  if (!store.CHG_STATUSES.has(to)) throw Errors.badRequest(`status 非法: ${to}`);
  checkTransition(CHG_TRANSITIONS, c.status, to, '变更包');
  const out = await store.setChangePackageStatus(tenantId, id, to, headCommit || null);
  // 变更包移交（ready_for_review）接入 P7 审计链（best-effort）
  if (to === 'ready_for_review') {
    await tryAudit({
      tenantId, projectId, action: 'change_package.handover',
      resourceKind: 'change_package', resourceId: id,
      payload: { status: 'ready_for_review', branch: c.branch, head_commit: headCommit || c.head_commit },
    });
  }
  return out;
}

// ---------- artifacts ----------
export async function registerArtifact(tenantId, projectId, changePackageId, body) {
  await getChangePackage(tenantId, projectId, changePackageId); // 归属校验
  const { kind, contentHash, uri = '', signature = null } = body || {};
  if (!store.ART_KINDS.has(kind)) throw Errors.badRequest(`kind 非法: ${kind}`);
  if (!contentHash || !HASH_RE.test(String(contentHash))) {
    throw Errors.badRequest('contentHash 必填且必须为 sha256 十六进制（64 位）', { code: 'INVALID_HASH' });
  }
  return store.createArtifact({ tenantId, changePackageId, kind, contentHash, uri, signature });
}

// ---------- pipeline runs（静态模型） ----------
export async function createPipelineRun({ tenantId, projectId, body }) {
  const { changePackageId = null, stage } = body || {};
  if (!store.PIPE_STAGES.has(stage)) throw Errors.badRequest(`stage 非法: ${stage}`);
  if (changePackageId) await getChangePackage(tenantId, projectId, changePackageId);
  return store.createPipelineRun({ tenantId, projectId, changePackageId, stage });
}

export async function getPipelineRun(tenantId, projectId, id) {
  const p = await store.getPipelineRun(tenantId, id).catch(() => null);
  if (!p || p.project_id !== projectId) throw Errors.notFound('流水线运行不存在');
  return p;
}

export async function transitionPipelineRun(tenantId, projectId, id, to, gateDecision) {
  const p = await getPipelineRun(tenantId, projectId, id);
  if (!store.PIPE_STATUSES.has(to)) throw Errors.badRequest(`status 非法: ${to}`);
  checkTransition(PIPE_TRANSITIONS, p.status, to, '流水线运行');
  // 门禁防绕过：已绑定变更包的编排运行，其 passed/gated 只能经 advanceStage 门禁产生，
  // 不允许经静态 PATCH 直接改写（无变更包绑定的 V1.0-A 静态记录不受影响）。
  if (p.change_package_id && (to === 'passed' || to === 'gated')) {
    throw Errors.badRequest('编排中的流水线阶段必须经 advance 门禁推进，不能直接改状态',
      { code: 'GATE_BYPASS_DENIED' });
  }
  const patch = { status: to };
  if (to === 'running' && !p.started_at) patch.startedAt = Date.now();
  if (['passed', 'failed', 'cancelled'].includes(to) && !p.finished_at) patch.finishedAt = Date.now();
  if (gateDecision !== undefined) patch.gateDecision = gateDecision;
  return store.setPipelineRun(tenantId, id, patch);
}

export { store };
