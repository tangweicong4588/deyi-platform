/** delivery 测试：V1.0-A 交付域模型 —— 状态机 / 验收门禁 / 密钥铁律 / 鉴权 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-del-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.DEV_IDP_SECRET = 'test-dev-secret';
process.env.BOOTSTRAP_ENABLED = 'false';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerDeliveryRoutes } = await import('../src/modules/delivery/routes.mjs');
const { decide } = await import('../src/modules/policy/index.mjs');

let tenant, project, otherProject, adminSecret, viewerSecret, otherSecret;
before(async () => {
  await openDb();
  await migrate(db());
  tenant = await store.createTenant({ name: 'DEL Tenant' });
  project = await store.createProject(tenant.id, { name: 'DEL Project' });
  otherProject = await store.createProject(tenant.id, { name: 'DEL Other' });

  const admin = await store.createActor(tenant.id, { kind: 'user', name: 'DEL Admin' });
  await store.bindRole(tenant.id, admin.id, null, 'admin');
  const ak = mintKey();
  await store.createApiKeyRow({ tenantId: tenant.id, actorId: admin.id, name: 'del-admin', prefix: ak.prefix, keyHash: ak.keyHash });
  adminSecret = ak.secret;

  const viewer = await store.createActor(tenant.id, { kind: 'user', name: 'DEL Viewer' });
  await store.bindRole(tenant.id, viewer.id, project.id, 'viewer');
  const vk = mintKey();
  await store.createApiKeyRow({ tenantId: tenant.id, actorId: viewer.id, name: 'del-viewer', prefix: vk.prefix, keyHash: vk.keyHash });
  viewerSecret = vk.secret;

  const t2 = await store.createTenant({ name: 'DEL Tenant B' });
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

test('创建需求：默认 draft', async () => {
  const r = await post(`${D(project.id)}/requirements`, { title: '登录支持 SSO', kind: 'feature' });
  assert.equal(r.status, 201);
  const { data } = await r.json();
  assert.equal(data.status, 'draft');
  assert.ok(data.id.startsWith('req_'));
});

test('非法跃迁：draft 直接 done → 400', async () => {
  const c = await post(`${D(project.id)}/requirements`, { title: '非法跃迁测试' });
  const { data } = await c.json();
  const r = await patch(`${D(project.id)}/requirements/${data.id}`, { status: 'done' });
  assert.equal(r.status, 400);
});

test('需求全链路：draft→clarifying→ready→in_progress→verifying→done', async () => {
  const c = await post(`${D(project.id)}/requirements`, { title: '全链路需求' });
  const req = (await c.json()).data;
  for (const s of ['clarifying', 'ready', 'in_progress']) {
    const r = await patch(`${D(project.id)}/requirements/${req.id}`, { status: s });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).data.status, s);
  }
  // 无 AC 时不能进 verifying
  const blocked = await patch(`${D(project.id)}/requirements/${req.id}`, { status: 'verifying' });
  assert.equal(blocked.status, 400);

  // 加两条 AC：一条通过，一条豁免
  const a1 = await post(`${D(project.id)}/requirements/${req.id}/acceptance-criteria`,
    { givenMd: '已登录', whenMd: '点击 SSO', thenMd: '跳转 IdP', kind: 'auto' });
  assert.equal(a1.status, 201);
  const ac1 = (await a1.json()).data;
  const a2 = await post(`${D(project.id)}/requirements/${req.id}/acceptance-criteria`,
    { thenMd: '手动复核通过', kind: 'manual' });
  const ac2 = (await a2.json()).data;

  // AC 非法跃迁：pending→passed 后不能直接 failed
  const p1 = await patch(`${D(project.id)}/requirements/${req.id}/acceptance-criteria/${ac1.id}`, { status: 'passed' });
  assert.equal(p1.status, 200);
  const bad = await patch(`${D(project.id)}/requirements/${req.id}/acceptance-criteria/${ac1.id}`, { status: 'failed' });
  assert.equal(bad.status, 400);

  // M-2 业务 review：AC 直接 waive 不再允许——必须先有已批准的门禁例外
  const w2 = await patch(`${D(project.id)}/requirements/${req.id}/acceptance-criteria/${ac2.id}`, { status: 'waived' });
  assert.equal(w2.status, 400);
  assert.equal((await w2.json()).error.details.code, 'WAIVER_APPROVAL_REQUIRED');

  // 本用例走通过路径：ac2 直接 passed（豁免的审批流见 pipeline 测试）
  const p2 = await patch(`${D(project.id)}/requirements/${req.id}/acceptance-criteria/${ac2.id}`, { status: 'passed' });
  assert.equal(p2.status, 200);

  // 全部通过/豁免后可进 verifying
  const v = await patch(`${D(project.id)}/requirements/${req.id}`, { status: 'verifying' });
  assert.equal(v.status, 200);
  const d = await patch(`${D(project.id)}/requirements/${req.id}`, { status: 'done' });
  assert.equal(d.status, 200);
  assert.equal((await d.json()).data.status, 'done');
});

test('AC then 必填', async () => {
  const c = await post(`${D(project.id)}/requirements`, { title: 'AC 校验' });
  const req = (await c.json()).data;
  const r = await post(`${D(project.id)}/requirements/${req.id}/acceptance-criteria`, { givenMd: 'x' });
  assert.equal(r.status, 400);
});

test('仓库绑定：明文凭据字段被拒，只存引用', async () => {
  const bad = await post(`${D(project.id)}/repo-bindings`, {
    provider: 'gitea', remoteUrl: 'https://git.example.com/a/b.git', password: 's3cret',
  });
  assert.equal(bad.status, 400);
  const ok = await post(`${D(project.id)}/repo-bindings`, {
    provider: 'gitea', remoteUrl: 'https://git.example.com/a/b.git', credentialRef: 'vault://gitea-main',
  });
  assert.equal(ok.status, 201);
  const { data } = await ok.json();
  assert.equal(data.credential_ref, 'vault://gitea-main');

  // DB 表结构里没有明文字段
  const cols = await db().query(`PRAGMA table_info(repo_bindings)`);
  const names = cols.map((c) => c.name).join(',');
  assert.ok(!/(password|secret|token)/i.test(names), `表结构含可疑列: ${names}`);
  // 行数据里也没有明文
  const row = (await db().query('SELECT * FROM repo_bindings WHERE id=?', [data.id]))[0];
  assert.ok(!JSON.stringify(row).includes('s3cret'));

  // 绑定可禁用
  const dis = await patch(`${D(project.id)}/repo-bindings/${data.id}`, { status: 'disabled' });
  assert.equal(dis.status, 200);
  assert.equal((await dis.json()).data.status, 'disabled');
});

test('变更包状态机：跳阶段被拒', async () => {
  const c = await post(`${D(project.id)}/requirements`, { title: '变更包需求' });
  const req = (await c.json()).data;
  const p = await post(`${D(project.id)}/change-packages`, { requirementId: req.id, branch: 'feat/x' });
  assert.equal(p.status, 201);
  const chg = (await p.json()).data;
  const skip = await patch(`${D(project.id)}/change-packages/${chg.id}`, { status: 'verifying' });
  assert.equal(skip.status, 400);
  for (const s of ['building', 'verifying', 'ready_for_review', 'handed_over']) {
    const r = await patch(`${D(project.id)}/change-packages/${chg.id}`, { status: s });
    assert.equal(r.status, 200);
  }
});

test('产物登记：缺 hash / 坏 hash 被拒', async () => {
  const c = await post(`${D(project.id)}/requirements`, { title: '产物需求' });
  const req = (await c.json()).data;
  const p = await post(`${D(project.id)}/change-packages`, { requirementId: req.id, branch: 'feat/y' });
  const chg = (await p.json()).data;
  const noHash = await post(`${D(project.id)}/change-packages/${chg.id}/artifacts`, { kind: 'diff' });
  assert.equal(noHash.status, 400);
  const badHash = await post(`${D(project.id)}/change-packages/${chg.id}/artifacts`, { kind: 'diff', contentHash: 'xyz' });
  assert.equal(badHash.status, 400);
  const ok = await post(`${D(project.id)}/change-packages/${chg.id}/artifacts`,
    { kind: 'test_report', contentHash: HASH, uri: 's3://x/report.json' });
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).data.content_hash, HASH);
});

test('流水线运行（静态模型）：pending→running→gated→passed，门禁结论落盘', async () => {
  const p = await post(`${D(project.id)}/pipeline-runs`, { stage: 'develop' });
  assert.equal(p.status, 201);
  const run = (await p.json()).data;
  assert.equal(run.status, 'pending');
  const r1 = await patch(`${D(project.id)}/pipeline-runs/${run.id}`, { status: 'running' });
  assert.equal(r1.status, 200);
  const r2 = await patch(`${D(project.id)}/pipeline-runs/${run.id}`, {
    status: 'gated', gateDecision: { passed: false, reason: '事实缺失' },
  });
  assert.equal(r2.status, 200);
  assert.deepEqual((await r2.json()).data.gate_decision, { passed: false, reason: '事实缺失' });
  const r3 = await patch(`${D(project.id)}/pipeline-runs/${run.id}`, { status: 'passed' });
  assert.equal(r3.status, 200);
});

test('viewer 可读不可写', async () => {
  const w = await post(`${D(project.id)}/requirements`, { title: 'viewer 写' }, viewerSecret);
  assert.equal(w.status, 403);
  const r = await get(`${D(project.id)}/requirements`, viewerSecret);
  assert.equal(r.status, 200);
});

test('跨租户 403', async () => {
  const r = await get(`${D(project.id)}/requirements`, otherSecret);
  assert.equal(r.status, 403);
});

test('跨项目 ID 枚举 → 404（不泄露）', async () => {
  const c = await post(`${D(project.id)}/requirements`, { title: '项目A需求' });
  const req = (await c.json()).data;
  const r = await get(`${D(otherProject.id)}/requirements/${req.id}`);
  assert.equal(r.status, 404);
});

test('未认证 401', async () => {
  const r = await fetch(`${D(project.id)}/requirements`);
  assert.equal(r.status, 401);
});

test('策略：delivery.read viewer 放行，delivery.write viewer 拒绝', async () => {
  const baseInput = {
    actor: { id: 'usr_v', kind: 'user', status: 'active', roles: [{ project_id: 'prj_1', role: 'viewer' }] },
    tenant: { id: 'ten_1', status: 'active' },
    project: { id: 'prj_1' },
  };
  const r1 = await decide({ ...baseInput, action: 'delivery.read' });
  assert.equal(r1.allow, true);
  const r2 = await decide({ ...baseInput, action: 'delivery.write' });
  assert.equal(r2.allow, false);
  const r3 = await decide({
    ...baseInput,
    actor: { ...baseInput.actor, roles: [{ project_id: 'prj_1', role: 'operator' }] },
    action: 'delivery.write',
  });
  assert.equal(r3.allow, true);
});
