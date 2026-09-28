// tests/schema-bigint.test.mjs —— 静态回归：毫秒时间/金额/token 字段必须用 BIGINT，
// 禁止回退到 32 位 INTEGER（2026-09-28 PG live 曾因 applied_at INTEGER 溢出）。
// 不连数据库，纯扫描 migration SQL 文本。
import { test } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');

// 毫秒时间戳 / 金额(分) / token 计量：语义上必然超过 2^31，必须 BIGINT
const BIGINT_PATTERNS = [
  /_at\b/i,        // created_at / updated_at / expires_at / *_at
  /_cents\b/i,     // 金额（分）
  /_tokens\b/i,    // token 计量
  /\bseq\b/i,      // 序列号
];
const EXCEPTIONS = new Set([
  // 明确豁免：这些字段语义上不会溢出 32 位
]);

function columnDefs(sql) {
  // 粗粒度提取 "name TYPE" 定义行
  const defs = [];
  for (const m of sql.matchAll(/^\s*"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+(INTEGER|BIGINT|TEXT|REAL|BLOB|NUMERIC)\b/gim)) {
    defs.push({ name: m[1], type: m[2].toUpperCase() });
  }
  return defs;
}

test('毫秒时间/金额/token 字段不得用 32 位 INTEGER', () => {
  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(files.length > 0, '无 migration 文件');
  const violations = [];
  for (const f of files) {
    const sql = readFileSync(join(MIG_DIR, f), 'utf8');
    for (const { name, type } of columnDefs(sql)) {
      if (type !== 'INTEGER') continue;
      if (EXCEPTIONS.has(`${f}:${name}`)) continue;
      if (BIGINT_PATTERNS.some((re) => re.test(name))) {
        violations.push(`${f}: ${name} 用了 INTEGER（应为 BIGINT）`);
      }
    }
  }
  assert.deepStrictEqual(violations, [], `发现 ${violations.length} 处 INTEGER 误用:\n${violations.join('\n')}`);
});

test('_migrations.applied_at 必须为 BIGINT', () => {
  // applied_at 定义在 migrate.mjs 的建表语句里（非 001），直接读源码断言
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrate.mjs'), 'utf8');
  assert.match(src, /applied_at\s+BIGINT/i, 'migrate.mjs 的 _migrations.applied_at 应为 BIGINT');
});
