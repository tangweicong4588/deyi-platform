#!/usr/bin/env node
/**
 * scripts/tenant-import.mjs —— V2.18：单租户数据恢复（与 tenant-export.mjs 配对）。
 *
 * 把 tenant-export.mjs 产出的目录导入目标库（通常是"从全量备份恢复出的临时库"
 * 或在线库）。按 manifest 表顺序（父表在前）INSERT，整库单事务；行已存在时
 * 跳过（幂等，可重复跑），tenants 行已存在则保留目标库现有行（不覆盖在线状态）。
 *
 * 用法：
 *   node scripts/tenant-import.mjs --tenant <tenantId> --in <dir> [--dry-run]
 *
 * DB 由环境变量决定：DATABASE_URL（PG）或 SQLITE_PATH。
 * 注意：导入前请确认目标库已执行 migrate（表结构存在）；--dry-run 只统计不写入。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, db } from '../src/db/index.mjs';

const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : null;
};
const dryRun = args.includes('--dry-run');

const tenantId = opt('--tenant');
const inDir = opt('--in');
if (!tenantId || !inDir) {
  console.error('用法: node scripts/tenant-import.mjs --tenant <tenantId> --in <dir> [--dry-run]');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(inDir, 'manifest.json'), 'utf8'));
if (manifest.kind !== 'deyi-tenant-export' || manifest.tenant_id !== tenantId) {
  console.error(`manifest 不匹配（期望租户 ${tenantId}，文件内 ${manifest.tenant_id}）`);
  process.exit(1);
}

async function main() {
  await openDb();
  const ignore = db().kind === 'pg' ? 'ON CONFLICT DO NOTHING' : 'OR IGNORE';
  const report = { tenant_id: tenantId, dry_run: dryRun, tables: {} };
  const run = async (tx) => {
    for (const table of Object.keys(manifest.tables)) {
      const raw = readFileSync(join(inDir, `${table}.jsonl`), 'utf8').trim();
      const rows = raw ? raw.split('\n').map((l) => JSON.parse(l)) : [];
      let inserted = 0;
      for (const row of rows) {
        const cols = Object.keys(row);
        const vals = cols.map((c) => (typeof row[c] === 'object' && row[c] !== null ? JSON.stringify(row[c]) : row[c]));
        const q = tx || db();
        // PG 语法：INSERT INTO ... VALUES (...) ON CONFLICT DO NOTHING（冲突子句在末尾）
        const sql = db().kind === 'pg'
          ? `INSERT INTO ${table}(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) ${ignore}`
          : `INSERT ${ignore} INTO ${table}(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
        const r = await q.run(sql, vals);
        inserted += r.changes || 0;
      }
      report.tables[table] = { rows: rows.length, inserted, skipped: rows.length - inserted };
    }
    if (dryRun) throw new Error('__dry_run_rollback__');
  };
  try {
    await db().transaction(run);
  } catch (e) {
    if (e.message !== '__dry_run_rollback__') throw e;
  }
  console.log(JSON.stringify(report));
}

main().catch((e) => { console.error('导入失败:', e.message); process.exit(1); });
