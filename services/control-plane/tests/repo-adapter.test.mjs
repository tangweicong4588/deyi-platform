/** repo-adapter 测试：V1.0-C 仓库与 CI 适配 —— Gitea 适配器 / 受控分支 / 草稿 PR / CI 接口 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-repo-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op-test-token-repo';
process.env.DEV_IDP_SECRET = 'dev-idp-secret-repo';
process.env.BOOTSTRAP_ENABLED = 'false';
delete process.env.GITEA_URL; // 本文件全部走 fake fallback

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const audit = await import('../src/modules/evidence/audit.mjs');
const store = await import('../src/modules/identity/store.mjs');
const dstore = await import('../src/modules/delivery/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerDeliveryRoutes } = await import('../src/modules/delivery/routes.mjs');
const { createRepoClient, sanitizeBranchName, getRepoAdapterStatus } =
  await import('../src/adapters/gitea/client.mjs');
const { resolveToken } = await import('../src/adapters/credentials.mjs');
const { createPipelineAdapter, assertRunShape, getPipelineAdapterStatus } =
  await import('../src/adapters/pipeline/adapter.mjs');
const { controlledBranchName } = await import('../src/modules/delivery/repo.mjs');

let tenant, project, adminSecret, viewerSecret;
let tenantB, projectB, bSecret;
before(async () => {
  await openDb();
  await migrate(db());
  await audit.initEvidence();
  tenant = await store.createTenant({ name: 'REPO Tenant' });
  project = await store.createProject(tenant.id, { name: 'REPO Project' });
  const admin = await store.createActor(tenant.id, { kind: 'user', name: 'REPO Admin' });
  await store.bindRole(tenant.id, admin.id, null, 'admin');
  const ak = mintKey();
  await store.createApiKeyRow({ tenantId: tenant.id, actorId: admin.id, name: 'repo-admin', prefix: ak.prefix, keyHash: ak.keyHash });
  adminSecret = ak.secret;

  const viewer = await store.createActor(tenant.id, { kind: 'user', name: 'REPO Viewer' });
  await store.bindRole(tenant.id, viewer.id, project.id, 'viewer');
  const vk = mintKey();
  await store.createApiKeyRow({ tenantId: tenant.id, actorId: viewer.id, name: 'repo-viewer', prefix: vk.prefix, keyHash: vk.keyHash });
  viewerSecret = vk.secret;

  tenantB = await store.createTenant({ name: 'REPO Tenant B' });
  projectB = await store.createProject(tenantB.id, { name: 'REPO Project B' });
  const bAdmin = await store.createActor(tenantB.id, { kind: 'user', name: 'B Admin' });
  await store.bindRole(tenantB.id, bAdmin.id, null, 'admin');
  const bk = mintKey();
  await store.createApiKeyRow({ tenantId: tenantB.id, actorId: bAdmin.id, name: 'b-admin', prefix: bk.prefix, keyHash: bk.keyHash });
  bSecret = bk.secret;
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
const get = (url, token = adminSecret) =>
  fetch(url, { headers: { authorization: `Bearer ${token}` } });
const P = () => D(project.id);
const PB = () => D(projectB.id);

async function mkReq(title = '仓库需求') {
  const r = await post(`${P()}/requirements`, { title, kind: 'feature', scopeMd: '做 X' });
  assert.equal(r.status, 201);
  return (await r.json()).data;
}
/** 不带 branch 的变更包：分支由平台受控创建 */
async function mkChg(reqId) {
  const r = await post(`${P()}/change-packages`, { requirementId: reqId });
  assert.equal(r.status, 201, 'branch 应为可选（V1.0-C 平台分配）');
  return (await r.json()).data;
}
async function mkBinding(t = adminSecret, p = project.id, extra = {}) {
  const r = await post(`${D(p)}/repo-bindings`,
    { provider: 'local', remoteUrl: 'local://demo', defaultBranch: 'main', ...extra }, t);
  assert.equal(r.status, 201);
  return (await r.json()).data;
}
async function startPipe(chgId, t = adminSecret, p = project.id) {
  const r = await post(`${D(p)}/change-packages/${chgId}/pipeline/start`, {}, t);
  assert.ok([200, 201].includes(r.status));
  return (await r.json()).data;
}

// ---------- A. fake 全链路 ----------
test('A1 RepoSnapshot 采集：落 snp_（kind=snapshot），facts 门禁通过', async () => {
  const req = await mkReq('A1 需求');
  const chg = await mkChg(req.id);
  const binding = await mkBinding(adminSecret, project.id, { remoteUrl: 'local://a1' });
  await startPipe(chg.id);
  const factsRunId = (await (await get(`${P()}/change-packages/${chg.id}/pipeline`)).json())
    .data.stages.find((s) => s.stage === 'facts').run_id;
  assert.ok(factsRunId, '应能取到 facts 运行');

  const c = await post(`${P()}/repo-snapshots/collect`,
    { repoBindingId: binding.id, pipelineRunId: factsRunId });
  assert.equal(c.status, 201);
  const { snapshot, simulated } = (await c.json()).data;
  assert.equal(snapshot.kind, 'snapshot');
  assert.equal(simulated, true);
  assert.match(snapshot.baseline_commit, /^[0-9a-f]{40}$/);
  assert.equal(snapshot.environment.snapshot_kind, 'repo');
  assert.ok(Array.isArray(snapshot.environment.branches));
  assert.ok(Array.isArray(snapshot.environment.recent_commits));

  // facts 门禁：基线 commit 已具备 → 通过
  const adv = await post(`${P()}/pipeline-runs/${factsRunId}/advance`, {});
  assert.equal(adv.status, 200);
  const advBody = (await adv.json()).data;
  assert.ok(!advBody.blocked, `facts 门禁应通过，实际 missing=${JSON.stringify(advBody.missing)}`);
  assert.equal(advBody.run.status, 'passed');
});

test('A2 受控分支：创建 dy/<chg_id>，幂等，base_commit 与快照基线一致', async () => {
  const req = await mkReq('A2 需求');
  const chg = await mkChg(req.id);
  const binding = await mkBinding(adminSecret, project.id, { remoteUrl: 'local://a2' });
  await startPipe(chg.id);
  const factsRunId = (await (await get(`${P()}/change-packages/${chg.id}/pipeline`)).json())
    .data.stages.find((s) => s.stage === 'facts').run_id;
  const c = await post(`${P()}/repo-snapshots/collect`, { repoBindingId: binding.id, pipelineRunId: factsRunId });
  const baseline = (await c.json()).data.snapshot.baseline_commit;

  const b = await post(`${P()}/change-packages/${chg.id}/branch`, { repoBindingId: binding.id });
  assert.equal(b.status, 201);
  const bb = (await b.json()).data;
  assert.equal(bb.branch, `dy/${chg.id}`);
  assert.equal(bb.base_commit, baseline);
  assert.equal(bb.simulated, true);
  assert.equal(bb.change_package.branch, `dy/${chg.id}`);

  const b2 = await post(`${P()}/change-packages/${chg.id}/branch`, { repoBindingId: binding.id });
  assert.equal(b2.status, 200);
  assert.equal((await b2.json()).data.existed, true);
});

test('A3 草稿 PR：创建登记为 draft，幂等不重复', async () => {
  const req = await mkReq('A3 需求');
  const chg = await mkChg(req.id);
  const binding = await mkBinding(adminSecret, project.id, { remoteUrl: 'local://a3' });
  await post(`${P()}/change-packages/${chg.id}/branch`, { repoBindingId: binding.id });

  const pr = await post(`${P()}/change-packages/${chg.id}/pull-request`,
    { repoBindingId: binding.id, title: 'A3 变更' });
  assert.equal(pr.status, 201);
  const prb = (await pr.json()).data;
  assert.equal(prb.pull_request.status, 'draft');
  assert.equal(prb.pull_request.head_branch, `dy/${chg.id}`);
  assert.equal(prb.simulated, true);
  assert.ok(prb.pull_request.url.startsWith('fake://'));

  const pr2 = await post(`${P()}/change-packages/${chg.id}/pull-request`, { repoBindingId: binding.id });
  assert.equal(pr2.status, 200);
  const pr2b = (await pr2.json()).data;
  assert.equal(pr2b.existed, true);
  assert.equal(pr2b.pull_request.id, prb.pull_request.id);

  // 列表与详情
  const list = await get(`${P()}/pull-requests?changePackageId=${chg.id}`);
  assert.equal(list.status, 200);
  assert.equal((await list.json()).data.length, 1);
});

test('A4 PR 状态轮询：外部 merged 经 sync 进入登记', async () => {
  const req = await mkReq('A4 需求');
  const chg = await mkChg(req.id);
  const binding = await mkBinding(adminSecret, project.id, { remoteUrl: 'local://a4' });
  await post(`${P()}/change-packages/${chg.id}/branch`, { repoBindingId: binding.id });
  const pr = await post(`${P()}/change-packages/${chg.id}/pull-request`, { repoBindingId: binding.id });
  const prId = (await pr.json()).data.pull_request.id;
  const prNumber = (await dstore.getPullRequest(tenant.id, prId)).number;

  // 无外部变化 → changed=false
  const s1 = await post(`${P()}/pull-requests/${prId}/sync`, {});
  assert.equal(s1.status, 200);
  const s1b = (await s1.json()).data;
  assert.equal(s1b.changed, false);
  assert.equal(s1b.pull_request.status, 'draft');

  // 模拟外部事件：人工在远端合入
  const brow = await dstore.getRepoBinding(tenant.id, binding.id);
  const client = createRepoClient({ binding: brow, token: null });
  client._testHook.setPullExternal(prNumber, { merged: true, state: 'closed' });

  const s2 = await post(`${P()}/pull-requests/${prId}/sync`, {});
  assert.equal(s2.status, 200);
  const s2b = (await s2.json()).data;
  assert.equal(s2b.changed, true);
  assert.equal(s2b.pull_request.status, 'merged');

  // 终态后 sync 不再变化
  const s3 = await post(`${P()}/pull-requests/${prId}/sync`, {});
  assert.equal((await s3.json()).data.changed, false);
});

// ---------- B. 本地 git hybrid（真实 bare repo） ----------
function makeBareRepoWithCommit() {
  const dir = mkdtempSync(join(tmpdir(), 'deyi-git-'));
  const bare = join(dir, 'repo.git');
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--bare', '-q', bare]);
  const w = join(dir, 'w');
  execFileSync('git', ['clone', '-q', bare, w]);
  execFileSync('git', ['-C', w, 'config', 'user.email', 't@t.t']);
  execFileSync('git', ['-C', w, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', w, 'checkout', '-qb', 'main']);
  writeFileSync(join(w, 'f.txt'), 'hi\n');
  execFileSync('git', ['-C', w, 'add', '.']);
  execFileSync('git', ['-C', w, 'commit', '-qm', 'init commit']);
  execFileSync('git', ['-C', w, 'push', '-q', 'origin', 'main']);
  const sha = execFileSync('git', ['--git-dir', bare, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { dir, bare, sha };
}

test('B 本地 git：真实 bare repo 采集/建分支全链路', async () => {
  const { bare, sha } = makeBareRepoWithCommit();
  const req = await mkReq('B 需求');
  const chg = await mkChg(req.id);
  const binding = await mkBinding(adminSecret, project.id,
    { remoteUrl: bare, defaultBranch: 'main' });

  await startPipe(chg.id);
  const factsRunId = (await (await get(`${P()}/change-packages/${chg.id}/pipeline`)).json())
    .data.stages.find((s) => s.stage === 'facts').run_id;
  const c = await post(`${P()}/repo-snapshots/collect`, { repoBindingId: binding.id, pipelineRunId: factsRunId });
  assert.equal(c.status, 201);
  const snp = (await c.json()).data.snapshot;
  assert.equal(snp.baseline_commit, sha, '基线应为真实 commit sha');
  assert.equal(snp.environment.recent_commits[0].sha, sha);
  assert.equal(snp.environment.recent_commits[0].message, 'init commit');
  assert.ok(snp.environment.branches.some((b) => b.name === 'main' && b.sha === sha));

  const b = await post(`${P()}/change-packages/${chg.id}/branch`, { repoBindingId: binding.id });
  assert.equal(b.status, 201);
  const bb = (await b.json()).data;
  assert.equal(bb.branch, `dy/${chg.id}`);
  assert.equal(bb.simulated, true); // PR/分支走本地 git 仍标记 simulated（无真 forge）
  // 真实验证：分支确已写入 bare repo
  const real = execFileSync('git', ['--git-dir', bare, 'rev-parse', '--verify', `refs/heads/dy/${chg.id}`],
    { encoding: 'utf8' }).trim();
  assert.equal(real, sha);

  const pr = await post(`${P()}/change-packages/${chg.id}/pull-request`, { repoBindingId: binding.id });
  assert.equal(pr.status, 201);
  assert.equal((await pr.json()).data.pull_request.status, 'draft');
});

// ---------- C. draft 强制 ----------
test('C draft 强制：适配器层拒绝非 draft；登记层拒绝非 draft 状态', async () => {
  const binding = await dstore.getRepoBinding(tenant.id,
    (await mkBinding(adminSecret, project.id, { remoteUrl: 'local://c1' })).id);
  const client = createRepoClient({ binding, token: null });

  await assert.rejects(
    () => client.createDraftPull({ head: 'dy/x', base: 'main', title: 't', draft: false }),
    (e) => e.details?.code === 'DRAFT_REQUIRED',
  );
  await assert.rejects(
    () => client.createDraftPull({ head: 'dy/x', base: 'main', title: 't' }),
    (e) => e.details?.code === 'DRAFT_REQUIRED',
  );
  // 平台无 merge 方法（硬禁令）
  assert.equal(typeof client.merge, 'undefined');

  const req = await mkReq('C 需求');
  const chg = await mkChg(req.id);
  await assert.rejects(
    () => dstore.createPullRequest({
      tenantId: tenant.id, projectId: project.id, changePackageId: chg.id,
      repoBindingId: binding.id, provider: 'local', status: 'open',
    }),
    (e) => e.details?.code === 'DRAFT_REQUIRED',
  );
});

// ---------- D. 无 merge 端点 ----------
test('D 无 merge 端点：路由表无 merge，假想 merge URL 全部 404', async () => {
  const req = await mkReq('D 需求');
  const chg = await mkChg(req.id);
  const binding = await mkBinding(adminSecret, project.id, { remoteUrl: 'local://d1' });
  await post(`${P()}/change-packages/${chg.id}/branch`, { repoBindingId: binding.id });
  const pr = await post(`${P()}/change-packages/${chg.id}/pull-request`, { repoBindingId: binding.id });
  const prId = (await pr.json()).data.pull_request.id;

  for (const url of [
    `${P()}/pull-requests/${prId}/merge`,
    `${P()}/change-packages/${chg.id}/merge`,
    `${P()}/pull-requests/merge`,
  ]) {
    const r = await post(url, {});
    assert.equal(r.status, 404, `${url} 不应存在`);
  }

  // 源码级断言：所有 R('...') 路由路径都不含 merge
  const src = readFileSync(new URL('../src/modules/delivery/routes.mjs', import.meta.url), 'utf8');
  const paths = [...src.matchAll(/R\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(paths.length > 10, '应能解析出路由表');
  const bad = paths.filter((p) => p.toLowerCase().includes('merge'));
  assert.deepEqual(bad, [], `路由表不应含 merge: ${bad.join(',')}`);
});

// ---------- E. 凭证不进日志/错误/快照/审计 ----------
test('E 凭证隔离：错误路径/快照/审计 payload 绝不带 token', async () => {
  const TOKEN = 'tok-live-secret-xyz-999';
  process.env.VAULT_GITEA_TEST_TOKEN = TOKEN;
  try {
    const req = await mkReq('E 需求');
    const chg = await mkChg(req.id);
    const binding = await mkBinding(adminSecret, project.id,
      { remoteUrl: 'local://e1', credentialRef: 'gitea-test-token' });

    // 错误路径：base 分支不存在 → 4xx，错误 JSON 不含 token
    const bad = await post(`${P()}/change-packages/${chg.id}/branch`,
      { repoBindingId: binding.id, baseBranch: 'no-such-branch-xyz' });
    assert.ok(bad.status >= 400 && bad.status < 500);
    const badText = JSON.stringify(await bad.json());
    assert.ok(!badText.includes(TOKEN), '错误响应不得含 token');

    // 成功路径：快照 environment 不含 token
    await startPipe(chg.id);
    const factsRunId = (await (await get(`${P()}/change-packages/${chg.id}/pipeline`)).json())
      .data.stages.find((s) => s.stage === 'facts').run_id;
    const c = await post(`${P()}/repo-snapshots/collect`, { repoBindingId: binding.id, pipelineRunId: factsRunId });
    assert.equal(c.status, 201);
    const snapText = JSON.stringify((await c.json()).data.snapshot);
    assert.ok(!snapText.includes(TOKEN), '快照 JSON 不得含 token');

    // 审计 payload 不含 token
    const rows = await db().query(
      `SELECT payload FROM audit_events WHERE tenant_id=? AND action='repo.snapshot.collect' ORDER BY seq DESC LIMIT 5`,
      [tenant.id]);
    assert.ok(rows.length > 0);
    for (const r of rows) assert.ok(!String(r.payload).includes(TOKEN), '审计 payload 不得含 token');

    // vault 未解析 → fail-closed（400，不降级匿名）
    const b2 = await mkBinding(adminSecret, project.id,
      { remoteUrl: 'local://e2', credentialRef: 'gitea-missing-ref' });
    const chg2 = await mkChg((await mkReq('E2 需求')).id);
    await startPipe(chg2.id);
    const fr2 = (await (await get(`${P()}/change-packages/${chg2.id}/pipeline`)).json())
      .data.stages.find((s) => s.stage === 'facts').run_id;
    const c2 = await post(`${P()}/repo-snapshots/collect`, { repoBindingId: b2.id, pipelineRunId: fr2 });
    assert.equal(c2.status, 400);
    assert.equal((await c2.json()).error.details.code, 'VAULT_UNRESOLVED');
  } finally {
    delete process.env.VAULT_GITEA_TEST_TOKEN;
  }
});

// ---------- F. 跨租户隔离 ----------
test('F 跨租户：B 触碰 A 的绑定/变更包/PR 全部 404，自己项目内为空', async () => {
  const req = await mkReq('F 需求');
  const chg = await mkChg(req.id);
  const binding = await mkBinding(adminSecret, project.id, { remoteUrl: 'local://f1' });
  await post(`${P()}/change-packages/${chg.id}/branch`, { repoBindingId: binding.id });
  const pr = await post(`${P()}/change-packages/${chg.id}/pull-request`, { repoBindingId: binding.id });
  const prId = (await pr.json()).data.pull_request.id;

  // B 建自己的流水线，拿 A 的 binding 去采集 → 404
  const bReq = await post(`${PB()}/requirements`, { title: 'B 需求', kind: 'feature', scopeMd: 'x' }, bSecret);
  const bReqId = (await bReq.json()).data.id;
  const bChgR = await post(`${PB()}/change-packages`, { requirementId: bReqId }, bSecret);
  const bChgId = (await bChgR.json()).data.id;
  await startPipe(bChgId, bSecret, projectB.id);
  const bFacts = (await (await get(`${PB()}/change-packages/${bChgId}/pipeline`, bSecret)).json())
    .data.stages.find((s) => s.stage === 'facts').run_id;
  const c = await post(`${PB()}/repo-snapshots/collect`,
    { repoBindingId: binding.id, pipelineRunId: bFacts }, bSecret);
  assert.equal(c.status, 404);

  // B 在 A 的变更包上建分支 → 404
  const b2 = await post(`${PB()}/change-packages/${chg.id}/branch`, {}, bSecret);
  assert.equal(b2.status, 404);

  // B 读 A 的 PR → 404；B 自己的 PR 列表为空
  const g = await get(`${PB()}/pull-requests/${prId}`, bSecret);
  assert.equal(g.status, 404);
  const l = await get(`${PB()}/pull-requests`, bSecret);
  assert.deepEqual((await l.json()).data, []);
});

// ---------- G. 分支名注入防御 ----------
test('G 分支名白名单：注入串被拒，合法通过', () => {
  assert.equal(sanitizeBranchName('dy/chg_abc123'), 'dy/chg_abc123');
  assert.equal(sanitizeBranchName('main'), 'main');
  for (const evil of ['dy/../../etc', 'dy/chg_;rm -rf', 'dy/chg_@{1}', '/abs', 'dy/', 'dy//x', '-rf',
    'dy/chg_..\\win', 'x'.repeat(300)]) {
    assert.throws(() => sanitizeBranchName(evil), /分支名非法/, `应拒绝: ${evil.slice(0, 20)}`);
  }
  // 平台分支名由 chg_id 派生：非法 id 直接抛错，不会拼出危险分支
  assert.throws(() => controlledBranchName('chg_../../../etc'), /非法/);
});

// ---------- H. PR 状态机 ----------
test('H PR 状态机：非法跃迁被拒；平台层无法直接写 merged', async () => {
  const req = await mkReq('H 需求');
  const chg = await mkChg(req.id);
  const binding = await mkBinding(adminSecret, project.id, { remoteUrl: 'local://h1' });
  await post(`${P()}/change-packages/${chg.id}/branch`, { repoBindingId: binding.id });
  const pr = await post(`${P()}/change-packages/${chg.id}/pull-request`, { repoBindingId: binding.id });
  const prId = (await pr.json()).data.pull_request.id;
  const brow = await dstore.getRepoBinding(tenant.id, binding.id);
  const client = createRepoClient({ binding: brow, token: null });
  const prNumber = (await dstore.getPullRequest(tenant.id, prId)).number;
  client._testHook.setPullExternal(prNumber, { merged: true, state: 'closed' });
  await post(`${P()}/pull-requests/${prId}/sync`, {});

  // merged → draft 非法
  await assert.rejects(
    () => dstore.setPullRequestStatus(tenant.id, prId, 'draft'),
    (e) => e.details?.code === 'INVALID_TRANSITION',
  );
  // 同状态同步是幂等 no-op
  const same = await dstore.setPullRequestStatus(tenant.id, prId, 'merged');
  assert.equal(same.status, 'merged');
});

// ---------- I. Pipeline Adapter（fake） ----------
test('I1 CI fake：trigger → 轮询推进 → 制品', async () => {
  const binding = await dstore.getRepoBinding(tenant.id,
    (await mkBinding(adminSecret, project.id, { remoteUrl: 'local://i1' })).id);
  const ci = createPipelineAdapter({ provider: 'gitea-actions', binding, token: null });

  const run = await ci.triggerRun({ kind: 'test', ref: 'main', changePackageId: 'chg_x' });
  assertRunShape(run);
  assert.equal(run.status, 'queued');
  assert.equal(run.simulated, true);
  assert.match(run.id, /^cir_/);

  const r2 = await ci.getRunStatus(run.id);
  assert.equal(r2.status, 'running');
  const r3 = await ci.getRunStatus(run.id);
  assert.equal(r3.status, 'passed');
  assert.ok(r3.finishedAt);

  const arts = await ci.listArtifacts(run.id);
  assert.equal(arts.length, 1);
  assert.equal(arts[0].kind, 'test_report');
  assert.equal(arts[0].simulated, true);

  await assert.rejects(() => ci.triggerRun({ kind: 'deploy', ref: 'main' }), /CI kind 非法/);
  await assert.rejects(() => ci.triggerRun({ kind: 'build', ref: '' }), /ref.*必填/);
  await assert.rejects(() => ci.getRunStatus('cir_nonexistent'), /不存在/);
});

test('I2 CI fake：失败路径制品为空（_testHook 模拟外部 CI 失败）', async () => {
  const binding = await dstore.getRepoBinding(tenant.id,
    (await mkBinding(adminSecret, project.id, { remoteUrl: 'local://i2' })).id);
  const ci = createPipelineAdapter({ provider: 'gitea-actions', binding, token: null });
  const run = await ci.triggerRun({ kind: 'scan', ref: 'main' });
  ci._testHook.setRunStatus(run.id, 'failed');
  const r = await ci.getRunStatus(run.id);
  assert.equal(r.status, 'failed');
  assert.deepEqual(await ci.listArtifacts(run.id), []);
});

test('I3 CI 工厂：未知 provider 拒绝；gitlab/jenkins 为扩展点 stub', async () => {
  const binding = await dstore.getRepoBinding(tenant.id,
    (await mkBinding(adminSecret, project.id, { remoteUrl: 'local://i3' })).id);
  assert.throws(
    () => createPipelineAdapter({ provider: 'tekton', binding, token: null }),
    (e) => e.details?.code === 'UNKNOWN_CI_PROVIDER',
  );
  // 扩展点 stub：工厂创建时即明确失败（fail-fast），不伪装可用
  assert.throws(
    () => createPipelineAdapter({ provider: 'gitlab', binding, token: null }),
    (e) => e.details?.code === 'ADAPTER_NOT_IMPLEMENTED',
  );
  assert.throws(
    () => createPipelineAdapter({ provider: 'jenkins', binding, token: null }),
    (e) => e.details?.code === 'ADAPTER_NOT_IMPLEMENTED',
  );

  assert.equal(getPipelineAdapterStatus(), 'gitea-actions(fake/fallback)');
  assert.equal(getRepoAdapterStatus(), 'fake(fallback)');
});

// ---------- J. 快照 kind 区分 ----------
test('J 事实快照 kind：手动登记=manual，仓库采集=snapshot', async () => {
  const req = await mkReq('J 需求');
  const chg = await mkChg(req.id);
  const binding = await mkBinding(adminSecret, project.id, { remoteUrl: 'local://j1' });
  await startPipe(chg.id);
  const factsRunId = (await (await get(`${P()}/change-packages/${chg.id}/pipeline`)).json())
    .data.stages.find((s) => s.stage === 'facts').run_id;

  // 手动登记
  const m = await post(`${P()}/pipeline-runs/${factsRunId}/fact-snapshot`,
    { baselineCommit: 'abc123', environment: {}, dependencies: {}, unknownItems: [] });
  assert.equal(m.status, 201);
  assert.equal((await m.json()).data.kind, 'manual');

  // 仓库采集覆盖 → kind 变为 snapshot
  const c = await post(`${P()}/repo-snapshots/collect`, { repoBindingId: binding.id, pipelineRunId: factsRunId });
  assert.equal(c.status, 201);
  assert.equal((await c.json()).data.snapshot.kind, 'snapshot');
});

// ---------- K. review 修复回归 ----------
test('K1 remote_url 内嵌凭据被拒（密钥铁律）', async () => {
  const r = await post(`${P()}/repo-bindings`,
    { provider: 'gitea', remoteUrl: 'https://bot:s3cr3t@gitea.example.com/o/r.git', defaultBranch: 'main' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.details.code, 'PLAINTEXT_SECRET');

  // 无凭据的正常 URL 放行
  const ok = await post(`${P()}/repo-bindings`,
    { provider: 'gitea', remoteUrl: 'https://gitea.example.com/o/r.git', defaultBranch: 'main' });
  assert.equal(ok.status, 201);
});

test('K2 PR 并发双建：唯一索引兜底，回读胜者', async () => {
  const req = await mkReq('K2 需求');
  const chg = await mkChg(req.id);
  const binding = await mkBinding(adminSecret, project.id, { remoteUrl: 'local://k2' });
  await post(`${P()}/change-packages/${chg.id}/branch`, { repoBindingId: binding.id });

  const repoSvc = await import('../src/modules/delivery/repo.mjs');
  const act = await store.createActor(tenant.id, { kind: 'user', name: 'K2 Actor' });
  const [a, b] = await Promise.all([
    repoSvc.createDraftPullRequest({ tenantId: tenant.id, projectId: project.id, actorId: act.id, changePackageId: chg.id, repoBindingId: binding.id }),
    repoSvc.createDraftPullRequest({ tenantId: tenant.id, projectId: project.id, actorId: act.id, changePackageId: chg.id, repoBindingId: binding.id }),
  ]);
  assert.equal(a.pull_request.id, b.pull_request.id, '并发双建应收敛到同一 PR 登记');
  assert.ok(a.existed || b.existed, '至少一方走幂等/回读路径');
  const rows = await dstore.listPullRequests(tenant.id, project.id, { changePackageId: chg.id });
  assert.equal(rows.filter((r) => ['draft', 'open'].includes(r.status)).length, 1);
});
