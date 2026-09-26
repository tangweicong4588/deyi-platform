/** migrate 幂等性：跑两次，第二次不重复执行（sqlite 路径） */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-mig-')), 'test.db');
process.env.BOOTSTRAP_ENABLED = 'false';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');

before(async () => { await openDb(); });

test('migrate 跑两次：第二次零执行且表结构完整', async () => {
  await migrate(db());
  const n1 = await db().query('SELECT COUNT(*) AS c FROM _migrations');
  await migrate(db());
  const n2 = await db().query('SELECT COUNT(*) AS c FROM _migrations');
  assert.ok(Number(n1[0].c) > 0, '至少应用了一批迁移');
  assert.equal(Number(n2[0].c), Number(n1[0].c), '第二次不应新增记录');
  // 关键表存在
  for (const t of ['tenants', 'models', 'budgets', 'documents', 'audit_events']) {
    const r = await db().query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?", [t]);
    assert.equal(r.length, 1, `表 ${t} 应存在`);
  }
});
