/** V3.2 多环境发布与部署策略：环境/发布单/审批SoD/金丝雀走完/回滚/Runner 接线/隔离/审计 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-rel-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.DEV_IDP_SECRET = 'dev-idp-secret-for-tests-only-32b!!';
process.env.BOOTSTRAP_ENABLED = 'false';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const audit = await import('../src/modules/evidence/audit.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerReleaseRoutes } = await import('../src/modules/release/routes.mjs');

let tenant, project, adminSecret, adminId, admin2Secret, viewerSecret, otherSecret, otherProjectId;
let base, appServer;
before(async () => {
  await openDb();
  await migrate(db());
  await audit.initEvidence();
  tenant = await store.createTenant({ name: 'REL Tenant' });
  project = await store.createProject(tenant.id, { name: 'REL Project' });

  const mkActor = async (name, role, pid) => {
    const a = await store.createActor(tenant.id, { kind: 'user', name });
    await store.bindRole(tenant.id, a.id, pid === undefined ? null : pid, role);
    const k = mintKey();
    await store.createApiKeyRow({ tenantId: tenant.id, actorId: a.id, name, prefix: k.prefix, keyHash: k.keyHash });
    return { id: a.id, secret: k.secret };
  };
  const admin = await mkActor('REL Admin', 'admin');
  adminSecret = admin.secret; adminId = admin.id;
  const admin2 = await mkActor('REL Admin2', 'admin');
  admin2Secret = admin2.secret;
  const viewer = await mkActor('REL Viewer', 'viewer', project.id);
  viewerSecret = viewer.secret;

  const t2 = await store.createTenant({ name: 'REL Tenant B' });
  const p2 = await store.createProject(t2.id, { name: 'B Project' });
  otherProjectId = p2.id;
  const a2 = await store.createActor(t2.id, { kind: 'user', name: 'B Admin' });
  await store.bindRole(t2.id, a2.id, null, 'admin');
  const bk = mintKey();
  await store.createApiKeyRow({ tenantId: t2.id, actorId: a2.id, name: 'b-admin', prefix: bk.prefix, keyHash: bk.keyHash });
  otherSecret = bk.secret;

  // 注意：本仓库 before hook 并发执行，所有初始化必须在同一个 hook 内串行
  const app = createApp();
  registerIdentityRoutes(app);
  registerReleaseRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;
  const er = await post(`${E(project.id)}/ensure-defaults`, {});
  assert.equal(er.status, 200);
});
after(() => new Promise((r) => appServer.close(r)));

const R = (pid) => `${base}/v1/projects/${pid}/releases`;
const E = (pid) => `${base}/v1/projects/${pid}/deploy-environments`;
const P = () => R(project.id);
const post = (url, body, token = adminSecret) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const get = (url, token = adminSecret) =>
  fetch(url, { headers: { authorization: `Bearer ${token}` } });

async function mkRelease(over = {}, token = adminSecret) {
  const r = await post(P(), {
    environment_key: 'staging', version: 'v1.0.0',
    strategy: 'canary', strategy_config: { steps: [10, 50, 100] },
    ...over,
  }, token);
  assert.equal(r.status, 201);
  return (await r.json()).data;
}

test('V3.2：默认环境 dev/staging/prod 已就绪；重复 ensure 幂等', async () => {
  const envs = (await (await get(E(project.id))).json()).data;
  assert.deepEqual(envs.map((e) => e.key).sort(), ['dev', 'prod', 'staging']);
  const r = await post(`${E(project.id)}/ensure-defaults`, {});
  assert.equal(r.status, 200);
  assert.equal((await (await get(E(project.id))).json()).data.length, 3);
});

test('V3.2：非法策略配置 → 400（canary 非递增/末步非100；rolling batches 非法）', async () => {
  const bad1 = await post(P(), { environment_key: 'staging', version: 'v', strategy: 'canary', strategy_config: { steps: [50, 30, 100] } });
  assert.equal(bad1.status, 400);
  const bad2 = await post(P(), { environment_key: 'staging', version: 'v', strategy: 'canary', strategy_config: { steps: [50, 90] } });
  assert.equal(bad2.status, 400);
  const bad3 = await post(P(), { environment_key: 'staging', version: 'v', strategy: 'rolling', strategy_config: { batches: 1 } });
  assert.equal(bad3.status, 400);
  const bad4 = await post(P(), { environment_key: 'nope', version: 'v', strategy: 'canary', strategy_config: { steps: [50, 100] } });
  assert.equal(bad4.status, 404);
});

test('V3.2：prod 发布默认需审批——未审批启动 400；发起人自批 403；他人批准后可启动', async () => {
  const rel = await mkRelease({ environment_key: 'prod', version: 'v2.0.0' });
  assert.equal(rel.requires_approval, true);
  assert.equal(rel.status, 'draft');
  assert.equal((await post(`${P()}/${rel.id}/start`, { mode: 'simulated' })).status, 400);
  assert.equal((await post(`${P()}/${rel.id}/request-approval`, {})).status, 200);
  assert.equal((await post(`${P()}/${rel.id}/approve`, {}, adminSecret)).status, 403); // 自批 SoD
  const ap = await post(`${P()}/${rel.id}/approve`, { note: '评审通过' }, admin2Secret);
  assert.equal(ap.status, 200);
  assert.equal((await ap.json()).data.status, 'approved');
  const got = (await (await get(`${P()}/${rel.id}`)).json()).data;
  assert.equal(got.release.approval.decision, 'approved');
});

test('V3.2：staging 发布无需审批可直接启动', async () => {
  const rel = await mkRelease({ environment_key: 'staging', version: 'v1.1.0' });
  assert.equal(rel.requires_approval, false);
  assert.equal((await post(`${P()}/${rel.id}/request-approval`, {})).status, 400);
});

test('V3.2：金丝雀发布 simulated 全链走完——步骤按 [10,50,100] 生成，release succeeded', async () => {
  const rel = await mkRelease({ environment_key: 'staging', version: 'v1.2.0' });
  const r = await post(`${P()}/${rel.id}/start`, { mode: 'simulated' });
  assert.equal(r.status, 200);
  const { release, steps } = (await r.json()).data;
  assert.equal(release.status, 'succeeded');
  assert.equal(steps.length, 8); // 3×(deploy+health_check)+promote+verify
  assert.deepEqual(steps.map((s) => s.kind),
    ['deploy', 'health_check', 'deploy', 'health_check', 'deploy', 'health_check', 'promote', 'verify']);
  assert.deepEqual(steps.filter((s) => s.kind === 'deploy').map((s) => s.target.percentage), [10, 50, 100]);
  assert.ok(steps.every((s) => s.status === 'succeeded' && s.result.simulated === true));
});

test('V3.2：金丝雀中途失败 → 自动回滚 → rolled_back，回滚步骤可审计', async () => {
  const rel = await mkRelease({
    environment_key: 'staging', version: 'v1.3.0',
    strategy_config: { steps: [10, 50, 100], simulate_fail_at: [3] }, // 第3步=deploy 50% 失败
  });
  const r = await post(`${P()}/${rel.id}/start`, { mode: 'simulated' });
  assert.equal(r.status, 200);
  const { release, steps } = (await r.json()).data;
  assert.equal(release.status, 'rolled_back');
  assert.equal(steps[2].status, 'failed');
  // 失败后原计划剩余步骤标记 skipped，回滚步骤追加在末尾
  assert.ok(steps.slice(3, 8).every((s) => s.status === 'skipped'));
  const rbKinds = steps.slice(8).map((s) => s.kind);
  assert.deepEqual(rbKinds, ['rollback', 'verify']);
  assert.ok(steps.slice(8).every((s) => s.status === 'succeeded'));
  const ev = await db().query(
    `SELECT * FROM audit_events WHERE tenant_id=? AND action='release.rollback' AND resource_id=?`,
    [tenant.id, rel.id]);
  assert.equal(ev.length, 1);
  assert.equal(JSON.parse(ev[0].payload).trigger, 'auto');
});

test('V3.2：蓝绿发布走完——deploy green→health_check→promote 切流→verify', async () => {
  const rel = await mkRelease({ environment_key: 'staging', version: 'v2.1.0', strategy: 'blue_green', strategy_config: {} });
  const { release, steps } = (await (await post(`${P()}/${rel.id}/start`, { mode: 'simulated' })).json()).data;
  assert.equal(release.status, 'succeeded');
  assert.deepEqual(steps.map((s) => s.kind), ['deploy', 'health_check', 'promote', 'verify']);
  assert.equal(steps[2].target.to, 'green');
});

test('V3.2：滚动发布走完——batches=3 生成 7 步', async () => {
  const rel = await mkRelease({ environment_key: 'staging', version: 'v2.2.0', strategy: 'rolling', strategy_config: { batches: 3 } });
  const { release, steps } = (await (await post(`${P()}/${rel.id}/start`, { mode: 'simulated' })).json()).data;
  assert.equal(release.status, 'succeeded');
  assert.equal(steps.length, 7);
  assert.deepEqual(steps.filter((s) => s.kind === 'deploy').map((s) => s.target.batch), ['1/3', '2/3', '3/3']);
});

test('V3.2：runner 模式冒烟——真实执行部署命令，结果 simulated=false', async () => {
  const rel = await mkRelease({
    environment_key: 'dev', version: 'v9.9.9',
    strategy: 'blue_green', strategy_config: {},
    deploy: { commands: [{ argv: ['true'] }] },
    health_check: { commands: [{ argv: ['true'] }] },
  });
  const { release, steps } = (await (await post(`${P()}/${rel.id}/start`, { mode: 'runner' })).json()).data;
  assert.equal(release.status, 'succeeded');
  assert.ok(steps.every((s) => s.result.simulated === false));
  const deployStep = steps.find((s) => s.kind === 'deploy');
  assert.equal(deployStep.result.exit_code, 0);
});

test('V3.2：runner 模式部署命令失败 → failed 结果如实记录', async () => {
  const rel = await mkRelease({
    environment_key: 'dev', version: 'v9.9.8',
    strategy: 'blue_green', strategy_config: {},
    deploy: { commands: [{ argv: ['false'] }] },
  });
  const { release, steps } = (await (await post(`${P()}/${rel.id}/start`, { mode: 'runner' })).json()).data;
  // deploy 失败 → 自动回滚（回滚同样执行 deploy 命令也失败）→ failed
  assert.equal(release.status, 'failed');
  assert.equal(steps[0].status, 'failed');
  assert.equal(steps[0].result.simulated, false);
});

test('V3.2：手动回滚——succeeded 的发布可回滚到 rolled_back；重复回滚幂等', async () => {
  const rel = await mkRelease({ environment_key: 'staging', version: 'v3.0.0' });
  await post(`${P()}/${rel.id}/start`, { mode: 'simulated' });
  const r = await post(`${P()}/${rel.id}/rollback`, { mode: 'simulated' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).data.release.status, 'rolled_back');
  const r2 = await post(`${P()}/${rel.id}/rollback`, { mode: 'simulated' });
  assert.equal((await r2.json()).data.release.status, 'rolled_back');
});

test('V3.2：非法回滚——deploying/draft 状态不可手动回滚', async () => {
  const rel = await mkRelease({ environment_key: 'staging', version: 'v3.1.0' });
  assert.equal((await post(`${P()}/${rel.id}/rollback`, {})).status, 400);
});

test('V3.2：viewer 可读不可写；跨租户隔离', async () => {
  assert.equal((await get(P(), viewerSecret)).status, 200);
  assert.equal((await post(P(), { environment_key: 'staging', version: 'v', strategy: 'blue_green', strategy_config: {} }, viewerSecret)).status, 403);
  const rel = await mkRelease({ environment_key: 'staging', version: 'v4.0.0' });
  assert.equal((await get(`${P()}/${rel.id}`, otherSecret)).status, 403);
  const otherList = await get(R(otherProjectId), otherSecret);
  assert.equal(otherList.status, 200);
  assert.equal((await otherList.json()).data.length, 0);
});

test('V3.2：发布记录进审计链', async () => {
  const rel = await mkRelease({ environment_key: 'staging', version: 'v5.0.0' });
  await post(`${P()}/${rel.id}/start`, { mode: 'simulated' });
  const q = (action) => db().query(
    `SELECT * FROM audit_events WHERE tenant_id=? AND action=? AND resource_id=?`,
    [tenant.id, action, rel.id]);
  assert.equal((await q('release.create')).length, 1);
  assert.equal((await q('release.start')).length, 1);
  assert.equal((await q('release.succeeded')).length, 1);
  assert.ok((await q('release.step')).length >= 8);
});
