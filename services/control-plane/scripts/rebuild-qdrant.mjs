#!/usr/bin/env node
/**
 * scripts/rebuild-qdrant.mjs —— Qdrant 向量索引一键重建（Review-R6 数据 review 重写）。
 *
 * 背景：Qdrant / 内存向量索引是可重建的派生数据，业务真相永远在 DB
 * （documents / canonical_docs / facts）。索引丢失、维度变更、换 collection
 * 后，用本脚本从 DB 全量重建，无需重跑文档摄取。
 *
 * R6 数据 review 重写（旧实现的三处错误已修正）：
 *  1. 旧实现从 canonical 内容重新 chunkText，并按 chunk_index 复用/新建 fact 行——
 *     重建脚本不得改写业务真相。新实现只读 DB 中已有 status='active' 的 facts，
 *     逐条取其原有 content 重新 embedding，索引重建不创建、不重新定义任何 fact。
 *  2. 旧实现先写 Qdrant 再写 DB，DB 失败会留下孤儿向量。新实现只写向量索引，
 *     不写 DB，不存在"先索引后库"的顺序问题。
 *  3. 旧实现把"多余旧 fact"标 deleted——那是摄取/版本管理的职责，重建无权做。
 *  point ID 由 fact 平台 ID 派生（vector.pointUuid），幂等，可重复跑。
 *
 * 用法：
 *   node scripts/rebuild-qdrant.mjs [--tenant <tenantId>] [--dry-run]
 *
 * 注意：
 *  - 需要网关 embedding 模型可用（LITELLM_URL 或 fake 引擎）；重建会产生
 *    embedding 调用费用，按 fact 量评估。
 *  - 需要 DB 可达（DATABASE_URL 或开发 SQLite）。
 *  - Qdrant live 路径尚未与真实 Qdrant 联调（见 vector.mjs 头注），
 *    首次在生产跑之前先在 staging 验证。
 */
import { openDb, db } from '../src/db/index.mjs';
import { migrate } from '../src/db/migrate.mjs';
import { runWithContext, newTraceId } from '../src/kernel/context.mjs';
import { upsertChunks } from '../src/modules/knowledge/vector.mjs';
import { embedInternal } from '../src/modules/gateway/routes.mjs';
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

/**
 * 取某租户全部 active facts（只读）。重建的事实来源唯一入口：
 *  - 只取 status='active'；
 *  - 强制按 tenant_id 过滤（租户隔离）；
 *  - SELECT only，不写 facts 表。
 * 导出供测试验证"只读 + 租户隔离"契约。
 */
export async function fetchActiveFacts(tenantId) {
  return db().query(
    `SELECT f.id, f.tenant_id, f.project_id, f.document_id, f.chunk_index, f.content
     FROM facts f
     WHERE f.status='active' AND f.tenant_id=?
     ORDER BY f.document_id, f.chunk_index`,
    [tenantId]);
}

async function main() {
  await openDb();
  await migrate(db());

  const tenants = ONLY_TENANT
    ? [{ id: ONLY_TENANT }]
    : await db().query(`SELECT DISTINCT tenant_id AS id FROM facts WHERE status='active'`);
  console.log(`[rebuild] 租户数: ${tenants.length}${DRY_RUN ? '（dry-run，不写）' : ''}`);

  if (!DRY_RUN) await qdrantDropCollection();

  let totalChunks = 0;
  for (const t of tenants) {
    // 只读已有 active facts：用 fact 自己的 id/content/document_id/project_id/chunk_index。
    // 索引重建不得创建、修改、删除任何 fact 行——业务真相只读。
    // 注意：无论是否指定 --tenant，这里都必须按当前循环租户 t.id 过滤，
    // 否则多租户全量重建时每个租户循环都会重复处理全表（R6 复核修复）。
    const facts = await fetchActiveFacts(t.id);
    console.log(`[rebuild] tenant=${t.id} active facts=${facts.length}`);
    let tenantChunks = 0;
    await runWithContext({
      traceId: newTraceId(), tenantId: t.id,
      actorId: 'system:rebuild-qdrant', actorKind: 'system', authKind: 'system',
    }, async () => {
      for (let i = 0; i < facts.length; i += EMBED_BATCH) {
        const batch = facts.slice(i, i + EMBED_BATCH);
        const { vectors } = await embedInternal({
          input: batch.map((f) => f.content),
          project: { id: batch[0].project_id },
          dataClass: 'internal',
        });
        if (!vectors || vectors.length !== batch.length) {
          throw new Error(`embedding 返回数量不一致: 期望 ${batch.length}, 实际 ${vectors?.length}`);
        }
        const ups = batch.map((f, j) => ({
          id: f.id, // pointUuid(f.id) 派生 point ID：幂等，重复跑不产生重复 point
          vector: vectors[j],
          payload: {
            tenant_id: f.tenant_id, project_id: f.project_id,
            document_id: f.document_id, fact_id: f.id, chunk_index: f.chunk_index,
          },
        }));
        if (!DRY_RUN) await upsertChunks(ups);
        tenantChunks += ups.length;
      }
    });
    console.log(`[rebuild] tenant=${t.id} 重建 points=${tenantChunks}`);
    totalChunks += tenantChunks;
  }
  console.log(`[rebuild] 完成：共 ${totalChunks} 个 points${DRY_RUN ? '（dry-run 未写入）' : ''}`);
  await db().close();
}

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// 直接执行（node scripts/rebuild-qdrant.mjs）才跑 main；被测试 import 时只导出函数
if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) {
  main().catch((e) => { console.error('[rebuild] 失败:', e.message); process.exit(1); });
}
