/** V4.5 执行成本归因测试：任务成本 == 其下调用的网关计量之和（fake 上游真端到端） */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

const FAKE_PORT = 14532;

// fake LiteLLM 上游（固定端口，必须在业务模块 import 前启动，因为 config 读 env）
const fake = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const auth = req.headers['authorization'];
    if (auth !== 'Bearer ' + 'test-' + 'master') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'bad master key' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-cost', object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: '成本测试输出' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  });
});
await new Promise((r) => fake.listen(FAKE_PORT, '127.0.0.1', r));
after(() => new Promise((r) => fake.close(r)));

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-cost-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.DEV_IDP_SECRET = 'dev-idp-secret-for-tests-only';
process.env.BOOTSTRAP_ENABLED = 'false';
process.env.LITELLM_URL = `http://127.0.0.1:${FAKE_PORT}`;
process.env.LITELLM_MASTER_KEY = 'test-master';
process.env.GATEWAY_MAX_RETRIES = '0';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const gstore = await import('../src/modules/gateway/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerTaskRoutes } = await import('../src/modules/tasks/routes.mjs');
const { registerAgentRoutes } = await import('../src/modules/agents/routes.mjs');
const { registerAgentTemplateRoutes } = await import('../src/modules/agent_templates/routes.mjs');
const { registerDevAssistRoutes } = await import('../src/modules/dev_assist/routes.mjs');

async function mkKey(tenantId, actorId) {
  const k = mintKey();
  await store.createApiKeyRow({ tenantId, projectId: null, actorId, name: 'k', prefix: k.prefix, keyHash: k.keyHash, scopes: [] });
  return k.secret;
}

let tenantA, pA1, adminKeyA, viewerKeyA, tenantB, pB1, adminKeyB;
let base, appServer;

before(async () => {
  await openDb();
  await migrate(db());
  await gstore.ensureSeedModels();

  tenantA = await store.createTenant({ name: 'Cost Tenant A' });
  const adminA = await store.createActor(tenantA.id, { kind: 'user', name: 'Cost Admin A' });
  await store.bindRole(tenantA.id, adminA.id, null, 'admin');
  adminKeyA = await mkKey(tenantA.id, adminA.id);
  pA1 = await store.createProject(tenantA.id, { name: 'Cost Project 1' });
  const viewerA = await store.createActor(tenantA.id, { kind: 'user', name: 'Cost Viewer A' });
  await store.bindRole(tenantA.id, viewerA.id, pA1.id, 'viewer');
  viewerKeyA = await mkKey(tenantA.id, viewerA.id);

  tenantB = await store.createTenant({ name: 'Cost Tenant B' });
  const adminB = await store.createActor(tenantB.id, { kind: 'user', name: 'Cost Admin B' });
  await store.bindRole(tenantB.id, adminB.id, null, 'admin');
  adminKeyB = await mkKey(tenantB.id, adminB.id);
  pB1 = await store.createProject(tenantB.id, { name: 'Cost Project B1' });

  const app = createApp();
  registerIdentityRoutes(app);
  registerTaskRoutes(app);
  registerAgentRoutes(app);
  registerAgentTemplateRoutes(app);
  registerDevAssistRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;
});
after(async () => { await appServer?.close(); });

const pj = (pid) => `${base}/v1/projects/${pid}`;
const call = (method, u, key, body) => fetch(u, {
  method,
  headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

test('任务成本 == 其下 agent run 的网关计量之和（live 真端到端）', async () => {
  // 建任务
  const t = await call('POST', `${pj(pA1.id)}/tasks`, adminKeyA, { kind: 'ticket', title: '修登录 bug' });
  assert.equal(t.status, 201);
  const taskId = t.body.data.id;

  // 成本视图初始为 0
  const zero = await call('GET', `${pj(pA1.id)}/tasks/${taskId}/cost`, adminKeyA);
  assert.equal(zero.status, 200);
  assert.equal(zero.body.data.total.total_tokens, 0);
  assert.deepEqual(zero.body.data.by_kind, []);

  // 为任务实例化代码评审模板并 live 运行（2 个 llm 节点 → 2 次网关调用）
  const list = await call('GET', `${pj(pA1.id)}/agent-templates`, adminKeyA);
  const tpl = list.body.data.find((x) => x.key === 'code-review');
  const inst = await call('POST', `${pj(pA1.id)}/agent-templates/${tpl.id}/instantiate`, adminKeyA, {
    params: {}, agent_key: 'cost-review-1',
  });
  assert.equal(inst.status, 201);
  const run = await call('POST', `${pj(pA1.id)}/agents/${inst.body.data.agent.id}/runs`, adminKeyA, {
    input: { diff: 'diff --git a/x.js b/x.js\n+fix', context: '修登录' },
    mode: 'live', biz_task_id: taskId,
  });
  assert.equal(run.status, 201);
  assert.equal(run.body.data.status, 'succeeded');
  const runId = run.body.data.id;

  // 网关计量确实落在 run 级 trace 下（而非请求 trace）
  const calls = await db().query(
    `SELECT trace_id, total_tokens, cost_cents FROM model_calls WHERE tenant_id=? AND trace_id=?`,
    [tenantA.id, runId],
  );
  assert.equal(calls.length, 2, '2 个 llm 节点应产生 2 条计量');
  assert.ok(calls.every((c) => c.trace_id === runId));

  // 成本视图：任务成本 == 网关计量之和
  const cost = await call('GET', `${pj(pA1.id)}/tasks/${taskId}/cost`, adminKeyA);
  assert.equal(cost.status, 200);
  const d = cost.body.data;
  assert.equal(d.links.length, 1);
  assert.equal(d.links[0].kind, 'agent_run');
  assert.equal(d.links[0].trace_id, runId);
  const expected = calls.reduce((a, c) => a + c.total_tokens, 0);
  assert.equal(d.total.total_tokens, expected);
  assert.equal(d.total.total_tokens, 30); // 2 × 15（fake 上游固定 usage）
  assert.equal(d.by_kind.length, 1);
  assert.equal(d.by_kind[0].kind, 'agent_run');
  assert.equal(d.by_kind[0].total_tokens, 30);
  assert.ok(d.total.cost_cents >= 0);
});

test('ai_assist 为任务运行时登记归因边；多来源汇总', async () => {
  const t = await call('POST', `${pj(pA1.id)}/tasks`, adminKeyA, { kind: 'ticket', title: 'AI 评审任务' });
  const taskId = t.body.data.id;
  // 建变更包（dev_assist 需要）
  const deliveryStore = await import('../src/modules/delivery/store.mjs');
  const adminRow = (await db().query('SELECT id FROM actors WHERE tenant_id=? LIMIT 1', [tenantA.id]))[0];
  const req = await deliveryStore.createRequirement({ tenantId: tenantA.id, projectId: pA1.id, title: '需求', createdBy: adminRow.id });
  const chg = await deliveryStore.createChangePackage({ tenantId: tenantA.id, projectId: pA1.id, requirementId: req.id, branch: 'feat/cost', createdBy: adminRow.id });

  const r = await call('POST', `${pj(pA1.id)}/change-packages/${chg.id}/ai-assist`, adminKeyA, {
    kinds: ['review'], diff: 'diff --git a/a.js b/a.js\n+1', mode: 'simulated', biz_task_id: taskId,
  });
  assert.equal(r.status, 201);
  const cost = await call('GET', `${pj(pA1.id)}/tasks/${taskId}/cost`, adminKeyA);
  assert.equal(cost.body.data.links.length, 1);
  assert.equal(cost.body.data.links[0].kind, 'ai_assist_run');
  assert.equal(cost.body.data.by_kind[0].kind, 'ai_assist_run');
  assert.equal(cost.body.data.total.total_tokens, 0); // simulated 无消耗，但边已登记

  // 不存在的任务 → 400/404（linkCost 校验）
  const bad = await call('POST', `${pj(pA1.id)}/change-packages/${chg.id}/ai-assist`, adminKeyA, {
    kinds: ['review'], diff: 'x', mode: 'simulated', biz_task_id: 'bt_nonexistent',
  });
  assert.ok([400, 404].includes(bad.status));
});

test('鉴权与隔离：viewer 可读；跨租户任务 404；未鉴权 401', async () => {
  const t = await call('POST', `${pj(pA1.id)}/tasks`, adminKeyA, { kind: 'ticket', title: '隔离测试' });
  const taskId = t.body.data.id;
  const v = await call('GET', `${pj(pA1.id)}/tasks/${taskId}/cost`, viewerKeyA);
  assert.equal(v.status, 200);
  const cross = await call('GET', `${pj(pB1.id)}/tasks/${taskId}/cost`, adminKeyB);
  assert.equal(cross.status, 404);
  const anon = await call('GET', `${pj(pA1.id)}/tasks/${taskId}/cost`, null);
  assert.equal(anon.status, 401);
});
