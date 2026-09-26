/**
 * modules/ontology/service.mjs —— 本体服务（控制面自研资产编排）。
 *
 * 状态机：candidate → in_review → published → deprecated
 *         candidate/in_review → rejected → in_review（驳回后重新评审）
 *         in_review → candidate（打回）
 * 发布是特权动作：路由层走策略 decide('ontology.publish')（operator+，
 * 带 review_required 义务），service 层再强制"必须经过 in_review"，
 * 纵深防御：即使策略误放行也发不出去未经评审的术语。
 */
import { Errors } from '../../kernel/errors.mjs';
import { db } from '../../db/index.mjs';
import { logger } from '../../kernel/logging.mjs';
import * as store from './store.mjs';

const TRANSITIONS = {
  candidate: ['in_review', 'rejected'],
  in_review: ['published', 'rejected', 'candidate'],
  published: ['deprecated'],
  deprecated: [],
  rejected: ['in_review'], // 驳回后可修改并重新进入评审
};

function checkTransition(from, to) {
  if (!(TRANSITIONS[from] || []).includes(to)) {
    throw Errors.badRequest(`非法状态跃迁: ${from} → ${to}`, { code: 'INVALID_TRANSITION' });
  }
}

async function mustGet(tenantId, termId) {
  const t = await store.getTerm(tenantId, termId);
  if (!t) throw Errors.notFound('本体术语不存在');
  return t;
}

/** 冲突检测：同名（归一化）+ 定义高度重叠；命中则建 open 冲突（去重）。
 *  版本链场景：新版本与被替代的旧版本（supersedes 目标）不算冲突。 */
export async function detectConflicts(tenantId, projectId, term) {
  const created = [];
  const isSuperseded = (otherId) => term.supersedes_id && otherId === term.supersedes_id;
  for (const dup of await store.findSameName(tenantId, projectId, term.name_norm, term.id)) {
    if (isSuperseded(dup.id)) continue;
    created.push(await store.createConflict({
      tenantId, projectId, termId: term.id, conflictingTermId: dup.id, reason: 'duplicate_name',
    }));
  }
  for (const { term: ov } of await store.findOverlapping(tenantId, projectId, term.kind, term.definition, term.id)) {
    if (isSuperseded(ov.id)) continue;
    created.push(await store.createConflict({
      tenantId, projectId, termId: term.id, conflictingTermId: ov.id, reason: 'overlapping_definition',
    }));
  }
  if (created.length) logger.warn('ontology conflict detected', { term: term.id, n: created.length });
  return created;
}

export async function submitCandidate({ tenantId, projectId, name, kind, definition, evidence, supersedesId, actorId }) {
  if (!name || !String(name).trim()) throw Errors.badRequest('name 必填');
  if (!store.KINDS.has(kind)) throw Errors.badRequest('kind 非法（concept|relation|attribute）');
  let supersedes = null;
  if (supersedesId) {
    supersedes = await mustGet(tenantId, supersedesId);
    if (supersedes.project_id !== projectId) throw Errors.badRequest('supersedes 术语必须属于同一项目');
    if (supersedes.status !== 'published') throw Errors.badRequest('只能基于已发布的术语发新版本');
  }
  const term = await store.createTerm({
    tenantId, projectId, name, kind, definition,
    evidence: evidence || [], supersedesId: supersedes ? supersedes.id : null, createdBy: actorId,
  });
  const conflicts = await detectConflicts(tenantId, projectId, term);
  return { term, conflicts };
}

export async function startReview({ tenantId, termId }) {
  const t = await mustGet(tenantId, termId);
  checkTransition(t.status, 'in_review');
  const conflicts = await detectConflicts(tenantId, t.project_id, t); // 评审时复检（期间可能新增冲突术语）
  return { term: await store.setStatus(tenantId, termId, 'in_review'), conflicts };
}

export async function rejectTerm({ tenantId, termId, reason }) {
  const t = await mustGet(tenantId, termId);
  checkTransition(t.status, 'rejected');
  if (!reason) throw Errors.badRequest('驳回需给出 reason');
  return store.setStatus(tenantId, termId, 'rejected');
}

/**
 * 发布。要求：in_review 状态；无 open 冲突；如带 supersedes_id 则旧版本自动 deprecated。
 * （调用方=路由层必须先过 decide('ontology.publish')，这里是第二道锁。）
 */
export async function publishTerm({ tenantId, termId, actorId }) {
  const t = await mustGet(tenantId, termId);
  checkTransition(t.status, 'published');
  const open = await store.openConflictsFor(tenantId, termId);
  if (open.length) {
    throw Errors.conflict('存在未裁决的术语冲突，发布被阻塞', {
      code: 'ONTOLOGY_CONFLICT_BLOCKED', conflicts: open.map((c) => c.id),
    });
  }
  let deprecatedOld = null;
  if (t.supersedes_id) {
    const old = await mustGet(tenantId, t.supersedes_id);
    if (old.status !== 'published') throw Errors.badRequest('被替代的旧版本状态异常');
    deprecatedOld = await store.setStatus(tenantId, old.id, 'deprecated');
  }
  const term = await store.setStatus(tenantId, termId, 'published');
  logger.info('ontology published', { term: term.id, version: term.version, by: actorId });
  return { term, deprecatedOld };
}

export async function deprecateTerm({ tenantId, termId }) {
  const t = await mustGet(tenantId, termId);
  checkTransition(t.status, 'deprecated');
  return store.setStatus(tenantId, termId, 'deprecated');
}

/**
 * 冲突裁决（operator）。策略：
 * - keep：双方共存，冲突关闭；
 * - supersede：将 conflicting_term（旧/被替代方）置 deprecated，term 可继续发布；
 * - merge：将本 term 置 deprecated（并入对方），冲突关闭。
 *
 * 注意：这里的 deprecated 是"治理覆盖"（governance override），不经过 TRANSITIONS
 * 生命周期——operator 裁决本身就是终局治理动作（含审计日志），等价于"因重复而撤回"。
 * 从未发布的术语被 deprecated 视为撤回，不进入版本链。
 */
export async function resolveConflict({ tenantId, conflictId, strategy, note, actorId }) {
  if (!['keep', 'merge', 'supersede'].includes(strategy)) throw Errors.badRequest('strategy 非法（keep|merge|supersede）');
  const c = await store.getConflict(tenantId, conflictId);
  if (!c) throw Errors.notFound('冲突不存在');
  if (c.status !== 'open') throw Errors.badRequest('冲突已裁决');
  let deprecatedTerm = null;
  if (strategy === 'merge') {
    const t = await mustGet(tenantId, c.term_id);
    if (t.status === 'published') throw Errors.badRequest('merge 不能废止已发布术语，请先走版本链');
    deprecatedTerm = await store.setStatus(tenantId, t.id, 'deprecated');
  } else if (strategy === 'supersede') {
    const t = await mustGet(tenantId, c.conflicting_term_id);
    if (!['published', 'in_review', 'candidate'].includes(t.status)) throw Errors.badRequest('被替代方状态异常');
    deprecatedTerm = await store.setStatus(tenantId, t.id, 'deprecated');
  }
  const conflict = await store.resolveConflictRow(tenantId, conflictId, { strategy, note, resolvedBy: actorId });
  logger.info('ontology conflict resolved', { conflict: conflictId, strategy, by: actorId });
  return { conflict, deprecatedTerm };
}

/**
 * 影响分析（MVP 启发式）：找出同项目 facts/documents 中文本提及该术语名的条目，
 * 供废止/改名前确认。精确的术语—事实引用关系在后续版本增强。
 */
export async function impactAnalysis({ tenantId, projectId, termId, limit = 100 }) {
  const t = await mustGet(tenantId, termId);
  if (t.project_id !== projectId) throw Errors.notFound('本体术语不存在');
  const like = `%${t.name.trim()}%`;
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const facts = await db().query(
    `SELECT id, document_id, chunk_index, status FROM facts
     WHERE tenant_id=? AND project_id=? AND status='active' AND content LIKE ? LIMIT ${n}`,
    [tenantId, projectId, like]);
  const docIds = [...new Set(facts.map((f) => f.document_id))];
  let documents = [];
  if (docIds.length) {
    const ph = docIds.map(() => '?').join(',');
    documents = await db().query(
      `SELECT id, title, status FROM documents WHERE id IN (${ph})`, docIds);
  }
  return { term: t, facts, documents, chain: await store.versionChain(tenantId, termId) };
}

export { store };
