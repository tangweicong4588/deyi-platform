#!/usr/bin/env node
/**
 * scripts/tenant-export.mjs —— V2.18：单租户数据导出（备份恢复/租户迁移用）。
 *
 * 从"备份库"（或在线库）导出单个租户的全部业务行，JSONL 落盘，供
 * scripts/tenant-import.mjs 恢复。表顺序 = TABLE_DELETE_ORDER 的逆序
 * （父表在前），保证导入时外键顺序正确；与 offboard 共用同一拓扑，
 * 新增表只要进了 offboard 的删除拓扑就会被导出覆盖。
 *
 * 用法：
 *   node scripts/tenant-export.mjs --tenant <tenantId> --out <dir>
 *
 * DB 由环境变量决定（与控制面一致）：DATABASE_URL（PG）或 SQLITE_PATH。
 * 建议对"备份文件"做导出，避免在线库长事务。
 *
 * 导出内容：
 *   manifest.json                 —— {tenant_id, exported_at, tables:{表:行数}, format}
 *   tenants.jsonl                 —— 租户行（1 行）
 *   <table>.jsonl                 —— 各表行（有 tenant_id 的表按 tenant_id=?；特殊表见下）
 * 特殊表：pipeline_template_versions（经 pipeline_templates 关联）、
 *         tool_credentials（经 tools 关联）；audit_events / billing_invoices /
 *         anchors 按 tenant_id 直接导出（offboard 不删它们，但恢复时需要）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, db } from '../src/db/index.mjs';
import { TABLE_DELETE_ORDER } from '../src/modules/identity/offboard.mjs';

const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : null;
};

const tenantId = opt('--tenant');
const outDir = opt('--out');
if (!tenantId || !outDir) {
  console.error('用法: node scripts/tenant-export.mjs --tenant <tenantId> --out <dir>');
  process.exit(2);
}

// 父表在前的导出顺序：tenants → reversed(删除拓扑)，特殊表插到依赖之后。
function exportOrder() {
  const rev = [...TABLE_DELETE_ORDER].reverse();
  const order = ['tenants'];
  for (const t of rev) {
    order.push(t);
    if (t === 'pipeline_templates') order.push('pipeline_template_versions');
    if (t === 'tools') order.push('tool_credentials');
  }
  // audit / 账单 / 锚定：租户级事实，放在 projects/actors 之后（外键已就绪）
  const insertAfter = (anchor, ...tables) => {
    const i = order.indexOf(anchor);
    order.splice(i + 1, 0, ...tables);
  };
  insertAfter('projects', 'audit_events', 'billing_invoices', 'anchors');
  return order;
}

const SPECIAL = {
  pipeline_template_versions:
    'SELECT v.* FROM pipeline_template_versions v WHERE v.template_id IN (SELECT id FROM pipeline_templates WHERE tenant_id=?)',
  tool_credentials:
    'SELECT c.* FROM tool_credentials c WHERE c.tool_id IN (SELECT id FROM tools WHERE tenant_id=?)',
};

async function main() {
  await openDb();
  const t = await db().query('SELECT id FROM tenants WHERE id=?', [tenantId]);
  if (!t[0]) {
    console.error(`租户不存在: ${tenantId}`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const tables = {};
  const order = exportOrder();
  const seen = new Set();
  for (const table of order) {
    if (seen.has(table)) continue;
    seen.add(table);
    let rows;
    if (table === 'tenants') {
      rows = await db().query('SELECT * FROM tenants WHERE id=?', [tenantId]);
    } else if (SPECIAL[table]) {
      rows = await db().query(SPECIAL[table], [tenantId]);
    } else {
      const cols = await db().query(
        db().kind === 'pg'
          ? `SELECT column_name FROM information_schema.columns WHERE table_name=?`
          : `SELECT name FROM pragma_table_info(?)`,
        [table]);
      const names = cols.map((c) => c.column_name || c.name);
      if (!names.includes('tenant_id')) continue; // 无租户列的表跳过（由上层表覆盖）
      rows = await db().query(`SELECT * FROM ${table} WHERE tenant_id=?`, [tenantId]);
    }
    const lines = rows.map((r) => JSON.stringify(r)).join('\n');
    writeFileSync(join(outDir, `${table}.jsonl`), lines + (lines ? '\n' : ''));
    tables[table] = rows.length;
  }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({
    kind: 'deyi-tenant-export', format: 'jsonl-v1',
    tenant_id: tenantId, exported_at: Date.now(), tables,
  }, null, 2) + '\n');
  const total = Object.values(tables).reduce((a, b) => a + b, 0);
  console.log(JSON.stringify({ tenant_id: tenantId, tables: Object.keys(tables).length, rows: total, out: outDir }));
}

main().catch((e) => { console.error('导出失败:', e.message); process.exit(1); });
