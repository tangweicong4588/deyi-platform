/**
 * db/migrate.mjs —— 迁移执行器：按文件名顺序执行 src/db/migrations/*.{sql,mjs}，
 * 已执行的记录在 _migrations 表。生产与开发共用同一套迁移。
 *
 * - .sql：纯 SQL，直接执行（双库通用；需要按库分支时用 .mjs）。
 * - .mjs：export async function up(tx, db)，可按 db.kind 分支（如 CHECK 约束变更，
 *   SQLite 不支持 ALTER CHECK，只能重建表）。优先用 tx 执行，使 PG 侧仍受咨询锁保护。
 * - .mjs 还可声明 export const transactional = false：该迁移在 SQLite 上于主事务外
 *   执行（自己负责原子性）。用于 017 这类需要"事务外 PRAGMA foreign_keys=OFF"的
 *   表重建——该 PRAGMA 在事务内是 no-op，重建被引用的父表必报 FK 失败（R6 复核实测）。
 *   PG 侧不受影响（仍走咨询锁保护的大事务；017 的 PG 分支本身就是事务性 ALTER）。
 *
 * 并发安全：K8s 多副本同时启动时，PostgreSQL 用 pg_advisory_xact_lock
 * 保证同一时刻只有一个副本在跑迁移（锁随事务提交/回滚自动释放）；
 * SQLite 只用于单进程开发/测试，逐个迁移独立事务（原来是整个 migrate 一个大事务；
 * 改为逐个后，transactional=false 的迁移才能真正跑在事务外）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { logger } from '../kernel/logging.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
// 固定锁 ID（任意 64 位内常量，仅本库使用）
const MIGRATE_LOCK_ID = 4207001;

const DDL = `CREATE TABLE IF NOT EXISTS _migrations (
  name TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
)`;

async function loadMod(f) {
  const mod = await import(pathToFileURL(join(dir, f)).href);
  if (typeof mod.up !== 'function') throw new Error(`迁移 ${f} 缺少 export async function up(tx, db)`);
  return mod;
}

/** 在给定 tx 内执行单个迁移并记录 _migrations */
async function applyOne(tx, db, f) {
  logger.info('db migrate: applying', { file: f });
  if (f.endsWith('.mjs')) {
    await (await loadMod(f)).up(tx, db);
  } else {
    await tx.exec(readFileSync(join(dir, f), 'utf8'));
  }
  await tx.query('INSERT INTO _migrations(name, applied_at) VALUES (?, ?)', [f, Date.now()]);
  logger.info('db migrate: applied', { file: f });
}

async function applyPending(tx, db) {
  const done = new Set((await tx.query('SELECT name FROM _migrations')).map((r) => r.name));
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql') || f.endsWith('.mjs')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    await applyOne(tx, db, f);
  }
}

function pendingFiles(done) {
  return readdirSync(dir).filter((f) => f.endsWith('.sql') || f.endsWith('.mjs')).sort()
    .filter((f) => !done.has(f));
}

export async function migrate(db) {
  if (db.kind === 'pg') {
    await db.transaction(async (tx) => {
      // 事务级咨询锁：拿不到就排队等待，拿到后整个迁移过程独占
      await tx.query('SELECT pg_advisory_xact_lock(?)', [MIGRATE_LOCK_ID]);
      await tx.exec(DDL);
      await applyPending(tx, db);
    });
    return;
  }
  await db.exec(DDL);
  // SQLite：逐个迁移独立事务（顺序与文件名一致）。transactional=false 的迁移
  // 在事务外执行——up 自己负责 BEGIN/COMMIT 与 PRAGMA 切换，_migrations 记录紧随其后写入。
  const done = new Set((await db.query('SELECT name FROM _migrations')).map((r) => r.name));
  for (const f of pendingFiles(done)) {
    const mod = f.endsWith('.mjs') ? await loadMod(f) : null;
    if (mod && mod.transactional === false) {
      logger.info('db migrate: applying (non-transactional)', { file: f });
      await mod.up(db, db);
      await db.query('INSERT INTO _migrations(name, applied_at) VALUES (?, ?)', [f, Date.now()]);
      logger.info('db migrate: applied (non-transactional)', { file: f });
      continue;
    }
    await db.transaction(async (tx) => { await applyOne(tx, db, f); });
  }
}
