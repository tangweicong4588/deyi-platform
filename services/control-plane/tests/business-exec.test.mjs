/** V2.0-B 授权执行测试：短期授权 / 幂等 / dry-run 硬拦截 / 高风险审批 / 补偿与对账 / 脱敏 / 鉴权 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-bizexec-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op-token-bizexec';
process.env.DEV_IDP_SECRET = 'dev-secret-bizexec';
process.env.BOOTSTRAP_ENABLED = 'false';
process.env.BUSINESS_GRANT_TTL_MS = '900000';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const bizStore = await import('../src/modules/business/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerBusinessRoutes } = await import('../src/modules/business/routes.mjs');
const { registerTool } = await import('../src/modules/execution/service.mjs');
const ontologySvc = await import('../src/modules/ontology/service.mjs');
const planMod = await import('../src/modules/business/plan.mjs');
const execMod = await import('../src/modules/business/execute.mjs');

let tenant, project, adminSecret, opSecret, viewerSecret, otherSecret, adminActor, opActor;
let base, appServer, fakeServer, fakePort;
const fakeCalls = []; // [{ path, body }]，断言外部调用次数与补偿顺序

async function mkActorWithKey(tenantId, name, projectId, role) {
  const a = await store.createActor(tenantId, { kind: 'user', name });
  await store.bindRole(tenantId, a.id, projectId, role);
  const k = mintKey();
  await store.createApiKeyRow({ tenantId, actorId: a.id, name, prefix: k.prefix, keyHash: k.keyHash });
  return { actor: a, secret: k.secret };
}

before(async () => {
  // ---- fake 外部系统：计数 + 返回含"密钥形状"的响应（测脱敏） + 记录补偿顺序 ----
  fakeServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      fakeCalls.push({ path: req.url, body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/ext') {
        res.end(JSON.stringify({
          external_ref: 'EXT-2026-0001',
          payload: { api_key: 'sk-live-sekritAAA', note: 'ok' },
          blob: 'token=sk-live-sekritBBB',
        }));
      } else if (req.url === '/comp1' || req.url === '/comp2') {
        res.end(JSON.stringify({ ok: true, compensated: req.url }));
      } else {
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  await new Promise((r) => fakeServer.listen(0, '127.0.0.1', r));
  fakePort = fakeServer.address().port;

  await openDb();
  await migrate(db());
  tenant = await store.createTenant({ name: 'BIZEXEC Tenant' });
  project = await store.createProject(tenant.id, { name: 'BIZEXEC Project' });

  const adm = await mkActorWithKey(tenant.id, 'bex-admin', null, 'admin');
  adminActor = adm.actor; adminSecret = adm.secret;
  const op = await mkActorWithKey(tenant.id, 'bex-op', project.id, 'operator');
  opActor = op.actor; opSecret = op.secret;
  const vw = await mkActorWithKey(tenant.id, 'bex-viewer', project.id, 'viewer');
  viewerSecret = vw.secret;
  const t2 = await store.createTenant({ name: 'BIZEXEC Tenant B' });
  const b = await mkActorWithKey(t2.id, 'bex-b-admin', null, 'admin');
  otherSecret = b.secret;

  const F = (p) => `http://127.0.0.1:${fakePort}${p}`;
  await registerTool({ tenantId: tenant.id, projectId: project.id, actorId: adminActor.id, name: 'erp.purchase_order', kind: 'builtin', toolConfig: { builtin: 'echo' }, riskLevel: 'medium' });
  await registerTool({ tenantId: tenant.id, projectId: project.id, actorId: adminActor.id, name: 'wms.stock_transfer', kind: 'builtin', toolConfig: { builtin: 'echo' }, riskLevel: 'high' });
  await registerTool({ tenantId: tenant.id, projectId: project.id, actorId: adminActor.id, name: 'ext.echo', kind: 'http', endpoint: F('/ext'), toolConfig: {}, riskLevel: 'medium' });
  await registerTool({ tenantId: tenant.id, projectId: project.id, actorId: adminActor.id, name: 'comp.first', kind: 'http', endpoint: F('/comp1'), toolConfig: {}, riskLevel: 'medium' });
  await registerTool({ tenantId: tenant.id, projectId: project.id, actorId: adminActor.id, name: 'comp.second', kind: 'http', endpoint: F('/comp2'), toolConfig: {}, riskLevel: 'medium' });
  await registerTool({ tenantId: tenant.id, projectId: project.id, actorId: adminActor.id, name: 'test.failsvc', kind: 'builtin', toolConfig: { builtin: 'fail' }, riskLevel: 'medium' });

  for (const name of ['采购订单', '供应商', '库存调拨单', '仓库']) {
    const { term } = await ontologySvc.submitCandidate({
      tenantId: tenant.id, projectId: project.id, name, kind: 'concept',
      definition: `${name}（测试）`, evidence: [], actorId: adminActor.id,
    });
    await ontologySvc.startReview({ tenantId: tenant.id, termId: term.id });
    await ontologySvc.publishTerm({ tenantId: tenant.id, termId: term.id });
  }
});

let appStarted = false;
before(async () => {
  if (appStarted) return;
  appStarted = true;
  const app = createApp();
  registerIdentityRoutes(app);
  registerBusinessRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;
});
after(() => Promise.all([
  new Promise((r) => appServer.close(r)),
  new Promise((r) => fakeServer.close(r)),
]));

const B = (pid) => `${base}/v1/projects/${pid}/business`;
const H = (s) => ({ 'content-type': 'application/json', authorization: `Bearer ${s}` });
async function post(p, secret, body) {
  const r = await fetch(p, { method: 'POST', headers: H(secret), body: JSON.stringify(body || {}) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
async function get(p, secret) {
  const r = await fetch(p, { headers: H(secret) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
const codeOf = (json) => json?.error?.details?.code;

/** 完整 happy path 脚手架：意图 → 计划 → dryrun →（可选）批准 → 返回 { plan, action } */
async function readyPlan(text, { approve = false } = {}) {
  const { json: ij } = await post(`${B(project.id)}/intents`, opSecret, { raw_text: text });
  assert.equal(ij.data.status, 'draft');
  const { json: pj } = await post(`${B(project.id)}/intents/${ij.data.id}/plan`, opSecret, {});
  const planId = pj.data.plan.id;
  const dr = await post(`${B(project.id)}/plans/${planId}/dryrun`, opSecret, {});
  assert.equal(dr.json.data.plan.status, 'dryrun_passed');
  if (approve) {
    const ap = await post(`${B(project.id)}/plans/${planId}/approve`, adminSecret, {});
    assert.equal(ap.status, 200);
  }
  const acts = await get(`${B(project.id)}/plans/${planId}/actions`, opSecret);
  return { plan: pj.data.plan, planId, action: acts.json.data[0], actions: acts.json.data };
}

// ---------- dry-run 硬拦截 ----------
test('dry-run 未通过的动作绝不允许执行', async () => {
  const { json: ij } = await post(`${B(project.id)}/intents`, opSecret, { raw_text: '报销餐费，金额300元' });
  const { json: pj } = await post(`${B(project.id)}/intents/${ij.data.id}/plan`, opSecret, {});
  const planId = pj.data.plan.id;
  await post(`${B(project.id)}/plans/${planId}/dryrun`, opSecret, {}); // finance.reimburse 未注册 → blocked
  const acts = await get(`${B(project.id)}/plans/${planId}/actions`, opSecret);
  assert.equal(acts.json.data[0].status, 'dryrun_blocked');
  const { status, json } = await post(
    `${B(project.id)}/actions/${acts.json.data[0].id}/execute`, opSecret, {});
  assert.equal(status, 403);
  assert.equal(codeOf(json), 'DRYRUN_BLOCKED');
  // 整计划执行同样被拒
  const p2 = await post(`${B(project.id)}/plans/${planId}/execute`, opSecret, {});
  assert.equal(p2.status, 403);
  assert.equal(codeOf(p2.json), 'DRYRUN_BLOCKED');
});

test('未 dry-run 的计划不允许执行', async () => {
  const { json: ij } = await post(`${B(project.id)}/intents`, opSecret, { raw_text: '采购订书机，金额90元' });
  const { json: pj } = await post(`${B(project.id)}/intents/${ij.data.id}/plan`, opSecret, {});
  const { status, json } = await post(
    `${B(project.id)}/plans/${pj.data.plan.id}/execute`, opSecret, {});
  assert.equal(status, 409);
  assert.equal(codeOf(json), 'INVALID_PLAN_STATE');
});

// ---------- 正常执行与短期授权 ----------
test('单动作执行：done + grant 单次失效 + 可查询', async () => {
  const { action } = await readyPlan('采购显示器，金额2000元');
  const { status, json } = await post(
    `${B(project.id)}/actions/${action.id}/execute`, opSecret, {});
  assert.equal(status, 200);
  assert.equal(json.data.action.status, 'done');
  assert.equal(json.data.execution.status, 'succeeded');
  assert.equal(json.data.deduplicated, false);
  assert.match(json.data.execution.id, /^bxn_[0-9a-z]{26}$/);
  // grant 已消费
  const g = await bizStore.getGrant(tenant.id, json.data.execution.grant_id);
  assert.equal(g.status, 'used');
  // 执行记录可查询
  const q = await get(`${B(project.id)}/executions/${json.data.execution.id}`, opSecret);
  assert.equal(q.status, 200);
  assert.equal(q.json.data.id, json.data.execution.id);
});

test('grant 单次有效：消费后再次传入被拒（未命中幂等的新动作）', async () => {
  const r1p = await readyPlan('采购键盘，金额300元');
  const r2p = await readyPlan('采购鼠标垫，金额60元');
  const { grant } = await execMod.issueGrant({
    tenantId: tenant.id, projectId: project.id, actionId: r1p.action.id, actorId: opActor.id,
  });
  const r1 = await post(`${B(project.id)}/actions/${r1p.action.id}/execute`, opSecret, { grant_id: grant.id });
  assert.equal(r1.status, 200);
  assert.equal((await bizStore.getGrant(tenant.id, grant.id)).status, 'used');
  // 把已消费的 grant 换绑到另一个无执行记录的动作 → 校验阶段即被拒（GRANT_NOT_ACTIVE）
  await db().query('UPDATE credential_grants SET action_id=?, scope=? WHERE id=?',
    [r2p.action.id, JSON.stringify({
      tool_id: r2p.action.tool_ref, tool_action: 'execute',
      args_hash: (await import('../src/modules/execution/service.mjs')).hashArgs(r2p.action.args),
    }), grant.id]);
  const r2 = await post(`${B(project.id)}/actions/${r2p.action.id}/execute`, opSecret, { grant_id: grant.id });
  assert.equal(r2.status, 403);
  assert.equal(codeOf(r2.json), 'GRANT_NOT_ACTIVE');
});

test('grant 过期被拒', async () => {
  const { action } = await readyPlan('采购鼠标，金额150元');
  const { grant } = await execMod.issueGrant({
    tenantId: tenant.id, projectId: project.id, actionId: action.id, actorId: opActor.id,
  });
  await db().query('UPDATE credential_grants SET expires_at=? WHERE id=?', [Date.now() - 1000, grant.id]);
  const { status, json } = await post(
    `${B(project.id)}/actions/${action.id}/execute`, opSecret, { grant_id: grant.id });
  assert.equal(status, 403);
  assert.equal(codeOf(json), 'GRANT_EXPIRED');
  const g = await bizStore.getGrant(tenant.id, grant.id);
  assert.equal(g.status, 'expired');
});

test('grant scope 不匹配被拒并吊销（工具被篡改的 TOCTOU）', async () => {
  const { action } = await readyPlan('采购U盘，金额80元');
  // 伪造一个 scope 指向其他工具的 grant（模拟签发后动作被篡改）
  const evil = await bizStore.insertGrant({
    tenantId: tenant.id, projectId: project.id, actionId: action.id,
    scope: { tool_id: 'tool_evil', tool_action: 'execute', args_hash: 'deadbeef' },
    expiresAt: Date.now() + 600000, createdBy: opActor.id, grantedTo: opActor.id,
  });
  const { status, json } = await post(
    `${B(project.id)}/actions/${action.id}/execute`, opSecret, { grant_id: evil.id });
  assert.equal(status, 403);
  assert.equal(codeOf(json), 'GRANT_SCOPE_MISMATCH');
  const g = await bizStore.getGrant(tenant.id, evil.id);
  assert.equal(g.status, 'revoked');
});

// ---------- 幂等 ----------
test('重复执行直接返回首次结果，不重复调用外部', async () => {
  fakeCalls.length = 0;
  // 用 http 工具构造可计数的外部调用：直接建动作指向 ext.echo
  const intent = await bizStore.createIntent({ tenantId: tenant.id, projectId: project.id, rawText: '外部调用计数', createdBy: opActor.id });
  const p = await bizStore.createPlan({ tenantId: tenant.id, projectId: project.id, intentId: intent.id, createdBy: opActor.id });
  const tools = await (await import('../src/modules/execution/service.mjs')).listTools(tenant.id);
  const ext = tools.find((t) => t.name === 'ext.echo');
  const { idempotencyKeyFor } = planMod.__internal;
  const a = await bizStore.createAction({
    tenantId: tenant.id, projectId: project.id, planId: p.id, seq: 1,
    toolRef: ext.id, toolName: 'ext.echo', args: { q: 'ping' },
    idempotencyKey: idempotencyKeyFor(p.id, 1),
    expectedEffect: { target_system: 'ext', objects: ['x'], reversible: true, approval_required: false },
  });
  await bizStore.updatePlan(tenant.id, p.id, { status: 'dryrun_passed' });
  await bizStore.updateAction(tenant.id, a.id, { status: 'dryrun_ok' });

  const r1 = await post(`${B(project.id)}/actions/${a.id}/execute`, opSecret, {});
  assert.equal(r1.status, 200);
  assert.equal(r1.json.data.deduplicated, false);
  const r2 = await post(`${B(project.id)}/actions/${a.id}/execute`, opSecret, {});
  assert.equal(r2.status, 200);
  assert.equal(r2.json.data.deduplicated, true);
  assert.equal(r2.json.data.execution.id, r1.json.data.execution.id);
  const extCalls = fakeCalls.filter((c) => c.path === '/ext');
  assert.equal(extCalls.length, 1, '外部只应被调用一次');
});

// ---------- 脱敏 ----------
test('外部响应只存 external_ref + 脱敏摘要，敏感原文不落库', async () => {
  const intent = await bizStore.createIntent({ tenantId: tenant.id, projectId: project.id, rawText: '脱敏验证', createdBy: opActor.id });
  const p = await bizStore.createPlan({ tenantId: tenant.id, projectId: project.id, intentId: intent.id, createdBy: opActor.id });
  const svc = await import('../src/modules/execution/service.mjs');
  const ext = (await svc.listTools(tenant.id)).find((t) => t.name === 'ext.echo');
  const { idempotencyKeyFor } = planMod.__internal;
  const a = await bizStore.createAction({
    tenantId: tenant.id, projectId: project.id, planId: p.id, seq: 1,
    toolRef: ext.id, toolName: 'ext.echo', args: { q: 'ping' },
    idempotencyKey: idempotencyKeyFor(p.id, 1),
    expectedEffect: { target_system: 'ext', objects: ['x'], reversible: true, approval_required: false },
  });
  await bizStore.updatePlan(tenant.id, p.id, { status: 'dryrun_passed' });
  await bizStore.updateAction(tenant.id, a.id, { status: 'dryrun_ok' });
  const r = await post(`${B(project.id)}/actions/${a.id}/execute`, opSecret, {});
  assert.equal(r.status, 200);
  assert.equal(r.json.data.execution.external_ref, 'EXT-2026-0001');
  const row = await bizStore.getBusinessExecution(tenant.id, r.json.data.execution.id);
  assert.ok(!row.result_summary.includes('sk-live-sekritAAA'), 'key 名脱敏');
  assert.ok(!row.result_summary.includes('sk-live-sekritBBB'), 'value 形状脱敏');
  assert.ok(row.result_summary.includes('***'));
  assert.ok(!String(row.external_ref).includes('sk-'));
  // P6 侧 executions.result_ref 同样不得有敏感原文
  const p6rows = await db().query('SELECT result_ref FROM executions WHERE idempotency_key=?', [a.idempotency_key]);
  assert.ok(p6rows.length > 0);
  assert.ok(!p6rows[0].result_ref.includes('sk-live-sekritAAA'));
});

// ---------- 高风险审批 ----------
test('高风险动作未批准计划时执行被拒', async () => {
  const { action } = await readyPlan('调拨笔记本50台，从华东仓到华南仓');
  assert.equal(action.expected_effect.approval_required, true);
  const { status, json } = await post(
    `${B(project.id)}/actions/${action.id}/execute`, opSecret, {});
  assert.equal(status, 403);
  assert.equal(codeOf(json), 'PLAN_APPROVAL_REQUIRED');
});

test('审批人=创建人时批准被拒（职责分离）', async () => {
  const { json: ij } = await post(`${B(project.id)}/intents`, opSecret, { raw_text: '调拨键盘20个，从华东仓到华南仓' });
  const { json: pj } = await post(`${B(project.id)}/intents/${ij.data.id}/plan`, opSecret, {});
  await post(`${B(project.id)}/plans/${pj.data.plan.id}/dryrun`, opSecret, {});
  const { status, json } = await post(`${B(project.id)}/plans/${pj.data.plan.id}/approve`, opSecret, {});
  assert.equal(status, 403);
  assert.equal(codeOf(json), 'SOD_VIOLATION');
});

test('他人批准后高风险动作可执行：P6 审批自动放行且审计可追溯', async () => {
  const { planId, action } = await readyPlan('调拨显示器30台，从华东仓到华南仓', { approve: true });
  const pa = await bizStore.getPlanApproval(tenant.id, planId);
  assert.ok(pa, '审批记录落库');
  assert.equal(pa.approver_id, adminActor.id);
  const { status, json } = await post(
    `${B(project.id)}/actions/${action.id}/execute`, opSecret, {});
  assert.equal(status, 200);
  assert.equal(json.data.action.status, 'done');
  // P6 侧审批单被自动决议（approved），不是悬空 pending
  const aprs = await db().query(
    `SELECT a.* FROM approvals a JOIN executions e ON e.approval_id=a.id WHERE e.idempotency_key=?`,
    [action.idempotency_key]);
  assert.equal(aprs.length, 1);
  assert.equal(aprs[0].status, 'approved');
  assert.equal(aprs[0].decided_by, adminActor.id);
});

// ---------- 失败 / 补偿 / 对账 ----------
/** 手工多动作计划：a1(成功,有补偿) → a2(成功,有补偿) → a3(失败)，验证逆序补偿 */
async function buildRollbackPlan() {
  const svc = await import('../src/modules/execution/service.mjs');
  const tools = await svc.listTools(tenant.id);
  const byName = (n) => tools.find((t) => t.name === n).id;
  const intent = await bizStore.createIntent({ tenantId: tenant.id, projectId: project.id, rawText: '回滚验证', createdBy: opActor.id });
  const p = await bizStore.createPlan({ tenantId: tenant.id, projectId: project.id, intentId: intent.id, createdBy: opActor.id });
  const { idempotencyKeyFor } = planMod.__internal;
  const mk = (seq, toolName, compName) => bizStore.createAction({
    tenantId: tenant.id, projectId: project.id, planId: p.id, seq,
    toolRef: byName(toolName), toolName, args: { seq },
    idempotencyKey: idempotencyKeyFor(p.id, seq),
    expectedEffect: {
      target_system: 'test', objects: [`a${seq}`], reversible: true,
      approval_required: false, ...(compName ? { compensation_tool: compName } : {}),
    },
  });
  // 注意：补偿工具挂在"主动作"的 expected_effect.compensation_tool 上
  const a1 = await mk(1, 'erp.purchase_order', null);
  const a2 = await mk(2, 'erp.purchase_order', null);
  const a3 = await mk(3, 'test.failsvc', null);
  await bizStore.updateAction(tenant.id, a1.id, {
    status: 'dryrun_ok',
    expected_effect: { target_system: 'test', objects: ['a1'], reversible: true, approval_required: false, compensation_tool: 'comp.first' },
  });
  await bizStore.updateAction(tenant.id, a2.id, {
    status: 'dryrun_ok',
    expected_effect: { target_system: 'test', objects: ['a2'], reversible: true, approval_required: false, compensation_tool: 'comp.second' },
  });
  await bizStore.updateAction(tenant.id, a3.id, { status: 'dryrun_ok' });
  await bizStore.updatePlan(tenant.id, p.id, { status: 'dryrun_passed' });
  return { planId: p.id, a1, a2, a3 };
}

test('计划执行失败 → 停止后续 → 已成功动作逆序补偿', async () => {
  fakeCalls.length = 0;
  const { planId, a1, a2, a3 } = await buildRollbackPlan();
  const { status, json } = await post(`${B(project.id)}/plans/${planId}/execute`, opSecret, {});
  assert.equal(status, 200);
  assert.equal(json.data.failed_action_id, a3.id);
  assert.equal(json.data.results.length, 3);
  assert.equal(json.data.results[2].status, 'failed');
  const s1 = await bizStore.getAction(tenant.id, a1.id);
  const s2 = await bizStore.getAction(tenant.id, a2.id);
  const s3 = await bizStore.getAction(tenant.id, a3.id);
  assert.equal(s1.status, 'compensated');
  assert.equal(s2.status, 'compensated');
  assert.equal(s3.status, 'failed');
  // 补偿顺序：a2 的 comp.second 先于 a1 的 comp.first（逆序）
  const compCalls = fakeCalls.filter((c) => c.path === '/comp1' || c.path === '/comp2').map((c) => c.path);
  assert.deepEqual(compCalls, ['/comp2', '/comp1']);
  // 失败动作进对账队列
  const recs = await bizStore.listReconciliations(tenant.id, { status: 'open' });
  assert.ok(recs.some((r) => r.action_id === a3.id), '失败动作应进对账');
});

test('整计划 happy path → 意图 done', async () => {
  const { planId } = await readyPlan('采购网线，金额120元');
  const { status, json } = await post(`${B(project.id)}/plans/${planId}/execute`, opSecret, {});
  assert.equal(status, 200);
  assert.equal(json.data.failed_action_id, null);
  assert.equal(json.data.results[0].status, 'done');
  const plan = await bizStore.getPlan(tenant.id, planId);
  const intent = await bizStore.getIntent(tenant.id, plan.intent_id);
  assert.equal(intent.status, 'done');
});

// ---------- 鉴权 ----------
test('viewer 不可执行', async () => {
  const { action } = await readyPlan('采购剪刀，金额40元');
  const { status } = await post(`${B(project.id)}/actions/${action.id}/execute`, viewerSecret, {});
  assert.equal(status, 403);
});

test('跨租户 403/404', async () => {
  const { action } = await readyPlan('采购胶带，金额30元');
  const ex = await post(`${B(project.id)}/actions/${action.id}/execute`, opSecret, {});
  assert.equal(ex.status, 200);
  const bxnId = ex.json.data.execution.id;
  const g1 = await get(`${B(project.id)}/executions/${bxnId}`, otherSecret);
  assert.ok([403, 404].includes(g1.status), `跨租户查询应拒绝，实际 ${g1.status}`);
  const p2 = await post(`${B(project.id)}/actions/${action.id}/execute`, otherSecret, {});
  assert.ok([403, 404].includes(p2.status), `跨租户执行应拒绝，实际 ${p2.status}`);
});

test('平台运维伪 actor 不能直接执行（与 P6 同规则）', async () => {
  await assert.rejects(
    () => execMod.executeAction({
      tenantId: tenant.id, projectId: project.id, actionId: 'bact_00000000000000000000000000', actorId: 'operator',
    }),
    (e) => e?.code === 'FORBIDDEN');
});

test('幂等键并发碰撞：唯一约束兜底只保留首次记录', async () => {
  const svc = await import('../src/modules/execution/service.mjs');
  const tool = (await svc.listTools(tenant.id)).find((t) => t.name === 'erp.purchase_order');
  const intent = await bizStore.createIntent({ tenantId: tenant.id, projectId: project.id, rawText: '碰撞验证', createdBy: opActor.id });
  const p = await bizStore.createPlan({ tenantId: tenant.id, projectId: project.id, intentId: intent.id, createdBy: opActor.id });
  const { idempotencyKeyFor } = planMod.__internal;
  const a = await bizStore.createAction({
    tenantId: tenant.id, projectId: project.id, planId: p.id, seq: 1,
    toolRef: tool.id, toolName: 'erp.purchase_order', args: {},
    idempotencyKey: idempotencyKeyFor(p.id, 1),
    expectedEffect: { target_system: 'erp', objects: ['x'], reversible: true, approval_required: false },
  });
  const mk = () => bizStore.insertBusinessExecution({
    tenantId: tenant.id, projectId: project.id, actionId: a.id, grantId: null, idempotencyKey: a.idempotency_key,
  });
  const first = await mk();
  await assert.rejects(() => mk(), (e) => /UNIQUE|unique|duplicate/i.test(e.message));
  const back = await bizStore.getBusinessExecutionByKey(tenant.id, a.idempotency_key);
  assert.equal(back.id, first.id, '碰撞后回读的必须是首次记录');
});

test('补偿本身失败 → 如实进对账，不静默（二次失败）', async () => {  const svc = await import('../src/modules/execution/service.mjs');
  const tools = await svc.listTools(tenant.id);
  const byName = (n) => tools.find((t) => t.name === n).id;
  const intent = await bizStore.createIntent({ tenantId: tenant.id, projectId: project.id, rawText: '补偿失败验证', createdBy: opActor.id });
  const p = await bizStore.createPlan({ tenantId: tenant.id, projectId: project.id, intentId: intent.id, createdBy: opActor.id });
  const { idempotencyKeyFor } = planMod.__internal;
  const eff = (comp) => ({ target_system: 'test', objects: ['x'], reversible: true, approval_required: false, ...(comp ? { compensation_tool: comp } : {}) });
  const a1 = await bizStore.createAction({
    tenantId: tenant.id, projectId: project.id, planId: p.id, seq: 1,
    toolRef: byName('erp.purchase_order'), toolName: 'erp.purchase_order', args: { seq: 1 },
    idempotencyKey: idempotencyKeyFor(p.id, 1), expectedEffect: eff('test.failsvc'), // 补偿工具必失败
  });
  const a2 = await bizStore.createAction({
    tenantId: tenant.id, projectId: project.id, planId: p.id, seq: 2,
    toolRef: byName('test.failsvc'), toolName: 'test.failsvc', args: { seq: 2 },
    idempotencyKey: idempotencyKeyFor(p.id, 2), expectedEffect: eff(null),
  });
  await bizStore.updateAction(tenant.id, a1.id, { status: 'dryrun_ok' });
  await bizStore.updateAction(tenant.id, a2.id, { status: 'dryrun_ok' });
  await bizStore.updatePlan(tenant.id, p.id, { status: 'dryrun_passed' });

  const { status, json } = await post(`${B(project.id)}/plans/${p.id}/execute`, opSecret, {});
  assert.equal(status, 200);
  assert.equal(json.data.failed_action_id, a2.id);
  const s1 = await bizStore.getAction(tenant.id, a1.id);
  assert.equal(s1.status, 'done', '补偿失败的动作保持 done，不静默标 compensated');
  const comp = json.data.compensations.find((c) => c.action_id === a1.id);
  assert.equal(comp.compensated, false);
  const recs = await bizStore.listReconciliations(tenant.id, { status: 'open' });
  assert.ok(recs.some((r) => r.action_id === a1.id && r.reason.includes('compensation-failed')),
    '补偿失败必须进对账队列');
});

test('P6 审批放行失败不留僵尸：审批人掉角色 → 动作 failed + 对账', async () => {
  const { planId, action } = await readyPlan('调拨耳机10个，从华东仓到华南仓', { approve: true });
  // 审批后、执行前：admin 被移除所有角色（模拟掉权）
  await db().query('DELETE FROM role_bindings WHERE tenant_id=? AND actor_id=?', [tenant.id, adminActor.id]);
  const r = await post(`${B(project.id)}/actions/${action.id}/execute`, opSecret, {});
  assert.equal(r.status, 403); // 放行失败向上抛 FORBIDDEN
  const a = await bizStore.getAction(tenant.id, action.id);
  assert.equal(a.status, 'failed', '不得停留在 executing 僵尸状态');
  const bxn = await bizStore.getBusinessExecutionByKey(tenant.id, action.idempotency_key);
  assert.equal(bxn.status, 'failed');
  const recs = await bizStore.listReconciliations(tenant.id, { status: 'open' });
  assert.ok(recs.some((x) => x.action_id === action.id), '应进对账');
  // 恢复 admin 角色，不影响后续测试（本文件最后一个用 admin 的测试已过，此处保底）
  await store.bindRole(tenant.id, adminActor.id, null, 'admin');
});

// ---------- Review-R4 回归（V2.0 执行链加固） ----------
test('H-2 grant 持有人绑定：他人盗用被拒并吊销', async () => {
  const op2 = await mkActorWithKey(tenant.id, 'bex-op2', project.id, 'operator');
  const { action } = await readyPlan('采购计算器，金额120元');
  const { grant } = await execMod.issueGrant({
    tenantId: tenant.id, projectId: project.id, actionId: action.id, actorId: opActor.id,
  });
  assert.equal(grant.granted_to, opActor.id);
  // op2 拿着 op 的 grant 执行 → 持有人不一致
  const { status, json } = await post(
    `${B(project.id)}/actions/${action.id}/execute`, op2.secret, { grant_id: grant.id });
  assert.equal(status, 403);
  assert.equal(codeOf(json), 'GRANT_HOLDER_MISMATCH');
  const g = await bizStore.getGrant(tenant.id, grant.id);
  assert.equal(g.status, 'revoked', '盗用尝试必须吊销 grant');
});

test('H-3 失败计划可重置：reset 后重新执行走通', async () => {
  const { planId, a1, a2, a3 } = await buildRollbackPlan();
  const ex1 = await post(`${B(project.id)}/plans/${planId}/execute`, opSecret, {});
  assert.equal(ex1.status, 200);
  assert.equal(ex1.json.data.failed_action_id, a3.id);
  const beforeKeys = new Map();
  for (const a of [a1, a2, a3]) beforeKeys.set(a.id, (await bizStore.getAction(tenant.id, a.id)).idempotency_key);
  // reset：失败/补偿动作回到 approved + 新幂等键
  const r = await post(`${B(project.id)}/plans/${planId}/reset`, opSecret, {});
  assert.equal(r.status, 200);
  assert.equal(r.json.data.reset.length, 3);
  for (const item of r.json.data.reset) {
    assert.equal(item.status, 'approved');
    assert.notEqual(item.idempotency_key, beforeKeys.get(item.action_id), '幂等键必须轮换，否则复用旧失败记录');
  }
  // 修复 a3 的工具指向（模拟人工修复后），重新执行应整体成功
  const svc = await import('../src/modules/execution/service.mjs');
  const erp = (await svc.listTools(tenant.id)).find((t) => t.name === 'erp.purchase_order');
  await db().query('UPDATE business_actions SET tool_ref=?, tool_name=? WHERE id=?', [erp.id, erp.name, a3.id]);
  const ex2 = await post(`${B(project.id)}/plans/${planId}/execute`, opSecret, {});
  assert.equal(ex2.status, 200);
  assert.equal(ex2.json.data.failed_action_id, null);
  const plan = await bizStore.getPlan(tenant.id, planId);
  const intent = await bizStore.getIntent(tenant.id, plan.intent_id);
  assert.equal(intent.status, 'done');
  // 全部成功后无失败动作可重置 → 400 NOTHING_TO_RESET
  const r2 = await post(`${B(project.id)}/plans/${planId}/reset`, opSecret, {});
  assert.equal(r2.status, 400);
  assert.equal(codeOf(r2.json), 'NOTHING_TO_RESET');
});

test('M-9 补偿走一次性授权 + 认领幂等：重复执行计划不重复补偿', async () => {
  fakeCalls.length = 0;
  const { planId } = await buildRollbackPlan();
  const ex1 = await post(`${B(project.id)}/plans/${planId}/execute`, opSecret, {});
  assert.equal(ex1.status, 200);
  assert.ok(ex1.json.data.failed_action_id);
  const compCalls1 = fakeCalls.filter((c) => c.path === '/comp1' || c.path === '/comp2').length;
  assert.equal(compCalls1, 2, 'a2、a1 各补偿一次');
  // 补偿动作签发了一次性内部 grant 并已消费
  const grants = await db().query(
    `SELECT * FROM credential_grants WHERE tenant_id=? AND action_id IN
     (SELECT id FROM business_actions WHERE plan_id=?) AND granted_to=?`,
    [tenant.id, planId, opActor.id]);
  assert.ok(grants.length >= 2, '补偿应有一对一的一次性 grant');
  assert.ok(grants.every((g) => ['used', 'revoked'].includes(g.status)), '补偿 grant 不得残留 active');
  // 再次执行同一计划：已补偿动作不可重复执行，也不触发新的补偿调用
  const ex2 = await post(`${B(project.id)}/plans/${planId}/execute`, opSecret, {});
  assert.equal(ex2.status, 200);
  const compCalls2 = fakeCalls.filter((c) => c.path === '/comp1' || c.path === '/comp2').length;
  assert.equal(compCalls2, compCalls1, '重复执行不得产生新的补偿外部调用');
});

test('M-4 批准原子性：计划/审批记录/动作/意图四表一致，重复批准被拒', async () => {
  const { planId } = await readyPlan('采购白板，金额500元', {});
  const ap1 = await post(`${B(project.id)}/plans/${planId}/approve`, adminSecret, {});
  assert.equal(ap1.status, 200);
  const plan = await bizStore.getPlan(tenant.id, planId);
  assert.equal(plan.status, 'approved');
  const approval = await bizStore.getPlanApproval(tenant.id, planId);
  assert.ok(approval && approval.approver_id === adminActor.id, '审批记录必须落库');
  const acts = await bizStore.listActions(tenant.id, planId);
  assert.ok(acts.every((a) => a.status === 'approved'), 'dryrun_ok 动作应全部 approved');
  const intent = await bizStore.getIntent(tenant.id, plan.intent_id);
  assert.equal(intent.status, 'approved');
  // 重复批准：状态机前置检查拒绝（CAS 是并发双重批准的第二道防线）
  const ap2 = await post(`${B(project.id)}/plans/${planId}/approve`, adminSecret, {});
  assert.equal(ap2.status, 400);
  assert.equal(codeOf(ap2.json), 'DRYRUN_REQUIRED');
});

test('M-13 read-back 同步重试有总时长熔断默认值', async () => {
  const verify = await import('../src/modules/business/verify.mjs');
  assert.equal(verify.__internal.totalTimeoutMs(), 120000);
  assert.ok(verify.__internal.attempts() >= 1 && verify.__internal.attempts() <= 10);
});
