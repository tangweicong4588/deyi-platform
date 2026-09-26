/** evidence 测试：审计哈希链 / append-only / 证据包 / 成本账本 / 锚定 / tracing */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 必须在 import 业务模块之前设置（config 在 import 时加载）
// 注意：不设 AUDIT_ANCHOR_URL / OTEL_EXPORTER_OTLP_ENDPOINT，测缺配置路径
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-ev-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.DEV_IDP_SECRET = 'test-dev-secret';
process.env.BOOTSTRAP_ENABLED = 'false';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerEvidenceRoutes } = await import('../src/modules/evidence/routes.mjs');
const audit = await import('../src/modules/evidence/audit.mjs');
const { buildPackage, verifyPackage, merkleRoot } = await import('../src/modules/evidence/packages.mjs');
const { queryCost, rollupCostLedger, readLedger } = await import('../src/modules/evidence/cost.mjs');
const { getAnchorStatus, anchorChain, isAnchorConfigured } = await import('../src/modules/evidence/anchor.mjs');
const tracing = await import('../src/kernel/tracing.mjs');
const onto = await import('../src/modules/ontology/service.mjs');

let tenantA, tenantB, projectA, adminActor, viewerActor, operatorActor;
let adminSecret, viewerSecret, operatorSecret, tenantBAdminSecret;

before(async () => {
  await openDb();
  await migrate(db());
  await audit.initEvidence();

  tenantA = await store.createTenant({ name: 'EV Tenant A' });
  tenantB = await store.createTenant({ name: 'EV Tenant B' });
  projectA = await store.createProject(tenantA.id, { name: 'EV Project' });
  adminActor = await store.createActor(tenantA.id, { kind: 'user', name: 'EV Admin' });
  viewerActor = await store.createActor(tenantA.id, { kind: 'user', name: 'EV Viewer' });
  operatorActor = await store.createActor(tenantA.id, { kind: 'user', name: 'EV Operator' });
  await store.bindRole(tenantA.id, adminActor.id, null, 'admin');
  await store.bindRole(tenantA.id, viewerActor.id, null, 'viewer');
  await store.bindRole(tenantA.id, operatorActor.id, null, 'operator');
  const bAdmin = await store.createActor(tenantB.id, { kind: 'user', name: 'B Admin' });
  await store.bindRole(tenantB.id, bAdmin.id, null, 'admin');

  const mk = async (tenantId, actorId, name) => {
    const k = mintKey();
    await store.createApiKeyRow({ tenantId, actorId, name, prefix: k.prefix, keyHash: k.keyHash });
    return k.secret;
  };
  adminSecret = await mk(tenantA.id, adminActor.id, 'ev-admin');
  viewerSecret = await mk(tenantA.id, viewerActor.id, 'ev-viewer');
  operatorSecret = await mk(tenantA.id, operatorActor.id, 'ev-operator');
  tenantBAdminSecret = await mk(tenantB.id, bAdmin.id, 'ev-b-admin');
});

let base, appServer;
before(async () => {
  const app = createApp();
  registerIdentityRoutes(app);
  registerEvidenceRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;
});
after(() => new Promise((r) => appServer.close(r)));

const get = (path, token, q = '') => fetch(base + path + q, {
  headers: { authorization: `Bearer ${token}` },
});
const post = (path, token, body) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify(body || {}),
});

// ---------- 哈希链 ----------

test('append 形成哈希链：prev 链接 + seq 单调', async () => {
  const id1 = await audit.append({
    tenantId: tenantA.id, actorId: adminActor.id, traceId: 'tr-ev-1',
    action: 'test.evt', resourceKind: 'doc', resourceId: 'r1', payload: { a: 1 },
  });
  const id2 = await audit.append({
    tenantId: tenantA.id, actorId: adminActor.id, traceId: 'tr-ev-2',
    action: 'test.evt', resourceKind: 'doc', resourceId: 'r2', payload: { b: 2 },
  });
  const rows = await db().query('SELECT * FROM audit_events WHERE tenant_id=? ORDER BY seq', [tenantA.id]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].seq, 1);
  assert.equal(rows[0].prev_hash, 'GENESIS');
  assert.equal(rows[1].seq, 2);
  assert.equal(rows[1].prev_hash, rows[0].hash);
  assert.ok(id1 !== id2);
});

test('幂等：同 trace+action+resource 重复 append 不重复写', async () => {
  const before = await db().query('SELECT COUNT(*) AS c FROM audit_events WHERE tenant_id=?', [tenantA.id]);
  const id1 = await audit.append({
    tenantId: tenantA.id, actorId: adminActor.id, traceId: 'tr-dedup',
    action: 'test.dedup', resourceKind: 'doc', resourceId: 'rd', payload: {},
  });
  const id2 = await audit.append({
    tenantId: tenantA.id, actorId: adminActor.id, traceId: 'tr-dedup',
    action: 'test.dedup', resourceKind: 'doc', resourceId: 'rd', payload: {},
  });
  assert.equal(id1, id2);
  const after = await db().query('SELECT COUNT(*) AS c FROM audit_events WHERE tenant_id=?', [tenantA.id]);
  assert.equal(Number(after[0].c), Number(before[0].c) + 1);
});

test('并发 append 10 条：seq 无断裂，验链通过', async () => {
  await Promise.all([...Array(10)].map((_, i) => audit.append({
    tenantId: tenantA.id, actorId: adminActor.id, traceId: `tr-conc-${i}`,
    action: 'test.conc', resourceKind: 'doc', resourceId: `rc-${i}`, payload: { i },
  })));
  const seqs = (await db().query(
    'SELECT seq FROM audit_events WHERE tenant_id=? ORDER BY seq', [tenantA.id])).map((r) => r.seq);
  for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], seqs[i - 1] + 1);
  const v = await audit.verifyChain(tenantA.id);
  assert.equal(v.ok, true);
  assert.equal(v.checked, seqs.length);
});

test('篡改 payload 后验链定位断裂位置', async () => {
  // 临时撤掉触发器做篡改（append-only 由下一项测试锁定）
  await db().exec('DROP TRIGGER IF EXISTS trg_audit_no_update');
  const victim = (await db().query(
    'SELECT id, seq, payload FROM audit_events WHERE tenant_id=? ORDER BY seq LIMIT 1', [tenantA.id]))[0];
  const originalPayload = victim.payload;
  await db().query('UPDATE audit_events SET payload=? WHERE id=?', ['{"tampered":true}', victim.id]);
  const v = await audit.verifyChain(tenantA.id);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt.seq, victim.seq);
  assert.match(v.brokenAt.reason, /篡改/);
  // 恢复原值 + 重建触发器（后面的测试需要一条健康的链）
  await db().query('UPDATE audit_events SET payload=? WHERE id=?', [originalPayload, victim.id]);
  await audit.initEvidence();
  assert.equal((await audit.verifyChain(tenantA.id)).ok, true);
});

test('append-only：UPDATE / DELETE 被触发器拒绝', async () => {
  const row = (await db().query(
    'SELECT id FROM audit_events WHERE tenant_id=? LIMIT 1', [tenantA.id]))[0];
  await assert.rejects(
    db().query('UPDATE audit_events SET payload=? WHERE id=?', ['{}', row.id]),
    /append-only/);
  await assert.rejects(
    db().query('DELETE FROM audit_events WHERE id=?', [row.id]),
    /append-only/);
});

// ---------- 证据包 ----------

test('证据包：打包 → 验包 → 下载', async () => {
  const ids = (await db().query(
    'SELECT id FROM audit_events WHERE tenant_id=? ORDER BY seq LIMIT 3', [tenantA.id])).map((r) => r.id);
  const pkg = await buildPackage({
    tenantId: tenantA.id, name: '包-001', eventIds: ids, createdBy: adminActor.id,
  });
  assert.ok(pkg.merkle_root);
  assert.equal(pkg.event_count, 3);
  const v = await verifyPackage(tenantA.id, pkg.id);
  assert.equal(v.ok, true);

  // merkle 根可独立重算
  const rows = await db().query(
    `SELECT hash FROM audit_events WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY seq`, ids);
  assert.equal(pkg.merkle_root, merkleRoot(rows.map((r) => r.hash)));

  // 跨租户事件混入 → 拒绝
  const other = await audit.append({
    tenantId: tenantB.id, actorId: adminActor.id, traceId: 'tr-other',
    action: 'test.other', resourceKind: 'doc', payload: {},
  });
  await assert.rejects(
    buildPackage({ tenantId: tenantA.id, name: '坏包', eventIds: [...ids, other], createdBy: adminActor.id }),
    /不属于本租户/);
});

test('证据包 API：打包/下载/验包 + 越权拒绝', async () => {
  const r = await post(`/v1/admin/tenants/${tenantA.id}/evidence/packages`, operatorSecret, { name: 'api-包' });
  assert.equal(r.status, 201);
  const pkg = (await r.json()).data;

  const dl = await get(`/v1/admin/tenants/${tenantA.id}/evidence/packages/${pkg.id}/download`, viewerSecret);
  assert.equal(dl.status, 200);
  const bundle = await dl.json();
  assert.equal(bundle.package.merkle_root, pkg.merkle_root);
  assert.ok(bundle.events.length > 0);

  const v = await post(`/v1/admin/tenants/${tenantA.id}/evidence/packages/${pkg.id}/verify`, operatorSecret);
  assert.equal((await v.json()).data.ok, true);

  // viewer 不能打包（operator+）
  const r2 = await post(`/v1/admin/tenants/${tenantA.id}/evidence/packages`, viewerSecret, { name: 'x' });
  assert.equal(r2.status, 403);
  // 跨租户
  const r3 = await get(`/v1/admin/tenants/${tenantA.id}/evidence/packages/${pkg.id}/download`, tenantBAdminSecret);
  assert.equal(r3.status, 403);
});

// ---------- 审计查询 / 验链 API ----------

test('审计查询与验链 API：权限与隔离', async () => {
  const r = await get(`/v1/admin/tenants/${tenantA.id}/evidence/audit`, viewerSecret, '?limit=5');
  assert.equal(r.status, 200);
  const { data } = await r.json();
  assert.ok(data.length > 0);
  assert.ok(data[0].hash);

  const v = await post(`/v1/admin/tenants/${tenantA.id}/evidence/audit/verify`, operatorSecret, {});
  assert.equal(v.status, 200);
  assert.equal((await v.json()).data.ok, true);

  // viewer 不能验链
  const v2 = await post(`/v1/admin/tenants/${tenantA.id}/evidence/audit/verify`, viewerSecret, {});
  assert.equal(v2.status, 403);
  // 跨租户
  const r2 = await get(`/v1/admin/tenants/${tenantA.id}/evidence/audit`, tenantBAdminSecret);
  assert.equal(r2.status, 403);
  // 未认证
  const r3 = await fetch(base + `/v1/admin/tenants/${tenantA.id}/evidence/audit`);
  assert.equal(r3.status, 401);
});

// ---------- 成本账本 ----------

async function seedCalls() {
  const now = Date.now();
  const day1 = new Date('2026-09-20T10:00:00').getTime();
  const rows = [
    // [project, model, tokens, cost, ts]
    [projectA.id, 'deyi-default', 100, 10, day1],
    [projectA.id, 'deyi-default', 200, 20, day1 + 3600000],
    [projectA.id, 'deyi-embedding', 50, 1, day1],
    [null, 'deyi-default', 300, 30, now], // 租户级调用
  ];
  let i = 0;
  for (const [proj, model, tokens, cost, ts] of rows) {
    await db().query(
      `INSERT INTO model_calls(id, tenant_id, project_id, actor_id, trace_id, model, litellm_model,
        endpoint, prompt_tokens, completion_tokens, total_tokens, cost_cents, latency_ms, status, cached, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [`call_seed_${i++}`, tenantA.id, proj, adminActor.id, `tr-cost-${i}`, model, model,
       'chat.completions', tokens, 0, tokens, cost, 5, 'ok', 0, ts]);
  }
}

test('成本聚合：数字与 model_calls 明细对得上', async () => {
  await seedCalls();
  const byModel = await queryCost(tenantA.id, { groupBy: 'model' });
  const m = Object.fromEntries(byModel.data.map((g) => [g.key, g]));
  assert.equal(m['deyi-default'].tokens, 600);
  assert.equal(m['deyi-default'].cost_cents, 60);
  assert.equal(m['deyi-default'].calls, 3);
  assert.equal(m['deyi-embedding'].tokens, 50);
  assert.equal(byModel.total.tokens, 650);
  assert.equal(byModel.total.cost_cents, 61);
  assert.equal(byModel.total.calls, 4);

  const byDay = await queryCost(tenantA.id, { groupBy: 'day', from: '2026-09-20', to: '2026-09-26' });
  const d = Object.fromEntries(byDay.data.map((g) => [g.key, g]));
  assert.equal(d['2026-09-20'].tokens, 350);
  assert.equal(d['2026-09-20'].calls, 3);

  const byProject = await queryCost(tenantA.id, { groupBy: 'project' });
  const p = Object.fromEntries(byProject.data.map((g) => [g.key, g]));
  assert.equal(p[projectA.id].tokens, 350);
  assert.equal(p['(租户级)'].tokens, 300);
});

test('物化 rollup 与实时聚合一致（不重复记账）', async () => {
  const r1 = await rollupCostLedger({});
  assert.ok(r1.written > 0);
  const r2 = await rollupCostLedger({}); // 幂等重跑
  assert.equal(r2.written, r1.written);
  const ledger = await readLedger(tenantA.id, {});
  const lt = ledger.reduce((t, x) => ({
    tokens: t.tokens + x.tokens, cost_cents: t.cost_cents + x.cost_cents, calls: t.calls + x.calls,
  }), { tokens: 0, cost_cents: 0, calls: 0 });
  const live = await queryCost(tenantA.id, {});
  assert.deepEqual(lt, live.total);
});

test('成本 API：admin 可查，viewer 被拒，跨租户被拒', async () => {
  const r = await get(`/v1/admin/tenants/${tenantA.id}/cost`, adminSecret, '?groupBy=model');
  assert.equal(r.status, 200);
  const { data } = await r.json();
  assert.equal(data.total.calls, 4);

  const r2 = await get(`/v1/admin/tenants/${tenantA.id}/cost`, viewerSecret);
  assert.equal(r2.status, 403);
  const r3 = await get(`/v1/admin/tenants/${tenantA.id}/cost`, tenantBAdminSecret);
  assert.equal(r3.status, 403);
});

// ---------- 锚定 ----------

test('锚定缺配置：明确 anchored:false，不伪造', async () => {
  assert.equal(isAnchorConfigured(), false);
  const s = await get(`/v1/admin/tenants/${tenantA.id}/evidence/anchor`, viewerSecret);
  assert.equal(s.status, 200);
  const st = (await s.json()).data;
  assert.equal(st.anchored, false);
  assert.match(st.reason, /未配置/);

  const a = await post(`/v1/admin/tenants/${tenantA.id}/evidence/anchor`, operatorSecret, {});
  assert.equal(a.status, 200);
  assert.equal((await a.json()).data.anchored, false);

  // 直接调 service 同样诚实
  const direct = await anchorChain(tenantA.id);
  assert.equal(direct.anchored, false);
});

// ---------- tracing ----------

test('tracing 无端点：no-op，不抛错不发请求', async () => {
  assert.equal(tracing.isTracingEnabled(), false);
  const s = tracing.startSpan('test.span', { k: 'v' });
  s.setAttr('k2', 1);
  s.end(); // 不应抛错、不应有网络行为
  const v = await tracing.withSpan('test.wrap', {}, async () => 42);
  assert.equal(v, 42);
});

// ---------- 审计钩子（真实业务流） ----------

test('本体发布钩子：publishTerm 落审计事件', async () => {
  const { term: cand } = await onto.submitCandidate({
    tenantId: tenantA.id, projectId: projectA.id, name: '审计测试术语',
    kind: 'concept', definition: '用于验证审计钩子', evidence: [], actorId: adminActor.id,
  });
  await onto.startReview({ tenantId: tenantA.id, termId: cand.id });
  await onto.publishTerm({ tenantId: tenantA.id, termId: cand.id, actorId: adminActor.id });
  const rows = await db().query(
    `SELECT * FROM audit_events WHERE tenant_id=? AND action='ontology.publish' AND resource_id=?`,
    [tenantA.id, cand.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_id, adminActor.id);
  const v = await audit.verifyChain(tenantA.id);
  assert.equal(v.ok, true); // 钩子写入后链仍连续
});
