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

test('开发 IdP 签发的 JWT 可认证', async () => {
  const idp = getIdP();
  assert.equal(idp.kind, 'dev');
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
