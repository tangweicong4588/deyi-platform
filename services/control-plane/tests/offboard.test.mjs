/**
 * tests/offboard.test.mjs —— V2.12 租户 offboard（销户）。
 * - dryRun：只统计不删除，返回 counts + 合规包 manifest + confirm_token。
 * - confirm：token 缺失/伪造/跨租户/数据变化 → 拒绝；合法 token → 清除。
 * - 清除后：业务数据不可查、账单头保留、租户 purged、链可验（truncated）、旧锚定 archived。
 * - 幂等：重复 confirm 返回 already_purged；租户隔离（T2 不受影响）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-offboard-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.DEV_IDP_SECRET = 'test-dev-idp-secret';
process.env.BOOTSTRAP_ENABLED = 'false';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { append, verifyChain } = await import('../src/modules/evidence/audit.mjs');
const { verifyAnchors } = await import('../src/modules/evidence/anchor.mjs');
const { newTraceId } = await import('../src/kernel/context.mjs');
const { upsertMemories, searchMemories } = await import('../src/modules/memory/vector.mjs');
const { upsertChunks, searchChunks } = await import('../src/modules/knowledge/vector.mjs');

const OPERATOR_TOKEN = 'op_test_token';
let base, httpServer;
let T1, T2, t1Actor, t1KeySecret, t1Project;

const now = Date.now();
const auditEv = (tenantId, action) => append({
  tenantId, actorId: 'operator', traceId: newTraceId(),
  action, resourceKind: 'tenant', resourceId: tenantId, payload: {},
});

before(async () => {
  await openDb();
  await migrate(db());

  // T1：待销户租户，铺满各类数据
  T1 = await store.createTenant({ name: 'Offboard T1', slug: 'offboard-t1' });
  t1Project = await store.createProject(T1.id, { name: 'P1', slug: 'p1' });
  t1Actor = await store.createActor(T1.id, { kind: 'user', name: 'U1' });
  const k = mintKey();
  await store.createApiKeyRow({
    tenantId: T1.id, actorId: t1Actor.id, name: 'k1', prefix: k.prefix, keyHash: k.keyHash,
  });
  t1KeySecret = k.secret;
  await db().query(
    `INSERT INTO memories(id, tenant_id, project_id, actor_id, kind, content, created_at, updated_at)
     VALUES ('mem_o1', ?, ?, ?, 'semantic', 'm1', ?, ?), ('mem_o2', ?, ?, ?, 'episodic', 'm2', ?, ?)`,
    [T1.id, t1Project.id, t1Actor.id, now, now, T1.id, t1Project.id, t1Actor.id, now, now]);
  await db().query(
    `INSERT INTO memory_links(id, tenant_id, src_memory_id, dst_memory_id, relation, created_at)
     VALUES ('ml_o1', ?, 'mem_o1', 'mem_o2', 'relates_to', ?)`, [T1.id, now]);
  await db().query(
    `INSERT INTO model_calls(id, tenant_id, project_id, actor_id, trace_id, model, endpoint, status, created_at)
     VALUES ('call_o1', ?, ?, ?, 'tr_o1', 'deyi-default', 'chat.completions', 'ok', ?)`,
    [T1.id, t1Project.id, t1Actor.id, now]);
  await db().query(
    `INSERT INTO billing_invoices(id, tenant_id, period_key, plan, created_at)
     VALUES ('inv_o1', ?, '2026-09', 'trial', ?)`, [T1.id, now]);
  await auditEv(T1.id, 'tenant.provision');
  await auditEv(T1.id, 'memory.remember');
  const ev3 = await auditEv(T1.id, 'knowledge.ingest');
  const ev3row = await db().query('SELECT seq, hash FROM audit_events WHERE id=?', [ev3]);
  await db().query(
    `INSERT INTO anchors(id, tenant_id, chain_head_id, chain_head_hash, chain_head_seq, method, ref, status, created_at)
     VALUES ('anc_o1', ?, ?, ?, ?, 'manual', 'ref_o1', 'ok', ?)`,
    [T1.id, ev3, ev3row[0].hash, ev3row[0].seq, now]);
  // 向量派生索引（内存 fallback）
  await upsertMemories([{ id: 'mem_o1', vector: [0.1, 0.2], payload: { tenant_id: T1.id, memory_id: 'mem_o1' } }]);
  await upsertChunks([{ id: 'fact_o1', vector: [0.3, 0.4], payload: { tenant_id: T1.id, fact_id: 'fact_o1' } }]);

  // T2：隔离对照租户
  T2 = await store.createTenant({ name: 'Offboard T2', slug: 'offboard-t2' });
  const t2Actor = await store.createActor(T2.id, { kind: 'user', name: 'U2' });
  await db().query(
    `INSERT INTO memories(id, tenant_id, actor_id, kind, content, created_at, updated_at)
     VALUES ('mem_t2', ?, ?, 'semantic', 't2m', ?, ?)`, [T2.id, t2Actor.id, now, now]);
  await upsertMemories([{ id: 'mem_t2', vector: [0.5, 0.6], payload: { tenant_id: T2.id, memory_id: 'mem_t2' } }]);

  const app = createApp();
  registerIdentityRoutes(app);
  httpServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${httpServer.address().port}`;
});
after(() => new Promise((r) => httpServer.close(r)));

const post = (path, body, token = OPERATOR_TOKEN) =>
  fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
const count = async (t, tenantId) =>
  Number((await db().query(`SELECT COUNT(*) AS n FROM ${t} WHERE tenant_id=?`, [tenantId]))[0].n);

test('dryRun：统计准确、不删除数据、返回 token 与合规包 manifest', async () => {
  const beforeAudit = Number(
    (await db().query('SELECT COUNT(*) AS n FROM audit_events WHERE tenant_id=?', [T1.id]))[0].n);
  const r = await post(`/v1/admin/tenants/${T1.id}/offboard`, { phase: 'dryRun' });
  assert.equal(r.status, 200);
  const j = (await r.json()).data;
  assert.equal(j.phase, 'dryRun');
  assert.equal(j.counts.actors, 1);
  assert.equal(j.counts.memories, 2);
  assert.equal(j.counts.memory_links, 1);
  assert.equal(j.counts.model_calls, 1);
  assert.equal(j.counts.audit_events, beforeAudit + 1, '含 dryRun 自身的审计事件');
  assert.equal(j.counts.billing_invoices_kept, 1);
  assert.equal(j.counts.anchors_kept, 1);
  assert.ok(j.total_rows_to_delete > 0);
  assert.ok(j.confirm_token, '应签发 confirm_token');
  assert.ok(j.export_manifest.content_sha256, '合规包 manifest 应带内容 sha256');
  assert.equal(j.export_manifest.format, 'jsonl');
  // 未删除任何数据
  assert.equal(await count('actors', T1.id), 1);
  assert.equal(await count('memories', T1.id), 2);
});

test('confirm：缺少 token → 400；伪造 token → 403', async () => {
  const r1 = await post(`/v1/admin/tenants/${T1.id}/offboard`, { phase: 'confirm' });
  assert.equal(r1.status, 400);
  const r2 = await post(`/v1/admin/tenants/${T1.id}/offboard`, { phase: 'confirm', confirm_token: '12345.bad' });
  assert.equal(r2.status, 403);
});

test('confirm：跨租户 token → 403（token 绑定租户）', async () => {
  const dr = await (await post(`/v1/admin/tenants/${T2.id}/offboard`, { phase: 'dryRun' })).json();
  const r = await post(`/v1/admin/tenants/${T1.id}/offboard`, { phase: 'confirm', confirm_token: dr.data.confirm_token });
  assert.equal(r.status, 403);
});

test('confirm：dryRun 后数据变化 → token 失效（快照绑定）', async () => {
  const dr = await (await post(`/v1/admin/tenants/${T1.id}/offboard`, { phase: 'dryRun' })).json();
  const token = dr.data.confirm_token;
  await store.createActor(T1.id, { kind: 'user', name: 'U-sneaky' });
  const r = await post(`/v1/admin/tenants/${T1.id}/offboard`, { phase: 'confirm', confirm_token: token });
  assert.equal(r.status, 403);
  // 清理：删掉刚加的 actor，保持后续测试基线
  const sneak = await db().query("SELECT id FROM actors WHERE tenant_id=? AND name='U-sneaky'", [T1.id]);
  await db().query('DELETE FROM actors WHERE id=?', [sneak[0].id]);
});

test('confirm：合法 token → 销户成功，业务数据清除、账单/锚定保留', async () => {
  const dr = await (await post(`/v1/admin/tenants/${T1.id}/offboard`, { phase: 'dryRun' })).json();
  const r = await post(`/v1/admin/tenants/${T1.id}/offboard`, { phase: 'confirm', confirm_token: dr.data.confirm_token });
  assert.equal(r.status, 200);
  const j = (await r.json()).data;
  assert.equal(j.phase, 'confirm');
  assert.ok(j.purged_at);

  // 业务数据不可查
  for (const t of ['actors', 'projects', 'api_keys', 'auth_sessions', 'local_credentials',
    'memories', 'memory_links', 'model_calls', 'role_bindings', 'budgets', 'notify_channels']) {
    assert.equal(await count(t, T1.id), 0, `${t} 应被清空`);
  }
  // 保留：账单头、锚定引用
  assert.equal(await count('billing_invoices', T1.id), 1);
  assert.equal(await count('anchors', T1.id), 1);
  // 租户行：purged + 脱敏
  const tenant = await store.getTenant(T1.id);
  assert.equal(tenant.status, 'purged');
  assert.equal(tenant.name, '[purged]');
  assert.ok(tenant.slug.startsWith('purged-'));
  assert.ok(tenant.purged_at);

  // 链可验（truncated）
  const v = await verifyChain(T1.id);
  assert.equal(v.ok, true);
  assert.ok(v.truncated, '应识别为截断链');
  assert.equal(v.truncated.deleted_count, j.audit.wiped_events);
  // 旧锚定 → archived（非 broken）
  const va = await verifyAnchors(T1.id);
  assert.equal(va.anchors.length, 1);
  assert.equal(va.anchors[0].archived, true);

  // 向量派生索引清除（内存 fallback）
  const mres = await searchMemories({ vector: [0.1, 0.2], filter: { tenant_id: T1.id } });
  assert.equal(mres.filter((x) => x.memory_id === 'mem_o1').length, 0);
  const cres = await searchChunks({ vector: [0.3, 0.4], filter: { tenant_id: T1.id } });
  assert.equal(cres.length, 0);
  // T2 的向量不受影响
  const mres2 = await searchMemories({ vector: [0.5, 0.6], filter: { tenant_id: T2.id } });
  assert.ok(mres2.some((x) => x.memory_id === 'mem_t2'));

  // T2 数据隔离
  assert.equal(await count('actors', T2.id), 1);
  assert.equal(await count('memories', T2.id), 1);
});

test('销户后旧 API Key 立即 401', async () => {
  const r = await fetch(base + '/v1/me', { headers: { authorization: `Bearer ${t1KeySecret}` } });
  assert.equal(r.status, 401);
});

test('幂等：重复 confirm 返回 already_purged；dryRun 对已销户租户 → 409', async () => {
  const r1 = await post(`/v1/admin/tenants/${T1.id}/offboard`, { phase: 'confirm', confirm_token: 'x.y' });
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).data.already_purged, true);
  const r2 = await post(`/v1/admin/tenants/${T1.id}/offboard`, { phase: 'dryRun' });
  assert.equal(r2.status, 409);
});

test('phase 非法 → 400；未认证 → 401', async () => {
  const r1 = await post(`/v1/admin/tenants/${T2.id}/offboard`, { phase: 'nope' });
  assert.equal(r1.status, 400);
  const r2 = await post(`/v1/admin/tenants/${T2.id}/offboard`, { phase: 'dryRun' }, null);
  assert.equal(r2.status, 401);
});
