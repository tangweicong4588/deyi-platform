/** gateway 测试：LiteLLM 适配 / 白名单 / 预算熔断 / 计量 / 流式 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

const FAKE_PORT = 14531;

// fake LiteLLM 上游（固定端口，必须在业务模块 import 前启动，因为 config 读 env）
const seen = [];
const fake = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const auth = req.headers['authorization'];
    if (auth !== 'Bearer test-master') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'bad master key' }));
    }
    const body = JSON.parse(raw || '{}');
    seen.push({ url: req.url, body });
    if (body.model === 'fail-primary') {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'primary down' }));
    }
    if (req.url === '/v1/chat/completions' && body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"c1","choices":[{"delta":{"content":"hi"}}]}\n\n');
      res.write('data: {"id":"c1","usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n');
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'chatcmpl-x', object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    }
    if (req.url === '/v1/embeddings') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        data: [{ embedding: [0.1, 0.2], index: 0 }],
        usage: { prompt_tokens: 8, total_tokens: 8 },
      }));
    }
    res.writeHead(404).end('{}');
  });
});
await new Promise((r) => fake.listen(FAKE_PORT, '127.0.0.1', r));
after(() => new Promise((r) => fake.close(r)));

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-gw-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.DEV_IDP_SECRET = 'test-dev-secret';
process.env.BOOTSTRAP_ENABLED = 'false';
process.env.LITELLM_URL = `http://127.0.0.1:${FAKE_PORT}`;
process.env.LITELLM_MASTER_KEY = 'test-master';
process.env.GATEWAY_MAX_RETRIES = '0'; // 测试加速：上游重试关闭，降级链本身另测

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const gstore = await import('../src/modules/gateway/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp, sendJson } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerGatewayRoutes } = await import('../src/modules/gateway/routes.mjs');

let tenant, actor, adminSecret, project;
before(async () => {
  await openDb();
  await migrate(db());
  await gstore.ensureSeedModels();
  tenant = await store.createTenant({ name: 'GW Tenant' });
  actor = await store.createActor(tenant.id, { kind: 'user', name: 'GW Admin' });
  await store.bindRole(tenant.id, actor.id, null, 'admin');
  project = await store.createProject(tenant.id, { name: 'GW Project' });
  const k = mintKey();
  await store.createApiKeyRow({
    tenantId: tenant.id, actorId: actor.id, name: 'gwkey', prefix: k.prefix, keyHash: k.keyHash,
  });
  adminSecret = k.secret;
  // 一个"贵"模型，用来测预算熔断：1000000 cents / 1M prompt tokens
  await gstore.upsertModel({
    name: 'expensive', litellmModel: 'expensive',
    costPromptPerMtokCents: 1000000, costCompletionPerMtokCents: 1000000,
  });
  // 带降级链的模型：主模型 500，fallback 到 deyi-default
  await gstore.upsertModel({
    name: 'with-fallback', litellmModel: 'fail-primary', fallback: ['deyi-default'],
  });
});

let base, appServer;
before(async () => {
  const app = createApp();
  registerIdentityRoutes(app);
  registerGatewayRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;
});
after(() => new Promise((r) => appServer.close(r)));

const post = (path, body, { token = adminSecret, headers = {} } = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body),
  });

test('chat.completions：透传 + 身份映射 + 计量回写', async () => {
  seen.length = 0;
  const r = await post('/v1/gw/chat/completions', {
    model: 'deyi-default', messages: [{ role: 'user', content: 'hello' }],
  });
  assert.equal(r.status, 200);
  const json = await r.json();
  assert.equal(json.choices[0].message.content, 'ok');

  // 上游收到的归属信息
  const up = seen[0];
  assert.equal(up.body.user, actor.id);
  assert.equal(up.body.metadata.deyi_tenant_id, tenant.id);
  assert.equal(up.body.model, 'deyi-default'); // litellm_model

  // 账本
  const calls = await gstore.listCalls(tenant.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt_tokens, 10);
  assert.equal(calls[0].completion_tokens, 5);
  assert.equal(calls[0].actor_id, actor.id);
  assert.ok(calls[0].trace_id);
});

test('未知模型 → 400（白名单）', async () => {
  const r = await post('/v1/gw/chat/completions', {
    model: 'gpt-99', messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(r.status, 400);
});

test('数据分级越权 → 403', async () => {
  const r = await post('/v1/gw/chat/completions', {
    model: 'deyi-default', messages: [{ role: 'user', content: 'hi' }],
  }, { headers: { 'x-deyi-data-class': 'confidential' } });
  assert.equal(r.status, 403);
});

test('预算熔断：剩余额度不够 → 402 且不上游', async () => {
  await gstore.setBudget({ tenantId: tenant.id, costLimitCents: 1 }); // 1 cent
  seen.length = 0;
  const r = await post('/v1/gw/chat/completions', {
    model: 'expensive', messages: [{ role: 'user', content: 'hello world, this is a test' }],
  });
  assert.equal(r.status, 402);
  assert.equal(seen.length, 0); // 熔断在上游之前
  // 恢复预算，避免影响后续测试
  await gstore.setBudget({ tenantId: tenant.id, costLimitCents: 1000000 });
});

test('项目级预算 + x-deyi-project 头', async () => {
  await gstore.setBudget({ tenantId: tenant.id, projectId: project.id, costLimitCents: 1 });
  const r = await post('/v1/gw/chat/completions', {
    model: 'expensive', messages: [{ role: 'user', content: 'hello world, this is a test' }],
  }, { headers: { 'x-deyi-project': project.id } });
  assert.equal(r.status, 402);
  await gstore.setBudget({ tenantId: tenant.id, projectId: project.id, costLimitCents: 1000000 });

  // 正常调用时 project_id 回写账本
  const r2 = await post('/v1/gw/chat/completions', {
    model: 'deyi-default', messages: [{ role: 'user', content: 'hi' }],
  }, { headers: { 'x-deyi-project': project.id } });
  assert.equal(r2.status, 200);
  const calls = await gstore.listCalls(tenant.id, 5);
  assert.equal(calls[0].project_id, project.id);
});

test('embeddings：计量回写', async () => {
  const r = await post('/v1/gw/embeddings', { model: 'deyi-embedding', input: 'hello' });
  assert.equal(r.status, 200);
  const calls = await gstore.listCalls(tenant.id, 5);
  assert.equal(calls[0].endpoint, 'embeddings');
  assert.equal(calls[0].prompt_tokens, 8);
});

test('流式：SSE 直通且用量被记录', async () => {
  const r = await post('/v1/gw/chat/completions', {
    model: 'deyi-default', messages: [{ role: 'user', content: 'hi' }], stream: true,
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const text = await r.text();
  assert.ok(text.includes('[DONE]'));
  assert.ok(text.includes('"content":"hi"'));
  // 上游被注入了 stream_options.include_usage
  assert.equal(seen[seen.length - 1].body.stream_options.include_usage, true);
  const calls = await gstore.listCalls(tenant.id, 5);
  assert.equal(calls[0].total_tokens, 15);
});

test('用量账本不含 prompt 原文', async () => {
  const r = await fetch(base + `/v1/admin/tenants/${tenant.id}/usage?limit=5`, {
    headers: { authorization: `Bearer ${adminSecret}` },
  });
  assert.equal(r.status, 200);
  const { data } = await r.json();
  assert.ok(data.length > 0);
  assert.ok(!JSON.stringify(data).includes('hello world'));
});

test('降级链：主模型 500 → 自动走 fallback 并成功', async () => {
  seen.length = 0;
  const r = await post('/v1/gw/chat/completions', {
    model: 'with-fallback', messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(r.status, 200);
  const models = seen.map((s) => s.body.model);
  assert.deepEqual(models, ['fail-primary', 'deyi-default']);
});

test('未认证调用网关 → 401', async () => {
  const r = await fetch(base + '/v1/gw/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deyi-default', messages: [] }),
  });
  assert.equal(r.status, 401);
});

// ---------- Review-R6 回归 ----------

test('R6 fallback 披露：响应头 + deyi 扩展字段（L-10）', async () => {
  seen.length = 0;
  const r = await post('/v1/gw/chat/completions', {
    model: 'with-fallback', messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-deyi-fallback'), 'true');
  assert.equal(r.headers.get('x-deyi-served-model'), 'deyi-default');
  const json = await r.json();
  assert.equal(json.deyi.fallback, true);
  assert.equal(json.deyi.served_model, 'deyi-default');
  assert.equal(json.deyi.requested_model, 'with-fallback');
});

test('R6 未降级：fallback=false 如实披露（L-10）', async () => {
  const r = await post('/v1/gw/chat/completions', {
    model: 'deyi-default', messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-deyi-fallback'), 'false');
  assert.equal(r.headers.get('x-deyi-served-model'), 'deyi-default');
  const json = await r.json();
  assert.equal(json.deyi.fallback, false);
  assert.equal(json.deyi.requested_model, 'deyi-default');
});

test('R6 计量失败不改写上游成功：仍 200 + 进 outbox + 可补记（M-16）', async () => {
  const { reconcileUsageOutbox } = await import('../src/modules/gateway/routes.mjs');
  await db().exec('DROP TABLE model_calls'); // 模拟记账失败
  try {
    const r = await post('/v1/gw/chat/completions', {
      model: 'deyi-default', messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r.status, 200, '上游成功时记账失败不能转 500');
    assert.equal(r.headers.get('x-deyi-metering-deferred'), 'true');
    assert.ok((await gstore.countPendingUsageOutbox()) >= 1, '记账载荷应进 outbox');
  } finally {
    // migrate 会跳过已应用的 002（表被删了但 _migrations 有记录），这里按 DDL 直接重建
    await db().exec(`CREATE TABLE IF NOT EXISTS model_calls (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
      project_id TEXT REFERENCES projects(id), actor_id TEXT NOT NULL REFERENCES actors(id),
      trace_id TEXT NOT NULL, model TEXT NOT NULL, litellm_model TEXT, endpoint TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0, cost_cents INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
      cached INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
  }
  const res = await reconcileUsageOutbox({ limit: 100 });
  assert.ok(res.ok >= 1, '补记应成功');
  assert.equal(res.fail, 0);
  assert.equal(await gstore.countPendingUsageOutbox(), 0);
});

test('R6-2 记账原子单元：call + 两级预算同一事务，幂等重放不重复累加', async () => {
  const pk = gstore.currentPeriodKey();
  const tb0 = await gstore.getBudget(tenant.id, null, pk);
  const pb0 = await gstore.getBudget(tenant.id, project.id, pk);
  const tUsed0 = tb0.used_tokens, pUsed0 = pb0.used_tokens;
  const callRow = {
    id: 'call_r6atomic_test', tenant_id: tenant.id, project_id: project.id, actor_id: actor.id,
    trace_id: 'trace-r6', model: 'deyi-default', litellm_model: 'fake', endpoint: '/v1/gw/chat/completions',
    prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost_cents: 2,
    latency_ms: 1, status: 'ok', cached: 0, created_at: Date.now(),
  };
  const r1 = await gstore.persistUsageAtomic({
    callRow, tenantId: tenant.id, projectId: project.id, periodKey: pk,
  });
  assert.ok(r1 && r1.id === callRow.id, '首次记账应成功');
  assert.ok(await gstore.getCallById(callRow.id), 'call 应落库');
  assert.equal((await gstore.getBudget(tenant.id, null, pk)).used_tokens, tUsed0 + 15, '租户预算应累加');
  assert.equal((await gstore.getBudget(tenant.id, project.id, pk)).used_tokens, pUsed0 + 15, '项目预算应累加');
  // 幂等重放：同一 callRow 再记一次 → 返回 null，预算不再累加
  const r2 = await gstore.persistUsageAtomic({
    callRow, tenantId: tenant.id, projectId: project.id, periodKey: pk,
  });
  assert.equal(r2, null, '重复记账应幂等返回 null');
  assert.equal((await gstore.getBudget(tenant.id, null, pk)).used_tokens, tUsed0 + 15, '租户预算不得重复累加');
  assert.equal((await gstore.getBudget(tenant.id, project.id, pk)).used_tokens, pUsed0 + 15, '项目预算不得重复累加');
});

test('R6-3 记账中途失败整体回滚：预算表异常时 call 也不落库', async () => {
  const callRow = {
    id: 'call_r6rollback_test', tenant_id: tenant.id, project_id: project.id, actor_id: actor.id,
    trace_id: 'trace-r6rb', model: 'deyi-default', litellm_model: 'fake', endpoint: '/v1/gw/chat/completions',
    prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cents: 1,
    latency_ms: 1, status: 'ok', cached: 0, created_at: Date.now(),
  };
  await db().exec('DROP TABLE budgets'); // 模拟预算累加失败
  try {
    await assert.rejects(
      () => gstore.persistUsageAtomic({
        callRow, tenantId: tenant.id, projectId: project.id, periodKey: gstore.currentPeriodKey(),
      }));
    assert.equal(await gstore.getCallById(callRow.id), null, '回滚后 call 不得残留（旧逻辑会漏下这条）');
  } finally {
    // 重建 budgets 表（结构取自 004 migration 的 budgets 定义子集，测试够用）
    await db().exec(`CREATE TABLE IF NOT EXISTS budgets (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT, period TEXT NOT NULL,
      cost_limit_cents INTEGER, token_limit INTEGER, used_cost_cents INTEGER NOT NULL DEFAULT 0,
      used_tokens INTEGER NOT NULL DEFAULT 0, period_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  }
});

test('R6-3 outbox 补记使用入队时固化的账期（不串月）', async () => {
  const { reconcileUsageOutbox } = await import('../src/modules/gateway/routes.mjs');
  const oldPk = '2020-01'; // 足够老的账期，不会与当前账期相同
  assert.notEqual(oldPk, gstore.currentPeriodKey());
  await db().query(
    `INSERT INTO budgets(id,tenant_id,project_id,period,cost_limit_cents,token_limit,
     used_cost_cents,used_tokens,period_key,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['bdg_oldpk_test', tenant.id, null, 'monthly', 100000, 1000000, 0, 0, oldPk, 'active', Date.now(), Date.now()]);
  const curPk = gstore.currentPeriodKey();
  const curBefore = (await gstore.getBudget(tenant.id, null, curPk))?.used_tokens || 0;
  const callRow = {
    id: 'call_oldpk_test', tenant_id: tenant.id, project_id: null, actor_id: actor.id,
    trace_id: 't-oldpk', model: 'deyi-default', litellm_model: 'fake', endpoint: '/x',
    prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost_cents: 1,
    latency_ms: 1, status: 'ok', cached: 0, created_at: Date.now(),
  };
  await gstore.enqueueUsageOutbox(tenant.id, { callRow, periodKey: oldPk }, 'test');
  const res = await reconcileUsageOutbox({ limit: 100 });
  assert.equal(res.fail, 0, '补记不应失败');
  const oldB = await gstore.getBudget(tenant.id, null, oldPk);
  assert.equal(oldB.used_tokens, 5, '旧账期预算应累加');
  const curB = await gstore.getBudget(tenant.id, null, curPk);
  assert.equal(curB?.used_tokens || 0, curBefore, '当前账期预算不应被串改');
});

test('R6-4 老 outbox payload（无 periodKey）按 callRow.created_at 账期回放', async () => {
  const { reconcileUsageOutbox } = await import('../src/modules/gateway/routes.mjs');
  // 构造上个月的时间戳（本地时区口径与 periodKeyFromCreatedAt 一致）
  const lastMonth = new Date(); lastMonth.setMonth(lastMonth.getMonth() - 1);
  const oldPk = gstore.periodKeyFromCreatedAt(lastMonth.getTime());
  const curPk = gstore.currentPeriodKey();
  assert.ok(oldPk && oldPk !== curPk, `上月账期 ${oldPk} 应与当前 ${curPk} 不同`);
  await db().query(
    `INSERT INTO budgets(id,tenant_id,project_id,period,cost_limit_cents,token_limit,
     used_cost_cents,used_tokens,period_key,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['bdg_oldpayload_test', tenant.id, null, 'monthly', 100000, 1000000, 0, 0, oldPk, 'active', Date.now(), Date.now()]);
  const curBefore = (await gstore.getBudget(tenant.id, null, curPk))?.used_tokens || 0;
  const callRow = {
    id: 'call_oldpayload_test', tenant_id: tenant.id, project_id: null, actor_id: actor.id,
    trace_id: 't-oldpayload', model: 'deyi-default', litellm_model: 'fake', endpoint: '/x',
    prompt_tokens: 4, completion_tokens: 3, total_tokens: 7, cost_cents: 2,
    latency_ms: 1, status: 'ok', cached: 0, created_at: lastMonth.getTime(),
  };
  // 老格式 payload：只有 callRow，没有 periodKey
  await gstore.enqueueUsageOutbox(tenant.id, { callRow }, 'legacy payload');
  const res = await reconcileUsageOutbox({ limit: 100 });
  assert.equal(res.fail, 0, '补记不应失败');
  const oldB = await gstore.getBudget(tenant.id, null, oldPk);
  assert.equal(oldB.used_tokens, 7, '应记入调用发生月份的账期，而非当前月');
  const curB = await gstore.getBudget(tenant.id, null, curPk);
  assert.equal(curB?.used_tokens || 0, curBefore, '当前账期预算不应被串改');
});

test('R6-5 periodKeyFromCreatedAt 非法输入返回 null', () => {
  assert.equal(gstore.periodKeyFromCreatedAt(undefined), null);
  assert.equal(gstore.periodKeyFromCreatedAt(null), null);
  assert.equal(gstore.periodKeyFromCreatedAt('not-a-time'), null);
  assert.equal(gstore.periodKeyFromCreatedAt(-1), null);
  assert.match(gstore.periodKeyFromCreatedAt(Date.now()), /^\d{4}-\d{2}$/);
});
