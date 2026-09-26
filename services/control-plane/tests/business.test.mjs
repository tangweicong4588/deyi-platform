/** V2.0-A 业务意图与计划测试：模板计划生成 / dry-run 阻断 / 幂等键 / 脱敏 / 密钥铁律 / 鉴权 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-biz-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token_biz';
process.env.DEV_IDP_SECRET = 'dev_secret_biz_123';
process.env.BOOTSTRAP_ENABLED = 'false';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerBusinessRoutes } = await import('../src/modules/business/routes.mjs');
const { registerTool } = await import('../src/modules/execution/service.mjs');
const ontologySvc = await import('../src/modules/ontology/service.mjs');
const ontologyStore = await import('../src/modules/ontology/store.mjs');
const { decide } = await import('../src/modules/policy/index.mjs');
const planMod = await import('../src/modules/business/plan.mjs');

let tenant, project, adminSecret, opSecret, viewerSecret, otherSecret, adminActor, opActor;

async function mkActorWithKey(tenantId, name, projectId, role) {
  const a = await store.createActor(tenantId, { kind: 'user', name });
  await store.bindRole(tenantId, a.id, projectId, role);
  const k = mintKey();
  await store.createApiKeyRow({ tenantId, actorId: a.id, name, prefix: k.prefix, keyHash: k.keyHash });
  return { actor: a, secret: k.secret };
}

before(async () => {
  await openDb();
  await migrate(db());
  tenant = await store.createTenant({ name: 'BIZ Tenant' });
  project = await store.createProject(tenant.id, { name: 'BIZ Project' });

  const adm = await mkActorWithKey(tenant.id, 'biz-admin', null, 'admin');
  adminActor = adm.actor; adminSecret = adm.secret;
  const op = await mkActorWithKey(tenant.id, 'biz-op', project.id, 'operator');
  opActor = op.actor; opSecret = op.secret;
  const vw = await mkActorWithKey(tenant.id, 'biz-viewer', project.id, 'viewer');
  viewerSecret = vw.secret;

  const t2 = await store.createTenant({ name: 'BIZ Tenant B' });
  const b = await mkActorWithKey(t2.id, 'biz-b-admin', null, 'admin');
  otherSecret = b.secret;

  // 注册工具：erp.purchase_order（中风险）、wms.stock_transfer（高风险，测审批标记）；
  // finance.reimburse 故意不注册 → dry-run 工具缺失阻断
  await registerTool({ tenantId: tenant.id, projectId: project.id, actorId: adminActor.id, name: 'erp.purchase_order', kind: 'builtin', toolConfig: { builtin: 'echo' }, riskLevel: 'medium' });
  await registerTool({ tenantId: tenant.id, projectId: project.id, actorId: adminActor.id, name: 'wms.stock_transfer', kind: 'builtin', toolConfig: { builtin: 'echo' }, riskLevel: 'high' });

  // 发布采购相关本体术语（报销相关保持未发布 → 本体缺口场景）
  for (const name of ['采购订单', '供应商', '库存调拨单', '仓库']) {
    const { term } = await ontologySvc.submitCandidate({
      tenantId: tenant.id, projectId: project.id, name, kind: 'concept',
      definition: `${name}（测试）`, evidence: [], actorId: adminActor.id,
    });
    await ontologySvc.startReview({ tenantId: tenant.id, termId: term.id });
    await ontologySvc.publishTerm({ tenantId: tenant.id, termId: term.id });
  }
});

let base, appServer;
before(async () => {
  const app = createApp();
  registerIdentityRoutes(app);
  registerBusinessRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;
});
after(() => new Promise((r) => appServer.close(r)));

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
async function mkIntent(secret, text, pid) {
  return post(`${B(pid || project.id)}/intents`, secret, { raw_text: text });
}
async function mkPlan(secret, intentId) {
  return post(`${B(project.id)}/intents/${intentId}/plan`, secret, {});
}

// ---------- 意图创建与脱敏 ----------
test('创建意图：bint_ 前缀 + draft 状态', async () => {
  const { status, json } = await mkIntent(opSecret, '采购笔记本电脑，金额5000元');
  assert.equal(status, 201);
  assert.match(json.data.id, /^bint_[0-9a-z]{26}$/);
  assert.equal(json.data.status, 'draft');
});

test('raw_text 落库前脱敏：密钥形状打码', async () => {
  const { json } = await mkIntent(opSecret, '采购服务器，金额8000元，备注密码：hunter2，另附 sk-abcDEF123456789');
  assert.ok(!json.data.raw_text.includes('hunter2'), '密钥明文不得落库');
  assert.ok(!json.data.raw_text.includes('sk-abcDEF123456789'), 'sk- 形状不得落库');
  assert.ok(json.data.raw_text.includes('***'));
});

test('raw_text 超长截断（4000 上限）', async () => {
  const { json } = await mkIntent(opSecret, '采购' + 'x'.repeat(5000));
  assert.ok(json.data.raw_text.length <= 4012);
  assert.ok(json.data.raw_text.endsWith('…(truncated)'));
});

test('空意图 400', async () => {
  const { status } = await mkIntent(opSecret, '   ');
  assert.equal(status, 400);
});

test('未命中模板 400 NO_TEMPLATE_MATCH', async () => {
  const { status, json } = await mkIntent(opSecret, '今天天气不错');
  assert.equal(status, 201);
  const p = await mkPlan(opSecret, json.data.id);
  assert.equal(p.status, 400);
  assert.equal(p.json?.error?.details?.code, 'NO_TEMPLATE_MATCH');
});

test('缺少必填槽位 400 MISSING_SLOTS', async () => {
  const { json } = await mkIntent(opSecret, '申请采购一批办公用品');
  const p = await mkPlan(opSecret, json.data.id);
  assert.equal(p.status, 400);
  assert.equal(p.json?.error?.details?.code, 'MISSING_SLOTS');
});

// ---------- 计划生成 ----------
test('采购计划生成：模板命中 + 动作装配 + bplan_/bact_ 前缀', async () => {
  const { json: ij } = await mkIntent(opSecret, '采购笔记本电脑，金额5000元，申请人李四');
  const { status, json } = await mkPlan(opSecret, ij.data.id);
  assert.equal(status, 201);
  assert.match(json.data.plan.id, /^bplan_[0-9a-z]{26}$/);
  assert.equal(json.data.template, 'purchase_request');
  assert.equal(json.data.actions.length, 1);
  const a = json.data.actions[0];
  assert.match(a.id, /^bact_[0-9a-z]{26}$/);
  assert.equal(a.tool_name, 'erp.purchase_order');
  assert.ok(a.tool_ref, '已注册工具应解析出 tool_ref');
  assert.equal(a.args.amount_cents, 500000);
  assert.match(a.idempotency_key, /^[0-9a-f]{32}$/);
});

test('本体映射命中已发布术语（采购订单/供应商）', async () => {
  const { json: ij } = await mkIntent(opSecret, '采购投影仪，金额3000元');
  const { json } = await mkPlan(opSecret, ij.data.id);
  const a = json.data.actions[0];
  assert.equal(a.ontology_term_ids.length, 2);
  for (const tid of a.ontology_term_ids) {
    const t = await ontologyStore.getTerm(tenant.id, tid);
    assert.equal(t.status, 'published');
  }
  assert.equal(json.data.plan.ontology_gaps.length, 0);
});

test('本体缺口：未发布概念生成 candidate 建议，不静默捏造', async () => {
  const { json: ij } = await mkIntent(opSecret, '报销差旅费，金额1200元');
  const { json } = await mkPlan(opSecret, ij.data.id);
  const gaps = json.data.plan.ontology_gaps;
  assert.ok(gaps.length >= 1, '报销单/费用 未发布，应有缺口');
  const a = json.data.actions[0];
  assert.equal(a.ontology_term_ids.length, 0, '未命中术语不得捏造映射');
  for (const g of gaps) {
    const t = await ontologyStore.getTerm(tenant.id, g.candidate_term_id);
    assert.equal(t.status, 'candidate');
  }
});

// ---------- dry-run ----------
test('dry-run 通过：happy path → dryrun_passed', async () => {
  const { json: ij } = await mkIntent(opSecret, '采购显示器，金额2000元');
  const { json: pj } = await mkPlan(opSecret, ij.data.id);
  const { status, json } = await post(`${B(project.id)}/plans/${pj.data.plan.id}/dryrun`, opSecret, {});
  assert.equal(status, 200);
  assert.equal(json.data.plan.status, 'dryrun_passed');
  const eff = json.data.report.actions[0].expected_effect;
  assert.equal(eff.target_system, 'erp');
  assert.ok(eff.objects.length > 0);
  assert.equal(eff.reversible, true);
  assert.equal(typeof eff.compensation_available, 'boolean');
  const re = json.data.plan.risk_estimate;
  assert.equal(re.max_risk, 'medium');
  assert.deepEqual(re.impact_scope, ['erp']);
});

test('dry-run 阻断：工具未注册', async () => {
  const { json: ij } = await mkIntent(opSecret, '报销餐费，金额300元');
  const { json: pj } = await mkPlan(opSecret, ij.data.id);
  const { json } = await post(`${B(project.id)}/plans/${pj.data.plan.id}/dryrun`, opSecret, {});
  assert.equal(json.data.plan.status, 'dryrun_blocked');
  assert.match(JSON.stringify(json.data.report.actions[0].reasons), /工具未注册/);
});

test('dry-run 阻断：金额超模板边界', async () => {
  const { json: ij } = await mkIntent(opSecret, '采购服务器，金额100万元');
  const { json: pj } = await mkPlan(opSecret, ij.data.id);
  const { json } = await post(`${B(project.id)}/plans/${pj.data.plan.id}/dryrun`, opSecret, {});
  assert.equal(json.data.plan.status, 'dryrun_blocked');
  assert.match(JSON.stringify(json.data.report.actions[0].reasons), /金额.*超过模板上限/);
});

test('dry-run 阻断：职责分离冲突（申请人=审批人）', async () => {
  const { json: ij } = await mkIntent(opSecret, '采购笔记本电脑，金额5000元，申请人张三，审批人张三');
  const { json: pj } = await mkPlan(opSecret, ij.data.id);
  const { json } = await post(`${B(project.id)}/plans/${pj.data.plan.id}/dryrun`, opSecret, {});
  assert.equal(json.data.plan.status, 'dryrun_blocked');
  assert.match(JSON.stringify(json.data.report.actions[0].reasons), /职责分离/);
});

test('dry-run 阻断：本体缺口未发布', async () => {
  const { json: ij } = await mkIntent(opSecret, '报销交通费，金额200元');
  const { json: pj } = await mkPlan(opSecret, ij.data.id);
  // 先注册 finance.reimburse 以隔离出"本体缺口"单一变量
  await registerTool({ tenantId: tenant.id, projectId: project.id, actorId: adminActor.id, name: 'finance.reimburse', kind: 'builtin', toolConfig: { builtin: 'echo' }, riskLevel: 'medium' }).catch(() => {});
  const { json } = await post(`${B(project.id)}/plans/${pj.data.plan.id}/dryrun`, opSecret, {});
  assert.equal(json.data.plan.status, 'dryrun_blocked');
  assert.match(JSON.stringify(json.data.report.actions[0].reasons), /本体映射缺口/);
});

test('高风险工具 → approval_required 标记（不阻断 dry-run）', async () => {
  const { json: ij } = await mkIntent(opSecret, '调拨笔记本100台，从华东仓到华南仓');
  const { json: pj } = await mkPlan(opSecret, ij.data.id);
  const { json } = await post(`${B(project.id)}/plans/${pj.data.plan.id}/dryrun`, opSecret, {});
  assert.equal(json.data.plan.status, 'dryrun_passed');
  assert.equal(json.data.report.actions[0].expected_effect.approval_required, true);
  assert.equal(json.data.plan.risk_estimate.approval_required, true);
  assert.equal(json.data.plan.risk_estimate.max_risk, 'high');
});

test('幂等键：同计划稳定、跨计划唯一', async () => {
  const { json: i1 } = await mkIntent(opSecret, '采购鼠标，金额100元');
  const { json: p1 } = await mkPlan(opSecret, i1.data.id);
  const k1 = p1.data.actions[0].idempotency_key;
  await post(`${B(project.id)}/plans/${p1.data.plan.id}/dryrun`, opSecret, {});
  const g = await get(`${B(project.id)}/plans/${p1.data.plan.id}/actions`, opSecret);
  assert.equal(g.json.data[0].idempotency_key, k1, 'dry-run 后幂等键不变');
  const { json: i2 } = await mkIntent(opSecret, '采购键盘，金额150元');
  const { json: p2 } = await mkPlan(opSecret, i2.data.id);
  assert.notEqual(p2.data.actions[0].idempotency_key, k1, '不同计划幂等键不同');
});

// ---------- 审批 ----------
test('批准需先通过 dry-run', async () => {
  const { json: ij } = await mkIntent(opSecret, '采购音箱，金额800元');
  const { json: pj } = await mkPlan(opSecret, ij.data.id);
  const { status, json } = await post(`${B(project.id)}/plans/${pj.data.plan.id}/approve`, adminSecret, {});
  assert.equal(status, 400);
  assert.equal(json?.error?.details?.code, 'DRYRUN_REQUIRED');
});

test('审批职责分离：创建人不能批自己的计划', async () => {
  const { json: ij } = await mkIntent(opSecret, '采购摄像头，金额600元');
  const { json: pj } = await mkPlan(opSecret, ij.data.id);
  await post(`${B(project.id)}/plans/${pj.data.plan.id}/dryrun`, opSecret, {});
  const { status, json } = await post(`${B(project.id)}/plans/${pj.data.plan.id}/approve`, opSecret, {});
  assert.equal(status, 403);
  assert.equal(json?.error?.details?.code, 'SOD_VIOLATION');
});

test('他人批准 → approved，意图联动', async () => {
  const { json: ij } = await mkIntent(opSecret, '采购话筒，金额400元');
  const { json: pj } = await mkPlan(opSecret, ij.data.id);
  await post(`${B(project.id)}/plans/${pj.data.plan.id}/dryrun`, opSecret, {});
  const { status, json } = await post(`${B(project.id)}/plans/${pj.data.plan.id}/approve`, adminSecret, {});
  assert.equal(status, 200);
  assert.equal(json.data.status, 'approved');
  const gi = await get(`${B(project.id)}/intents/${ij.data.id}`, adminSecret);
  assert.equal(gi.json.data.intent.status, 'approved');
});

test('驳回计划 → rejected', async () => {
  const { json: ij } = await mkIntent(opSecret, '采购支架，金额200元');
  const { json: pj } = await mkPlan(opSecret, ij.data.id);
  const { status, json } = await post(`${B(project.id)}/plans/${pj.data.plan.id}/reject`, adminSecret, { reason: '预算不足' });
  assert.equal(status, 200);
  assert.equal(json.data.status, 'rejected');
});

// ---------- 密钥铁律 / 鉴权 ----------
test('动作参数密钥字段被拒（rejectPlaintextSecrets 模式）', async () => {
  const { assertNoPlaintextSecretsInArgs } = planMod.__internal;
  assert.throws(
    () => assertNoPlaintextSecretsInArgs({ item: 'x', api_key: 'sk-live-123' }),
    (e) => e?.details?.code === 'SECRET_IN_ARGS');
  assert.doesNotThrow(() => assertNoPlaintextSecretsInArgs({ item: 'x', tokenizer: 'abc' }));
});

test('viewer 可读不可写', async () => {
  const r = await get(`${B(project.id)}/intents`, viewerSecret);
  assert.equal(r.status, 200);
  const w = await mkIntent(viewerSecret, '采购U盘，金额50元');
  assert.equal(w.status, 403);
});

test('跨租户 403', async () => {
  const r = await get(`${B(project.id)}/intents`, otherSecret);
  assert.equal(r.status, 403);
  const w = await mkIntent(otherSecret, '采购U盘，金额50元', project.id);
  assert.equal(w.status, 403);
});

test('策略引擎：business.read viewer+ / business.write operator+', async () => {
  const mkInput = (roles) => ({
    actor: { id: 'u', kind: 'user', status: 'active', roles },
    tenant: { id: tenant.id, status: 'active' },
    project: { id: project.id },
    action: 'business.read', resource: {}, context: {},
  });
  const vr = await decide(mkInput([{ project_id: project.id, role: 'viewer' }]));
  assert.equal(vr.allow, true);
  const vw = await decide({ ...mkInput([{ project_id: project.id, role: 'viewer' }]), action: 'business.write' });
  assert.equal(vw.allow, false);
  const ow = await decide({ ...mkInput([{ project_id: project.id, role: 'operator' }]), action: 'business.write' });
  assert.equal(ow.allow, true);
});

test('LLM 不可用时计划生成不受影响（回落模板）', async () => {
  // 本环境无 LiteLLM：chatInternal 必然失败，tryLlmSlots 必须静默回落
  const { json: ij } = await mkIntent(opSecret, '采购网线，金额120元');
  const { status, json } = await mkPlan(opSecret, ij.data.id);
  assert.equal(status, 201);
  assert.equal(json.data.actions[0].args.amount_cents, 12000);
});
