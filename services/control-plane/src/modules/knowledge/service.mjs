/**
 * modules/knowledge/service.mjs —— 知识服务（控制面真相源编排）。
 *
 * - DB（documents/canonical_docs/facts/acl_entries）是真相源；Qdrant 是可重建派生索引。
 * - embedding 一律走网关 embedInternal（策略 + 预算 + 计量），绝不直连 provider。
 * - 版本链：重解析生成新 canonical_doc（version+1），旧 facts 标记 superseded 并删向量。
 * - ACL：ingest 默认授予所属项目 read；shareDocument 可显式授权给同租户其他项目。
 */
import { newId, nowMs } from '../../kernel/ids.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { db } from '../../db/index.mjs';
import { parseDocument, contentHash } from './docling.mjs';
import { upsertChunks, deleteChunks, searchChunks } from './vector.mjs';
import { embedInternal } from '../gateway/routes.mjs';
import { getProject } from '../identity/store.mjs';
import { tryAudit } from '../evidence/audit.mjs';
import { logger } from '../../kernel/logging.mjs';

const CHUNK_SIZE = 600;      // 字符
const EMBED_BATCH = 16;

/**
 * 切分：先按空行切段落并记录每个段落在原文中的精确 [start, end)，
 * 再贪心组块。span 精确可回溯（重复文本也不会错位），块与块首尾相接不重叠。
 * （跨块 overlap 是检索质量调优点，V0.5 先保证切分正确性，暂不做。）
 */
export function chunkText(markdown) {
  const paras = [];
  const re = /(.+?)(?=\n\s*\n|$)/gs;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    const text = m[1].trim();
    if (!text) continue;
    const start = markdown.indexOf(text, m.index); // m.index 递增，重复段落也能定位到各自位置
    paras.push({ text, start, end: start + text.length });
  }
  const chunks = [];
  let cur = [], curLen = 0;
  const flush = () => {
    if (!cur.length) return;
    chunks.push({
      index: chunks.length,
      text: cur.map((p) => p.text).join('\n\n'),
      span: { start: cur[0].start, end: cur[cur.length - 1].end },
    });
    cur = []; curLen = 0;
  };
  for (const p of paras) {
    if (p.text.length > CHUNK_SIZE) {
      flush();
      for (let i = 0; i < p.text.length; i += CHUNK_SIZE) { // 超长单段硬切
        const t = p.text.slice(i, i + CHUNK_SIZE);
        chunks.push({ index: chunks.length, text: t, span: { start: p.start + i, end: p.start + i + t.length } });
      }
      continue;
    }
    const addLen = (cur.length ? 2 : 0) + p.text.length;
    if (cur.length && curLen + addLen > CHUNK_SIZE) flush();
    cur.push(p);
    curLen += addLen;
  }
  flush();
  return chunks;
}

async function getDocumentRow(tenantId, documentId) {
  const rows = await db().query('SELECT * FROM documents WHERE id=? AND tenant_id=?', [documentId, tenantId]);
  return rows[0] || null;
}

export async function getDocument(tenantId, documentId) {
  const d = await getDocumentRow(tenantId, documentId);
  if (!d) throw Errors.notFound('文档不存在');
  const { raw_content, ...pub } = d; // 原始内容不对检索 API 暴露
  return pub;
}

export async function listDocuments(tenantId, projectId) {
  // 管理视角：本项目全部文档（含 processing/failed，便于排查）+ 共享给本项目的 ready 文档
  const rows = await db().query(
    `SELECT id, tenant_id, project_id, title, source, mime, data_class, status, fail_reason, created_by, created_at, updated_at
     FROM documents WHERE tenant_id=? AND project_id=? ORDER BY created_at DESC LIMIT 500`,
    [tenantId, projectId]);
  const seen = new Set(rows.map((r) => r.id));
  const extra = (await visibleDocumentIds(tenantId, projectId)).filter((id) => !seen.has(id));
  if (extra.length) {
    const placeholders = extra.map(() => '?').join(',');
    const shared = await db().query(
      `SELECT id, tenant_id, project_id, title, source, mime, data_class, status, fail_reason, created_by, created_at, updated_at
       FROM documents WHERE id IN (${placeholders})`, extra);
    rows.push(...shared);
    rows.sort((a, b) => b.created_at - a.created_at);
  }
  return rows.slice(0, 500);
}

/** 可见文档 ID：本项目 ready 文档 + 显式共享给本项目的文档 */
export async function visibleDocumentIds(tenantId, projectId) {
  // MVP 上限 2000：超大规模租户需要分页/游标或把可见项目反范式化进向量 payload
  const own = await db().query(
    `SELECT id FROM documents WHERE tenant_id=? AND project_id=? AND status='ready' LIMIT 2000`,
    [tenantId, projectId]);
  const shared = await db().query(
    `SELECT d.id FROM documents d JOIN acl_entries a
       ON a.resource_kind='document' AND a.resource_id=d.id
     WHERE a.tenant_id=? AND a.grantee_kind='project' AND a.grantee_id=?
       AND a.permission='read' AND d.tenant_id=? AND d.status='ready' LIMIT 2000`,
    [tenantId, projectId, tenantId]);
  return [...new Set([...own, ...shared].map((r) => r.id))].slice(0, 2000);
}

async function grantRead(tenantId, documentId, granteeKind, granteeId, actorId) {
  const exists = await db().query(
    `SELECT id FROM acl_entries WHERE resource_kind='document' AND resource_id=?
     AND grantee_kind=? AND grantee_id=? AND permission='read'`,
    [documentId, granteeKind, granteeId]);
  if (exists[0]) return exists[0];
  const row = {
    id: newId('acl'), tenant_id: tenantId, resource_kind: 'document', resource_id: documentId,
    grantee_kind: granteeKind, grantee_id: granteeId, permission: 'read',
    created_by: actorId, created_at: nowMs(),
  };
  await db().query(
    `INSERT INTO acl_entries(id, tenant_id, resource_kind, resource_id, grantee_kind, grantee_id, permission, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [row.id, row.tenant_id, row.resource_kind, row.resource_id, row.grantee_kind, row.grantee_id, row.permission, row.created_by, row.created_at]);
  return row;
}

/** 对一批 chunk 做 embedding→索引→建 facts（内部复用，ingest/reparse 共用） */
async function indexChunks({ tenantId, projectId, documentId, canonicalId, chunks, dataClass }) {
  const project = { id: projectId };
  const factRows = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    const { vectors } = await embedInternal({
      input: batch.map((c) => c.text), project, dataClass,
    });
    if (!vectors || vectors.length !== batch.length) {
      throw Errors.upstream('embedding 上游返回数量与请求不一致', { expected: batch.length, got: vectors?.length });
    }
    const ups = batch.map((c, j) => {
      const factId = newId('fct');
      factRows.push({
        id: factId, canonical_doc_id: canonicalId, document_id: documentId,
        tenant_id: tenantId, project_id: projectId, chunk_index: c.index,
        content: c.text, source_span: JSON.stringify(c.span),
        embedding_model: 'deyi-embedding', status: 'active', created_at: nowMs(),
      });
      return {
        id: factId, vector: vectors[j],
        payload: { tenant_id: tenantId, project_id: projectId, document_id: documentId, fact_id: factId, chunk_index: c.index },
      };
    });
    const { engine } = await upsertChunks(ups);
    await db().transaction(async (tx) => {
      for (const f of factRows.slice(-batch.length)) {
        await tx.query(
          `INSERT INTO facts(id, canonical_doc_id, document_id, tenant_id, project_id, chunk_index,
           content, source_span, embedding_model, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [f.id, f.canonical_doc_id, f.document_id, f.tenant_id, f.project_id, f.chunk_index,
           f.content, f.source_span, f.embedding_model, f.status, f.created_at]);
      }
    });
    logger.debug('knowledge chunks indexed', { documentId, batch: batch.length, engine });
  }
  return factRows;
}

async function markFailed(documentId, reason) {
  await db().query(`UPDATE documents SET status='failed', fail_reason=?, updated_at=? WHERE id=?`,
    [reason, nowMs(), documentId]);
}

/**
 * ingest：建 document → 解析 → 切分 → embedding(网关) → 索引 → facts → 默认 ACL。
 * MVP 同步执行；解析失败则 document 标记 failed 并抛 400（不伪造内容）。
 */
export async function ingestDocument({ tenantId, projectId, actorId, title, content, mime = 'text/markdown', dataClass = 'internal', source = 'upload' }) {
  if (!title || !content) throw Errors.badRequest('title / content 必填');
  const docId = newId('doc');
  await db().query(
    `INSERT INTO documents(id, tenant_id, project_id, title, source, mime, data_class, status, raw_content, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,'processing',?,?,?,?)`,
    [docId, tenantId, projectId, title, source, mime, dataClass, content, actorId, nowMs(), nowMs()]);

  const parsed = await parseDocument({ mime, content, filename: title });
  if (!parsed.ok) {
    await markFailed(docId, parsed.reason);
    throw Errors.badRequest(`文档解析失败：${parsed.reason}`);
  }
  const hash = contentHash(parsed.markdown);
  const cndId = newId('cnd');
  await db().query(
    `INSERT INTO canonical_docs(id, document_id, tenant_id, project_id, version, content, content_hash, parse_engine, created_at)
     VALUES (?,?,?,?,?, ?,?,?,?)`,
    [cndId, docId, tenantId, projectId, 1, parsed.markdown, hash, parsed.engine, nowMs()]);

  try {
    const chunks = chunkText(parsed.markdown);
    const facts = await indexChunks({
      tenantId, projectId, documentId: docId, canonicalId: cndId, chunks, dataClass,
    });
    await grantRead(tenantId, docId, 'project', projectId, actorId); // 默认 ACL：所属项目可读
    await db().query(`UPDATE documents SET status='ready', updated_at=? WHERE id=?`, [nowMs(), docId]);
    logger.info('knowledge ingest done', { docId, chunks: facts.length, engine: parsed.engine });
    await tryAudit({
      tenantId, projectId, actorId, action: 'knowledge.ingest', resourceKind: 'document',
      resourceId: docId, payload: { title, chunks: facts.length, parse_engine: parsed.engine, data_class: dataClass },
    });
    return { document: await getDocument(tenantId, docId), canonical: { id: cndId, version: 1, content_hash: hash, parse_engine: parsed.engine }, chunks: facts.length };
  } catch (e) {
    await markFailed(docId, `索引失败：${e.message || e}`);
    throw e;
  }
}

/**
 * reparse：用新内容重解析，生成 canonical 新版本；旧 facts 标记 superseded 并删向量。
 * 版本链通过 canonical_docs(document_id, version) 保证不断裂。
 */
export async function reparseDocument({ tenantId, projectId, documentId, actorId, content, mime }) {
  const doc = await getDocumentRow(tenantId, documentId);
  if (!doc || doc.project_id !== projectId) throw Errors.notFound('文档不存在');
  const raw = content ?? doc.raw_content;
  const mm = mime ?? doc.mime;
  if (!raw) throw Errors.badRequest('没有可重解析的内容');

  const parsed = await parseDocument({ mime: mm, content: raw, filename: doc.title });
  if (!parsed.ok) throw Errors.badRequest(`文档解析失败：${parsed.reason}`);
  const hash = contentHash(parsed.markdown);

  const ver = await db().query('SELECT COALESCE(MAX(version),0) AS v FROM canonical_docs WHERE document_id=?', [documentId]);
  // 并发重解析可能同时算出同一 version：UNIQUE(document_id, version) 会拒绝后者（500），
  // 调用方重试即可。V0.5 接受该语义，未来可加分布式锁/乐观并发。
  const nextVersion = Number(ver[0].v) + 1;
  const cndId = newId('cnd');
  await db().query(
    `INSERT INTO canonical_docs(id, document_id, tenant_id, project_id, version, content, content_hash, parse_engine, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [cndId, documentId, tenantId, projectId, nextVersion, parsed.markdown, hash, parsed.engine, nowMs()]);

  const oldFacts = await db().query(`SELECT id FROM facts WHERE document_id=? AND status='active'`, [documentId]);
  const chunks = chunkText(parsed.markdown);
  const facts = await indexChunks({
    tenantId, projectId, documentId, canonicalId: cndId, chunks, dataClass: doc.data_class,
  });
  // 旧版本下线：DB 标记 + 向量删除（任一失败都不影响新版本可用性，打日志）
  await db().query(`UPDATE facts SET status='superseded' WHERE document_id=? AND status='active' AND canonical_doc_id != ?`,
    [documentId, cndId]);
  try {
    await deleteChunks(oldFacts.map((f) => f.id));
  } catch (e) {
    logger.warn('knowledge delete old vectors failed', { documentId, err: String(e).slice(0, 200) });
  }
  await db().query(`UPDATE documents SET status='ready', mime=?, raw_content=?, updated_at=? WHERE id=?`,
    [mm, raw, nowMs(), documentId]);
  logger.info('knowledge reparse done', { documentId, version: nextVersion });
  return { document: await getDocument(tenantId, documentId), canonical: { id: cndId, version: nextVersion, content_hash: hash }, chunks: facts.length };
}

/** 显式共享：把某文档的读权限授给同租户另一个项目 */
export async function shareDocument({ tenantId, projectId, documentId, granteeProjectId, actorId }) {
  const doc = await getDocumentRow(tenantId, documentId);
  if (!doc || doc.project_id !== projectId) throw Errors.notFound('文档不存在');
  const gp = await getProject(tenantId, granteeProjectId).catch(() => null);
  if (!gp) throw Errors.badRequest('目标项目不存在或不属于本租户');
  if (gp.id === projectId) throw Errors.badRequest('无需共享给自己');
  const entry = await grantRead(tenantId, documentId, 'project', gp.id, actorId);
  logger.info('knowledge share', { documentId, from: projectId, to: gp.id });
  await tryAudit({
    tenantId, projectId, actorId, action: 'knowledge.share', resourceKind: 'document',
    resourceId: documentId, payload: { grantee_project: gp.id },
  });
  return entry;
}

/**
 * 检索：query embedding(网关) → DB 算可见文档(ACL 预过滤) → 向量召回 →
 * 从 DB 取 fact 原文组装引用。文本真相来自 DB，Qdrant 只做召回排序。
 */
export async function searchKnowledge({ tenantId, projectId, query, limit = 10, dataClass = 'internal' }) {
  if (!query || !query.trim()) throw Errors.badRequest('query 必填');
  const docIds = await visibleDocumentIds(tenantId, projectId);
  if (!docIds.length) return { data: [], total: 0 };
  const { vectors } = await embedInternal({ input: query, project: { id: projectId }, dataClass });
  const hits = await searchChunks({ vector: vectors[0], filter: { tenant_id: tenantId, document_ids: docIds }, limit });
  if (!hits.length) return { data: [], total: 0 };
  const factIds = [...new Set(hits.map((h) => h.fact_id).filter(Boolean))];
  const placeholders = factIds.map(() => '?').join(',');
  const rows = await db().query(
    `SELECT f.id, f.document_id, f.chunk_index, f.content, f.source_span, d.title AS document_title
     FROM facts f JOIN documents d ON d.id = f.document_id
     WHERE f.id IN (${placeholders}) AND f.tenant_id=? AND f.status='active'`,
    [...factIds, tenantId]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const data = [];
  for (const h of hits) {
    const f = byId.get(h.fact_id);
    if (!f) continue; // 索引与 DB 不一致时跳过（派生索引可重建）
    data.push({
      fact_id: f.id, document_id: f.document_id, document_title: f.document_title,
      chunk_index: f.chunk_index, span: JSON.parse(f.source_span || '{}'),
      score: h.score, text: f.content,
    });
  }
  return { data, total: data.length };
}
