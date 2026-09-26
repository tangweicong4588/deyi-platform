#!/usr/bin/env node
/**
 * scripts/rebuild-memory-index.mjs —— 记忆向量索引一键重建（V2.2-B）。
 *
 * 背景：Qdrant collection `deyi_memory` / 内存向量索引是可重建的派生数据，
 * 业务真相永远在 DB（memories 表）。索引丢失、维度变更后，用本脚本从 DB
 * 全量重建，无需重写任何记忆。
 *
 * 契约（与 rebuild-qdrant.mjs 一致）：
 *  1. 只读 DB 中 status='active' 的 memories，按 tenant_id 隔离处理；
 *  2. 只写向量索引，不写 DB，不存在"先索引后库"的顺序问题；
 *  3. point ID 由 memory 平台 ID 派生（memoryPointUuid），幂等，可重复跑。
 *
 * 用法：
 *   node scripts/rebuild-memory-index.mjs [--tenant <tenantId>] [--dry-run]
 *
 * 注意：
 *  - 需要网关 embedding 模型可用（LITELLM_URL 或 fake 引擎）；重建会产生
 *    embedding 调用费用，按记忆量评估。
 *  - 需要 DB 可达（DATABASE_URL 或开发 SQLite）。
 *  - Qdrant live 路径尚未与真实 Qdrant 联调（见 vector.mjs 头注），
 *    首次在生产跑之前先在 staging 验证。
 */
import { openDb, db } from '../src/db/index.mjs';
import { migrate } from '../src/db/migrate.mjs';
import { reindexMemories } from '../src/modules/memory/service.mjs';
import { getMemoryVectorStatus } from '../src/modules/memory/vector.mjs';
import { config } from '../src/kernel/config.mjs';

const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : null;
};
const DRY_RUN = args.includes('--dry-run');
const ONLY_TENANT = opt('--tenant');

async function qdrantDropCollection() {
  if (!config.QDRANT_URL) {
    console.log('[rebuild-memory] QDRANT_URL 未配置：跳过 collection 删除（内存索引随进程重建）');
    return;
  }
  const url = `${config.QDRANT_URL.replace(/\/$/, '')}/collections/deyi_memory`;
  const res = await fetch(url, { method: 'DELETE' });
  console.log(`[rebuild-memory] 删除 collection: HTTP ${res.status}`);
}

async function main() {
  await openDb();
  await migrate(db());

  const tenants = ONLY_TENANT
    ? [{ id: ONLY_TENANT }]
    : await db().query(`SELECT DISTINCT tenant_id AS id FROM memories WHERE status='active'`);
  console.log(`[rebuild-memory] 租户数: ${tenants.length}${DRY_RUN ? '（dry-run，不写）' : ''}`);

  if (DRY_RUN) {
    for (const t of tenants) {
      const rows = await db().query(
        `SELECT COUNT(*) AS c FROM memories WHERE tenant_id=? AND status='active'`, [t.id]);
      console.log(`[rebuild-memory] tenant=${t.id} active memories=${rows[0].c}（dry-run）`);
    }
    return;
  }

  await qdrantDropCollection();
  const out = await reindexMemories({ tenantId: ONLY_TENANT });
  console.log(`[rebuild-memory] 完成：indexed=${out.indexed} failed=${out.failed} total=${out.total} engine=${out.engine || getMemoryVectorStatus()}`);
}

main().catch((e) => {
  console.error('[rebuild-memory] 失败:', e?.message || e);
  process.exit(1);
});
