/** V4.4 业务场景模板测试：市场/实例化/可运行/鉴权隔离 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-agtt-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.OPERATOR_TOKEN = 'op_test_token_artifact33';
process.env.DEV_IDP_SECRET = 'dev-secret-artifact33';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerAgentRoutes } = await import('../src/modules/agents/routes.mjs');
const { registerAgentTemplateRoutes } = await import('../src/modules/agent_templates/routes.mjs');

async function mkKey(tenantId, actorId, scopes = []) {
  const k = mintKey();
  await store.createApiKeyRow({ tenantId, projectId: null, actorId, name: 'k', prefix: k.prefix, keyHash: k.keyHash, scopes });
  return k.secret;
}

let tenantA, pA1, adminKeyA, viewerKeyA, approverKeyA, tenantB, pB1, adminKeyB;
let base, appServer;

before(async () => {
  await openDb();
  await migrate(db());

  tenantA = await store.createTenant({ name: 'Tpl Tenant A' });
  const adminA = await store.createActor(tenantA.id, { kind: 'user', name: 'Tpl Admin A' });
  await store.bindRole(tenantA.id, adminA.id, null, 'admin');
  adminKeyA = await mkKey(tenantA.id, adminA.id);

  const viewerA = await store.createActor(tenantA.id, { kind: 'user', name: 'Tpl Viewer A' });
  pA1 = await store.createProject(tenantA.id, { name: 'Tpl Project 1' });
  await store.bindRole(tenantA.id, viewerA.id, pA1.id, 'viewer');
  viewerKeyA = await mkKey(tenantA.id, viewerA.id);

  const approverA = await store.createActor(tenantA.id, { kind: 'user', name: 'Tpl Approver A' });
  await store.bindRole(tenantA.id, approverA.id, pA1.id, 'operator');
  approverKeyA = await mkKey(tenantA.id, approverA.id);

  tenantB = await store.createTenant({ name: 'Tpl Tenant B' });
  const adminB = await store.createActor(tenantB.id, { kind: 'user', name: 'Tpl Admin B' });
  await store.bindRole(tenantB.id, adminB.id, null, 'admin');
  adminKeyB = await mkKey(tenantB.id, adminB.id);
  pB1 = await store.createProject(tenantB.id, { name: 'Tpl Project B1' });

  const app = createApp();
  registerIdentityRoutes(app);
  registerAgentRoutes(app);
  registerAgentTemplateRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;
});
after(async () => { await appServer?.close(); });

const pj = (pid) => `${base}/v1/projects/${pid}`;
const call = (method, url, key, body) => fetch(url, {
  method,
  headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

test('模板市场：3 个内置模板，category 可过滤', async () => {
  const { status, body } = await call('GET', `${pj(pA1.id)}/agent-templates`, adminKeyA);
  assert.equal(status, 200);
  const keys = body.data.map((t) => t.key).sort();
  assert.deepEqual(keys, ['customer-service', 'data-analysis', 'doc-review']);
  assert.ok(body.data.every((t) => t.builtin === true));
  const { body: b2 } = await call('GET', `${pj(pA1.id)}/agent-templates?category=support`, adminKeyA);
  assert.deepEqual(b2.data.map((t) => t.key), ['customer-service']);
});

test('模板详情：params_schema 可见', async () => {
  const list = await call('GET', `${pj(pA1.id)}/agent-templates`, adminKeyA);
  const tpl = list.body.data.find((t) => t.key === 'customer-service');
  const { status, body } = await call('GET', `${pj(pA1.id)}/agent-templates/${tpl.id}`, adminKeyA);
  assert.equal(status, 200);
  const names = body.data.params_schema.map((p) => p.name);
  assert.ok(names.includes('brand_name') && names.includes('tone') && names.includes('model'));
});

test('实例化客服助手：参数渲染进定义，Agent 可运行（simulated）', async () => {
  const list = await call('GET', `${pj(pA1.id)}/agent-templates`, adminKeyA);
  const tpl = list.body.data.find((t) => t.key === 'customer-service');
  const { status, body } = await call('POST', `${pj(pA1.id)}/agent-templates/${tpl.id}/instantiate`, adminKeyA, {
    params: { brand_name: '得逸智行' }, // tone/model 走默认值
    agent_key: 'cs-demo-1',
  });
  assert.equal(status, 201);
  assert.equal(body.data.version.version, 1);
  assert.equal(body.data.instance.params.brand_name, '得逸智行');
  assert.equal(body.data.instance.params.tone, '亲切');

  // 定义已渲染：prompt 含品牌名，无残留占位符（直接查版本快照）
  const vrow = (await db().query('SELECT definition FROM agent_versions WHERE id=?', [body.data.version.id]))[0];
  const dumped = vrow.definition;
  assert.ok(dumped.includes('得逸智行'), '渲染后定义应包含品牌名');
  assert.ok(!dumped.includes('[['), '渲染后不应残留 [[param]] 占位符');
  assert.ok(dumped.includes('{{input.question}}'), '运行时 {{input.x}} 占位应保留');

  // 验收：从模板实例化出可运行的业务 Agent（simulated 模式真实走图）
  const run = await call('POST', `${pj(pA1.id)}/agents/${body.data.agent.id}/runs`, adminKeyA, {
    input: { question: '如何重置密码？' }, mode: 'simulated',
  });
  assert.equal(run.status, 201);
  assert.equal(run.body.data.status, 'succeeded');
  assert.ok(run.body.data.output, 'run 应有输出');

  // 实例化记录
  const inst = await call('GET', `${pj(pA1.id)}/agent-template-instances`, adminKeyA);
  assert.equal(inst.status, 200);
  assert.ok(inst.body.data.some((i) => i.template_key === 'customer-service'));
});

test('文档审阅模板：HITL 流程可运行，换人审批后成功', async () => {
  const list = await call('GET', `${pj(pA1.id)}/agent-templates`, adminKeyA);
  const tpl = list.body.data.find((t) => t.key === 'doc-review');
  const { body } = await call('POST', `${pj(pA1.id)}/agent-templates/${tpl.id}/instantiate`, adminKeyA, {
    params: { focus_areas: '合规性', strictness: '严格' }, agent_key: 'dr-demo-1',
  });
  const run = await call('POST', `${pj(pA1.id)}/agents/${body.data.agent.id}/runs`, adminKeyA, {
    input: { document: '测试文档内容' }, mode: 'simulated',
  });
  assert.equal(run.body.data.status, 'waiting_approval');
  // SoD：发起人不能自批，换 approver 审批
  const selfApprove = await call('POST', `${pj(pA1.id)}/agent-runs/${run.body.data.id}/approve`, adminKeyA, { approved: true });
  assert.equal(selfApprove.status, 403);
  const approve = await call('POST', `${pj(pA1.id)}/agent-runs/${run.body.data.id}/approve`, approverKeyA, { approved: true, note: 'ok' });
  assert.equal(approve.status, 200);
  const done = await call('GET', `${pj(pA1.id)}/agent-runs/${run.body.data.id}`, adminKeyA);
  assert.equal(done.body.data.status, 'succeeded');
});

test('参数校验：缺必填 → 400；未知参数 → 400', async () => {
  const list = await call('GET', `${pj(pA1.id)}/agent-templates`, adminKeyA);
  const tpl = list.body.data.find((t) => t.key === 'customer-service');
  const miss = await call('POST', `${pj(pA1.id)}/agent-templates/${tpl.id}/instantiate`, adminKeyA, { params: {} });
  assert.equal(miss.status, 400);
  const unknown = await call('POST', `${pj(pA1.id)}/agent-templates/${tpl.id}/instantiate`, adminKeyA, {
    params: { brand_name: 'X', bogus: 1 },
  });
  assert.equal(unknown.status, 400);
});

test('租户自定义模板：创建/市场可见性/租户隔离', async () => {
  const created = await call('POST', `${pj(pA1.id)}/agent-templates`, adminKeyA, {
    key: 'my-echo', name: '回声模板', category: 'custom',
    params_schema: [{ name: 'greeting', type: 'string', default: '你好' }],
    definition_template: {
      entry: 'echo',
      nodes: [{ id: 'echo', type: 'llm', name: '回声', prompt: '[[greeting]]：{{input.text}}', next: null }],
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.builtin, false);

  const marketA = await call('GET', `${pj(pA1.id)}/agent-templates`, adminKeyA);
  assert.ok(marketA.body.data.some((t) => t.key === 'my-echo'), '本租户市场应可见自定义模板');
  const marketB = await call('GET', `${pj(pB1.id)}/agent-templates`, adminKeyB);
  assert.ok(!marketB.body.data.some((t) => t.key === 'my-echo'), '他租户市场不可见');
  assert.ok(marketB.body.data.some((t) => t.key === 'customer-service'), '他租户仍可见内置模板');

  // 自定义模板也可实例化运行
  const inst = await call('POST', `${pj(pA1.id)}/agent-templates/${created.body.data.id}/instantiate`, adminKeyA, {
    params: { greeting: '嗨' }, agent_key: 'echo-demo-1',
  });
  assert.equal(inst.status, 201);
  const run = await call('POST', `${pj(pA1.id)}/agents/${inst.body.data.agent.id}/runs`, adminKeyA, {
    input: { text: 'hello' }, mode: 'simulated',
  });
  assert.equal(run.body.data.status, 'succeeded');
});

test('非法模板创建：未知占位符 / 非法图 → 400', async () => {
  const bad1 = await call('POST', `${pj(pA1.id)}/agent-templates`, adminKeyA, {
    key: 'bad-ph', name: '坏占位', params_schema: [],
    definition_template: { entry: 'a', nodes: [{ id: 'a', type: 'llm', prompt: '[[nope]]', next: null }] },
  });
  assert.equal(bad1.status, 400);
  const bad2 = await call('POST', `${pj(pA1.id)}/agent-templates`, adminKeyA, {
    key: 'bad-graph', name: '坏图', params_schema: [],
    definition_template: { entry: 'a', nodes: [{ id: 'a', type: 'llm', prompt: 'x', next: 'missing' }] },
  });
  assert.equal(bad2.status, 400);
});

test('鉴权：viewer 可读不可写；未鉴权 401', async () => {
  const list = await call('GET', `${pj(pA1.id)}/agent-templates`, viewerKeyA);
  assert.equal(list.status, 200);
  const tpl = list.body.data.find((t) => t.key === 'data-analysis');
  const denied = await call('POST', `${pj(pA1.id)}/agent-templates/${tpl.id}/instantiate`, viewerKeyA, {
    params: { dataset_description: 'd', metrics: 'm' },
  });
  assert.equal(denied.status, 403);
  const anon = await call('GET', `${pj(pA1.id)}/agent-templates`, null);
  assert.equal(anon.status, 401);
});
