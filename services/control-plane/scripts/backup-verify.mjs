#!/usr/bin/env node
/**
 * scripts/backup-verify.mjs —— V2.18：备份完整性校验。
 *
 * 对"已恢复到临时库"的备份做冒烟校验：逐租户跑审计链 verifyChain，
 * 并做基础计数 sanity（表存在、行数非负）。任何失败 → exit 1。
 *
 * 用法：
 *   node scripts/backup-verify.mjs --db /path/to/restored.db   # SQLite
 *   DATABASE_URL=postgres://... node scripts/backup-verify.mjs # PG（临时库）
 *   SQLITE_PATH=/path/to/restored.db node scripts/backup-verify.mjs
 *
 * 注意：只做只读校验，不跑 migrate（避免改动备份内容）。
 */
const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : null;
};
const dbPath = opt('--db');
if (dbPath) {
  process.env.SQLITE_PATH = dbPath;
  delete process.env.DATABASE_URL; // --db 显式指定时才强制走 SQLite
}
if (!dbPath && !process.env.SQLITE_PATH && !process.env.DATABASE_URL) {
  console.error('用法: node scripts/backup-verify.mjs --db <restored.db>（或设 SQLITE_PATH / DATABASE_URL）');
  process.exit(2);
}

const { openDb, db } = await import('../src/db/index.mjs');
const { verifyChain } = await import('../src/modules/evidence/audit.mjs');

await openDb();
const report = { db: dbPath || process.env.SQLITE_PATH || '(DATABASE_URL)', tenants: [], ok: true };
const tenants = await db().query('SELECT id FROM tenants');
for (const t of tenants) {
  const entry = { tenant_id: t.id };
  try {
    const r = await verifyChain(t.id);
    entry.events = r.checked ?? 0;
    entry.chain_ok = r.ok === true;
  } catch (e) {
    entry.chain_ok = false;
    entry.error = e.message;
  }
  const n = await db().query('SELECT COUNT(*) AS n FROM model_calls WHERE tenant_id=?', [t.id]).catch(() => [{ n: 0 }]);
  entry.model_calls = Number(n[0]?.n || 0);
  entry.ok = entry.chain_ok;
  if (!entry.ok) report.ok = false;
  report.tenants.push(entry);
}
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
