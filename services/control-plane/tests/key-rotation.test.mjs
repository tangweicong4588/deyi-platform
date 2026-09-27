/**
 * tests/key-rotation.test.mjs —— V2.5：API Key 轮换 + 细粒度 scope。
 * - 非法 scope 在签发时被拒绝（400 INVALID_SCOPE）
 * - 轮换：新 secret 仅返回一次；宽限期内双 key 可用；宽限期后旧 key 401
 * - 轮换记录 rotated_to 链路 + 审计事件 identity.apikey.rotated
 * - scope 强制：带 memory.read 的 key 调 remember → 403；recall → 200
 * - 空 scopes = 不限制（向后兼容）：历史 key 全路由可过
 * - 宽限期边界：graceHours 超范围 400；轮换已吊销 key 404
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-rot-')), 'test.db');
process.env.OPERATOR_TOKEN = 'test-operator-token-v25';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerMemoryRoutes } = await import('../src/modules/memory/routes.mjs');
const audit = await import('../src/modules/evidence/audit.mjs');

const OPERATOR = process.env.OPERATOR_TOKEN;
let tenantA, adminActor, adminSecret, base, appServer;

const post = (path, token, body) => fetch(base + path, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
});
const get = (path, token) => fetch(base + path, {
  headers: { authorization: `Bearer ${token}` },
});
const del = (path, token) => fetch(base + path, {
  method: 'DELETE',
  headers: { authorization: `Bearer ${token}` },
});
const mk = async (actorId, scopes = []) => {
  const k = mintKey();
  await store.createApiKeyRow({
    tenantId: tenantA.id, actorId, name: `k-${Date.now()}-${Math.random()}`, prefix: k.prefix, keyHash: k.keyHash, scopes,
  });
  return k.secret;
};

before(async () => {
  openDb();
  await migrate(db());
  await audit.initEvidence();

  tenantA = await store.createTenant({ name: 'ROT Tenant A' });
  adminActor = await store.createActor(tenantA.id, { kind: 'user', name: 'ROT Admin' });
  await store.bindRole(tenantA.id, adminActor.id, null, 'admin');
  adminSecret = await mk(adminActor.id);

  const app = createApp();
  registerIdentityRoutes(app);
  registerMemoryRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;
});

after(async () => { appServer.close(); });

test('非法 scope 在签发时被拒绝', async () => {
  const r = await post(`/v1/admin/tenants/${tenantA.id}/api-keys`, adminSecret, {
    actorId: adminActor.id, name: 'bad-scope-key', scopes: ['root.everything'],
  });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error?.details?.code, 'INVALID_SCOPE');
});

test('轮换全流程：双 key 可用 → 宽限期后旧 key 401 → 链路与审计', async () => {
  const oldSecret = await mk(adminActor.id);
  // 旧 key 先确认可用（recall 空库返回 200 即可）
  const okOld = await get(`/v1/tenants/${tenantA.id}/memory/recall?query=x`, oldSecret);
  assert.equal(okOld.status, 200);

  // 找到刚创建的 key id
  const keys = await store.listApiKeys(tenantA.id);
  const oldKey = keys[keys.length - 1];
  const rr = await post(
    `/v1/admin/tenants/${tenantA.id}/api-keys/${oldKey.id}/rotate`, adminSecret, { graceHours: 24 });
  assert.equal(rr.status, 201);
  const j = await rr.json();
  const newSecret = j.data.newKey.secret;
  assert.ok(newSecret && newSecret.startsWith('dyk_'), '新 secret 只返回一次');
  assert.ok(j.data.oldKey.rotated_to === j.data.newKey.id, '旧 key 记录 rotated_to 链路');
  assert.ok(j.data.graceUntil > Date.now(), '宽限期在未来');

  // 宽限期内：双 key 都可用
  assert.equal((await get(`/v1/tenants/${tenantA.id}/memory/recall?query=x`, oldSecret)).status, 200);
  assert.equal((await get(`/v1/tenants/${tenantA.id}/memory/recall?query=x`, newSecret)).status, 200);

  // 模拟宽限期结束：把旧 key 的 expires_at 拨到过去
  await db().run('UPDATE api_keys SET expires_at=? WHERE id=?', [Date.now() - 1000, oldKey.id]);
  assert.equal((await get(`/v1/tenants/${tenantA.id}/memory/recall?query=x`, oldSecret)).status, 401);
  assert.equal((await get(`/v1/tenants/${tenantA.id}/memory/recall?query=x`, newSecret)).status, 200);

  // 审计事件落库
  const evts = await db().query(
    "SELECT * FROM audit_events WHERE tenant_id=? AND action='identity.apikey.rotated'", [tenantA.id]);
  assert.ok(evts.length >= 1, '轮换写审计');
});

test('轮换参数边界：graceHours 超范围 400；轮换已吊销 key 404', async () => {
  const s = await mk(adminActor.id);
  const keys = await store.listApiKeys(tenantA.id);
  const k = keys[keys.length - 1];
  const r1 = await post(`/v1/admin/tenants/${tenantA.id}/api-keys/${k.id}/rotate`, adminSecret, { graceHours: 0 });
  assert.equal(r1.status, 400);
  const r2 = await post(`/v1/admin/tenants/${tenantA.id}/api-keys/${k.id}/rotate`, adminSecret, { graceHours: 999 });
  assert.equal(r2.status, 400);
  await del(`/v1/admin/tenants/${tenantA.id}/api-keys/${k.id}`, adminSecret);
  const r3 = await post(`/v1/admin/tenants/${tenantA.id}/api-keys/${k.id}/rotate`, adminSecret, { graceHours: 24 });
  assert.equal(r3.status, 404);
});

test('scope 强制：memory.read 的 key 写记忆 403、读 200；空 scope 不限制', async () => {
  const readOnly = await mk(adminActor.id, ['memory.read']);
  const w = await post(`/v1/tenants/${tenantA.id}/memory`, readOnly, { content: 'nope', kind: 'episodic' });
  assert.equal(w.status, 403);
  const r = await get(`/v1/tenants/${tenantA.id}/memory/recall?query=nope`, readOnly);
  assert.equal(r.status, 200);

  // 空 scopes = 向后兼容，不限制
  const legacy = await mk(adminActor.id, []);
  const w2 = await post(`/v1/tenants/${tenantA.id}/memory`, legacy, { content: 'legacy-ok', kind: 'episodic' });
  assert.equal(w2.status, 201);
});
