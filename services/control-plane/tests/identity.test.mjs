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

/* ============ batch1 遗留回归 ============ */

test('Keycloak JWT：RS256/RS384/RS512 真实签名回归（alg→hash 映射）', async () => {
  const { generateKeyPairSync, createSign } = await import('node:crypto');
  const { __internal } = await import('../src/modules/identity/idp.mjs');
  const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const signJwt = (alg, hash, privateKey, kid, payload) => {
    const h = b64u({ alg, kid, typ: 'JWT' });
    const p = b64u(payload);
    const sig = createSign(hash).update(`${h}.${p}`).sign(privateKey);
    return `${h}.${p}.${sig.toString('base64url')}`;
  };
  const payload = { sub: 'u1', exp: Math.floor(Date.now() / 1000) + 300 };
  for (const [alg, hash] of [['RS256', 'SHA256'], ['RS384', 'SHA384'], ['RS512', 'SHA512']]) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' });
    jwk.kid = `rsa-${alg}`;
    const token = signJwt(alg, hash, privateKey, jwk.kid, payload);
    const { claims } = await __internal.verifyKeycloakSignature(token, [jwk]);
    assert.equal(claims.sub, 'u1', `${alg} 应验签通过`);
  }
});

test('Keycloak JWT：ES256/ES384/ES512 真实签名回归（JWS raw→DER 转换）', async () => {
  const { generateKeyPairSync, createSign } = await import('node:crypto');
  const { __internal } = await import('../src/modules/identity/idp.mjs');
  const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  // DER → JWS raw R||S（测试侧构造签名用，与生产侧 derEncodeEcdsaSig 互逆）
  const derToRaw = (der, coordLen) => {
    let o = 0;
    assert.equal(der[o++], 0x30);
    let len = der[o++];
    if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = (len << 8) | der[o++]; }
    const out = Buffer.alloc(coordLen * 2);
    for (const k of [0, 1]) {
      assert.equal(der[o++], 0x02);
      let ilen = der[o++];
      if (ilen & 0x80) { const n = ilen & 0x7f; ilen = 0; for (let i = 0; i < n; i++) ilen = (ilen << 8) | der[o++]; }
      let v = der.subarray(o, o + ilen); o += ilen;
      if (v[0] === 0x00) v = v.subarray(1);
      v.copy(out, k * coordLen + (coordLen - v.length));
    }
    return out;
  };
  const cases = [
    ['ES256', 'SHA256', 'P-256', 32],
    ['ES384', 'SHA384', 'P-384', 48],
    ['ES512', 'SHA512', 'P-521', 66],
  ];
  const payload = { sub: 'u2', exp: Math.floor(Date.now() / 1000) + 300 };
  for (const [alg, hash, curve, coordLen] of cases) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: curve });
    const jwk = publicKey.export({ format: 'jwk' });
    jwk.kid = `ec-${alg}`;
    const h = b64u({ alg, kid: jwk.kid, typ: 'JWT' });
    const p = b64u(payload);
    const derSig = createSign(hash).update(`${h}.${p}`).sign(privateKey);
    const token = `${h}.${p}.${derToRaw(derSig, coordLen).toString('base64url')}`;
    const { claims } = await __internal.verifyKeycloakSignature(token, [jwk]);
    assert.equal(claims.sub, 'u2', `${alg} 应验签通过`);
  }
});

test('Keycloak JWT：算法混淆/错钥/篡改一律 401', async () => {
  const { generateKeyPairSync, createSign } = await import('node:crypto');
  const { __internal } = await import('../src/modules/identity/idp.mjs');
  const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  jwk.kid = 'k1';
  const payload = { sub: 'u3', exp: Math.floor(Date.now() / 1000) + 300 };
  const good = (() => {
    const h = b64u({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
    const p = b64u(payload);
    return `${h}.${p}.${createSign('SHA256').update(`${h}.${p}`).sign(privateKey).toString('base64url')}`;
  })();
  const expect401 = async (token, keys, why) => {
    await assert.rejects(() => __internal.verifyKeycloakSignature(token, keys),
      (e) => e && e.status === 401, why);
  };
  // alg=none
  await expect401(`${b64u({ alg: 'none', kid: 'k1' })}.${b64u(payload)}.`, [jwk], 'none 应被白名单拒绝');
  // HS256 不在白名单
  await expect401(`${b64u({ alg: 'HS256', kid: 'k1' })}.${b64u(payload)}.x`, [jwk], 'HS256 应被白名单拒绝');
  // 错钥签名
  const { privateKey: other } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const h2 = b64u({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const p2 = b64u(payload);
  await expect401(
    `${h2}.${p2}.${createSign('SHA256').update(`${h2}.${p2}`).sign(other).toString('base64url')}`,
    [jwk], '错钥签名应 401',
  );
  // 篡改 payload
  const [gh, , gs] = good.split('.');
  await expect401(`${gh}.${b64u({ ...payload, sub: 'attacker' })}.${gs}`, [jwk], '篡改 payload 应 401');
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
  const prevKc = process.env.KEYCLOAK_URL;
  process.env.DEYI_ENV = 'production';
  delete process.env.DATABASE_URL;
  delete process.env.KEYCLOAK_URL;
  try {
    await assert.rejects(
      () => import('../src/kernel/config.mjs?prod-failfast'),
      (e) => {
        assert.match(String(e && e.message || e), /生产配置校验失败/);
        assert.match(String(e && e.message || e), /DATABASE_URL/);
        assert.match(String(e && e.message || e), /KEYCLOAK_URL/);
        return true;
      },
      '生产缺 DATABASE_URL/KEYCLOAK_URL 应启动失败',
    );
  } finally {
    if (prevEnv === undefined) delete process.env.DEYI_ENV; else process.env.DEYI_ENV = prevEnv;
    if (prevDb !== undefined) process.env.DATABASE_URL = prevDb;
    if (prevKc !== undefined) process.env.KEYCLOAK_URL = prevKc;
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
