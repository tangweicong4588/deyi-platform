/** V2.0-C 验证与对账测试：read-back 验证 / 对账状态机 / 运营指标 / 鉴权隔离 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-bizrecon-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op-token-bizrecon';
process.env.DEV_IDP_SECRET = 'dev-secret-bizrecon';
process.env.BOOTSTRAP_ENABLED = 'false';
process.env.BUSINESS_GRANT_TTL_MS = '900000';
process.env.BUSINESS_VERIFY_ATTEMPTS = '2';
process.env.BUSINESS_VERIFY_RETRY_DELAY_MS = '0';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const bizStore = await import('../src/modules/business/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerBusinessRoutes } = await import('../src/modules/business/routes.mjs');
const { registerTool } = await import('../src/modules/execution/service.mjs');
const planMod = await import('../src/modules/business/plan.mjs');

let tenant, project, adminSecret, opSecret, viewerSecret, otherSecret, adminActor, opActor;
let base, appServer, fakeServer, fakePort;
let ctr = 0;
// fake 外部系统 read-back 行为：测试按需切换
const readBehavior = { mode: 'match', amount: 50000 };

async function mkActorWithKey(tenantId, name, projectId, role) {
  const a = await store.createActor(tenantId, { kind: 'user', name });
  await store.bindRole(tenantId, a.id, projectId, role);
  const k = mintKey();
  await store.createApiKeyRow({ tenantId, actorId: a.id, name, prefix: k.prefix, keyHash: k.keyHash });
  return { actor: a, secret: k.secret };
}

before(async () => {
  fakeServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      res.setHeader('content-type', 'application/json');
      if (req.url === '/pay') {
        res.end(JSON.stringify({ external_ref: 'PAY-2026-0001', ok: true }));
      } else if (req.url === '/pay/query') {
        const m = readBehavior.mode;
        if (m === 'error') { res.statusCode = 500; res.end(JSON.stringify({ error: 'boom' })); }
        else if (m === 'pending') res.end(JSON.stringify({ status: 'pending' }));
        else if (m === 'missing') res.end(JSON.stringify({ order_no: 'PAY-2026-0001', status: 'completed' }));
        else if (m === 'mismatch') res.end(JSON.stringify({ order_no: 'PAY-2026-0001', amount_cents: readBehavior.amount + 1, status: 'completed' }));
        else res.end(JSON.stringify({ order_no: 'PAY-2026-0001', amount_cents: readBehavior.amount, status: 'completed' }));
      } else {
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  await new Promise((r) => fakeServer.listen(0, '127.0.0.1', r));
  fakePort = fakeServer.address().port;

  await openDb();
  await migrate(db());
  tenant = await store.createTenant({ name: 'BIZRECON Tenant' });
  project = await store.createProject(tenant.id, { name: 'BIZRECON Project' });

  const adm = await mkActorWithKey(tenant.id, 'brc-admin', null, 'admin');
  adminActor = adm.actor; adminSecret = adm.secret;
  const op = await mkActorWithKey(tenant.id, 'brc-op', project.id, 'operator');
  opActor = op.actor; opSecret = op.secret;
  const vw = await mkActorWithKey(tenant.id, 'brc-viewer', project.id, 'viewer');
  viewerSecret = vw.secret;
  const t2 = await store.createTenant({ name: 'BIZRECON Tenant B' });
  const b = await mkActorWithKey(t2.id, 'brc-b-admin', null, 'admin');
  otherSecret = b.secret;

  const F = (p) => `http://127.0.0.1:${fakePort}${p}`;
  await registerTool({ tenantId: tenant.id, projectId: project.id, actorId: adminActor.id, name: 'biz.payment', kind: 'http', endpoint: F('/pay'), toolConfig: {}, riskLevel: 'medium' });
  await registerTool({ tenantId: tenant.id, projectId: project.id, actorId: adminActor.id, name: 'biz.payment.query', kind: 'http', endpoint: F('/pay/query'), toolConfig: {}, riskLevel: 'low' });
  await registerTool({ tenantId: tenant.id, projectId: project.id, actorId: adminActor.id, name: 'biz.risky.query', kind: 'http', endpoint: F('/pay/query'), toolConfig: {}, riskLevel: 'high' });
  await registerTool({ tenantId: tenant.id, projectId: project.id, actorId: adminActor.id, name: 'biz.fail', kind: 'builtin', toolConfig: { builtin: 'fail' }, riskLevel: 'medium' });

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

const defaultVerifySpec = () => ({
  tool: 'biz.payment.query', action: 'read',
  args: { order_no: '$external_ref' },
  rules: [
    { field: 'amount_cents', op: 'eq', expected: '$effect.amount_cents' },
    { field: 'status', op: 'eq', expected: 'completed' },
  ],
});

/** 完整可执行动作：意图→计划→动作（直接落库+状态置位）→执行，返回执行记录 */
async function mkExecutable({ amountCents = 50000, verifySpec = defaultVerifySpec(), toolName = 'biz.payment' } = {}) {
  const intent = await bizStore.createIntent({ tenantId: tenant.id, projectId: project.id, rawText: '测试付款', createdBy: opActor.id });
  const plan = await bizStore.createPlan({ tenantId: tenant.id, projectId: project.id, intentId: intent.id, createdBy: opActor.id });
  const toolRow = (await db().query('SELECT * FROM tools WHERE tenant_id=? AND name=?', [tenant.id, toolName]))[0];
  const action = await bizStore.createAction({
    tenantId: tenant.id, projectId: project.id, planId: plan.id, seq: 1,
    toolRef: toolRow.id, toolName, args: { order_no: 'ORD-1', amount_cents: amountCents },
    idempotencyKey: `vrfy-${Date.now()}-${(ctr += 1)}`,
    expectedEffect: {
      target_system: 'pay', objects: ['付款单(ORD-1)'], amount_cents: amountCents,
      reversible: true, verify: verifySpec,
    },
  });
  await bizStore.updatePlan(tenant.id, plan.id, { status: 'dryrun_passed' });
  await bizStore.updateAction(tenant.id, action.id, { status: 'dryrun_ok' });
  return { intent, plan, action };
}

async function executeAndVerify(opts = {}) {
  const f = await mkExecutable(opts);
  const ex = await post(`${B(project.id)}/actions/${f.action.id}/execute`, opSecret, {});
  assert.equal(ex.status, 200, `执行应成功: ${JSON.stringify(ex.json).slice(0, 300)}`);
  const bxn = ex.json.data.execution;
  assert.equal(bxn.status, 'succeeded');
  const v = await post(`${B(project.id)}/executions/${bxn.id}/verify`, opSecret, {});
  assert.equal(v.status, 200);
  return { ...f, execution: bxn, verify: v.json.data };
}

// ---------- 验证结论 ----------
test('read-back 一致 → verified，执行状态保持 succeeded', async () => {
  readBehavior.mode = 'match';
  const { execution, verify } = await executeAndVerify({});
  assert.equal(verify.verdict, 'verified');
  assert.equal(verify.execution.verify_status, 'verified');
  assert.equal(verify.execution.status, 'succeeded'); // 验证是独立步骤，不改执行状态
  assert.equal(verify.reconId, null);
  assert.equal(verify.rules.length, 2);
  assert.ok(verify.rules.every((r) => r.passed));
});

test('金额不一致 → mismatched + 对账项自动创建；执行状态仍为 succeeded', async () => {
  readBehavior.mode = 'mismatch';
  const { execution, verify } = await executeAndVerify({});
  assert.equal(verify.verdict, 'mismatched');
  assert.equal(verify.execution.verify_status, 'mismatched');
  assert.equal(verify.execution.status, 'succeeded'); // 验证失败≠执行失败
  assert.match(verify.reconId, /^brec_/);
  const q = await get(`${B(project.id)}/reconciliation/${verify.reconId}`, opSecret);
  assert.equal(q.status, 200);
  assert.equal(q.json.data.source, 'verify');
  assert.equal(q.json.data.status, 'open');
  assert.ok(q.json.data.reason.includes('amount_cents'));
  readBehavior.mode = 'match';
  return verify.reconId;
});

test('无 verify 声明 → unverifiable 进人工队列', async () => {
  const { verify } = await executeAndVerify({ verifySpec: null });
  assert.equal(verify.verdict, 'unverifiable');
  assert.match(verify.reconId, /^brec_/);
  const q = await get(`${B(project.id)}/reconciliation/${verify.reconId}`, opSecret);
  assert.ok(q.json.data.reason.includes('人工'));
});

test('验证工具未注册 → unverifiable + 对账项', async () => {
  const spec = defaultVerifySpec(); spec.tool = 'nope.missing';
  const { verify } = await executeAndVerify({ verifySpec: spec });
  assert.equal(verify.verdict, 'unverifiable');
  assert.match(verify.reconId, /^brec_/);
});

test('高风险工具不许做只读验证（fail-closed）', async () => {
  const spec = defaultVerifySpec(); spec.tool = 'biz.risky.query';
  const { verify } = await executeAndVerify({ verifySpec: spec });
  assert.equal(verify.verdict, 'unverifiable');
  assert.ok(verify.execution.verify_result.reason.includes('fail-closed'));
  assert.match(verify.reconId, /^brec_/);
});

test('规则字段在 read-back 缺失 → unverifiable（覆盖不到→人工）', async () => {
  readBehavior.mode = 'missing';
  const { verify } = await executeAndVerify({});
  assert.equal(verify.verdict, 'unverifiable');
  assert.ok(verify.execution.verify_result.reason.includes('覆盖不到'));
  assert.match(verify.reconId, /^brec_/);
  readBehavior.mode = 'match';
});

test('read-back 失败 → 重试后 unverifiable；重复 verify 不重复建队', async () => {
  readBehavior.mode = 'error';
  const { execution, verify } = await executeAndVerify({});
  assert.equal(verify.verdict, 'unverifiable');
  assert.match(verify.reconId, /^brec_/);
  const v2 = await post(`${B(project.id)}/executions/${execution.id}/verify`, opSecret, {});
  assert.equal(v2.json.data.verdict, 'unverifiable');
  assert.equal(v2.json.data.reconId, verify.reconId); // 去重：同一执行的未关闭项只一条
  readBehavior.mode = 'match';
});

test('非 succeeded 执行 → unverifiable 且不新增对账项', async () => {
  const f = await mkExecutable({ toolName: 'biz.fail' });
  const r = await post(`${B(project.id)}/actions/${f.action.id}/execute`, opSecret, {});
  assert.equal(r.status, 200); // P6 引擎失败 → 落库 failed（不抛 500），并已进对账
  assert.equal(r.json.data.execution.status, 'failed');
  const bxn = r.json.data.execution;
  const before = await bizStore.listReconciliations(tenant.id, { status: null, executionId: bxn.id });
  const v = await post(`${B(project.id)}/executions/${bxn.id}/verify`, opSecret, {});
  assert.equal(v.status, 200);
  assert.equal(v.json.data.verdict, 'unverifiable');
  assert.equal(v.json.data.reconId, null);
  const afterList = await bizStore.listReconciliations(tenant.id, { status: null, executionId: bxn.id });
  assert.equal(afterList.length, before.length); // 失败已有对账路径，验证不新增
});

// ---------- 对账状态机 ----------
let reconMismatchId = null;
test('对账全生命周期：investigate→resolve→close；非法跳转 409；resolve 缺 note 400', async () => {
  readBehavior.mode = 'mismatch';
  const { verify } = await executeAndVerify({});
  readBehavior.mode = 'match';
  reconMismatchId = verify.reconId;

  // 非法：open 不能直接 close
  const bad = await post(`${B(project.id)}/reconciliation/${reconMismatchId}/close`, opSecret, {});
  assert.equal(bad.status, 409);
  assert.equal(codeOf(bad.json), 'ILLEGAL_TRANSITION');
  // resolve 缺 note → 400
  await post(`${B(project.id)}/reconciliation/${reconMismatchId}/investigate`, opSecret, {});
  const noNote = await post(`${B(project.id)}/reconciliation/${reconMismatchId}/resolve`, opSecret, {});
  assert.equal(noNote.status, 400);
  assert.equal(codeOf(noNote.json), 'NOTE_REQUIRED');
  // 正常：investigating → resolved（决议落库）→ closed
  const rs = await post(`${B(project.id)}/reconciliation/${reconMismatchId}/resolve`, opSecret,
    { note: '已与财务核对，差额为通道手续费，接受', evidence_ref: 'EV-2026-001' });
  assert.equal(rs.status, 200);
  assert.equal(rs.json.data.status, 'resolved');
  assert.equal(rs.json.data.resolution.note, '已与财务核对，差额为通道手续费，接受');
  assert.equal(rs.json.data.resolution.evidence_ref, 'EV-2026-001');
  assert.equal(rs.json.data.resolution.decided_by, opActor.id);
  const cl = await post(`${B(project.id)}/reconciliation/${reconMismatchId}/close`, opSecret, {});
  assert.equal(cl.status, 200);
  assert.equal(cl.json.data.status, 'closed');
  assert.ok(cl.json.data.closed_at);
  // closed 是终端
  const again = await post(`${B(project.id)}/reconciliation/${reconMismatchId}/investigate`, opSecret, {});
  assert.equal(again.status, 409);
});

test('escalate 需 assignee；升级记通知审计；可降回 investigating', async () => {
  const spec = defaultVerifySpec(); spec.tool = 'nope.missing';
  const { verify } = await executeAndVerify({ verifySpec: spec });
  const id = verify.reconId;
  const noAssignee = await post(`${B(project.id)}/reconciliation/${id}/escalate`, opSecret, {});
  assert.equal(noAssignee.status, 400);
  assert.equal(codeOf(noAssignee.json), 'ASSIGNEE_REQUIRED');
  const es = await post(`${B(project.id)}/reconciliation/${id}/escalate`, opSecret, { assignee: adminActor.id });
  assert.equal(es.status, 200);
  assert.equal(es.json.data.status, 'escalated');
  assert.equal(es.json.data.assignee, adminActor.id);
  // 通知审计事件入链（真实通知通道留扩展点）
  const notes = await db().query(
    "SELECT * FROM audit_events WHERE tenant_id=? AND action='business.reconciliation.notify' AND resource_id=?",
    [tenant.id, id]);
  assert.equal(notes.length, 1);
  assert.ok(JSON.parse(notes[0].payload).to === adminActor.id);
  // 降回 investigating 再 resolve
  const back = await post(`${B(project.id)}/reconciliation/${id}/investigate`, opSecret, {});
  assert.equal(back.status, 200);
  assert.equal(back.json.data.status, 'investigating');
});

test('对账列表过滤：status=all / source=verify', async () => {
  const open = await get(`${B(project.id)}/reconciliation?status=open`, opSecret);
  assert.equal(open.status, 200);
  assert.ok(open.json.data.every((r) => r.status === 'open'));
  const all = await get(`${B(project.id)}/reconciliation?status=all`, opSecret);
  assert.ok(all.json.data.some((r) => r.status === 'closed'));
  const vsrc = await get(`${B(project.id)}/reconciliation?status=all&source=verify`, opSecret);
  assert.ok(vsrc.json.data.length > 0);
  assert.ok(vsrc.json.data.every((r) => r.source === 'verify'));
});

// ---------- 运营指标 ----------
test('指标聚合：漏斗/对账率/平均耗时/补偿率', async () => {
  const { json } = await get(`${B(project.id)}/metrics`, opSecret);
  const m = json.data;
  assert.ok(m.funnel.executed >= 8, `executed=${m.funnel.executed}`);
  assert.ok(m.funnel.verified >= 1);
  assert.ok(m.funnel.mismatched >= 1);
  assert.ok(m.funnel.unverifiable >= 1);
  assert.ok(m.reconciliation.total >= 4);
  assert.ok(typeof m.rates.recon_rate === 'number' && m.rates.recon_rate > 0);
  assert.ok(typeof m.rates.verify_rate === 'number');
  assert.ok(typeof m.execution.avg_duration_ms === 'number' && m.execution.avg_duration_ms >= 0);
  assert.ok(m.execution.finished_samples >= 8);
  // 时间窗口过滤：未来窗口应为空
  const f = await get(`${B(project.id)}/metrics?since=${Date.now() + 3600000}`, opSecret);
  assert.equal(f.json.data.funnel.executed, 0);
  assert.equal(f.json.data.reconciliation.total, 0);
});

// ---------- 鉴权与隔离 ----------
test('鉴权：viewer 不能 verify；跨租户 403；viewer 可读 metrics/对账', async () => {
  const f = await mkExecutable({});
  const ex = await post(`${B(project.id)}/actions/${f.action.id}/execute`, opSecret, {});
  const bxnId = ex.json.data.execution.id;
  const vw = await post(`${B(project.id)}/executions/${bxnId}/verify`, viewerSecret, {});
  assert.equal(vw.status, 403); // viewer 无 business.write
  const cross = await post(`${B(project.id)}/executions/${bxnId}/verify`, otherSecret, {});
  assert.ok([403, 404].includes(cross.status)); // 跨租户隔离
  const m = await get(`${B(project.id)}/metrics`, viewerSecret);
  assert.equal(m.status, 200); // viewer 可读指标
  const rl = await get(`${B(project.id)}/reconciliation?status=open`, viewerSecret);
  assert.equal(rl.status, 200);
  const rw = await post(`${B(project.id)}/reconciliation/${reconMismatchId}/investigate`, viewerSecret, {});
  assert.equal(rw.status, 403); // viewer 不能处理对账
});
