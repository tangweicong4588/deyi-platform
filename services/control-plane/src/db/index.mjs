/**
 * db/index.mjs —— 数据库抽象。
 *
 * 真相源必须是 PostgreSQL（生产）。DATABASE_URL 未设置时，开发/测试模式
 * 回退到 SQLite 文件（node:sqlite，零依赖），并在启动日志里明确警告。
 *
 * SQL 书写约定：占位符一律用 `?`，本层在 pg 下自动转成 $1..$n；
 * 迁移脚本只用两边都支持的语法（TEXT 主键、INTEGER 时间戳、无 PG 专有类型）。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../kernel/config.mjs';
import { logger } from '../kernel/logging.mjs';

let backend = null;

function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function openPg() {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  // 预热连接，失败直接抛给启动流程
  await pool.query('select 1');
  logger.info('db backend: postgresql');
  return {
    kind: 'pg',
    query: async (sql, params = []) => (await pool.query(toPgPlaceholders(sql), params)).rows,
    run: async (sql, params = []) => ({ changes: (await pool.query(toPgPlaceholders(sql), params)).rowCount ?? 0 }),
    exec: async (sql) => { await pool.query(sql); },
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx = {
          query: async (sql, params = []) => (await client.query(toPgPlaceholders(sql), params)).rows,
          run: async (sql, params = []) => ({ changes: (await client.query(toPgPlaceholders(sql), params)).rowCount ?? 0 }),
          exec: async (sql) => { await client.query(sql); },
        };
        const r = await fn(tx);
        await client.query('COMMIT');
        return r;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    close: async () => pool.end(),
  };
}

function openSqlite(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  if (!config.DATABASE_URL) {
    logger.warn('db backend: sqlite（仅开发/测试 fallback，生产必须 PostgreSQL）', { path });
  }
  return {
    kind: 'sqlite',
    query: async (sql, params = []) => db.prepare(sql).all(...params),
    run: async (sql, params = []) => ({ changes: Number(db.prepare(sql).run(...params).changes) }),
    exec: async (sql) => { db.exec(sql); },
    transaction: async (fn) => {
      // node:sqlite 同步 API：用显式事务包裹
      db.exec('BEGIN');
      try {
        const tx = {
          query: async (sql, params = []) => db.prepare(sql).all(...params),
          run: async (sql, params = []) => ({ changes: Number(db.prepare(sql).run(...params).changes) }),
          exec: async (sql) => { db.exec(sql); },
        };
        const r = await fn(tx);
        db.exec('COMMIT');
        return r;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw e;
      }
    },
    close: async () => db.close(),
  };
}

export async function openDb() {
  if (backend) return backend;
  backend = config.DATABASE_URL ? await openPg() : openSqlite(config.SQLITE_PATH);
  return backend;
}

/** 取已打开的 db（调用前必须 await openDb()） */
export function db() {
  if (!backend) throw new Error('db 未初始化：先 await openDb()');
  return backend;
}
