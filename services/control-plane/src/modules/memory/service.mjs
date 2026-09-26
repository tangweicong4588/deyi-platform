/**
 * modules/memory/service.mjs —— V2.2-A：记忆服务（自研服务层 + PG 真相源）。
 *
 * 治理（方案要求）：
 * - 分层：episodic（情景/会话内事件）/ semantic（提炼事实）；
 * - 可见性：private（仅 owner）/ project（同项目可见）；跨租户不可见（tenant_id 硬隔离）；
 * - TTL：expires_at 过期 → recall 自动过滤 + sweep 标记 expired；
 * - 遗忘：forget 硬删 + 审计（memory.forgotten）；
 * - 事实提升：promote 只建 pending 提案，admin 审批后才 ingest 为 knowledge document；
 * - 审计：写入/遗忘/提升/审批全部进审计链（memory.*）。
 *
 * 向量召回（V2.2-B）：Qdrant 派生索引；本文件 recall 为 PG 关键词+权重排序实现。
 * Mem0/Graphiti 保留为外部记忆引擎扩展点（src/adapters/memory/）。
 */
import { db } from '../../db/index.mjs';
import { newId, nowMs } from '../../kernel/ids.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { logger } from '../../kernel/logging.mjs';
import { ctx, runWithContext, newTraceId } from '../../kernel/context.mjs';
import { tryAudit } from '../evidence/audit.mjs';
import { embedInternal } from '../gateway/routes.mjs';
import {
  upsertMemories, deleteMemories, searchMemories, getMemoryVectorStatus,
} from './vector.mjs';

const KINDS = ['episodic', 'semantic'];
const VIS = ['private', 'project'];

function cleanTags(tags) {
  if (!tags) return null;
  const arr = Array.isArray(tags) ? tags : [tags];
  const out = arr.map((t) => String(t).slice(0, 64)).filter(Boolean).slice(0, 20);
  return out.length ? JSON.stringify(out) : null;
}

function rowToPublic(r) {
  return {
    id: r.id, tenantId: r.tenant_id, projectId: r.project_id, actorId: r.actor_id,
    kind: r.kind, content: r.content, visibility: r.visibility,
    importance: r.importance, tags: r.tags ? JSON.parse(r.tags) : [],
    status: r.status, expiresAt: r.expires_at,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** 写入一条记忆 */
export async function remember(tenantId, { projectId = null, kind, content, visibility = 'project', importance = 0.5, tags = null, ttlMs = null }) {
  const c = ctx();
  const actorId = c.actorId || 'unknown';
  if (!KINDS.includes(kind)) throw Errors.badRequest(`kind 非法：${kind}`, { code: 'INVALID_KIND' });
  if (!VIS.includes(visibility)) throw Errors.badRequest(`visibility 非法：${visibility}`, { code: 'INVALID_VISIBILITY' });
  const text = String(content || '').trim();
  if (!text) throw Errors.badRequest('content 不能为空', { code: 'EMPTY_CONTENT' });
  if (text.length > 8000) throw Errors.badRequest('content 超过 8000 字符', { code: 'CONTENT_TOO_LONG' });
  const imp = Number(importance);
  if (!Number.isFinite(imp) || imp < 0 || imp > 1) throw Errors.badRequest('importance 必须在 0~1', { code: 'INVALID_IMPORTANCE' });
  const now = nowMs();
  const row = {
    id: newId('mem'), tenant_id: tenantId, project_id: projectId || null, actor_id: actorId,
    kind, content: text, visibility, importance: imp, tags: cleanTags(tags),
    status: 'active', expires_at: ttlMs ? now + Math.max(1, Number(ttlMs)) : null,
    created_at: now, updated_at: now,
  };
  await db().query(
    `INSERT INTO memories(id,tenant_id,project_id,actor_id,kind,content,visibility,importance,tags,status,expires_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [row.id, row.tenant_id, row.project_id, row.actor_id, row.kind, row.content, row.visibility,
     row.importance, row.tags, row.status, row.expires_at, row.created_at, row.updated_at]);
  await tryAudit({
    tenantId, projectId: row.project_id, actorId, action: 'memory.remember',
    resourceKind: 'memory', resourceId: row.id, payload: { kind, visibility, importance: imp },
  });
  logger.info('memory remembered', { tenantId, id: row.id, kind, visibility });
  // 向量索引是派生数据：best-effort，失败不影响写入（可用 reindexMemories 重建）
  indexMemoryVector(row).catch((e) =>
    logger.warn('memory vector index failed (best-effort)', { id: row.id, err: String(e?.message || e).slice(0, 200) }));
  return rowToPublic({ ...row });
}

/**
 * 单条记忆向量索引（派生数据，失败由调用方决定是否容忍）。
 * embedding 一律走网关（策略 + 预算 + 计量），绝不直连 provider。
 */
export async function indexMemoryVector(row) {
  const { vectors } = await embedInternal({
    input: row.content,
    project: row.project_id ? { id: row.project_id } : null,
    dataClass: 'internal',
  });
  if (!vectors?.[0]) throw new Error('embedding 上游未返回向量');
  return upsertMemories([{
    id: row.id, vector: vectors[0],
    payload: {
      tenant_id: row.tenant_id, memory_id: row.id,
      kind: row.kind, project_id: row.project_id,
    },
  }]);
}

/** 可见性过滤：private 只对 owner；project 对同项目（project_id 为空的记忆视为租户级，按 project 可见） */
function visibilityClause(actorId, isAdmin) {
  if (isAdmin) return { sql: '', params: [] };
  return {
    sql: ` AND (visibility='project' OR (visibility='private' AND actor_id=?))`,
    params: [actorId],
  };
}

function isExpired(r, now) {
  return r.expires_at != null && r.expires_at <= now;
}

/**
 * 召回。mode: 'auto'（默认）→ 有查询词时优先语义向量召回，失败回退关键词；
 * 'semantic' → 强制语义（embedding/索引失败则抛错，不静默回退）；
 * 'keyword' → PG 关键词 + importance/时间排序（V2.2-A 行为）。
 *
 * 向量只做召回：可见性（private/project）、过期、status 过滤一律在 DB 侧做。
 * 返回 { items: [publicRow(+score)], mode, engine }。
 */
export async function recall(tenantId, { q = '', kind = null, projectId = null, limit = 10, mode = 'auto', isAdmin = false } = {}) {
  const query = String(q || '').trim().slice(0, 200);
  if (mode === 'semantic' || (mode === 'auto' && query)) {
    try {
      return await recallSemantic(tenantId, { query, kind, projectId, limit, isAdmin });
    } catch (e) {
      if (mode === 'semantic') throw e;
      logger.warn('memory semantic recall failed, fallback to keyword', {
        tenantId, err: String(e?.message || e).slice(0, 200),
      });
    }
  }
  const items = await recallKeyword(tenantId, { q: query, kind, projectId, limit, isAdmin });
  return { items, mode: 'keyword', engine: 'pg' };
}

async function recallSemantic(tenantId, { query, kind, projectId, limit, isAdmin }) {
  const c = ctx();
  const actorId = c.actorId || 'unknown';
  const admin = isAdmin || c.authKind === 'operator';
  const n = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const { vectors } = await embedInternal({
    input: query, project: projectId ? { id: projectId } : null, dataClass: 'internal',
  });
  if (!vectors?.[0]) throw new Error('embedding 上游未返回向量');
  // 多召回一些，DB 侧过滤后再截断
  const hits = await searchMemories({ vector: vectors[0], filter: { tenant_id: tenantId }, limit: n * 3 });
  if (!hits.length) return { items: [], mode: 'semantic', engine: getMemoryVectorStatus() };
  const ids = [...new Set(hits.map((h) => h.memory_id))];
  const vis = visibilityClause(actorId, admin);
  const conds = [`tenant_id=?`, `status='active'`, `id IN (${ids.map(() => '?').join(',')})`];
  const params = [tenantId, ...ids];
  if (kind) {
    if (!KINDS.includes(kind)) throw Errors.badRequest(`kind 非法：${kind}`, { code: 'INVALID_KIND' });
    conds.push(`kind=?`); params.push(kind);
  }
  if (projectId) { conds.push(`project_id=?`); params.push(projectId); }
  const rows = await db().query(
    `SELECT * FROM memories WHERE ${conds.join(' AND ')}${vis.sql}`,
    [...params, ...vis.params]);
  const scoreOf = new Map(hits.map((h) => [h.memory_id, h.score]));
  const now = nowMs();
  const items = rows
    .filter((r) => !isExpired(r, now))
    .map((r) => ({ ...rowToPublic(r), score: scoreOf.get(r.id) ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
  return { items, mode: 'semantic', engine: hits[0]?.engine || getMemoryVectorStatus() };
}

/** PG 关键词召回（V2.2-A 行为；语义不可用时的回退） */
async function recallKeyword(tenantId, { q = '', kind = null, projectId = null, limit = 10, isAdmin = false } = {}) {
  const c = ctx();
  const actorId = c.actorId || 'unknown';
  const n = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const now = nowMs();
  const vis = visibilityClause(actorId, isAdmin || c.authKind === 'operator');
  const conds = [`tenant_id=?`, `status='active'`];
  const params = [tenantId];
  if (kind) {
    if (!KINDS.includes(kind)) throw Errors.badRequest(`kind 非法：${kind}`, { code: 'INVALID_KIND' });
    conds.push(`kind=?`); params.push(kind);
  }
  if (projectId) { conds.push(`project_id=?`); params.push(projectId); }
  const query = String(q || '').trim().slice(0, 200);
  if (query) { conds.push(`content LIKE ?`); params.push(`%${query.replace(/[%_]/g, '')}%`); }
  const rows = await db().query(
    `SELECT * FROM memories WHERE ${conds.join(' AND ')}${vis.sql}
     ORDER BY importance DESC, created_at DESC LIMIT ${n}`,
    [...params, ...vis.params]);
  // 过期懒过滤（物理标记由 sweep 完成）
  return rows.filter((r) => !isExpired(r, now)).map(rowToPublic);
}

/** 取单条（带可见性校验） */
async function getVisible(tenantId, memoryId, { isAdmin = false } = {}) {
  const c = ctx();
  const actorId = c.actorId || 'unknown';
  const rows = await db().query(`SELECT * FROM memories WHERE id=? AND tenant_id=?`, [memoryId, tenantId]);
  const r = rows[0];
  if (!r) throw Errors.notFound('记忆不存在');
  const admin = isAdmin || c.authKind === 'operator';
  if (!admin && r.visibility === 'private' && r.actor_id !== actorId) {
    throw Errors.forbidden('无权访问该记忆');
  }
  return r;
}

/**
 * 遗忘：硬删 + 审计。owner 或 admin 可执行（admin 可删他人 private，审计留痕操作人）。
 * 关联的 links 级联删除；已提升的 knowledge document 不受影响（知识库是独立真相）。
 */
export async function forgetMemory(tenantId, memoryId, { isAdmin = false } = {}) {
  const c = ctx();
  const actorId = c.actorId || 'unknown';
  const r = await getVisible(tenantId, memoryId, { isAdmin });
  const admin = isAdmin || c.authKind === 'operator';
  if (!admin && r.actor_id !== actorId) throw Errors.forbidden('只能删除自己的记忆（或租户 admin）');
  await db().transaction(async (tx) => {
    await tx.query(`DELETE FROM memory_links WHERE src_memory_id=? OR dst_memory_id=?`, [memoryId, memoryId]);
    await tx.query(`DELETE FROM memory_promotions WHERE memory_id=? AND status='pending'`, [memoryId]);
    await tx.query(`DELETE FROM memories WHERE id=?`, [memoryId]);
  });
  // 派生索引同步清理（best-effort）
  deleteMemories([memoryId]).catch((e) =>
    logger.warn('memory vector delete failed (best-effort)', { id: memoryId, err: String(e?.message || e).slice(0, 200) }));
  await tryAudit({
    tenantId, projectId: r.project_id, actorId, action: 'memory.forgotten',
    resourceKind: 'memory', resourceId: memoryId, payload: { kind: r.kind, byAdmin: admin && r.actor_id !== actorId },
  });
  logger.info('memory forgotten', { tenantId, id: memoryId });
  return { deleted: true, id: memoryId };
}

/** 记忆关联边（时序/语义图谱轻量实现） */
export async function linkMemories(tenantId, srcId, dstId, relation) {
  if (!['relates_to', 'contradicts', 'supersedes'].includes(relation)) {
    throw Errors.badRequest(`relation 非法：${relation}`, { code: 'INVALID_RELATION' });
  }
  if (srcId === dstId) throw Errors.badRequest('不能关联自己', { code: 'SELF_LINK' });
  const src = await getVisible(tenantId, srcId);
  await getVisible(tenantId, dstId);
  const id = newId('mlk');
  await db().query(
    `INSERT INTO memory_links(id,tenant_id,src_memory_id,dst_memory_id,relation,created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(tenant_id, src_memory_id, dst_memory_id, relation) DO NOTHING`,
    [id, tenantId, srcId, dstId, relation, nowMs()]);
  await tryAudit({
    tenantId, projectId: src.project_id, actorId: ctx().actorId || 'unknown',
    action: 'memory.linked', resourceKind: 'memory', resourceId: srcId,
    payload: { dst: dstId, relation },
  });
  return { id, srcId, dstId, relation };
}

/**
 * 事实提升：只建 pending 提案，不直接写知识库（防幻觉记忆污染业务真相源）。
 * 同一记忆的 pending 提案幂等复用。
 */
export async function proposePromotion(tenantId, memoryId, { projectId = null } = {}) {
  const c = ctx();
  const actorId = c.actorId || 'unknown';
  const r = await getVisible(tenantId, memoryId);
  if (r.status !== 'active') throw Errors.badRequest(`记忆状态 ${r.status} 不可提升`, { code: 'INVALID_STATUS' });
  if (isExpired(r, nowMs())) throw Errors.badRequest('记忆已过期，不可提升', { code: 'MEMORY_EXPIRED' });
  const existing = await db().query(
    `SELECT * FROM memory_promotions WHERE memory_id=? AND status='pending'`, [memoryId]);
  if (existing[0]) {
    return { id: existing[0].id, status: 'pending', deduped: true };
  }
  const id = newId('mpr');
  const now = nowMs();
  await db().query(
    `INSERT INTO memory_promotions(id,tenant_id,project_id,memory_id,content,status,proposed_by,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [id, tenantId, projectId || r.project_id, memoryId, r.content, 'pending', actorId, now]);
  await tryAudit({
    tenantId, projectId: r.project_id, actorId, action: 'memory.promote.proposed',
    resourceKind: 'memory_promotion', resourceId: id, payload: { memory_id: memoryId },
  });
  return { id, status: 'pending' };
}

/** 审批通过：ingest 为 knowledge document（来源可追溯），记忆标 promoted */
export async function approvePromotion(tenantId, promotionId) {
  const c = ctx();
  const actorId = c.actorId || 'unknown';
  const rows = await db().query(`SELECT * FROM memory_promotions WHERE id=? AND tenant_id=?`, [promotionId, tenantId]);
  const p = rows[0];
  if (!p) throw Errors.notFound('提升提案不存在');
  if (p.status !== 'pending') throw Errors.badRequest(`提案已${p.status}，不可重复审批`, { code: 'INVALID_STATUS' });
  const mem = (await db().query(`SELECT * FROM memories WHERE id=?`, [p.memory_id]))[0];
  if (!mem) throw Errors.badRequest('原记忆已被删除，提案作废', { code: 'MEMORY_GONE' });
  // 动态导入防循环依赖：memory → knowledge 单向依赖
  const { ingestDocument } = await import('../knowledge/service.mjs');
  const doc = await ingestDocument({
    tenantId, projectId: p.project_id, actorId,
    title: `记忆提升：${mem.kind}/${mem.id}`,
    content: p.content, mime: 'text/markdown',
    dataClass: 'internal', source: 'memory-promotion',
  });
  const documentId = doc.document.id;
  const now = nowMs();
  await db().transaction(async (tx) => {
    await tx.query(`UPDATE memory_promotions SET status='approved', reviewed_by=?, reviewed_at=? WHERE id=?`,
      [actorId, now, promotionId]);
    await tx.query(`UPDATE memories SET status='promoted', updated_at=? WHERE id=?`, [now, p.memory_id]);
  });
  await tryAudit({
    tenantId, projectId: p.project_id, actorId, action: 'memory.promote.approved',
    resourceKind: 'memory_promotion', resourceId: promotionId,
    payload: { memory_id: p.memory_id, document_id: documentId },
  });
  return { id: promotionId, status: 'approved', documentId };
}

/** 驳回提升提案 */
export async function rejectPromotion(tenantId, promotionId, { reason = '' } = {}) {
  const actorId = ctx().actorId || 'unknown';
  const rows = await db().query(`SELECT * FROM memory_promotions WHERE id=? AND tenant_id=?`, [promotionId, tenantId]);
  const p = rows[0];
  if (!p) throw Errors.notFound('提升提案不存在');
  if (p.status !== 'pending') throw Errors.badRequest(`提案已${p.status}，不可重复审批`, { code: 'INVALID_STATUS' });
  const now = nowMs();
  await db().query(`UPDATE memory_promotions SET status='rejected', reviewed_by=?, reviewed_at=? WHERE id=?`,
    [actorId, now, promotionId]);
  await tryAudit({
    tenantId, projectId: p.project_id, actorId, action: 'memory.promote.rejected',
    resourceKind: 'memory_promotion', resourceId: promotionId,
    payload: { memory_id: p.memory_id, reason: String(reason).slice(0, 200) },
  });
  return { id: promotionId, status: 'rejected' };
}

/** 列出提升提案（运营/审批视图） */
export async function listPromotions(tenantId, { status = null, limit = 50 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const conds = [`tenant_id=?`]; const params = [tenantId];
  if (status) { conds.push(`status=?`); params.push(status); }
  const rows = await db().query(
    `SELECT * FROM memory_promotions WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT ${n}`, params);
  return rows.map((p) => ({
    id: p.id, tenantId: p.tenant_id, projectId: p.project_id, memoryId: p.memory_id,
    content: p.content, status: p.status, proposedBy: p.proposed_by, reviewedBy: p.reviewed_by,
    createdAt: p.created_at, reviewedAt: p.reviewed_at,
  }));
}

/**
 * TTL 扫荡：把过期的 active 记忆标为 expired（recall 本就过滤过期，这里做物理标记）。
 * 由 operator 手动触发或未来定时任务调用；返回处理条数。
 */
export async function sweepExpired(tenantId = null) {
  const now = nowMs();
  const conds = [`status='active'`, `expires_at IS NOT NULL`, `expires_at<=?`];
  const params = [now];
  if (tenantId) { conds.push(`tenant_id=?`); params.push(tenantId); }
  const rows = await db().query(`SELECT id, tenant_id FROM memories WHERE ${conds.join(' AND ')}`, params);
  for (const r of rows) {
    await db().query(`UPDATE memories SET status='expired', updated_at=? WHERE id=? AND status='active'`, [now, r.id]);
  }
  if (rows.length) {
    logger.info('memory sweep expired', { count: rows.length, tenantId: tenantId || '*' });
    // 过期记忆移出向量索引（best-effort）
    deleteMemories(rows.map((r) => r.id)).catch((e) =>
      logger.warn('memory vector sweep delete failed (best-effort)', { err: String(e?.message || e).slice(0, 200) }));
  }
  return { swept: rows.length };
}

/**
 * 向量索引重建：从 DB（真相源）全量重建 deyi_memory 派生索引。
 * 只读 active 记忆、只写向量索引，不改写任何业务行（幂等，可重复跑）。
 * 按租户进 runWithContext（embedding 计量正确归属租户）。
 * 由 scripts/rebuild-memory-index.mjs 或 operator 路由调用。
 */
export async function reindexMemories({ tenantId = null, batch = 32 } = {}) {
  const tenants = tenantId
    ? [{ id: tenantId }]
    : await db().query(`SELECT DISTINCT tenant_id AS id FROM memories WHERE status='active'`);
  let indexed = 0, failed = 0, total = 0;
  for (const t of tenants) {
    const r = await runWithContext({
      traceId: newTraceId(), tenantId: t.id,
      actorId: 'system:rebuild-memory-index', actorKind: 'system', authKind: 'system',
    }, () => reindexTenantMemories(t.id, batch));
    indexed += r.indexed; failed += r.failed; total += r.total;
  }
  logger.info('memory reindex done', { indexed, failed, total, tenantId: tenantId || '*' });
  return { indexed, failed, total, engine: getMemoryVectorStatus() };
}

async function reindexTenantMemories(tenantId, batch) {
  const rows = await db().query(
    `SELECT * FROM memories WHERE tenant_id=? AND status='active' ORDER BY created_at`, [tenantId]);
  let indexed = 0, failed = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    try {
      const { vectors } = await embedInternal({
        input: chunk.map((r) => r.content), project: null, dataClass: 'internal',
      });
      if (!vectors || vectors.length !== chunk.length) throw new Error('embedding 数量不一致');
      await upsertMemories(chunk.map((r, j) => ({
        id: r.id, vector: vectors[j],
        payload: { tenant_id: r.tenant_id, memory_id: r.id, kind: r.kind, project_id: r.project_id },
      })));
      indexed += chunk.length;
    } catch (e) {
      failed += chunk.length;
      logger.warn('memory reindex batch failed', { tenantId, err: String(e?.message || e).slice(0, 200) });
    }
  }
  return { indexed, failed, total: rows.length };
}
