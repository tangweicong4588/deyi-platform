/**
 * db/migrate.mjs —— 迁移执行器：按文件名顺序执行 src/db/migrations/*.sql，
 * 已执行的记录在 _migrations 表。生产与开发共用同一套迁移。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../kernel/logging.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(db) {
  await db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
  const done = new Set((await db.query('SELECT name FROM _migrations')).map((r) => r.name));
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    logger.info('db migrate: applying', { file: f });
    const sql = readFileSync(join(dir, f), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO _migrations(name, applied_at) VALUES (?, ?)', [f, Date.now()]);
    });
    logger.info('db migrate: applied', { file: f });
  }
}
