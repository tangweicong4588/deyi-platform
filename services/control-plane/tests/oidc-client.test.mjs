/** OIDC Client 测试：fake IdP（discovery/JWKS/token）做协议级验证 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const FAKE_PORT = 18321;
const ISSUER = `http://127.0.0.1:${FAKE_PORT}`;

// 必须在 import 业务模块之前设置（config 在 import 时加载）
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-test-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.DEV_IDP_SECRET = 'test-local-jwt-secret';
process.env.BOOTSTRAP_ENABLED = 'false';
process.env.OIDC_ISSUER = ISSUER;
process.env.OIDC_CLIENT_ID = 'deyi-test-client';
process.env.OIDC_CLIENT_SECRET = 'test-oidc-secret';
process.env.OIDC_REDIRECT_URI = 'http://localhost:8080/v1/auth/oidc/callback';
process.env.OIDC_DEFAULT_TENANT_ID = '';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { createApp, sendJson } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerAuthRoutes } = await import('../src/modules/identity/auth-routes.mjs');
const oidc = await import('../src/modules/identity/oidc.mjs');

/* ---------- fake OIDC IdP ---------- */
const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const json = (res, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};
const holder = { claims: null, priv: null }; // 测试预置下一次 token 端点签发的 claims/密钥

function signIdToken(priv, claims, kid = 'test-k1') {
  const h = b64u({ alg: 'RS256', kid, typ: 'JWT' });
  const p = b64u(claims);
  return `${h}.${p}.${createSign('RSA-SHA256').update(`${h}.${p}`).sign(priv).toString('base64url')}`;
}

let keypair, otherKeypair, tenant, base, httpServer, fakeServer;

const baseClaims = (nonce, over = {}) => ({
  iss: ISSUER, aud: 'deyi-test-client', sub: 'oidc-u1',
  name: 'OIDC User', email: 'oidc@example.com', deyi_tenant: tenant.slug,
  iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
  nonce, ...over,
});

before(async () => {
  keypair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  otherKeypair = generateKeyPairSync('rsa', { modulusLength: 2048 });

  fakeServer = createServer((req, res) => {
    const url = new URL(req.url, ISSUER);
    if (url.pathname === '/.well-known/openid-configuration') {
      json(res, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/auth`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
      });
    } else if (url.pathname === '/jwks') {
      const jwk = keypair.publicKey.export({ format: 'jwk' });
      jwk.kid = 'test-k1'; jwk.use = 'sig'; jwk.alg = 'RS256';
      json(res, { keys: [jwk] });
    } else if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        assert.ok(body.includes('grant_type=authorization_code'), '应为 authorization_code 交换');
        assert.ok(body.includes('code_verifier='), '应带 PKCE code_verifier');
        json(res, {
          id_token: signIdToken(holder.priv || keypair.privateKey, holder.claims),
          token_type: 'Bearer', expires_in: 300,
        });
      });
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => fakeServer.listen(FAKE_PORT, '127.0.0.1', r));

  await openDb();
  await migrate(db());
  tenant = await store.createTenant({ name: 'OIDC Tenant' });

  const app = createApp();
  registerIdentityRoutes(app);
  registerAuthRoutes(app);
  httpServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${httpServer.address().port}`;
});
after(async () => {
  await new Promise((r) => httpServer.close(r));
  await new Promise((r) => fakeServer.close(r));
});

const startLogin = async (withTenant = true) => {
  const { url, state } = await oidc.buildLoginUrl(withTenant ? { tenant: tenant.slug } : {});
  const p = oidc.__internal.peekPending(state);
  assert.ok(p, 'state 应暂存');
  return { url, state, nonce: p.nonce };
};

/* ---------- 登录发起 ---------- */

test('OIDC 登录发起：302 跳转，带 PKCE/state/nonce', async () => {
  const r = await fetch(`${base}/v1/auth/oidc/login?tenant=${tenant.slug}`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  const loc = r.headers.get('location');
  assert.ok(loc.startsWith(`${ISSUER}/auth`), '应跳到 IdP 授权端点');
  assert.ok(loc.includes('code_challenge='), '应带 PKCE challenge');
  assert.ok(loc.includes('state='), '应带 state');
  assert.ok(loc.includes('nonce='), '应带 nonce');
});

/* ---------- 回调全流程 ---------- */

test('OIDC 回调：验签→租户映射→JIT→本平台会话；重复登录不建重复 actor', async () => {
  const { state, nonce } = await startLogin();
  holder.claims = baseClaims(nonce);
  holder.priv = null;

  const r = await fetch(`${base}/v1/auth/oidc/callback?code=fake-code&state=${state}`);
  assert.equal(r.status, 200);
  const { data } = await r.json();
  assert.ok(data.accessToken);
  assert.ok(data.refreshToken.startsWith('dyr_'));

  const me = await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${data.accessToken}` } });
  assert.equal(me.status, 200);
  const { data: meData } = await me.json();
  assert.equal(meData.actor.name, 'OIDC User');
  assert.equal(meData.tenant.id, tenant.id);

  const actors = await db().query(
    'SELECT * FROM actors WHERE tenant_id=? AND external_id=?', [tenant.id, 'oidc-u1']);
  assert.equal(actors.length, 1);

  // 第二次登录：同一 sub 不重复建 actor
  const s2 = await startLogin();
  holder.claims = baseClaims(s2.nonce);
  const out2 = await oidc.handleOidcCallback({ code: 'c2', state: s2.state });
  assert.ok(out2.accessToken);
  const actors2 = await db().query(
    'SELECT * FROM actors WHERE tenant_id=? AND external_id=?', [tenant.id, 'oidc-u1']);
  assert.equal(actors2.length, 1);
  assert.equal(actors2[0].id, actors[0].id);
});

/* ---------- 异常路径 ---------- */

test('OIDC 回调：state 无效 → 401', async () => {
  await assert.rejects(
    oidc.handleOidcCallback({ code: 'x', state: 'st_bogus' }),
    (e) => e.status === 401);
});

test('OIDC 回调：nonce 不匹配 → 401', async () => {
  const { state } = await startLogin();
  holder.claims = baseClaims('wrong-nonce');
  await assert.rejects(
    oidc.handleOidcCallback({ code: 'x', state }),
    (e) => e.status === 401);
});

test('OIDC 回调：错钥签名 → 401', async () => {
  const { state, nonce } = await startLogin();
  holder.claims = baseClaims(nonce);
  holder.priv = otherKeypair.privateKey;
  try {
    await assert.rejects(
      oidc.handleOidcCallback({ code: 'x', state }),
      (e) => e.status === 401);
  } finally {
    holder.priv = null;
  }
});

test('OIDC 回调：aud 不匹配 → 401', async () => {
  const { state, nonce } = await startLogin();
  holder.claims = baseClaims(nonce, { aud: 'other-client' });
  await assert.rejects(
    oidc.handleOidcCallback({ code: 'x', state }),
    (e) => e.status === 401);
});

test('OIDC 回调：claims 无租户映射且无默认租户 → 401', async () => {
  const { state, nonce } = await startLogin(false); // 不预置 tenant，走 claims 映射
  const c = baseClaims(nonce);
  delete c.deyi_tenant;
  holder.claims = c;
  await assert.rejects(
    oidc.handleOidcCallback({ code: 'x', state }),
    (e) => e.status === 401);
});
