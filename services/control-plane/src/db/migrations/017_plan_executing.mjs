/**
 * 017_plan_executing.mjs —— batch4 遗留修复：计划状态集新增 executing。
 *
 * executePlan 需要 approved/dryrun_passed → executing 的 CAS 认领，防并发重复执行。
 * 但 SQLite 不支持 ALTER CHECK，只能重建表；PostgreSQL 可直接换约束。按 db.kind 分支。
 *
 * R6 复核重写（原实现在有引用数据的 SQLite 库上必失败，已实测）：
 *  - 原实现在 migrate 的大事务内执行 PRAGMA foreign_keys=OFF——SQLite 里该 PRAGMA
 *    在事务内是 no-op（实测 foreign_keys 仍为 1），随后 DROP 被 business_actions
 *    引用的 business_plans 直接报 FOREIGN KEY constraint failed。
 *    defer_foreign_keys 同样不行：DROP 产生的延迟违反在 COMMIT 时仍按旧表判定。
 *  - 按 SQLite 官方 12 步流程（https://www.sqlite.org/lang_altertable.html#otheralter），
 *    表重建必须在事务外关 FK → 重建 → foreign_key_check 校验 → 恢复 FK。
 *  - 因此本迁移声明 export const transactional = false；migrate 在 SQLite 上让它在
 *    主事务外执行（PG 侧仍是普通事务性 ALTER，受咨询锁保护）。
 *  - 列集合与 011_business.sql 的原始定义逐列对齐（新增列会静默丢失，必须同步改这里）；
 *    索引 idx_bplan_intent / idx_bplan_tenant 重建；无触发器/视图依赖该表。
 */
export const transactional = false;

const STATUSES = "('draft','dryrun_passed','dryrun_blocked','approved','executing','rejected')";

const NEW_TABLE_DDL = `CREATE TABLE business_plans_new (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES business_intents(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ${STATUSES}),
  risk_estimate TEXT NOT NULL DEFAULT '{}',
  ontology_gaps TEXT NOT NULL DEFAULT '[]',
  dryrun_report TEXT NOT NULL DEFAULT '{}',
  created_by TEXT REFERENCES actors(id),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
)`;
const COLS = 'id,intent_id,tenant_id,project_id,status,risk_estimate,ontology_gaps,dryrun_report,created_by,created_at,updated_at';

export async function up(tx, db) {
  if (db.kind === 'pg') {
    // 内联 CHECK 的自动约束名为 business_plans_status_check
    await tx.exec('ALTER TABLE business_plans DROP CONSTRAINT IF EXISTS business_plans_status_check');
    await tx.exec(`ALTER TABLE business_plans ADD CONSTRAINT business_plans_status_check CHECK (status IN ${STATUSES})`);
    return;
  }
  // SQLite：官方 12 步流程。注意以下三点都在事务外：
  //  1) PRAGMA foreign_keys=OFF 必须在 BEGIN 之前（事务内是 no-op）；
  //  2) 重建在自己 BEGIN/COMMIT 里，与 migrate 主事务无关；
  //  3) 完成后 PRAGMA foreign_key_check 全库校验，有违反就抛错（不静默），最后恢复 FK。
  await db.exec('PRAGMA foreign_keys=OFF');
  try {
    await db.exec('BEGIN');
    try {
      await db.exec('DROP TABLE IF EXISTS business_plans_new'); // 历史失败残留幂等
      await db.exec(NEW_TABLE_DDL);
      await db.exec(`INSERT INTO business_plans_new(${COLS}) SELECT ${COLS} FROM business_plans`);
      await db.exec('DROP TABLE business_plans');
      await db.exec('ALTER TABLE business_plans_new RENAME TO business_plans');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_bplan_intent ON business_plans(intent_id)');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_bplan_tenant ON business_plans(tenant_id, project_id, created_at)');
      await db.exec('COMMIT');
    } catch (e) {
      try { await db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
    const violations = await db.query('PRAGMA foreign_key_check');
    if (violations.length) {
      throw new Error(`017 迁移后 FK 校验失败（数据不一致，拒绝继续）: ${JSON.stringify(violations).slice(0, 500)}`);
    }
  } finally {
    // 无论成功失败，连接必须恢复 FK 强制，否则后续写入失去 FK 保护
    await db.exec('PRAGMA foreign_keys=ON');
  }
}
