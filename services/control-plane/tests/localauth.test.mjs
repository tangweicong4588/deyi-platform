/** localauth 测试：自研身份服务（密码/TOTP/锁定/refresh/审计）与 OIDC 未配置路径 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 必须在 import 业务模块之前设置（config 在 import 时加载）
// 注意：故意不设 OIDC_*，覆盖"OIDC 未配置"路径（配置态见 oidc-client.test.mjs）
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-test-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.DEV_IDP_SECRET = 'test-local-jwt-secret';
process.env.BOOTSTRAP_ENABLED = 'false';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp, sendJson } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerAuthRoutes } = await import('../src/modules/identity/auth-routes.mjs');
const { hashPassword, verifyPassword } = await import('../src/modules/identity/passwords.mjs');
const { totpCode } = await import('../src/modules/identity/totp.mjs');
const localauth = await import('../src/modules/identity/localauth.mjs');

let tenant, adminActor, adminSecret, base, httpServer;

before(async () => {
  await openDb();
  await migrate(db());
  tenant = await store.createTenant({ name: 'Auth Tenant' });
  adminActor = await store.createActor(tenant.id, { kind: 'user', name: 'Admin' });
  await store.bindRole(tenant.id, adminActor.id, null, 'admin');
  const k = mintKey();
  await store.createApiKeyRow({
    tenantId: tenant.id, actorId: adminActor.id, name: 'adminkey',
    prefix: k.prefix, keyHash: k.keyHash,
  });
  adminSecret = k.secret;

  const app = createApp();
  registerIdentityRoutes(app);
  registerAuthRoutes(app);
  httpServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${httpServer.address().port}`;
});
after(() => new Promise((r) => httpServer.close(r)));

const req = (path, { method = 'GET', token = null, body = undefined, followRedirect = true } = {}) =>
  fetch(base + path, {
    method,
    redirect: followRedirect ? 'follow' : 'manual',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

const createUser = (username, password = 's3cure-Pass', extra = {}) =>
  req(`/v1/admin/tenants/${tenant.id}/users`, {
    method: 'POST', token: adminSecret, body: { username, password, name: username, ...extra },
  });

const login = (username, password, extra = {}) =>
  req('/v1/auth/login', { method: 'POST', body: { tenant: tenant.slug, username, password, ...extra } });

/* ---------- 密码哈希 ---------- */

test('scrypt：哈希/校验往返，错误密码与未知版本拒绝', async () => {
  const h = await hashPassword('correct-horse');
  assert.ok(h.startsWith('scrypt$v1$'));
  assert.equal(await verifyPassword('correct-horse', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
  assert.equal(await verifyPassword('correct-horse', 'argon2$v1$xxx'), false);
  assert.equal(await verifyPassword('correct-horse', 'garbage'), false);
});

/* ---------- 用户创建 ---------- */

test('租户 admin 创建本地用户 → 201，不泄露 password_hash', async () => {
  const r = await createUser('alice');
  assert.equal(r.status, 201);
  const { data } = await r.json();
  assert.equal(data.username, 'alice');
  assert.ok(data.actor.id.startsWith('usr_'));
  assert.ok(!('password_hash' in data) && !JSON.stringify(data).includes('password_hash'));
});

test('短密码/非法用户名/重复用户名 → 400/400/409', async () => {
  const r1 = await createUser('bob', 'short');
  assert.equal(r1.status, 400);
  const r2 = await createUser('bad name!');
  assert.equal(r2.status, 400);
  const r3 = await createUser('alice');
  assert.equal(r3.status, 409);
});

/* ---------- 密码登录 ---------- */

test('密码登录成功：access 可调 /v1/me（jwt），tenant id 也可登录', async () => {
  const r = await login('alice', 's3cure-Pass');
  assert.equal(r.status, 200);
  const { data } = await r.json();
  assert.ok(data.accessToken.split('.').length === 3);
  assert.ok(data.refreshToken.startsWith('dyr_'));
  assert.equal(data.tokenType, 'Bearer');

  const me = await req('/v1/me', { token: data.accessToken });
  assert.equal(me.status, 200);
  const { data: meData } = await me.json();
  assert.equal(meData.authKind, 'jwt');
  assert.equal(meData.actor.name, 'alice');

  const r2 = await req('/v1/auth/login', {
    method: 'POST', body: { tenant: tenant.id, username: 'alice', password: 's3cure-Pass' },
  });
  assert.equal(r2.status, 200);
});

test('错密码 → 401；login_attempts 记录失败', async () => {
  const r = await login('alice', 'wrong-pass');
  assert.equal(r.status, 401);
  const rows = await db().query(
    "SELECT * FROM login_attempts WHERE tenant_id=? AND username='alice' ORDER BY created_at DESC LIMIT 1",
    [tenant.id]);
  assert.equal(rows[0].success, 0);
});

/* ---------- 登录锁定 ---------- */

test('连续 5 次失败 → 第 6 次（即使密码正确）423 锁定', async () => {
  await createUser('lockuser');
  for (let i = 0; i < 5; i++) {
    const r = await login('lockuser', 'wrong');
    assert.equal(r.status, 401, `第 ${i + 1} 次应 401`);
  }
  const r = await login('lockuser', 's3cure-Pass');
  assert.equal(r.status, 423, '锁定中即使密码正确也应 423');
  const { error } = await r.json();
  assert.equal(error.code, 'LOCKED');
});

test('窗口外的旧失败不计入锁定', async () => {
  await createUser('oldfail');
  // 插入 5 条 16 分钟前的失败（窗口 15min 之外）
  const old = Date.now() - 16 * 60_1000;
  for (let i = 0; i < 5; i++) {
    await db().query(
      'INSERT INTO login_attempts(id,tenant_id,username,success,ip,created_at) VALUES (?,?,?,?,?,?)',
      [`lat_old${i}`, tenant.id, 'oldfail', 0, null, old]);
  }
  assert.equal(await localauth.__internal.isLocked(tenant.id, 'oldfail'), false);
  const r = await login('oldfail', 's3cure-Pass');
  assert.equal(r.status, 200, '旧失败不应触发锁定');
});

/* ---------- TOTP ---------- */

test('TOTP 全流程：setup → 未带码登录 401 → enable → 带码登录 200 → disable', async () => {
  await createUser('totpuser');
  let lr = await login('totpuser', 's3cure-Pass');
  assert.equal(lr.status, 200);
  let { data: sess } = await lr.json();

  // setup（需认证）
  const s = await req('/v1/auth/totp/setup', { method: 'POST', token: sess.accessToken });
  assert.equal(s.status, 200);
  const { data: setup } = await s.json();
  assert.ok(setup.secret.length >= 16);
  assert.ok(setup.otpauthUrl.startsWith('otpauth://totp/'));

  // 未启用前：登录仍不需要码
  lr = await login('totpuser', 's3cure-Pass');
  assert.equal(lr.status, 200);

  // enable：错码 400
  const e1 = await req('/v1/auth/totp/enable', {
    method: 'POST', token: sess.accessToken, body: { code: '000000' },
  });
  assert.equal(e1.status, 400);
  // enable：对码成功
  const e2 = await req('/v1/auth/totp/enable', {
    method: 'POST', token: sess.accessToken, body: { code: totpCode(setup.secret) },
  });
  assert.equal(e2.status, 200);

  // 启用后：不带码 → 401 TOTP_REQUIRED
  const l1 = await login('totpuser', 's3cure-Pass');
  assert.equal(l1.status, 401);
  const { error } = await l1.json();
  assert.equal(error.details.code, 'TOTP_REQUIRED');
  // 带错码 → 401；带对码 → 200
  const l2 = await login('totpuser', 's3cure-Pass', { totpCode: '000000' });
  assert.equal(l2.status, 401);
  const l3 = await login('totpuser', 's3cure-Pass', { totpCode: totpCode(setup.secret) });
  assert.equal(l3.status, 200);
  sess = (await l3.json()).data;

  // disable：错密码 401，对密码成功；之后登录不再需要码
  const d1 = await req('/v1/auth/totp/disable', {
    method: 'POST', token: sess.accessToken, body: { password: 'wrong' },
  });
  assert.equal(d1.status, 401);
  const d2 = await req('/v1/auth/totp/disable', {
    method: 'POST', token: sess.accessToken, body: { password: 's3cure-Pass' },
  });
  assert.equal(d2.status, 200);
  const l4 = await login('totpuser', 's3cure-Pass');
  assert.equal(l4.status, 200);
});

/* ---------- refresh / logout ---------- */

test('refresh 轮换：旧 refresh 作废；logout 后 refresh 失效', async () => {
  await createUser('sessuser');
  const lr = await login('sessuser', 's3cure-Pass');
  const { data: s1 } = await lr.json();

  const rr = await req('/v1/auth/refresh', { method: 'POST', body: { refreshToken: s1.refreshToken } });
  assert.equal(rr.status, 200);
  const { data: s2 } = await rr.json();
  assert.notEqual(s2.refreshToken, s1.refreshToken);

  const rr2 = await req('/v1/auth/refresh', { method: 'POST', body: { refreshToken: s1.refreshToken } });
  assert.equal(rr2.status, 401, '轮换后旧 refresh 应失效');

  const lo = await req('/v1/auth/logout', { method: 'POST', body: { refreshToken: s2.refreshToken } });
  assert.equal(lo.status, 200);
  const { data: loData } = await lo.json();
  assert.equal(loData.revoked, true);

  const rr3 = await req('/v1/auth/refresh', { method: 'POST', body: { refreshToken: s2.refreshToken } });
  assert.equal(rr3.status, 401, 'logout 后 refresh 应失效');
});

/* ---------- OIDC 未配置 ---------- */

test('OIDC 未配置 → /v1/auth/oidc/login 报 400', async () => {
  const r = await req('/v1/auth/oidc/login', { followRedirect: false });
  assert.equal(r.status, 400);
});
