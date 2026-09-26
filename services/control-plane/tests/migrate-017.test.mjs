/**
 * 017_plan_executing 升级路径测试（R6 复核）：
 * 构造"017 之前"的旧库（含 business_actions → business_plans 的引用数据，FK 开启），
 * 再跑 migrate() 应用 017，验证：
 *  1. 迁移成功（原实现在此必报 FOREIGN KEY constraint failed）；
 *  2. 计划/动作数据逐列完整；
 *  3. 新 CHECK 允许 executing、仍拒绝非法状态；
 *  4. FK 强制恢复且无违反（foreign_key_check 为空），索引重建。
 *
 * 手法：预写 _migrations 跳过 017/018（无文件移动，与并行测试文件无竞态），
 * 造数据后再删除这两条记录，重新 migrate() 让 017/018 真实执行。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-m17-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.DEV_IDP_SECRET = 'dev_test_secret_32bytes_xxxxxxxx';
process.env.BOOTSTRAP_ENABLED = 'false';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const istore = await import('../src/modules/identity/store.mjs');
const bstore = await import('../src/modules/business/store.mjs');

const SKIP = ['017_plan_executing.mjs', '018_gex_broad_waiver.sql'];
let tenant, project, intent, plan, action;

before(async () => {
  await openDb();
  // 预写 _migrations：让第一次 migrate() 停在 016（含旧 business_plans 定义，不含 executing）
  await db().exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  for (const f of SKIP) {
    await db().query('INSERT INTO _migrations(name, applied_at) VALUES (?, ?)', [f, Date.now()]);
  }
  await migrate(db());

  // 确认旧 CHECK 确实不含 executing（旧库状态）
  const sql = await db().query(`SELECT sql FROM sqlite_master WHERE name='business_plans'`);
  assert.ok(!sql[0].sql.includes('executing'), '前置条件：旧表 CHECK 不应含 executing');

  // 造引用数据：intent → plan → actions（FK 全程开启）
  tenant = await istore.createTenant({ name: 'M17 Tenant' });
  const actor = await istore.createActor(tenant.id, { kind: 'user', name: 'M17' });
  project = await istore.createProject(tenant.id, { name: 'M17 Project' });
  intent = await bstore.createIntent({ tenantId: tenant.id, projectId: project.id, rawText: 'm17', createdBy: actor.id });
  plan = await bstore.createPlan({ tenantId: tenant.id, projectId: project.id, intentId: intent.id, createdBy: actor.id });
  await bstore.updatePlan(tenant.id, plan.id, { status: 'approved', risk_estimate: { x: 1 } });
  plan = await bstore.getPlan(tenant.id, plan.id);
  action = await bstore.createAction({
    tenantId: tenant.id, projectId: project.id, planId: plan.id, seq: 1,
    toolName: 't', args: {}, idempotencyKey: 'idem-m17-1',
  });

  // 删除跳过标记，第二次 migrate() 真实应用 017/018
  await db().query(`DELETE FROM _migrations WHERE name IN (?, ?)`, SKIP);
  await migrate(db());
});

test('017 在有引用数据的库上迁移成功', async () => {
  const names = (await db().query('SELECT name FROM _migrations')).map((r) => r.name);
  assert.ok(names.includes('017_plan_executing.mjs'), '017 应已应用');
  const sql = await db().query(`SELECT sql FROM sqlite_master WHERE name='business_plans'`);
  assert.ok(sql[0].sql.includes('executing'), '新 CHECK 应含 executing');
});

test('计划与动作数据逐列完整（无静默丢列）', async () => {
  const p = await bstore.getPlan(tenant.id, plan.id);
  assert.equal(p.id, plan.id);
  assert.equal(p.intent_id, intent.id);
  assert.equal(p.status, 'approved');
  assert.equal(p.risk_estimate.x, 1);
  assert.deepEqual(p.ontology_gaps, []);
  const a = await bstore.getAction(tenant.id, action.id);
  assert.equal(a.id, action.id);
  assert.equal(a.plan_id, plan.id);
  assert.equal(a.idempotency_key, 'idem-m17-1');
});

test('新 CHECK：executing 允许，非法状态仍拒绝', async () => {
  assert.equal(await bstore.claimPlanForExecution(tenant.id, plan.id), true);
  assert.equal((await bstore.getPlan(tenant.id, plan.id)).status, 'executing');
  await assert.rejects(
    () => db().query(`UPDATE business_plans SET status='bogus' WHERE id=?`, [plan.id]),
    /CHECK|constraint/i, '非法状态应被 CHECK 拒绝');
});

test('FK 强制已恢复且无违反，索引重建', async () => {
  const fk = await db().query('PRAGMA foreign_keys');
  assert.equal(fk[0].foreign_keys, 1, '迁移后 FK 强制必须恢复');
  const violations = await db().query('PRAGMA foreign_key_check');
  assert.deepEqual(violations, [], 'foreign_key_check 应为空');
  // FK 仍有效：引用不存在计划的动作应失败
  await assert.rejects(
    () => bstore.createAction({
      tenantId: tenant.id, projectId: project.id, planId: 'bplan_nope', seq: 9,
      toolName: 't', args: {}, idempotencyKey: 'idem-m17-9',
    }),
    /FOREIGN KEY/i, 'FK 应仍强制');
  const idx = await db().query(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='business_plans'`);
  const names = idx.map((r) => r.name);
  assert.ok(names.includes('idx_bplan_intent') && names.includes('idx_bplan_tenant'), '索引应重建');
});
