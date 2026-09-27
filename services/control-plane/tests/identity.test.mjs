/** identity 测试：租户/项目/Key/RBAC/认证中间件（SQLite 临时库） */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 必须在 import 业务模块之前设置（config 在 import 时加载）
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-test-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.DEV_IDP_SECRET = 'test-dev-secret';
process.env.BOOTSTRAP_ENABLED = 'false';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { mintKey, verifyApiKey } = await import('../src/modules/identity/keys.mjs');
const { createApp, sendJson } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { getIdP } = await import('../src/modules/identity/idp.mjs');

let tenantA, tenantB, adminActor, viewerActor, adminKey, adminSecret, viewerSecret;

before(async () => {
  await openDb();
  await migrate(db());

  tenantA = await store.createTenant({ name: 'Tenant A' });
  tenantB = await store.createTenant({ name: 'Tenant B' });
  adminActor = await store.createActor(tenantA.id, { kind: 'user', name: 'Admin' });
  viewerActor = await store.createActor(tenantA.id, { kind: 'user', name: 'Viewer' });
  await store.bindRole(tenantA.id, adminActor.id, null, 'admin');
  await store.bindRole(tenantA.id, viewerActor.id, null, 'viewer');

  const k1 = mintKey();
  adminKey = await store.createApiKeyRow({
    tenantId: tenantA.id, actorId: adminActor.id, name: 'adminkey',
    prefix: k1.prefix, keyHash: k1.keyHash,
  });
  adminSecret = k1.secret;

  const k2 = mintKey();
  await store.createApiKeyRow({
    tenantId: tenantA.id, actorId: viewerActor.id, name: 'viewerkey',
    prefix: k2.prefix, keyHash: k2.keyHash,
  });
  viewerSecret = k2.secret;
});

test('Key 校验成功返回租户与主体', async () => {
  const { tenant, actor } = await verifyApiKey(adminSecret, {
    getTenant: store.getTenant, getActor: store.getActor,
  });
  assert.equal(tenant.id, tenantA.id);
  assert.equal(actor.id, adminActor.id);
});

test('伪造/篡改的 Key 一律 401（不泄露原因）', async () => {
  await assert.rejects(
    verifyApiKey(adminSecret.slice(0, -2) + 'xx', { getTenant: store.getTenant, getActor: store.getActor }),
    (e) => e.status === 401);
  await assert.rejects(
    verifyApiKey('dyk_' + 'z'.repeat(32), { getTenant: store.getTenant, getActor: store.getActor }),
    (e) => e.status === 401);
});

test('吊销后 Key 立即失效', async () => {
  const k = mintKey();
  const row = await store.createApiKeyRow({
    tenantId: tenantA.id, actorId: adminActor.id, name: 'temp',
    prefix: k.prefix, keyHash: k.keyHash,
  });
  await store.revokeApiKey(tenantA.id, row.id);
  await assert.rejects(
    verifyApiKey(k.secret, { getTenant: store.getTenant, getActor: store.getActor }),
    (e) => e.status === 401);
});

test('租户 slug 冲突 → 409', async () => {
  await assert.rejects(store.createTenant({ name: 'x', slug: tenantA.slug }), (e) => e.status === 409);
});

// ---------- HTTP 层 ----------
let base, httpServer;
before(async () => {
  const app = createApp();
  app.get('/healthz', async (req, res) => sendJson(res, 200, { status: 'ok' }));
  registerIdentityRoutes(app);
  httpServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${httpServer.address().port}`;
});
after(() => new Promise((r) => httpServer.close(r)));

const req = (path, { method = 'GET', token = null, body = undefined } = {}) =>
  fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

test('未认证 → 401', async () => {
  const r = await req('/v1/me');
  assert.equal(r.status, 401);
});

test('/v1/me 返回身份与租户', async () => {
  const r = await req('/v1/me', { token: adminSecret });
  assert.equal(r.status, 200);
  const { data } = await r.json();
  assert.equal(data.tenant.slug, tenantA.slug);
  assert.equal(data.actor.name, 'Admin');
});

test('admin 可建项目，viewer 被 403', async () => {
  const r1 = await req(`/v1/admin/tenants/${tenantA.id}/projects`, {
    method: 'POST', token: adminSecret, body: { name: 'P1' },
  });
  assert.equal(r1.status, 201);

  const r2 = await req(`/v1/admin/tenants/${tenantA.id}/projects`, {
    method: 'POST', token: viewerSecret, body: { name: 'P2' },
  });
  assert.equal(r2.status, 403);
});

test('跨租户访问被 403（租户隔离）', async () => {
  const r = await req(`/v1/admin/tenants/${tenantB.id}/projects`, {
    method: 'POST', token: adminSecret, body: { name: 'hack' },
  });
  assert.equal(r.status, 403);
  // 租户 B 里确实没有被建出项目
  assert.equal((await store.listProjects(tenantB.id)).length, 0);
});

test('operator token 可建租户，普通 key 不行', async () => {
  const r1 = await req('/v1/admin/tenants', {
    method: 'POST', token: 'op_test_token', body: { name: 'Tenant C' },
  });
  assert.equal(r1.status, 201);

  const r2 = await req('/v1/admin/tenants', {
    method: 'POST', token: adminSecret, body: { name: 'Tenant D' },
  });
  assert.equal(r2.status, 403);
});

test('本地 IdP 签发的 JWT 可认证', async () => {
  const idp = getIdP();
  assert.equal(idp.kind, 'local');
  const jwt = idp.issueDevToken(adminActor, tenantA);
  const r = await req('/v1/me', { token: jwt });
  assert.equal(r.status, 200);
  const { data } = await r.json();
  assert.equal(data.authKind, 'jwt');
  assert.equal(data.actor.name, 'Admin');
});

test('API Key 列表不泄露 hash/secret', async () => {
  const r = await req(`/v1/admin/tenants/${tenantA.id}/api-keys`, { token: adminSecret });
  assert.equal(r.status, 200);
  const { data } = await r.json();
  assert.ok(data.length > 0);
  for (const k of data) {
    assert.ok(!('key_hash' in k));
    assert.ok(!('key' in k));
    assert.ok(k.prefix.startsWith('dyk_'));
  }
});

test('pepper A→B 轮换：旧 key 过渡期可用，移除旧 pepper 后失效', async () => {
  const keysMod = await import('../src/modules/identity/keys.mjs');
  const setChain = keysMod.__internal.setPepperChain;
  try {
    // 阶段1：pepper=A 时签发
    setChain(['A', '']);
    const k = mintKey();
    await store.createApiKeyRow({
      tenantId: tenantA.id, actorId: adminActor.id, name: 'rotkey',
      prefix: k.prefix, keyHash: k.keyHash,
    });
    // 阶段2：轮换到 B，A 保留在 _PREVIOUS → 旧 key 仍可用
    setChain(['B', 'A', '']);
    const r1 = await req('/v1/me', { token: k.secret });
    assert.equal(r1.status, 200, '轮换过渡期旧 key 应仍可用');
    // 新签发的 key 走 B
    const k2 = mintKey();
    await store.createApiKeyRow({
      tenantId: tenantA.id, actorId: adminActor.id, name: 'rotkey2',
      prefix: k2.prefix, keyHash: k2.keyHash,
    });
    const r2 = await req('/v1/me', { token: k2.secret });
    assert.equal(r2.status, 200, '新 pepper 签发的 key 应可用');
    // 阶段3：A 从 _PREVIOUS 移除 → 旧 key 失效，新 key 仍可用
    setChain(['B', '']);
    const r3 = await req('/v1/me', { token: k.secret });
    assert.equal(r3.status, 401, '移除旧 pepper 后旧 key 应失效');
    const r4 = await req('/v1/me', { token: k2.secret });
    assert.equal(r4.status, 200, '新 key 不受影响');
    // pepper 启用前的无 pepper 旧格式（sha256(secret)）在链尾永远兼容
    setChain(['B', '']);
    const legacy = mintKey.call(null); // 链首是 B；手动构造无 pepper 版
    void legacy;
    const { createHash } = await import('node:crypto');
    const secretOnly = 'dyk_' + createHash('sha256').update('legacy-test').digest('hex').slice(0, 32);
    const legacyHash = createHash('sha256').update(secretOnly, 'utf8').digest('hex');
    await store.createApiKeyRow({
      tenantId: tenantA.id, actorId: adminActor.id, name: 'legacykey',
      prefix: secretOnly.slice(0, 12), keyHash: legacyHash,
    });
    const r5 = await req('/v1/me', { token: secretOnly });
    assert.equal(r5.status, 200, '无 pepper 历史格式应永远兼容');
  } finally {
    setChain(null); // 恢复走 config
  }
});

test('生产配置缺失关键项 → 启动时 fail-fast', async () => {
  const prevEnv = process.env.DEYI_ENV;
  const prevDb = process.env.DATABASE_URL;
  const prevAuth = process.env.AUTH_JWT_SECRET;
  process.env.DEYI_ENV = 'production';
  delete process.env.DATABASE_URL;
  delete process.env.AUTH_JWT_SECRET;
  try {
    await assert.rejects(
      () => import('../src/kernel/config.mjs?prod-failfast'),
      (e) => {
        assert.match(String(e && e.message || e), /生产配置校验失败/);
        assert.match(String(e && e.message || e), /DATABASE_URL/);
        assert.match(String(e && e.message || e), /AUTH_JWT_SECRET/);
        return true;
      },
      '生产缺 DATABASE_URL/AUTH_JWT_SECRET 应启动失败',
    );
  } finally {
    if (prevEnv === undefined) delete process.env.DEYI_ENV; else process.env.DEYI_ENV = prevEnv;
    if (prevDb !== undefined) process.env.DATABASE_URL = prevDb;
    if (prevAuth !== undefined) process.env.AUTH_JWT_SECRET = prevAuth;
  }
});

test('API Key 签发响应：secret 仅返回一次，不泄露 hash', async () => {
  const r = await req(`/v1/admin/tenants/${tenantA.id}/api-keys`, {
    method: 'POST', token: adminSecret, body: { name: 'oncekey', actorId: adminActor.id },
  });
  assert.equal(r.status, 201);
  const { data } = await r.json();
  assert.ok(typeof data.key === 'string' && data.key.startsWith('dyk_'), '创建响应应返回一次 secret');
  assert.ok(!('key_hash' in data) && !('keyHash' in data), '创建响应不得泄露 hash');
  // secret 可用
  const r2 = await req('/v1/me', { token: data.key });
  assert.equal(r2.status, 200);
});
