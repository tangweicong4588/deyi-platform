/** contract 测试：V1.0-E 产物合同与交接 —— 合同评估/组装/报告/证据封存/门禁联动/跨租户 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const scratch = mkdtempSync(join(tmpdir(), 'deyi-contract-'));
process.env.SQLITE_PATH = join(scratch, 'test.db');
process.env.OPERATOR_TOKEN = 'op-test-token';
process.env.DEV_IDP_SECRET = 'dev-test-secret';
process.env.BOOTSTRAP_ENABLED = 'false';
process.env.RUNNER_ROOT = join(scratch, 'runner-root');
process.env.PACKAGES_ROOT = join(scratch, 'packages');
process.env.RUNNER_MODE = 'live'; // 合同需要真实 step 证据；waive/隔离类用例走 store 层
delete process.env.GITEA_URL; // repo 适配器走 fake（simulated）

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const audit = await import('../src/modules/evidence/audit.mjs');
const store = await import('../src/modules/identity/store.mjs');
const dstore = await import('../src/modules/delivery/store.mjs');
const { verifyPackage } = await import('../src/modules/evidence/packages.mjs');
const { newId } = await import('../src/kernel/ids.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerDeliveryRoutes } = await import('../src/modules/delivery/routes.mjs');

let tenant, project, adminActorId, adminSecret, admin2Secret;
let tenantB, projectB, bSecret;
let fixtureDir, bareRepo;

before(async () => {
  await openDb();
  await migrate(db());
  await audit.initEvidence();

  tenant = await store.createTenant({ name: 'CONTRACT Tenant' });
  project = await store.createProject(tenant.id, { name: 'CONTRACT Project' });
  const admin = await store.createActor(tenant.id, { kind: 'user', name: 'CONTRACT Admin' });
  adminActorId = admin.id;
  await store.bindRole(tenant.id, admin.id, null, 'admin');
  const ak = mintKey();
  await store.createApiKeyRow({ tenantId: tenant.id, actorId: admin.id, name: 'ct-admin', prefix: ak.prefix, keyHash: ak.keyHash });
  adminSecret = ak.secret;
  // 第二审批人：门禁例外 SoD 要求申请人与审批人分离
  const admin2 = await store.createActor(tenant.id, { kind: 'user', name: 'CONTRACT Admin2' });
  await store.bindRole(tenant.id, admin2.id, null, 'admin');
  const ak2 = mintKey();
  await store.createApiKeyRow({ tenantId: tenant.id, actorId: admin2.id, name: 'ct-admin2', prefix: ak2.prefix, keyHash: ak2.keyHash });
  admin2Secret = ak2.secret;

  tenantB = await store.createTenant({ name: 'CONTRACT Tenant B' });
  projectB = await store.createProject(tenantB.id, { name: 'CONTRACT B Project' });
  const bAdmin = await store.createActor(tenantB.id, { kind: 'user', name: 'B Admin' });
  await store.bindRole(tenantB.id, bAdmin.id, null, 'admin');
  const bk = mintKey();
  await store.createApiKeyRow({ tenantId: tenantB.id, actorId: bAdmin.id, name: 'b-admin', prefix: bk.prefix, keyHash: bk.keyHash });
  bSecret = bk.secret;

  // step 产物 fixture：测试报告 + 扫描报告（含 severity 汇总）
  fixtureDir = mkdtempSync(join(scratch, 'fixture-'));
  writeFileSync(join(fixtureDir, 'test-report.txt'), 'tests: 12 passed', 'utf8');
  writeFileSync(join(fixtureDir, 'scan-report.json'),
    JSON.stringify({ severities: { critical: 0, high: 0, moderate: 1, low: 2 } }), 'utf8');

  // 本地 bare git 仓库（fake repo 客户端的 getBranchCommit 走真 git ls-remote）
  const gitDir = mkdtempSync(join(scratch, 'git-'));
  bareRepo = join(gitDir, 'repo.git');
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--bare', '-q', bareRepo]);
  const w = join(gitDir, 'w');
  execFileSync('git', ['clone', '-q', bareRepo, w]);
  execFileSync('git', ['-C', w, 'config', 'user.email', 't@t.t']);
  execFileSync('git', ['-C', w, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', w, 'checkout', '-qb', 'main']);
  writeFileSync(join(w, 'f.txt'), 'hi\n');
  execFileSync('git', ['-C', w, 'add', '.']);
  execFileSync('git', ['-C', w, 'commit', '-qm', 'init commit']);
  execFileSync('git', ['-C', w, 'push', '-q', 'origin', 'main']);
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
const ECHO = ['echo', 'ok'];

/**
 * 构建一个"万事俱备"的变更包（需求→AC→分支→steps→diff→[reproduce]→PR→verifying）。
 * 返回 { reqId, chgId }。
 */
async function mkFullPackage({ reproduce = true } = {}) {
  const req = await (await post(`${D(project.id)}/requirements`,
    { title: '合同测试需求', kind: 'feature', scopeMd: 'scope' })).json();
  const reqId = req.data.id;
  const ac = await (await post(`${D(project.id)}/requirements/${reqId}/acceptance-criteria`,
    { thenMd: '接口返回 200', kind: 'auto' })).json();
  await patch(`${D(project.id)}/requirements/${reqId}/acceptance-criteria/${ac.data.id}`, { status: 'passed' });
  for (const s of ['clarifying', 'ready', 'in_progress', 'verifying']) {
    const r = await patch(`${D(project.id)}/requirements/${reqId}`, { status: s });
    assert.equal(r.status, 200, `需求跃迁 ${s}`);
  }
  const chg = await (await post(`${D(project.id)}/change-packages`,
    { requirementId: reqId })).json();
  const chgId = chg.data.id;

  const rbRes = await post(`${D(project.id)}/repo-bindings`,
    { provider: 'local', remoteUrl: bareRepo });
  assert.equal(rbRes.status, 201);
  const rb = await rbRes.json();
  const br = await post(`${D(project.id)}/change-packages/${chgId}/branch`,
    { repoBindingId: rb.data.id });
  assert.ok([200, 201].includes(br.status), '受控分支创建');
  await patch(`${D(project.id)}/change-packages/${chgId}`, { status: 'building' });

  const step = async (stepName, extra = {}) => {
    const r = await post(`${D(project.id)}/change-packages/${chgId}/steps`,
      { step: stepName, commands: [{ argv: ECHO }], sourceDir: fixtureDir, ...extra });
    assert.equal(r.status, 201, `${stepName} step`);
    return r.json();
  };
  await step('build');
  await step('test', { artifacts: [{ kind: 'test_report', path: 'test-report.txt' }] });
  await step('scan', {
    reportFile: 'scan-report.json',
    artifacts: [{ kind: 'scan_report', path: 'scan-report.json' }],
  });
  const dr = await post(`${D(project.id)}/change-packages/${chgId}/artifacts`,
    { kind: 'diff', contentHash: HASH, uri: 'test:diff' });
  assert.equal(dr.status, 201);

  if (reproduce) {
    const rp = await post(`${D(project.id)}/change-packages/${chgId}/reproduce`);
    assert.equal(rp.status, 200);
    assert.equal((await rp.json()).data.consistent, true);
  }
  const pr = await post(`${D(project.id)}/change-packages/${chgId}/pull-request`, { title: '合同测试 PR' });
  assert.ok([200, 201].includes(pr.status), '草稿 PR 创建');
  const fin = await patch(`${D(project.id)}/change-packages/${chgId}`,
    { status: 'verifying', headCommit: 'abc123def456' });
  assert.equal(fin.status, 200);
  return { reqId, chgId };
}

const evaluate = (chgId, token) =>
  post(`${D(project.id)}/change-packages/${chgId}/contract/evaluate`, {}, token);
const assemble = (chgId, token) =>
  post(`${D(project.id)}/change-packages/${chgId}/assemble`, {}, token);

// ---------------------------------------------------------------- 合同与组装
test('合同全过 → assemble 成功：产物/证据包/报告/成本齐全', async () => {
  const { chgId } = await mkFullPackage();

  // 成本真相源里放两条模型调用（断言不重复计算）
  for (const [tokens, cents] of [[100, 5], [200, 15]]) {
    await db().query(
      `INSERT INTO model_calls(id,tenant_id,project_id,actor_id,trace_id,model,endpoint,
        total_tokens,cost_cents,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [newId('call'), tenant.id, project.id, adminActorId, 'trace-test', 'test-model',
        'chat.completions', tokens, cents, 'ok', Date.now()]);
  }

  const ev = await evaluate(chgId);
  assert.equal(ev.status, 200);
  const contract = (await ev.json()).data;
  assert.equal(contract.passed, true);
  assert.equal(contract.items.length, 8);
  assert.ok(contract.items.every((i) => i.status === 'pass'),
    `应全 pass，实际: ${JSON.stringify(contract.items.map((i) => [i.key, i.status]))}`);

  const as = await assemble(chgId);
  assert.equal(as.status, 201);
  const asm = (await as.json()).data;
  assert.equal(asm.artifacts.length, 3, 'manifest/handover/cost 三产物登记');
  assert.ok(asm.evidence_package && asm.evidence_package.verified === true, '证据包封存且验包通过');
  assert.ok(asm.evidence_package.event_count > 0);
  // 成本摘要：模型调用精确求和（不重复计算），runner 有耗时
  assert.equal(asm.cost.model.calls, 2);
  assert.equal(asm.cost.model.tokens, 300);
  assert.equal(asm.cost.model.cost_cents, 20);
  assert.ok(asm.cost.runner.total_runs >= 5, 'build/test/scan + 2 次 reproduce');
  assert.ok(asm.cost.runner.total_duration_ms >= 0);
  // manifest 机读校验
  const manifest = asm.manifest;
  assert.equal(manifest.change_package_id, chgId);
  assert.equal(manifest.contract.passed, true);
  assert.ok(manifest.artifacts.some((a) => a.uri === `package:${chgId}/handover.md`));
  assert.ok(manifest.artifacts.some((a) => a.uri === `package:${chgId}/cost.json`));

  // 证据包独立验签
  const v = await verifyPackage(tenant.id, asm.evidence_package.id);
  assert.equal(v.ok, true);

  // 交接报告下载：含需求映射/diff/测试/扫描/例外/预览/回滚/成本/证据包要素
  const hr = await get(`${D(project.id)}/change-packages/${chgId}/handover`);
  assert.equal(hr.status, 200);
  assert.ok(hr.headers.get('content-type').includes('text/markdown'));
  const md = await hr.text();
  for (const h of ['## 需求映射', '## 文件 diff 摘要', '## 测试结果', '## 扫描结果',
    '## 例外清单', '## 预览地址', '## 回滚说明', '## 成本摘要', '## 证据包']) {
    assert.ok(md.includes(h), `报告缺 ${h}`);
  }
  assert.ok(md.includes('合同测试需求'), '报告含需求标题');
  assert.ok(md.includes(asm.evidence_package.merkle_root), '报告含证据包 Merkle 根');

  // 报告被篡改 → hash 不一致 → 500（不返回伪造报告）
  appendFileSync(join(process.env.PACKAGES_ROOT, chgId, 'handover.md'), '\n<!-- tampered -->');
  const hr2 = await get(`${D(project.id)}/change-packages/${chgId}/handover`);
  assert.equal(hr2.status, 500);
});

test('缺 reproduce → 合同 fail，assemble 被拒（409）', async () => {
  const { chgId } = await mkFullPackage({ reproduce: false });
  const ev = await evaluate(chgId);
  assert.equal(ev.status, 200);
  const contract = (await ev.json()).data;
  assert.equal(contract.passed, false);
  const rep = contract.items.find((i) => i.key === 'contract.reproduce');
  assert.equal(rep.status, 'fail');

  const as = await assemble(chgId);
  assert.equal(as.status, 409);
  const body = await as.json();
  assert.ok((body.error.details.failed || []).includes('contract.reproduce'));
});

test('fail 项有例外批准 → waive 放行；无批准伪造 waive 不可能', async () => {
  const { chgId } = await mkFullPackage({ reproduce: false });
  // 批准一条覆盖 contract.reproduce 的门禁例外（store 层登记，模拟已审批记录）
  const prun = await dstore.createPipelineRun({
    tenantId: tenant.id, projectId: project.id, changePackageId: chgId, stage: 'handover',
  });
  const gex = await dstore.createGateException({
    tenantId: tenant.id, projectId: project.id, pipelineRunId: prun.id, stage: 'handover',
    missingItems: ['contract.reproduce'], reason: '测试豁免', requestedBy: adminActorId,
  });
  await dstore.decideGateException(tenant.id, gex.id,
    { approved: true, decidedBy: adminActorId, reason: 'ok' });

  const ev = await evaluate(chgId);
  const contract = (await ev.json()).data;
  const rep = contract.items.find((i) => i.key === 'contract.reproduce');
  assert.equal(rep.status, 'waived');
  assert.equal(rep.waived_by, gex.id, 'waive 必须引用真实批准记录');
  assert.equal(contract.passed, true);

  const as = await assemble(chgId);
  assert.equal(as.status, 201);
  const md = await (await get(`${D(project.id)}/change-packages/${chgId}/handover`)).text();
  assert.ok(md.includes(gex.id), '例外清单列出批准单');

  // 反例：另一个未豁免的包，fail 项不能凭空 waive
  const other = await mkFullPackage({ reproduce: false });
  const ev2 = await (await evaluate(other.chgId)).json();
  assert.equal(ev2.data.items.find((i) => i.key === 'contract.reproduce').status, 'fail');
});

// ---------------------------------------------------------------- 门禁联动
const startPipeline = (chgId) =>
  post(`${D(project.id)}/change-packages/${chgId}/pipeline/start`, {});
const advance = (runId, body = {}) =>
  post(`${D(project.id)}/pipeline-runs/${runId}/advance`, body);

async function driveToHandover(chgId) {
  const started = await (await startPipeline(chgId)).json();
  const runOf = (stage) => started.data.runs.find((r) => r.stage === stage).id;
  // facts：登记快照后推进
  const factsId = runOf('facts');
  const sn = await post(`${D(project.id)}/pipeline-runs/${factsId}/fact-snapshot`, {
    baselineCommit: 'abc123', environment: { os: 'linux' }, dependencies: { node: '22' }, unknownItems: [],
  });
  assert.equal(sn.status, 201);
  assert.equal((await (await advance(factsId)).json()).data.run.status, 'passed');
  // requirements / clarify：需求已 verifying、AC 存在，直接推进
  assert.equal((await (await advance(runOf('requirements'))).json()).data.run.status, 'passed');
  assert.equal((await (await advance(runOf('clarify'))).json()).data.run.status, 'passed');
  // develop：diff/test_report/scan_report + head_commit 已齐
  assert.equal((await (await advance(runOf('develop'))).json()).data.run.status, 'passed');
  const view = await (await get(`${D(project.id)}/change-packages/${chgId}/pipeline`)).json();
  return view.data.stages.find((s) => s.stage === 'handover').run_id;
}

test('门禁联动：assemble 前 handover 被合同项阻断；assemble 后放行 → ready_for_review', async () => {
  const { chgId } = await mkFullPackage(); // reproduce 已做，合同全过
  const hoRunId = await driveToHandover(chgId);

  // assemble 前：缺 artifact:report → 阻断（合同已通过，无合同项缺失）
  const b1 = await (await advance(hoRunId)).json();
  assert.equal(b1.data.blocked, true);
  assert.ok(b1.data.missing.includes('artifact:report'));
  assert.ok(!b1.data.missing.some((m) => String(m).startsWith('contract.')), '合同全过，不应有合同项缺失');

  await assemble(chgId);
  const b2 = await (await advance(hoRunId)).json();
  assert.equal(b2.data.run.status, 'passed');
  const chg = await (await get(`${D(project.id)}/change-packages/${chgId}`)).json();
  assert.equal(chg.data.status, 'ready_for_review');
});

test('门禁联动：合同 fail 项进入门禁缺失清单，可经例外审批 waive 后交接', async () => {
  const { chgId } = await mkFullPackage({ reproduce: false });
  await evaluate(chgId); // 落库 fail 结论，供门禁读取
  const hoRunId = await driveToHandover(chgId);

  const b1 = await (await advance(hoRunId)).json();
  assert.equal(b1.data.blocked, true);
  assert.ok(b1.data.missing.includes('contract.reproduce'), '合同 fail 项进入门禁缺失');
  assert.ok(b1.data.missing.includes('artifact:report'));

  // 例外审批覆盖全部缺失项（走真实 API 路径）。
  // SoD：申请人（adminSecret）不能自批，换第二审批人决议。
  const gex = await (await post(`${D(project.id)}/pipeline-runs/${hoRunId}/gate-exceptions`,
    { missingItems: ['contract.reproduce', 'artifact:report'], reason: '测试豁免' })).json();
  const selfDecide = await post(`${D(project.id)}/gate-exceptions/${gex.data.id}/decide`,
    { approved: true, reason: '自批' });
  assert.equal(selfDecide.status, 403, '申请人自批应被 SoD 拒绝');
  const dec = await post(`${D(project.id)}/gate-exceptions/${gex.data.id}/decide`,
    { approved: true, reason: 'ok' }, admin2Secret);
  assert.equal(dec.status, 200);

  // assemble：合同现场评估发现 waive → 通过
  const as = await assemble(chgId);
  assert.equal(as.status, 201);
  const b2 = await (await advance(hoRunId)).json();
  assert.equal(b2.data.run.status, 'passed');
  const chg = await (await get(`${D(project.id)}/change-packages/${chgId}`)).json();
  assert.equal(chg.data.status, 'ready_for_review');
});

// ---------------------------------------------------------------- 边界与隔离
test('未 assemble 前 GET handover → 404', async () => {
  const { chgId } = await mkFullPackage();
  const r = await get(`${D(project.id)}/change-packages/${chgId}/handover`);
  assert.equal(r.status, 404);
});

test('已编排的变更包 PATCH 直达 ready_for_review → 400（门禁绕过拒绝）', async () => {
  const { chgId } = await mkFullPackage();
  await startPipeline(chgId);
  const r = await patch(`${D(project.id)}/change-packages/${chgId}`, { status: 'ready_for_review' });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.error.details.code, 'GATE_BYPASS_DENIED');
});

test('跨租户：B 租户读 A 租户的合同/报告 → 403', async () => {
  const { chgId } = await mkFullPackage();
  await assemble(chgId);
  const pid = project.id; // A 租户的项目
  const e1 = await post(`${base}/v1/projects/${pid}/delivery/change-packages/${chgId}/contract/evaluate`, {}, bSecret);
  assert.equal(e1.status, 403);
  const e2 = await post(`${base}/v1/projects/${pid}/delivery/change-packages/${chgId}/assemble`, {}, bSecret);
  assert.equal(e2.status, 403);
  const e3 = await get(`${base}/v1/projects/${pid}/delivery/change-packages/${chgId}/handover`, bSecret);
  assert.equal(e3.status, 403);
});

test('viewer 可读合同与报告，不可 assemble', async () => {
  const { chgId } = await mkFullPackage();
  await assemble(chgId);
  const viewer = await store.createActor(tenant.id, { kind: 'user', name: 'CT Viewer' });
  await store.bindRole(tenant.id, viewer.id, project.id, 'viewer');
  const vk = mintKey();
  await store.createApiKeyRow({ tenantId: tenant.id, actorId: viewer.id, name: 'ct-viewer', prefix: vk.prefix, keyHash: vk.keyHash });
  const vs = vk.secret;
  const e1 = await evaluate(chgId, vs);
  assert.equal(e1.status, 403, '合同评估要 delivery.write');
  const h = await get(`${D(project.id)}/change-packages/${chgId}/handover`, vs);
  assert.equal(h.status, 200, 'viewer 可读报告');
  const as = await assemble(chgId, vs);
  assert.equal(as.status, 403, 'viewer 不可组装');
});
