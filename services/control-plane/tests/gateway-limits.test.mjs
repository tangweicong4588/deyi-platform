/**
 * tests/gateway-limits.test.mjs —— V2.6：套餐配额落地 + 网关速率限制。
 * - 开通租户（/provision）→ 当月自动落 plan 预算行（trial token_limit=1_000_000，source='plan'）
 * - enterprise（不限配额）→ 不落行
 * - 手工预算行优先：PUT /budgets 后再 sync-plan，不被覆盖
 * - 套餐变更 professional→trial：plan 行 token_limit 同步下调
 * - token 配额耗尽 → chat 402 BUDGET_EXCEEDED（走已有 guardAndRoute 熔断）
 * - 限流：rpm=3 时第 4 个请求 429 + retry-after + x-ratelimit 头；不同 key 桶隔离
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

const FAKE_PORT = 14532;
const fake = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'c1', object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  });
});
await new Promise((r) => fake.listen(FAKE_PORT, '127.0.0.1', r));
after(() => new Promise((r) => fake.close(r)));

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-lim-')), 'test.db');
process.env.OPERATOR_TOKEN = 'test-operator-token-v26';
process.env.DEV_IDP_SECRET = 'test-dev-idp-secret';
process.env.BOOTSTRAP_ENABLED = 'false';
process.env.LITELLM_URL = `http://127.0.0.1:${FAKE_PORT}`;
process.env.LITELLM_MASTER_KEY = 'test-master';
process.env.GATEWAY_MAX_RETRIES = '0';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const gstore = await import('../src/modules/gateway/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { __internal: rlInternal } = await import('../src/modules/gateway/ratelimit/index.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerGatewayRoutes } = await import('../src/modules/gateway/routes.mjs');

const OPERATOR = process.env.OPERATOR_TOKEN;
let base, appServer;

const post = (path, body, token, headers = {}) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
  body: JSON.stringify(body || {}),
});
const provision = async (body) => {
  const r = await post('/v1/admin/tenants/provision', body, OPERATOR);
  assert.equal(r.status, 201);
  return (await r.json()).data; // { tenant, project, actor, apiKey }
};
const mkKey = async (tenantId, actorId, scopes = ['gateway.chat']) => {
  const k = mintKey();
  await store.createApiKeyRow({ tenantId, actorId, name: `lim-${Date.now()}-${Math.random()}`, prefix: k.prefix, keyHash: k.keyHash, scopes });
  return k.secret;
};

before(async () => {
  openDb();
  await migrate(db());
  await gstore.ensureSeedModels();
  const app = createApp();
  registerIdentityRoutes(app);
  registerGatewayRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;
});
after(async () => { appServer.close(); });

test('开通租户自动落 plan 预算行；enterprise 不落', async () => {
  const { tenant } = await provision({ name: 'LIM Trial', plan: 'trial', adminName: 'a' });
  const rows = await gstore.listBudgets(tenant.id);
  const planRow = rows.find((b) => b.source === 'plan' && b.period_key === gstore.currentPeriodKey());
  assert.ok(planRow, 'trial 租户有 plan 预算行');
  assert.equal(planRow.token_limit, 1_000_000);

  const ent = await provision({ name: 'LIM Ent', plan: 'enterprise', adminName: 'a' });
  const rows2 = await gstore.listBudgets(ent.tenant.id);
  assert.equal(rows2.filter((b) => b.source === 'plan').length, 0);
});

test('手工预算行优先于套餐同步；套餐变更同步 plan 行', async () => {
  const { tenant } = await provision({ name: 'LIM Manual', plan: 'trial', adminName: 'a' });

  // 手工设置更高额度
  const put = await fetch(base + `/v1/admin/tenants/${tenant.id}/budgets`, {
    method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${OPERATOR}` },
    body: JSON.stringify({ tokenLimit: 9_999_999 }),
  });
  assert.equal(put.status, 200);
  // sync-plan 不应覆盖手工行
  const sync = await post('/v1/admin/budgets/sync-plan', {}, OPERATOR);
  assert.equal(sync.status, 200);
  const row = (await gstore.listBudgets(tenant.id))
    .find((b) => b.period_key === gstore.currentPeriodKey() && !b.project_id);
  assert.equal(row.source, 'manual');
  assert.equal(row.token_limit, 9_999_999);

  // 套餐变更 professional → trial：plan 行同步下调
  const t2 = await provision({ name: 'LIM Plan', plan: 'professional', adminName: 'a' });
  let b2 = (await gstore.listBudgets(t2.tenant.id)).find((b) => b.source === 'plan');
  assert.equal(b2.token_limit, 100_000_000);
  const up = await fetch(base + `/v1/admin/tenants/${t2.tenant.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${OPERATOR}` },
    body: JSON.stringify({ plan: 'trial' }),
  });
  assert.equal(up.status, 200);
  b2 = (await gstore.listBudgets(t2.tenant.id)).find((b) => b.source === 'plan');
  assert.equal(b2.token_limit, 1_000_000);
});

test('token 配额耗尽 → chat 402', async () => {
  const { tenant, actor } = await provision({
    name: 'LIM Broke', plan: 'trial', quotas: { tokens_per_month: 0 }, adminName: 'a',
  });
  const secret = await mkKey(tenant.id, actor.id);
  const cr = await post('/v1/gw/chat/completions',
    { model: 'deyi-default', messages: [{ role: 'user', content: 'hi' }] }, secret);
  assert.equal(cr.status, 402);
  const j = await cr.json();
  assert.equal(j.error?.code, 'BUDGET_EXCEEDED');
});

test('限流：超 rpm → 429 + 头；不同 key 隔离', async () => {
  rlInternal.clear();
  const { tenant, actor } = await provision({
    name: 'LIM RL', plan: 'trial', quotas: { rpm: 3, tokens_per_month: 100_000_000 }, adminName: 'a',
  });
  const s1 = await mkKey(tenant.id, actor.id);
  const s2 = await mkKey(tenant.id, actor.id);
  const body = { model: 'deyi-default', messages: [{ role: 'user', content: 'hi' }] };
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await post('/v1/gw/chat/completions', body, s1)).status);
  assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
  assert.equal(statuses[3], 429);
  const r429 = await post('/v1/gw/chat/completions', body, s1);
  assert.ok(r429.headers.get('retry-after') !== null, '有 retry-after 头');
  assert.equal(r429.headers.get('x-ratelimit-limit'), '3');
  assert.equal(r429.headers.get('x-ratelimit-remaining'), '0');
  assert.equal((await r429.json()).error?.code, 'RATE_LIMITED');
  // 另一个 key 不受影响
  assert.equal((await post('/v1/gw/chat/completions', body, s2)).status, 200);
});
