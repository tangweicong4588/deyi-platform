/**
 * db/migrate.mjs —— 迁移执行器：按文件名顺序执行 src/db/migrations/*.sql，
 * 已执行的记录在 _migrations 表。生产与开发共用同一套迁移。
 *
 * 并发安全：K8s 多副本同时启动时，PostgreSQL 用 pg_advisory_xact_lock
 * 保证同一时刻只有一个副本在跑迁移（锁随事务提交/回滚自动释放）；
 * SQLite 只用于单进程开发/测试，走原逻辑。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../kernel/logging.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
// 固定锁 ID（任意 64 位内常量，仅本库使用）
const MIGRATE_LOCK_ID = 4207001;

const DDL = `CREATE TABLE IF NOT EXISTS _migrations (
  name TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
)`;

async function applyPending(tx) {
  const done = new Set((await tx.query('SELECT name FROM _migrations')).map((r) => r.name));
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    logger.info('db migrate: applying', { file: f });
    const sql = readFileSync(join(dir, f), 'utf8');
    await tx.exec(sql);
    await tx.query('INSERT INTO _migrations(name, applied_at) VALUES (?, ?)', [f, Date.now()]);
    logger.info('db migrate: applied', { file: f });
  }
}

export async function migrate(db) {
  if (db.kind === 'pg') {
    await db.transaction(async (tx) => {
      // 事务级咨询锁：拿不到就排队等待，拿到后整个迁移过程独占
      await tx.query('SELECT pg_advisory_xact_lock(?)', [MIGRATE_LOCK_ID]);
      await tx.exec(DDL);
      await applyPending(tx);
    });
    return;
  }
  await db.exec(DDL);
  await db.transaction(applyPending);
}
