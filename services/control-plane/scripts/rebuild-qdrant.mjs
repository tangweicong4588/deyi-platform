#!/usr/bin/env node
/**
 * scripts/rebuild-qdrant.mjs —— Qdrant 向量索引一键重建（Review-R6 数据 review）。
 *
 * 背景：Qdrant / 内存向量索引是可重建的派生数据，业务真相永远在 DB
 * （documents / canonical_docs / facts）。索引丢失、维度变更、换 collection
 * 后，用本脚本从 DB 全量重建，无需重跑文档摄取。
 *
 * 做法：
 *  1. 删除 Qdrant collection（deyi_knowledge），清掉脏 point；
 *  2. 按租户遍历 status='ready' 的文档最新 canonical 版本；
 *  3. 重新 chunkText → 经网关 embedInternal 取向量 → upsertChunks 写回。
 *  point ID 由 fact 平台 ID 派生（vector.pointUuid），幂等，可重复跑。
 *
 * 用法：
 *   node scripts/rebuild-qdrant.mjs [--tenant <tenantId>] [--dry-run]
 *
 * 注意：
 *  - 需要网关 embedding 模型可用（LITELLM_URL 或 fake 引擎）；重建会产生
 *    embedding 调用费用，按文档量评估。
 *  - 需要 DB 可达（DATABASE_URL 或开发 SQLite）。
 *  - Qdrant live 路径尚未与真实 Qdrant 联调（见 vector.mjs 头注），
 *    首次在生产跑之前先在 staging 验证。
 */
import { openDb, db } from '../src/db/index.mjs';
import { migrate } from '../src/db/migrate.mjs';
import { runWithContext, newTraceId } from '../src/kernel/context.mjs';
import { chunkText } from '../src/modules/knowledge/service.mjs';
import { upsertChunks, deleteChunks } from '../src/modules/knowledge/vector.mjs';
import { embedInternal } from '../src/modules/gateway/routes.mjs';
import { newId } from '../src/kernel/ids.mjs';
import { config } from '../src/kernel/config.mjs';

const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : null;
};
const DRY_RUN = args.includes('--dry-run');
const ONLY_TENANT = opt('--tenant');

const EMBED_BATCH = 32;

async function qdrantDropCollection() {
  if (!config.QDRANT_URL) {
    console.log('[rebuild] QDRANT_URL 未配置：跳过 collection 删除（内存索引随进程重建）');
    return;
  }
  const url = `${config.QDRANT_URL.replace(/\/$/, '')}/collections/deyi_knowledge`;
  const res = await fetch(url, { method: 'DELETE' });
  console.log(`[rebuild] 删除 collection: HTTP ${res.status}`);
}

async function main() {
  await openDb();
  await migrate(db());

  const tenants = ONLY_TENANT
    ? [{ id: ONLY_TENANT }]
    : await db().query(`SELECT DISTINCT tenant_id AS id FROM documents WHERE status='ready'`);
  console.log(`[rebuild] 租户数: ${tenants.length}${DRY_RUN ? '（dry-run，不写）' : ''}`);

  if (!DRY_RUN) await qdrantDropCollection();

  let totalChunks = 0;
  for (const t of tenants) {
    const docs = await db().query(
      `SELECT d.id AS document_id, d.project_id, c.id AS canonical_id, c.content
       FROM documents d
       JOIN canonical_docs c ON c.document_id=d.id
       WHERE d.tenant_id=? AND d.status='ready'
         AND c.version=(SELECT MAX(version) FROM canonical_docs WHERE document_id=d.id)`,
      [t.id]);
    console.log(`[rebuild] tenant=${t.id} 文档数=${docs.length}`);
    let tenantChunks = 0;
    await runWithContext({
      traceId: newTraceId(), tenantId: t.id,
      actorId: 'system:rebuild-qdrant', actorKind: 'system', authKind: 'system',
    }, async () => {
      for (const doc of docs) {
        // 复用已有 fact ID（pointUuid 由 fact ID 派生，复用=幂等）；
        // chunk 算法变更导致数量不一致时，新增 fact 行、旧多余行标记 deleted。
        const existing = DRY_RUN ? [] : await db().query(
          `SELECT id, chunk_index FROM facts
           WHERE document_id=? AND canonical_doc_id=? AND status='active'`,
          [doc.document_id, doc.canonical_id]);
        const byIndex = new Map(existing.map((f) => [Number(f.chunk_index), f.id]));
        const chunks = chunkText(doc.content);
        const seen = new Set();
        const newFactRows = [];
        for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
          const batch = chunks.slice(i, i + EMBED_BATCH);
          const { vectors } = await embedInternal({
            input: batch.map((c) => c.text),
            project: { id: doc.project_id },
            dataClass: 'internal',
          });
          if (!vectors || vectors.length !== batch.length) {
            throw new Error(`embedding 返回数量不一致: 期望 ${batch.length}, 实际 ${vectors?.length}`);
          }
          const ups = batch.map((c, j) => {
            let factId = byIndex.get(c.index);
            if (!factId) {
              factId = newId('fct');
              newFactRows.push({
                id: factId, canonical_doc_id: doc.canonical_id, document_id: doc.document_id,
                tenant_id: t.id, project_id: doc.project_id, chunk_index: c.index,
                content: c.text, source_span: JSON.stringify(c.span),
                embedding_model: 'deyi-embedding', status: 'active', created_at: Date.now(),
              });
            }
            seen.add(factId);
            return {
              id: factId,
              vector: vectors[j],
              payload: {
                tenant_id: t.id, project_id: doc.project_id,
                document_id: doc.document_id, fact_id: factId, chunk_index: c.index,
              },
            };
          });
          if (!DRY_RUN) await upsertChunks(ups);
          tenantChunks += ups.length;
        }
        if (!DRY_RUN) {
          // 新增 fact 行落库
          await db().transaction(async (tx) => {
            for (const f of newFactRows) {
              await tx.query(
                `INSERT INTO facts(id, canonical_doc_id, document_id, tenant_id, project_id, chunk_index,
                  content, source_span, embedding_model, status, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                [f.id, f.canonical_doc_id, f.document_id, f.tenant_id, f.project_id, f.chunk_index,
                 f.content, f.source_span, f.embedding_model, f.status, f.created_at]);
            }
          });
          // 多余旧 fact：标记 deleted 并从向量索引删除
          const stale = existing.filter((f) => !seen.has(f.id)).map((f) => f.id);
          if (stale.length) {
            await db().query(
              `UPDATE facts SET status='deleted' WHERE id IN (${stale.map(() => '?').join(',')})`, stale);
            await deleteChunks(stale);
            console.log(`[rebuild] doc=${doc.document_id} 清理多余旧 facts=${stale.length}`);
          }
        }
      }
    });
    console.log(`[rebuild] tenant=${t.id} 重建 chunks=${tenantChunks}`);
    totalChunks += tenantChunks;
  }
  console.log(`[rebuild] 完成：共 ${totalChunks} 个 chunks${DRY_RUN ? '（dry-run 未写入）' : ''}`);
  await db().close();
}

main().catch((e) => { console.error('[rebuild] 失败:', e.message); process.exit(1); });
