/** V3.5 AI 生产力 Agent 测试：评审/用例/风险 + 成本归因 + 鉴权 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-aia-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.OPERATOR_TOKEN = 'op_test_token_artifact33';
process.env.DEV_IDP_SECRET = 'dev-secret-artifact33';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const deliveryStore = await import('../src/modules/delivery/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerAgentRoutes } = await import('../src/modules/agents/routes.mjs');
const { registerAgentTemplateRoutes } = await import('../src/modules/agent_templates/routes.mjs');
const { registerDevAssistRoutes } = await import('../src/modules/dev_assist/routes.mjs');

async function mkKey(tenantId, actorId) {
  const k = mintKey();
  await store.createApiKeyRow({ tenantId, projectId: null, actorId, name: 'k', prefix: k.prefix, keyHash: k.keyHash, scopes: [] });
  return k.secret;
}

let tenantA, pA1, adminKeyA, viewerKeyA, adminIdA, chgA, tenantB, pB1, adminKeyB, chgB;
let base, appServer;

const DIFF = `diff --git a/auth.js b/auth.js
--- a/auth.js
+++ b/auth.js
@@ -1,3 +1,5 @@
 function login(pw) {
-  return check(pw);
+  if (!pw) return false;
+  return check(pw);
 }`;

before(async () => {
  await openDb();
  await migrate(db());

  tenantA = await store.createTenant({ name: 'AIA Tenant A' });
  const adminA = await store.createActor(tenantA.id, { kind: 'user', name: 'AIA Admin A' });
  adminIdA = adminA.id;
  await store.bindRole(tenantA.id, adminA.id, null, 'admin');
  adminKeyA = await mkKey(tenantA.id, adminA.id);
  const viewerA = await store.createActor(tenantA.id, { kind: 'user', name: 'AIA Viewer A' });
  pA1 = await store.createProject(tenantA.id, { name: 'AIA Project 1' });
  await store.bindRole(tenantA.id, viewerA.id, pA1.id, 'viewer');
  viewerKeyA = await mkKey(tenantA.id, viewerA.id);
  const req = await deliveryStore.createRequirement({ tenantId: tenantA.id, projectId: pA1.id, title: '登录空密码校验', createdBy: adminA.id });
  chgA = await deliveryStore.createChangePackage({ tenantId: tenantA.id, projectId: pA1.id, requirementId: req.id, branch: 'feat/empty-pw', createdBy: adminA.id });

  tenantB = await store.createTenant({ name: 'AIA Tenant B' });
  const adminB = await store.createActor(tenantB.id, { kind: 'user', name: 'AIA Admin B' });
  await store.bindRole(tenantB.id, adminB.id, null, 'admin');
  adminKeyB = await mkKey(tenantB.id, adminB.id);
  pB1 = await store.createProject(tenantB.id, { name: 'AIA Project B1' });
  const reqB = await deliveryStore.createRequirement({ tenantId: tenantB.id, projectId: pB1.id, title: 'B 需求', createdBy: adminB.id });
  chgB = await deliveryStore.createChangePackage({ tenantId: tenantB.id, projectId: pB1.id, requirementId: reqB.id, branch: 'feat/b', createdBy: adminB.id });

  const app = createApp();
  registerIdentityRoutes(app);
  registerAgentRoutes(app);
  registerAgentTemplateRoutes(app);
  registerDevAssistRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;
});
after(async () => { await appServer?.close(); });

const url = (pid, chg) => `${base}/v1/projects/${pid}/change-packages/${chg}/ai-assist`;
const call = (method, u, key, body) => fetch(u, {
  method,
  headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

test('一次变更产出评审报告+测试用例（simulated）', async () => {
  const { status, body } = await call('POST', url(pA1.id, chgA.id), adminKeyA, {
    kinds: ['review', 'testgen'], diff: DIFF, mode: 'simulated',
  });
  assert.equal(status, 201);
  assert.equal(body.data.runs.length, 2);
  assert.ok(body.data.runs.every((r) => r.status === 'succeeded'));
  const review = body.data.runs.find((r) => r.kind === 'review');
  const testgen = body.data.runs.find((r) => r.kind === 'testgen');
  assert.ok(review.report && review.report.length > 0, '评审报告非空');
  assert.ok(testgen.report && testgen.report.length > 0, '测试用例非空');
  assert.ok(review.run_id && testgen.run_id);
  assert.equal(body.data.usage_total.total_tokens, 0); // simulated 不走网关，无消耗
});

test('变更风险评估可运行，记录可查', async () => {
  const { status, body } = await call('POST', url(pA1.id, chgA.id), adminKeyA, {
    kinds: ['risk'], diff: DIFF, mode: 'simulated',
  });
  assert.equal(status, 201);
  assert.equal(body.data.runs[0].status, 'succeeded');
  const list = await call('GET', url(pA1.id, chgA.id), adminKeyA);
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 3);
  assert.ok(list.body.data.every((r) => r.report && r.usage));
  const filtered = await call('GET', `${url(pA1.id, chgA.id)}?kind=risk`, adminKeyA);
  assert.equal(filtered.body.data.length, 1);
  assert.equal(filtered.body.data[0].kind, 'risk');
});

test('token 消耗归因：model_calls 按 run trace_id 汇总', async () => {
  const posted = await call('POST', url(pA1.id, chgA.id), adminKeyA, {
    kinds: ['review'], diff: DIFF, mode: 'simulated',
  });
  const runId = posted.body.data.runs[0].run_id;
  const now = Date.now();
  // 模拟网关计量写入（live 模式下 chatInternal 会写入同样结构）
  await db().run(
    `INSERT INTO model_calls(id,tenant_id,project_id,actor_id,trace_id,model,endpoint,
       prompt_tokens,completion_tokens,total_tokens,cost_cents,latency_ms,status,cached,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['call_test1', tenantA.id, pA1.id, adminIdA, runId, 'deyi-default', 'chat.completions',
      1200, 800, 2000, 15, 100, 'ok', 0, now],
  );
  const list = await call('GET', url(pA1.id, chgA.id), adminKeyA);
  const row = list.body.data.find((r) => r.run_id === runId);
  assert.ok(row, '应找到该 run 的记录');
  // 注意：POST 当时是 simulated，无消耗；此处验证归因查询口径——直接调 collectRunUsage
  const { collectRunUsage } = await import('../src/modules/dev_assist/assist.mjs');
  const usage = await collectRunUsage({ tenantId: tenantA.id, runId });
  assert.equal(usage.total_tokens, 2000);
  assert.equal(usage.cost_cents, 15);
  assert.equal(usage.calls, 1);
  // 他 run 的 trace 不串
  const other = await collectRunUsage({ tenantId: tenantA.id, runId: 'agr_nonexistent' });
  assert.equal(other.total_tokens, 0);
});

test('参数校验：未知 kind / 空 diff / 不存在的变更包', async () => {
  const bad1 = await call('POST', url(pA1.id, chgA.id), adminKeyA, { kinds: ['nope'], diff: DIFF });
  assert.equal(bad1.status, 400);
  const bad2 = await call('POST', url(pA1.id, chgA.id), adminKeyA, { kinds: ['review'], diff: '  ' });
  assert.equal(bad2.status, 400);
  const bad3 = await call('POST', url(pA1.id, 'chg_nonexistent'), adminKeyA, { kinds: ['review'], diff: DIFF });
  assert.equal(bad3.status, 404);
  // 跨租户变更包不可见
  const cross = await call('POST', url(pA1.id, chgB.id), adminKeyA, { kinds: ['review'], diff: DIFF });
  assert.equal(cross.status, 404);
});

test('鉴权：viewer 可读不可跑；未鉴权 401', async () => {
  const list = await call('GET', url(pA1.id, chgA.id), viewerKeyA);
  assert.equal(list.status, 200);
  const denied = await call('POST', url(pA1.id, chgA.id), viewerKeyA, { kinds: ['review'], diff: DIFF });
  assert.equal(denied.status, 403);
  const anon = await call('GET', url(pA1.id, chgA.id), null);
  assert.equal(anon.status, 401);
});
