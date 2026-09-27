/**
 * tests/retention.test.mjs —— V2.7：数据保留策略。
 * - 策略合并：平台默认 + 租户 quotas 覆盖
 * - dryRun 只计数不删除；真实清扫删旧留新（终态/已处理才删）
 * - 审计前缀删除：检查点进链、链连续；无检查点的前缀缺失判 broken
 * - 锚定保护：默认不删被锚定覆盖的事件；显式开启后删除→锚定变 archived（非 broken）
 * - 路由：平台 operator 可跑批，租户 token 403
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-ret-')), 'test.db');
process.env.OPERATOR_TOKEN='test-operator-token';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerEvidenceRoutes } = await import('../src/modules/evidence/routes.mjs');
const audit = await import('../src/modules/evidence/audit.mjs');
const { verifyChain } = await import('../src/modules/evidence/audit.mjs');
const { verifyAnchors } = await import('../src/modules/evidence/anchor.mjs');
const retention = await import('../src/modules/evidence/retention.mjs');

const OPERATOR = process.env.OPERATOR_TOKEN;
const DAY = 86400_000;
let tenantA, tenantB, actorA, actorB, adminSecret, base, appServer;

const ev = (tenantId, i) => audit.append({
  tenantId, actorId: 'tester', traceId: `ret-test-${tenantId}-${i}-${Date.now()}`,
  action: 'ret.test', resourceKind: 'test', resourceId: `r${i}`, payload: { i },
});

before(async () => {
  openDb();
  await migrate(db());
  await audit.initEvidence();

  tenantA = await store.createTenant({ name: 'RET Tenant A' });
  tenantB = await store.createTenant({ name: 'RET Tenant B' });
  actorA = await store.createActor(tenantA.id, { kind: 'user', name: 'A Admin' });
  actorB = await store.createActor(tenantB.id, { kind: 'user', name: 'B Admin' });
  await store.bindRole(tenantA.id, actorA.id, null, 'admin');
  await store.bindRole(tenantB.id, actorB.id, null, 'admin');
  const k = mintKey();
  await store.createApiKeyRow({ tenantId: tenantA.id, actorId: actorA.id, name: 'k', prefix: k.prefix, keyHash: k.keyHash });
  adminSecret = k.secret;

  const app = createApp();
  registerIdentityRoutes(app);
  registerEvidenceRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;

  const now = Date.now();
  const oldTs = now - 200 * DAY;
  // tenantA：旧计量 / 新计量
  await db().query(
    `INSERT INTO model_calls(id, tenant_id, actor_id, trace_id, model, endpoint, total_tokens, status, created_at)
     VALUES ('call_old','${tenantA.id}','${actorA.id}','t1','m','chat.completions',10,'ok',${oldTs}),
            ('call_new','${tenantA.id}','${actorA.id}','t2','m','chat.completions',10,'ok',${now})`);
  // tenantA：投递记录——旧终态(删)/旧排队中(留)/新终态(留)
  await db().query(
    `INSERT INTO notify_deliveries(id, tenant_id, intent, payload, status, created_at, updated_at)
     VALUES ('nd_old_sent','${tenantA.id}','i','{}','sent',${oldTs},${oldTs}),
            ('nd_old_queued','${tenantA.id}','i','{}','queued',${oldTs},${oldTs}),
            ('nd_new_sent','${tenantA.id}','i','{}','sent',${now},${now})`);
  // tenantA：outbox——旧已处理(删)/旧未处理(留)
  await db().query(
    `INSERT INTO gateway_usage_outbox(id, tenant_id, payload_json, processed_at, created_at)
     VALUES ('uo_old_done','${tenantA.id}','{}',${oldTs},${oldTs}),
            ('uo_old_pending','${tenantA.id}','{}',NULL,${oldTs})`);
});

after(async () => { appServer?.close(); });

test('策略合并：默认 730/180/90/30，quotas 覆盖生效', async () => {
  const p0 = retention.getRetentionPolicy(tenantA);
  assert.equal(p0.audit_events_days, 730);
  assert.equal(p0.model_calls_days, 180);
  assert.equal(p0.notify_deliveries_days, 90);
  assert.equal(p0.usage_outbox_days, 30);
  assert.equal(p0.audit_include_anchored, false);

  await store.updateTenant(tenantA.id, {
    quotas: { retention_days_model_calls: 7, retention_audit_include_anchored: true },
  });
  const t = await store.getTenant(tenantA.id);
  const p1 = retention.getRetentionPolicy(t);
  assert.equal(p1.model_calls_days, 7);
  assert.equal(p1.audit_include_anchored, true);
  assert.equal(p1.audit_events_days, 730); // 未覆盖项保持默认
  // 恢复，避免影响后续测试
  await store.updateTenant(tenantA.id, { quotas: {} });
});

test('dryRun：只计数不删除', async () => {
  const r = await retention.sweepTenant(tenantA.id, { dryRun: true });
  assert.equal(r.dry_run, true);
  assert.equal(r.deleted.model_calls, 1);
  assert.equal(r.deleted.notify_deliveries, 1); // 只有旧终态；queued 不计
  assert.equal(r.deleted.usage_outbox, 1);       // 只有已处理
  const n = await db().query('SELECT COUNT(*) AS n FROM model_calls WHERE tenant_id=?', [tenantA.id]);
  assert.equal(Number(n[0].n), 2); // 一行没少
});

test('真实清扫：删旧留新，终态/已处理才删', async () => {
  const r = await retention.sweepTenant(tenantA.id);
  assert.equal(r.dry_run, false);
  assert.equal(r.deleted.model_calls, 1);
  assert.equal(r.deleted.notify_deliveries, 1);
  assert.equal(r.deleted.usage_outbox, 1);

  const calls = await db().query('SELECT id FROM model_calls WHERE tenant_id=?', [tenantA.id]);
  assert.deepEqual(calls.map((x) => x.id), ['call_new']);
  const nds = await db().query('SELECT id FROM notify_deliveries WHERE tenant_id=? ORDER BY id', [tenantA.id]);
  assert.deepEqual(nds.map((x) => x.id), ['nd_new_sent', 'nd_old_queued']);
  const uo = await db().query('SELECT id FROM gateway_usage_outbox WHERE tenant_id=?', [tenantA.id]);
  assert.deepEqual(uo.map((x) => x.id), ['uo_old_pending']);
  // 清扫本身写了审计事件
  const sweepEv = await db().query(
    `SELECT id FROM audit_events WHERE tenant_id=? AND action='retention.sweep'`, [tenantA.id]);
  assert.equal(sweepEv.length, 1);
});

test('审计前缀删除：检查点进链，链保持连续可验', async () => {
  await store.updateTenant(tenantB.id, { quotas: { retention_days_audit_events: 0 } });
  for (let i = 1; i <= 5; i++) await ev(tenantB.id, i);

  const r = await retention.sweepTenant(tenantB.id);
  assert.equal(r.deleted.audit_events, 5);
  assert.ok(r.checkpoint);
  assert.equal(r.checkpoint.deleted_count, 5);
  assert.equal(r.checkpoint.deleted_through_seq, 5);

  const v = await verifyChain(tenantB.id);
  assert.equal(v.ok, true);
  // 整链被删光后从检查点续起（seq 永不重启），属截断链，应标记 truncated
  assert.ok(v.truncated);
  assert.equal(v.truncated.deleted_through_seq, 5);
  assert.equal(v.truncated.deleted_count, 5);
  const remain = await db().query(
    `SELECT action, seq FROM audit_events WHERE tenant_id=? ORDER BY seq ASC`, [tenantB.id]);
  assert.deepEqual(remain.map((x) => x.action), ['retention.checkpoint', 'retention.sweep']);
  await store.updateTenant(tenantB.id, { quotas: {} });
});

test('截断验证：前缀被删但有检查点→ok + truncated', async () => {
  const t = await store.createTenant({ name: 'RET Trunc' });
  for (let i = 1; i <= 5; i++) {
    await audit.append({
      tenantId: t.id, actorId: 'tester', traceId: `trunc-${i}-${Date.now()}`,
      action: 'ret.trunc', resourceKind: 'test', resourceId: `r${i}`, payload: {},
    });
  }
  const ev2 = await db().query(
    'SELECT hash FROM audit_events WHERE tenant_id=? AND seq=2', [t.id]);
  // 模拟"策略删除"：删前缀但不写检查点→先手动补一个合法检查点
  await retention.withRetentionBypass(async (h) => {
    await h.query('DELETE FROM audit_events WHERE tenant_id=? AND seq<=2', [t.id]);
  });
  await audit.append({
    tenantId: t.id, actorId: 'system:retention', traceId: `trunc-cp-${Date.now()}`,
    action: 'retention.checkpoint', resourceKind: 'tenant', resourceId: t.id,
    payload: { deleted_through_seq: 2, deleted_through_hash: ev2[0].hash, deleted_count: 2 },
  });

  const v = await verifyChain(t.id);
  assert.equal(v.ok, true);
  assert.ok(v.truncated);
  assert.equal(v.truncated.deleted_through_seq, 2);
  assert.equal(v.truncated.deleted_count, 2);
});

test('无检查点的前缀缺失判 broken（防绕过策略删除）', async () => {
  const t = await store.createTenant({ name: 'RET Tamper' });
  for (let i = 1; i <= 3; i++) {
    await audit.append({
      tenantId: t.id, actorId: 'tester', traceId: `tamper-${i}-${Date.now()}`,
      action: 'ret.tamper', resourceKind: 'test', resourceId: `r${i}`, payload: {},
    });
  }
  await retention.withRetentionBypass(async (h) => {
    await h.query('DELETE FROM audit_events WHERE tenant_id=? AND seq<=2', [t.id]);
  });
  const v = await verifyChain(t.id);
  assert.equal(v.ok, false);
  assert.match(v.brokenAt.reason, /无保留检查点/);
});

test('锚定保护：默认不删被锚定覆盖的旧事件', async () => {
  const t = await store.createTenant({ name: 'RET Anchor' });
  for (let i = 1; i <= 4; i++) {
    await audit.append({
      tenantId: t.id, actorId: 'tester', traceId: `anc-${i}-${Date.now()}`,
      action: 'ret.anc', resourceKind: 'test', resourceId: `r${i}`, payload: {},
    });
  }
  const head2 = await db().query(
    'SELECT id, hash FROM audit_events WHERE tenant_id=? AND seq=2', [t.id]);
  await db().query(
    `INSERT INTO anchors(id, tenant_id, chain_head_id, chain_head_hash, chain_head_seq, method, status, created_at)
     VALUES ('anc_1',?,?,?,2,'manual','ok',?)`,
    [t.id, head2[0].id, head2[0].hash, Date.now()]);
  await store.updateTenant(t.id, { quotas: { retention_days_audit_events: 0 } });

  const r = await retention.sweepTenant(t.id);
  assert.equal(r.deleted.audit_events, 2); // 只删 seq 3,4；1,2 被锚定保护
  const v = await verifyChain(t.id);
  assert.equal(v.ok, true);
  const va = await verifyAnchors(t.id);
  assert.equal(va.verified, true);
  assert.equal(va.anchors[0].ok, true);
});

test('锚定归档：显式开启后删除锚定事件→archived 而非 broken', async () => {
  const t = await store.createTenant({ name: 'RET Arch' });
  for (let i = 1; i <= 3; i++) {
    await audit.append({
      tenantId: t.id, actorId: 'tester', traceId: `arch-${i}-${Date.now()}`,
      action: 'ret.arch', resourceKind: 'test', resourceId: `r${i}`, payload: {},
    });
  }
  const head2 = await db().query(
    'SELECT id, hash FROM audit_events WHERE tenant_id=? AND seq=2', [t.id]);
  await db().query(
    `INSERT INTO anchors(id, tenant_id, chain_head_id, chain_head_hash, chain_head_seq, method, status, created_at)
     VALUES ('anc_2',?,?,?,2,'manual','ok',?)`,
    [t.id, head2[0].id, head2[0].hash, Date.now()]);
  await store.updateTenant(t.id, {
    quotas: { retention_days_audit_events: 0, retention_audit_include_anchored: true },
  });

  const r = await retention.sweepTenant(t.id);
  assert.equal(r.deleted.audit_events, 3);
  const va = await verifyAnchors(t.id);
  assert.equal(va.verified, false);
  assert.equal(va.anchors[0].archived, true); // 归档，非篡改
  assert.match(va.anchors[0].reason, /归档/);
  const v = await verifyChain(t.id);
  assert.equal(v.ok, true); // 剩余链（检查点起）连续
});

test('路由：平台 operator 可跑批 dryRun；租户 token 403', async () => {
  const ok = await fetch(base + '/v1/admin/retention/sweep', {
    method: 'POST',
    headers: { authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tenantId: tenantA.id, dryRun: true }),
  });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.data.dry_run, true);
  assert.equal(body.data.tenants, 1);

  const f = await fetch(base + '/v1/admin/retention/sweep', {
    method: 'POST',
    headers: { authorization: `Bearer ${adminSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ dryRun: true }),
  });
  assert.equal(f.status, 403);
});
