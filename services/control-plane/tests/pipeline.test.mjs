/** pipeline 测试：V1.0-B 五阶段流水线编排 —— 门禁 / 例外审批 / 澄清 / 事实快照 / 审计 / 非法跃迁 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-pipe-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.DEV_IDP_SECRET = 'test-dev-secret';
process.env.BOOTSTRAP_ENABLED = 'false';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const audit = await import('../src/modules/evidence/audit.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerDeliveryRoutes } = await import('../src/modules/delivery/routes.mjs');

let tenant, project, adminSecret, admin2Secret, viewerSecret, otherSecret;
before(async () => {
  await openDb();
  await migrate(db());
  await audit.initEvidence();
  tenant = await store.createTenant({ name: 'PIPE Tenant' });
  project = await store.createProject(tenant.id, { name: 'PIPE Project' });

  const admin = await store.createActor(tenant.id, { kind: 'user', name: 'PIPE Admin' });
  await store.bindRole(tenant.id, admin.id, null, 'admin');
  const ak = mintKey();
  await store.createApiKeyRow({ tenantId: tenant.id, actorId: admin.id, name: 'pipe-admin', prefix: ak.prefix, keyHash: ak.keyHash });
  adminSecret = ak.secret;

  // batch3 遗留修复（SoD 测试用）：第二个审批人，申请人不能批准自己的例外
  const admin2 = await store.createActor(tenant.id, { kind: 'user', name: 'PIPE Admin2' });
  await store.bindRole(tenant.id, admin2.id, null, 'admin');
  const ak2 = mintKey();
  await store.createApiKeyRow({ tenantId: tenant.id, actorId: admin2.id, name: 'pipe-admin2', prefix: ak2.prefix, keyHash: ak2.keyHash });
  admin2Secret = ak2.secret;

  const viewer = await store.createActor(tenant.id, { kind: 'user', name: 'PIPE Viewer' });
  await store.bindRole(tenant.id, viewer.id, project.id, 'viewer');
  const vk = mintKey();
  await store.createApiKeyRow({ tenantId: tenant.id, actorId: viewer.id, name: 'pipe-viewer', prefix: vk.prefix, keyHash: vk.keyHash });
  viewerSecret = vk.secret;

  const t2 = await store.createTenant({ name: 'PIPE Tenant B' });
  const a2 = await store.createActor(t2.id, { kind: 'user', name: 'B Admin' });
  await store.bindRole(t2.id, a2.id, null, 'admin');
  const bk = mintKey();
  await store.createApiKeyRow({ tenantId: t2.id, actorId: a2.id, name: 'b-admin', prefix: bk.prefix, keyHash: bk.keyHash });
  otherSecret = bk.secret;
});

let base, appServer;
before(async () => {
  const app = createApp();
  registerIdentityRoutes(app);
  registerDeliveryRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;
});
after(() => new Promise((r) => appServer.close(r)));

const D = (pid) => `${base}/v1/projects/${pid}/delivery`;
const post = (url, body, token = adminSecret) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const patch = (url, body, token = adminSecret) =>
  fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const get = (url, token = adminSecret) =>
  fetch(url, { headers: { authorization: `Bearer ${token}` } });

const HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const P = () => D(project.id);

async function mkPackage(title = '流水线需求') {
  const rq = await post(`${P()}/requirements`, { title, kind: 'feature', scopeMd: '做 X', nonGoalsMd: '不做 Y' });
  assert.equal(rq.status, 201);
  const req = (await rq.json()).data;
  const cp = await post(`${P()}/change-packages`, { requirementId: req.id, branch: 'feat/pipe' });
  assert.equal(cp.status, 201);
  const chg = (await cp.json()).data;
  return { req, chg, reqId: req.id, chgId: chg.id };
}

async function startPipe(chgId) {
  const r = await post(`${P()}/change-packages/${chgId}/pipeline/start`, {});
  assert.ok([200, 201].includes(r.status));
  return (await r.json()).data;
}
const runOf = (runs, stage) => runs.find((r) => r.stage === stage);
const advance = (runId, body = {}, token = adminSecret) => post(`${P()}/pipeline-runs/${runId}/advance`, body, token);

/** 走完 facts 门禁的流水线（登记完整快照），返回 reqId/chgId */
async function factsPassedPipe(title) {
  const { reqId, chgId } = await mkPackage(title);
  const { runs } = await startPipe(chgId);
  const facts = runOf(runs, 'facts');
  const s = await post(`${P()}/pipeline-runs/${facts.id}/fact-snapshot`, {
    baselineCommit: 'abc1234',
    environment: { node: '20', os: 'linux' },
    dependencies: { litellm: '1.0.0' },
    unknownItems: [],
  });
  assert.equal(s.status, 201);
  const adv = await advance(facts.id, { evidence: { notes: '基线已确认' } });
  assert.equal(adv.status, 200);
  assert.equal((await adv.json()).data.run.status, 'passed');
  return { reqId, chgId };
}

/** 把流水线推到 clarify 阶段 running（需求已发布到 ready） */
async function toClarifyStage(title) {
  const { reqId, chgId } = await factsPassedPipe(title);
  await patch(`${P()}/requirements/${reqId}`, { status: 'clarifying' });
  await patch(`${P()}/requirements/${reqId}`, { status: 'ready' });
  const view = await (await get(`${P()}/change-packages/${chgId}/pipeline`)).json();
  const reqRun = view.data.stages.find((s) => s.stage === 'requirements');
  await advance(reqRun.run_id);
  const view2 = await (await get(`${P()}/change-packages/${chgId}/pipeline`)).json();
  const clfRun = view2.data.stages.find((s) => s.stage === 'clarify');
  assert.equal(clfRun.status, 'running');
  return { reqId, chgId, clfRunId: clfRun.run_id };
}

// ---------- start / 幂等 ----------
test('startPipeline：创建 5 个阶段，facts 自动 running', async () => {
  const { chg } = await mkPackage('启动测试');
  const r = await post(`${P()}/change-packages/${chg.id}/pipeline/start`, {});
  assert.equal(r.status, 201);
  const { runs, created } = (await r.json()).data;
  assert.equal(created, true);
  assert.equal(runs.length, 5);
  assert.deepEqual(runs.map((x) => x.stage), ['facts', 'requirements', 'clarify', 'develop', 'handover']);
  assert.equal(runOf(runs, 'facts').status, 'running');
  assert.equal(runOf(runs, 'handover').status, 'pending');
});

test('startPipeline 幂等：重复启动返回已有记录', async () => {
  const { chg } = await mkPackage('幂等测试');
  await startPipe(chg.id);
  const r = await post(`${P()}/change-packages/${chg.id}/pipeline/start`, {});
  assert.equal(r.status, 200);
  const { created, runs } = (await r.json()).data;
  assert.equal(created, false);
  assert.equal(runs.length, 5);
});

test('流水线视图：GET 包级 pipeline 含各阶段门禁状态', async () => {
  const { chg } = await mkPackage('视图测试');
  await startPipe(chg.id);
  const r = await get(`${P()}/change-packages/${chg.id}/pipeline`);
  assert.equal(r.status, 200);
  const { stages } = (await r.json()).data;
  assert.equal(stages.length, 5);
  assert.ok(stages.every((s) => 'gate_decision' in s));
});

// ---------- facts 门禁 / 例外审批 ----------
test('facts 门禁：无快照 → gated，missing 含 fact_snapshot', async () => {
  const { chg } = await mkPackage('门禁阻断测试');
  const { runs } = await startPipe(chg.id);
  const facts = runOf(runs, 'facts');
  const r = await advance(facts.id, { evidence: { notes: '啥也没准备' } });
  assert.equal(r.status, 200);
  const out = (await r.json()).data;
  assert.equal(out.blocked, true);
  assert.ok(out.missing.includes('fact_snapshot'));
  assert.equal(out.run.status, 'gated');
  assert.equal(out.run.gate_decision.passed, false);
});

test('事实快照密钥扫描：environment 含疑似凭据键 → 400', async () => {
  const { chg } = await mkPackage('密钥扫描测试');
  const { runs } = await startPipe(chg.id);
  const facts = runOf(runs, 'facts');
  const r = await post(`${P()}/pipeline-runs/${facts.id}/fact-snapshot`, {
    baselineCommit: 'abc1234',
    environment: { node: '20', dbPassword: 'secret123' },
    dependencies: {}, unknownItems: [],
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.error.details.code, 'PLAINTEXT_SECRET');
});

test('门禁例外审批：申请→批准→放行（waived_by 落盘）', async () => {
  const { chg } = await mkPackage('例外放行测试');
  const { runs } = await startPipe(chg.id);
  const facts = runOf(runs, 'facts');
  await advance(facts.id); // 阻断 → gated
  const q = await post(`${P()}/pipeline-runs/${facts.id}/gate-exceptions`, {
    missingItems: ['fact_snapshot'], reason: '基线 commit 在外部系统，本次先行',
  });
  assert.equal(q.status, 201);
  const gex = (await q.json()).data;
  assert.equal(gex.status, 'pending');
  const d = await post(`${P()}/gate-exceptions/${gex.id}/decide`, { approved: true, reason: '风险可接受' }, admin2Secret);
  assert.equal(d.status, 200);
  assert.equal((await d.json()).data.status, 'approved');
  const adv = await advance(facts.id);
  assert.equal(adv.status, 200);
  const out = (await adv.json()).data;
  assert.equal(out.run.status, 'passed');
  assert.equal(out.waived_by, gex.id);
  assert.equal(out.run.gate_decision.exception_waived_by, gex.id);
  assert.equal(out.next.stage, 'requirements');
  assert.equal(out.next.status, 'running');
});

test('例外审批：missingItems 不在缺失清单内 → 400', async () => {
  const { chg } = await mkPackage('例外越界测试');
  const { runs } = await startPipe(chg.id);
  const facts = runOf(runs, 'facts');
  await advance(facts.id);
  const q = await post(`${P()}/pipeline-runs/${facts.id}/gate-exceptions`, {
    missingItems: ['不存在的项'], reason: 'x',
  });
  assert.equal(q.status, 400);
});

test('例外审批：未被阻断的阶段申请 → 400', async () => {
  const { chg } = await mkPackage('例外误用测试');
  const { runs } = await startPipe(chg.id);
  const facts = runOf(runs, 'facts');
  const q = await post(`${P()}/pipeline-runs/${facts.id}/gate-exceptions`, { reason: 'x' });
  assert.equal(q.status, 400);
});

test('例外驳回后：再次推进仍被阻断（200 blocked，不静默通过）', async () => {
  const { chg } = await mkPackage('例外驳回测试');
  const { runs } = await startPipe(chg.id);
  const facts = runOf(runs, 'facts');
  await advance(facts.id);
  const q = await post(`${P()}/pipeline-runs/${facts.id}/gate-exceptions`, { reason: '试试' });
  const gex = (await q.json()).data;
  // 驳回也需职责分离：由另一审批人决议
  await post(`${P()}/gate-exceptions/${gex.id}/decide`, { approved: false, reason: '证据不足' }, admin2Secret);
  const adv = await advance(facts.id);
  assert.equal(adv.status, 200);
  const out = (await adv.json()).data;
  assert.equal(out.blocked, true);
  assert.equal(out.run.status, 'gated');
});

test('例外审批幂等：同缺失集合重复申请返回同一单', async () => {
  const { chg } = await mkPackage('例外幂等测试');
  const { runs } = await startPipe(chg.id);
  const facts = runOf(runs, 'facts');
  await advance(facts.id);
  const q1 = await post(`${P()}/pipeline-runs/${facts.id}/gate-exceptions`, { reason: 'a' });
  const q2 = await post(`${P()}/pipeline-runs/${facts.id}/gate-exceptions`, { reason: 'b' });
  assert.equal((await q1.json()).data.id, (await q2.json()).data.id);
});

// ---------- requirements 门禁 + 需求发布审计 ----------
test('requirements 门禁：需求未发布 → 阻断；发布到 ready → 通过且审计落链', async () => {
  const { reqId, chgId } = await factsPassedPipe('需求门禁测试');
  const view = await (await get(`${P()}/change-packages/${chgId}/pipeline`)).json();
  const reqRun = view.data.stages.find((s) => s.stage === 'requirements');
  assert.equal(reqRun.status, 'running');
  const blocked = await advance(reqRun.run_id);
  assert.equal(blocked.status, 200);
  assert.ok((await blocked.json()).data.missing.some((m) => String(m).startsWith('requirement_ready')));
  // 发布需求：draft → clarifying → ready
  await patch(`${P()}/requirements/${reqId}`, { status: 'clarifying' });
  const ready = await patch(`${P()}/requirements/${reqId}`, { status: 'ready' });
  assert.equal(ready.status, 200);
  const adv = await advance(reqRun.run_id);
  assert.equal(adv.status, 200);
  assert.equal((await adv.json()).data.run.status, 'passed');
  // 审计链：requirement.publish
  const rows = await db().query(
    "SELECT * FROM audit_events WHERE tenant_id=? AND action='requirement.publish' AND resource_id=?",
    [tenant.id, reqId]);
  assert.ok(rows.length >= 1, 'requirement.publish 应写入审计链');
});

// ---------- clarify 门禁 + 澄清转 AC ----------
test('clarify 门禁：未回答问题阻断 → 回答后缺 AC 阻断 → 补 AC 通过', async () => {
  const { reqId, chgId, clfRunId } = await toClarifyStage('澄清门禁测试');
  // 提问（会影响实现）
  const q = await post(`${P()}/pipeline-runs/${clfRunId}/clarifications`, {
    question: '超时时间是 30s 还是 60s？', impactsImplementation: true, requirementId: reqId,
  });
  assert.equal(q.status, 201);
  const clf = (await q.json()).data;
  const b1 = await advance(clfRunId);
  const b1j = await b1.json();
  assert.ok(b1j.data.missing.some((m) => String(m).startsWith('unanswered_clarifications')));
  // 回答
  const a = await post(`${P()}/pipeline-runs/${clfRunId}/clarifications/${clf.id}/answer`, { answer: '60s' });
  assert.equal(a.status, 200);
  assert.equal((await a.json()).data.answer, '60s');
  const b2 = await advance(clfRunId);
  const b2j = await b2.json();
  assert.ok(b2j.data.missing.includes('acceptance_criteria'));
  // 答案转 AC
  const t = await post(`${P()}/pipeline-runs/${clfRunId}/clarifications/${clf.id}/to-ac`, { kind: 'manual' });
  assert.equal(t.status, 201);
  const ac = (await t.json()).data;
  assert.ok(ac.then_md.includes('60s'));
  assert.ok(ac.given_md.includes('超时时间'));
  const adv = await advance(clfRunId);
  assert.equal((await adv.json()).data.run.status, 'passed');
});

test('澄清校验：空问题 400；未回答不能转 AC', async () => {
  const { clfRunId } = await toClarifyStage('澄清校验测试');
  const empty = await post(`${P()}/pipeline-runs/${clfRunId}/clarifications`, { question: '   ' });
  assert.equal(empty.status, 400);
  const q = await post(`${P()}/pipeline-runs/${clfRunId}/clarifications`, { question: '用 redis 还是内存？' });
  const clf = (await q.json()).data;
  const t = await post(`${P()}/pipeline-runs/${clfRunId}/clarifications/${clf.id}/to-ac`, {});
  assert.equal(t.status, 400);
});

test('澄清校验：在 facts 阶段提问 → 400（阶段不匹配）', async () => {
  const { chgId } = await mkPackage('阶段错配测试');
  const { runs } = await startPipe(chgId);
  const facts = runOf(runs, 'facts');
  const r = await post(`${P()}/pipeline-runs/${facts.id}/clarifications`, { question: '这里能问吗？' });
  assert.equal(r.status, 400);
});

// ---------- develop / handover 门禁 + 全链路 ----------
test('全链路：develop 缺产物阻断 → 补齐通过；handover 通过 → ready_for_review + 交接审计', async () => {
  const { reqId, chgId, clfRunId } = await toClarifyStage('全链路测试');
  await post(`${P()}/requirements/${reqId}/acceptance-criteria`, { thenMd: '接口返回 200', kind: 'auto' });
  await advance(clfRunId);
  let view = await (await get(`${P()}/change-packages/${chgId}/pipeline`)).json();
  const devRun = view.data.stages.find((s) => s.stage === 'develop');
  const b1 = await advance(devRun.run_id);
  const m1 = (await b1.json()).data.missing;
  assert.ok(m1.includes('artifact:diff') && m1.includes('artifact:test_report'));
  // 补齐：head_commit + 三类产物
  await patch(`${P()}/change-packages/${chgId}`, { status: 'building', headCommit: 'def5678' });
  for (const kind of ['diff', 'test_report', 'scan_report']) {
    const ar = await post(`${P()}/change-packages/${chgId}/artifacts`, { kind, contentHash: HASH });
    assert.equal(ar.status, 201);
  }
  const dAdv = await advance(devRun.run_id);
  assert.equal((await dAdv.json()).data.run.status, 'passed');
  // handover：缺报告 + 状态未 verifying → 阻断
  view = await (await get(`${P()}/change-packages/${chgId}/pipeline`)).json();
  const hoRun = view.data.stages.find((s) => s.stage === 'handover');
  const b2 = await advance(hoRun.run_id);
  const m2 = (await b2.json()).data.missing;
  assert.ok(m2.includes('artifact:report'));
  assert.ok(m2.some((m) => String(m).startsWith('change_package_verifying')));
  await post(`${P()}/change-packages/${chgId}/artifacts`, { kind: 'report', contentHash: HASH });
  await patch(`${P()}/change-packages/${chgId}`, { status: 'verifying' });
  // H-1/M-1 安全 review：handover 门禁现场重评估产物合同（fail-closed）。
  // 合同证据缺失（AC 未验收、无 step 运行、无扫描汇总、无 PR）→ 阻断，
  // 必须经门禁例外逐项 waive。
  const hBlock = await advance(hoRun.run_id);
  assert.equal(hBlock.status, 200);
  const hMissing = (await hBlock.json()).data.missing;
  assert.ok(hMissing.includes('contract.ac'), '合同未通过应进入缺失清单');
  assert.ok(hMissing.some((m) => String(m).startsWith('contract.steps.')));
  // 例外审批覆盖全部合同缺失项 → 批准 → 再次推进放行
  // （含 contract.ac 整包豁免，需 broadWaiver 显式确认；审批人须与申请人分离）
  const q = await post(`${P()}/pipeline-runs/${hoRun.run_id}/gate-exceptions`, {
    missingItems: hMissing.filter((m) => String(m).startsWith('contract.')),
    reason: '测试环境豁免合同证据',
    broadWaiver: true,
  });
  assert.equal(q.status, 201);
  const gex = (await q.json()).data;
  const d = await post(`${P()}/gate-exceptions/${gex.id}/decide`, { approved: true, reason: '测试豁免' }, admin2Secret);
  assert.equal(d.status, 200);
  const hAdv = await advance(hoRun.run_id);
  assert.equal(hAdv.status, 200);
  assert.equal((await hAdv.json()).data.run.status, 'passed');
  // 变更包 → ready_for_review
  const chg = await (await get(`${P()}/change-packages/${chgId}`)).json();
  assert.equal(chg.data.status, 'ready_for_review');
  // 审计链：change_package.handover
  const rows = await db().query(
    "SELECT * FROM audit_events WHERE tenant_id=? AND action='change_package.handover' AND resource_id=?",
    [tenant.id, chgId]);
  assert.ok(rows.length >= 1, 'change_package.handover 应写入审计链');
});

test('AC 豁免需已批准的门禁例外（M-2）：无审批 400，有审批放行', async () => {
  const { reqId, chgId, clfRunId } = await toClarifyStage('AC 豁免审批流测试');
  const ac = await post(`${P()}/requirements/${reqId}/acceptance-criteria`, { thenMd: '豁免测试', kind: 'manual' });
  const acId = (await ac.json()).data.id;
  await advance(clfRunId);
  let view = await (await get(`${P()}/change-packages/${chgId}/pipeline`)).json();
  const devRun = view.data.stages.find((s) => s.stage === 'develop');
  await patch(`${P()}/change-packages/${chgId}`, { status: 'building', headCommit: 'def5678' });
  for (const kind of ['diff', 'test_report', 'scan_report']) {
    await post(`${P()}/change-packages/${chgId}/artifacts`, { kind, contentHash: HASH });
  }
  await advance(devRun.run_id);
  await post(`${P()}/change-packages/${chgId}/artifacts`, { kind: 'report', contentHash: HASH });
  await patch(`${P()}/change-packages/${chgId}`, { status: 'verifying' });
  view = await (await get(`${P()}/change-packages/${chgId}/pipeline`)).json();
  const hoRun = view.data.stages.find((s) => s.stage === 'handover');
  const blocked = await advance(hoRun.run_id);
  const missing = (await blocked.json()).data.missing;
  assert.ok(missing.includes('contract.ac'));
  // 无审批直接 waive → 400
  const w1 = await patch(`${P()}/requirements/${reqId}/acceptance-criteria/${acId}`, { status: 'waived' });
  assert.equal(w1.status, 400);
  assert.equal((await w1.json()).error.details.code, 'WAIVER_APPROVAL_REQUIRED');
  // 为 contract.ac 申请例外（整包豁免需 broadWaiver 显式确认）→ 批准 → 豁免放行
  const q0 = await post(`${P()}/pipeline-runs/${hoRun.run_id}/gate-exceptions`, {
    missingItems: ['contract.ac'], reason: '未确认整包豁免',
  });
  assert.equal(q0.status, 400);
  assert.equal((await q0.json()).error.details.code, 'BROAD_WAIVER_CONFIRM_REQUIRED');
  const q = await post(`${P()}/pipeline-runs/${hoRun.run_id}/gate-exceptions`, {
    missingItems: ['contract.ac'], reason: '该 AC 不适用本次变更', broadWaiver: true,
  });
  assert.equal(q.status, 201);
  const gex = (await q.json()).data;
  assert.equal(gex.broad_waiver, true);
  const d = await post(`${P()}/gate-exceptions/${gex.id}/decide`, { approved: true, reason: '同意豁免' }, admin2Secret);
  assert.equal(d.status, 200);
  const w2 = await patch(`${P()}/requirements/${reqId}/acceptance-criteria/${acId}`, { status: 'waived' });
  assert.equal(w2.status, 200);
  assert.equal((await w2.json()).data.status, 'waived');
  // 审计：delivery.ac.waive
  const rows = await db().query(
    "SELECT * FROM audit_events WHERE tenant_id=? AND action='delivery.ac.waive' AND resource_id=?",
    [tenant.id, acId]);
  assert.ok(rows.length >= 1, 'delivery.ac.waive 应写入审计链');
});

// ---------- 非法跃迁 / 权限 ----------
test('门禁防绕过：静态 PATCH 不能直接改编排运行的门禁状态', async () => {
  const { chg } = await mkPackage('防绕过测试');
  const { runs } = await startPipe(chg.id);
  const facts = runOf(runs, 'facts');
  // running → gated 在静态状态机里合法，但对编排运行必须拒绝（只能经 advance 门禁产生）
  const r = await patch(`${P()}/pipeline-runs/${facts.id}`, { status: 'gated' });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.error.details.code, 'GATE_BYPASS_DENIED');
  // 运行状态未被篡改
  const g = await get(`${P()}/pipeline-runs/${facts.id}`);
  assert.equal((await g.json()).data.run.status, 'running');
  // 无变更包绑定的静态记录不受影响（V1.0-A 兼容）
  const sp = await post(`${P()}/pipeline-runs`, { stage: 'develop' });
  const srun = (await sp.json()).data;
  await patch(`${P()}/pipeline-runs/${srun.id}`, { status: 'running' });
  const sg = await patch(`${P()}/pipeline-runs/${srun.id}`, { status: 'gated' });
  assert.equal(sg.status, 200);
});

test('startPipeline：已取消的变更包不能启动流水线', async () => {
  const { chgId } = await mkPackage('终态测试');
  await patch(`${P()}/change-packages/${chgId}`, { status: 'cancelled' });
  const r = await post(`${P()}/change-packages/${chgId}/pipeline/start`, {});
  assert.equal(r.status, 400);
});

test('非法跳阶段：pending 的 handover 直接推进 → 400', async () => {
  const { chg } = await mkPackage('跳阶段测试');
  const { runs } = await startPipe(chg.id);
  const ho = runOf(runs, 'handover');
  const r = await advance(ho.id);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.details.code, 'INVALID_TRANSITION');
});

test('非法：前序未通过时推进 clarify → 400', async () => {
  const { chg } = await mkPackage('前序校验测试');
  const { runs } = await startPipe(chg.id);
  const clf = runOf(runs, 'clarify');
  const r = await advance(clf.id);
  assert.equal(r.status, 400);
});

test('非法：重复推进已通过的阶段 → 400', async () => {
  const { chg } = await mkPackage('重复推进测试');
  const { runs } = await startPipe(chg.id);
  const facts = runOf(runs, 'facts');
  await post(`${P()}/pipeline-runs/${facts.id}/fact-snapshot`, {
    baselineCommit: 'abc', environment: {}, dependencies: {}, unknownItems: [],
  });
  await advance(facts.id);
  const r = await advance(facts.id);
  assert.equal(r.status, 400);
});

test('gated 阶段无例外批准再次推进 → 仍阻断（不静默通过）', async () => {
  const { chg } = await mkPackage('无例外重推测试');
  const { runs } = await startPipe(chg.id);
  const facts = runOf(runs, 'facts');
  await advance(facts.id); // gated
  const r = await advance(facts.id); // 仍无快照、无例外
  assert.equal(r.status, 200);
  const out = (await r.json()).data;
  assert.equal(out.blocked, true);
  assert.equal(out.run.status, 'gated');
  assert.ok(out.missing.includes('fact_snapshot'));
});

test('鉴权：viewer 不能推进阶段（delivery.write）', async () => {
  const { chg } = await mkPackage('viewer 测试');
  const { runs } = await startPipe(chg.id);
  const facts = runOf(runs, 'facts');
  const r = await advance(facts.id, {}, viewerSecret);
  assert.equal(r.status, 403);
});

test('鉴权：viewer 可读流水线视图（delivery.read）', async () => {
  const { chg } = await mkPackage('viewer 读测试');
  await startPipe(chg.id);
  const r = await get(`${P()}/change-packages/${chg.id}/pipeline`, viewerSecret);
  assert.equal(r.status, 200);
});

test('租户隔离：B 租户访问 A 租户流水线 → 403', async () => {
  const { chg } = await mkPackage('隔离测试');
  await startPipe(chg.id);
  const r = await get(`${D('whatever')}/change-packages/${chg.id}/pipeline`.replace('whatever', project.id), otherSecret);
  assert.equal(r.status, 403);
});

test('例外决议鉴权：viewer 不能决议例外审批', async () => {
  const { chg } = await mkPackage('例外鉴权测试');
  const { runs } = await startPipe(chg.id);
  const facts = runOf(runs, 'facts');
  await advance(facts.id);
  const q = await post(`${P()}/pipeline-runs/${facts.id}/gate-exceptions`, { reason: 'x' });
  const gex = (await q.json()).data;
  const d = await post(`${P()}/gate-exceptions/${gex.id}/decide`, { approved: true }, viewerSecret);
  assert.equal(d.status, 403);
});

test('SoD：申请人不能批准自己的门禁例外 → 403', async () => {
  const { chg } = await mkPackage('SoD 测试');
  const { runs } = await startPipe(chg.id);
  const facts = runOf(runs, 'facts');
  await advance(facts.id);
  const q = await post(`${P()}/pipeline-runs/${facts.id}/gate-exceptions`, { reason: '自批试试' });
  assert.equal(q.status, 201);
  const gex = (await q.json()).data;
  // 同一 actor（申请人=admin）决议 → 403 SOD_VIOLATION
  const d = await post(`${P()}/gate-exceptions/${gex.id}/decide`, { approved: true, reason: '自己批自己' });
  assert.equal(d.status, 403);
  assert.equal((await d.json()).error.details.code, 'SOD_VIOLATION');
  // 另一审批人可正常决议
  const d2 = await post(`${P()}/gate-exceptions/${gex.id}/decide`, { approved: true, reason: '他人批准' }, admin2Secret);
  assert.equal(d2.status, 200);
});

test('AC 逐项豁免：ac:<id> 无需 broadWaiver，批准后可 waive 单项', async () => {
  const { reqId, chgId, clfRunId } = await toClarifyStage('逐项豁免测试');
  const ac = await post(`${P()}/requirements/${reqId}/acceptance-criteria`, { thenMd: '逐项豁免', kind: 'manual' });
  const acId = (await ac.json()).data.id;
  await advance(clfRunId);
  let view = await (await get(`${P()}/change-packages/${chgId}/pipeline`)).json();
  const devRun = view.data.stages.find((s) => s.stage === 'develop');
  await patch(`${P()}/change-packages/${chgId}`, { status: 'building', headCommit: 'def5678' });
  for (const kind of ['diff', 'test_report', 'scan_report']) {
    await post(`${P()}/change-packages/${chgId}/artifacts`, { kind, contentHash: HASH });
  }
  await advance(devRun.run_id);
  await post(`${P()}/change-packages/${chgId}/artifacts`, { kind: 'report', contentHash: HASH });
  await patch(`${P()}/change-packages/${chgId}`, { status: 'verifying' });
  view = await (await get(`${P()}/change-packages/${chgId}/pipeline`)).json();
  const hoRun = view.data.stages.find((s) => s.stage === 'handover');
  const blocked = await advance(hoRun.run_id);
  const missing = (await blocked.json()).data.missing;
  // 缺失清单同时含包级 contract.ac 与逐项 ac:<id>
  assert.ok(missing.includes('contract.ac'));
  assert.ok(missing.includes(`ac:${acId}`), '逐项 ac:<id> 应进入缺失清单');
  // 逐项申请：无需 broadWaiver
  const q = await post(`${P()}/pipeline-runs/${hoRun.run_id}/gate-exceptions`, {
    missingItems: [`ac:${acId}`], reason: '仅豁免该单项',
  });
  assert.equal(q.status, 201);
  const gexBody = (await q.json()).data;
  assert.equal(gexBody.broad_waiver, false);
  const gexId = gexBody.id;
  const d = await post(`${P()}/gate-exceptions/${gexId}/decide`, { approved: true, reason: '同意逐项豁免' }, admin2Secret);
  assert.equal(d.status, 200);
  const w = await patch(`${P()}/requirements/${reqId}/acceptance-criteria/${acId}`, { status: 'waived' });
  assert.equal(w.status, 200);
  assert.equal((await w.json()).data.status, 'waived');
});
