// Phase 6 OIDC live：平台 oidc.mjs 客户端 ↔ mock OIDC Provider（规范实现）
// 验证：discovery → 登录 URL(PKCE/state/nonce) → code 交换 → RS256 JWKS 验签 →
//       iss/aud/exp/nonce 校验 → 租户映射 → JIT 建账号 → 本平台会话签发。
// 诚实边界：provider 是联调替身，非真实商业 IdP（Entra/Okta/飞书等）。
import assert from 'node:assert';
import { pgQuery } from './pg-cli.mjs';

const BASE = process.env.APP_BASE || 'http://127.0.0.1:18080';
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', `${name}：${e.message.slice(0, 180)}`]); }
};

// 1. discovery 直连 provider
await check('provider discovery', async () => {
  const d = await fetch('http://127.0.0.1:18443/.well-known/openid-configuration').then((r) => r.json());
  assert.ok(d.authorization_endpoint && d.token_endpoint && d.jwks_uri);
});

// 2. 平台生成登录 URL
const jT = await fetch(BASE + '/v1/admin/tenants', { headers: { Authorization: 'Bearer op-live-token' } }).then((r) => r.json());
const tenantId = jT.data[0].id;
let loginUrl = '';
await check('平台生成 OIDC 登录 URL', async () => {
  const r = await fetch(`${BASE}/v1/auth/oidc/login?tenant=${tenantId}`, { redirect: 'manual' });
  assert.strictEqual(r.status, 302);
  loginUrl = r.headers.get('location');
  assert.match(loginUrl, /code_challenge=/);
  assert.match(loginUrl, /state=st_/);
});

// 3. "用户"访问 authorize（mock 直接返回 code，真实 IdP 会 302 回跳）
let code = '', state = '';
await check('authorize 颁发 code', async () => {
  const j = await fetch(loginUrl).then((r) => r.json());
  assert.ok(j.code, '无 code');
  code = j.code; state = j.state;
});

// 4. 回调：平台换 token + 验签 + JIT + 签发会话
let session = null;
await check('回调签发本平台会话', async () => {
  const r = await fetch(`${BASE}/v1/auth/oidc/callback?code=${code}&state=${state}`);
  const j = await r.json();
  assert.strictEqual(r.status, 200, JSON.stringify(j).slice(0, 200));
  session = j.data;
  assert.ok(session.accessToken || session.access_token, '无 access token');
});

// 5. 会话可用：调 /v1/me
await check('OIDC 会话可调用平台 API', async () => {
  const tok = session.accessToken || session.access_token;
  const r = await fetch(`${BASE}/v1/me`, { headers: { Authorization: `Bearer ${tok}` } });
  assert.strictEqual(r.status, 200);
});

// 6. JIT 账号落库
await check('JIT actor 落 PG', async () => {
  const out = pgQuery(`SELECT COUNT(*) FROM actors WHERE tenant_id='${tenantId}' AND external_id='mock-sub-001';`);
  assert.strictEqual(out, '1');
});

// 7. 负例：state 复用应被拒绝（防重放）
await check('state 复用被拒绝', async () => {
  const r = await fetch(`${BASE}/v1/auth/oidc/callback?code=${code}&state=${state}`);
  assert.ok(r.status === 400 || r.status === 401, `status=${r.status}`);
});

console.log(results.map(([s, n]) => `${s} ${n}`).join('\n'));
const fails = results.filter(([s]) => s === 'FAIL').length;
console.log(fails ? `OIDC LIVE: ${fails} 项失败` : 'OIDC LIVE: 全部通过（平台 OIDC 客户端 ↔ 规范 mock Provider）');
process.exit(fails ? 1 : 0);
