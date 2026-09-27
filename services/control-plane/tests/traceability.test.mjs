/** V3.4 全链路追溯测试：任一环节 ID 可查出需求→变更包→流水线→制品→发布全链 + 时间线 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-trace-')), 'test.db');
process.env.ARTIFACT_STORE_DIR = mkdtempSync(join(tmpdir(), 'deyi-trace-artifacts-'));
process.env.OPERATOR_TOKEN = 'op_test_token_artifact33';
process.env.DEV_IDP_SECRET = 'dev-secret-artifact33';
process.env.BOOTSTRAP_ENABLED = 'false';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const deliveryStore = await import('../src/modules/delivery/store.mjs');
const artStore = await import('../src/modules/artifacts/store.mjs');
const releaseMod = await import('../src/modules/release/release.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerTraceabilityRoutes } = await import('../src/modules/traceability/routes.mjs');

async function mkKey(tenantId, actorId, scopes = []) {
  const k = mintKey();
  await store.createApiKeyRow({ tenantId, projectId: null, actorId, name: 'k', prefix: k.prefix, keyHash: k.keyHash, scopes });
  return k.secret;
}

let tenantA, pA1, adminKeyA, viewerKeyA, noScopeKeyA, adminKeyB, pB1;
let req1, chg1, pipe1, pipe2, art1, pkg1, ver1, rel1, relOrphan, req2;
let base, appServer;

before(async () => {
  await openDb();
  await migrate(db());

  tenantA = await store.createTenant({ name: 'Trace Tenant A' });
  const adminA = await store.createActor(tenantA.id, { kind: 'user', name: 'Trace Admin A' });
  await store.bindRole(tenantA.id, adminA.id, null, 'admin');
  adminKeyA = await mkKey(tenantA.id, adminA.id);
  noScopeKeyA = await mkKey(tenantA.id, adminA.id, ['gateway.chat']); // 有 scope 但不含 trace.read

  const viewerA = await store.createActor(tenantA.id, { kind: 'user', name: 'Trace Viewer A' });
  pA1 = await store.createProject(tenantA.id, { name: 'Trace Project 1' });
  await store.bindRole(tenantA.id, viewerA.id, pA1.id, 'viewer');
  viewerKeyA = await mkKey(tenantA.id, viewerA.id);

  const tenantB = await store.createTenant({ name: 'Trace Tenant B' });
  const adminB = await store.createActor(tenantB.id, { kind: 'user', name: 'Trace Admin B' });
  await store.bindRole(tenantB.id, adminB.id, null, 'admin');
  adminKeyB = await mkKey(tenantB.id, adminB.id);
  pB1 = await store.createProject(tenantB.id, { name: 'Trace Project B1' });

  // —— 完整链：需求 → 变更包 → 流水线(2 阶段) → 制品(旧表+新版) → 发布(含步骤) ——
  req1 = await deliveryStore.createRequirement({ tenantId: tenantA.id, projectId: pA1.id, title: '追溯需求 R1', createdBy: adminA.id });
  chg1 = await deliveryStore.createChangePackage({
    tenantId: tenantA.id, projectId: pA1.id, requirementId: req1.id, branch: 'feat/trace-r1', createdBy: adminA.id,
  });
  pipe1 = await deliveryStore.createPipelineRun({ tenantId: tenantA.id, projectId: pA1.id, changePackageId: chg1.id, stage: 'develop' });
  await deliveryStore.setPipelineRun(tenantA.id, pipe1.id, { status: 'passed', startedAt: Date.now() - 9000, finishedAt: Date.now() - 8000 });
  pipe2 = await deliveryStore.createPipelineRun({ tenantId: tenantA.id, projectId: pA1.id, changePackageId: chg1.id, stage: 'handover' });
  await deliveryStore.setPipelineRun(tenantA.id, pipe2.id, { status: 'passed', startedAt: Date.now() - 7000, finishedAt: Date.now() - 6000 });
  art1 = await deliveryStore.createArtifact({
    tenantId: tenantA.id, changePackageId: chg1.id, kind: 'image_manifest',
    contentHash: 'a'.repeat(64), uri: 'registry.example.com/app:1.0',
  });
  pkg1 = await artStore.createPackage({ tenantId: tenantA.id, projectId: pA1.id, name: 'app-image', kind: 'image', createdBy: adminA.id });
  ver1 = await artStore.createVersion({
    tenantId: tenantA.id, packageId: pkg1.id, version: '1.0.0', filename: 'app.tar',
    createdBy: adminA.id, buffer: Buffer.from('fake-image-bytes'),
  });
  await artStore.addLink({ tenantId: tenantA.id, packageId: pkg1.id, versionOrId: ver1.id, linkKind: 'change_package', linkId: chg1.id, createdBy: adminA.id });
  await releaseMod.ensureDefaultEnvironments(tenantA.id, pA1.id, adminA.id);
  rel1 = await releaseMod.createRelease({
    tenantId: tenantA.id, projectId: pA1.id, actorId: adminA.id,
    body: { environment_key: 'staging', version: '1.0.0', strategy: 'rolling', strategy_config: { batches: 2 }, change_package_id: chg1.id },
  });
  await releaseMod.startRelease({ tenantId: tenantA.id, projectId: pA1.id, actorId: adminA.id, releaseId: rel1.id, mode: 'simulated' });

  // —— 游离实体：无变更包的发布单；无变更包的需求 ——
  relOrphan = await releaseMod.createRelease({
    tenantId: tenantA.id, projectId: pA1.id, actorId: adminA.id,
    body: { environment_key: 'dev', version: '0.0.1', strategy: 'rolling', strategy_config: { batches: 2 } },
  });
  req2 = await deliveryStore.createRequirement({ tenantId: tenantA.id, projectId: pA1.id, title: '孤儿需求 R2', createdBy: adminA.id });

  const app = createApp();
  registerIdentityRoutes(app);
  registerTraceabilityRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;
});
after(async () => { await appServer?.close(); });

const get = (key, qs) => fetch(`${base}/v1/projects/${pA1.id}/trace${qs}`, {
  headers: key ? { Authorization: `Bearer ${key}` } : {},
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

test('seed=requirement：一条 trace 查到底，时间线有序覆盖六环节', async () => {
  const { status, body } = await get(adminKeyA, `?seed_kind=requirement&seed_id=${req1.id}`);
  assert.equal(status, 200);
  assert.equal(body.data.seed.kind, 'requirement');
  assert.equal(body.data.chains.length, 1);
  const c = body.data.chains[0];
  assert.equal(c.requirement.id, req1.id);
  assert.equal(c.change_package.id, chg1.id);
  assert.equal(c.change_package.branch, 'feat/trace-r1');
  assert.equal(c.pipeline_runs.length, 2);
  assert.equal(c.artifacts.length, 1);
  assert.equal(c.artifacts[0].id, art1.id);
  assert.equal(c.artifact_versions.length, 1);
  assert.equal(c.artifact_versions[0].id, ver1.id);
  assert.equal(c.releases.length, 1);
  assert.equal(c.releases[0].id, rel1.id);
  assert.ok(c.releases[0].steps.length > 0, '发布步骤应随链返回');
  // 时间线：单调非递减，且覆盖六个环节
  const tl = c.timeline;
  assert.ok(tl.length >= 8, `时间线应有足够事件，实际 ${tl.length}`);
  for (let i = 1; i < tl.length; i++) assert.ok(tl[i].ts >= tl[i - 1].ts, '时间线必须按时间排序');
  const nodes = new Set(tl.map((e) => e.node));
  for (const n of ['requirement', 'change_package', 'pipeline_run', 'artifact', 'artifact_version', 'release']) {
    assert.ok(nodes.has(n), `时间线缺环节 ${n}`);
  }
  assert.equal(tl[0].ts, Math.min(...tl.map((e) => e.ts)), '首事件应为最早时间戳');
  const reqEv = tl.find((e) => e.node === 'requirement' && e.kind === 'created');
  assert.ok(reqEv && reqEv.ts === c.requirement.created_at, '需求创建事件应携带需求创建时间');
});

test('各环节 seed 都能解析到同一条链', async () => {
  const seeds = [
    ['change_package', chg1.id],
    ['pipeline_run', pipe1.id],
    ['artifact', art1.id],
    ['artifact_package', pkg1.id],
    ['artifact_version', ver1.id],
    ['release', rel1.id],
  ];
  for (const [kind, id] of seeds) {
    const { status, body } = await get(adminKeyA, `?seed_kind=${kind}&seed_id=${encodeURIComponent(id)}`);
    assert.equal(status, 200, `seed ${kind} 应 200`);
    assert.equal(body.data.chains.length, 1, `seed ${kind} 应解析出 1 条链`);
    assert.equal(body.data.chains[0].change_package.id, chg1.id, `seed ${kind} 应定位到变更包 ${chg1.id}`);
  }
});

test('游离发布单：返回自身单实体链', async () => {
  const { status, body } = await get(adminKeyA, `?seed_kind=release&seed_id=${relOrphan.id}`);
  assert.equal(status, 200);
  const c = body.data.chains[0];
  assert.equal(c.change_package, null);
  assert.equal(c.releases.length, 1);
  assert.equal(c.releases[0].id, relOrphan.id);
  assert.ok(c.timeline.some((e) => e.node === 'release' && e.kind === 'created'));
});

test('无变更包的需求：返回需求自身链', async () => {
  const { status, body } = await get(adminKeyA, `?seed_kind=requirement&seed_id=${req2.id}`);
  assert.equal(status, 200);
  const c = body.data.chains[0];
  assert.equal(c.requirement.id, req2.id);
  assert.equal(c.change_package, null);
  assert.ok(c.timeline.some((e) => e.node === 'requirement'));
});

test('seed 不存在 → 404；seed_kind 非法 → 400；缺参数 → 400', async () => {
  assert.equal((await get(adminKeyA, '?seed_kind=requirement&seed_id=req_missing')).status, 404);
  assert.equal((await get(adminKeyA, '?seed_kind=bogus&seed_id=x')).status, 400);
  assert.equal((await get(adminKeyA, '?seed_kind=requirement')).status, 400);
  assert.equal((await get(adminKeyA, '')).status, 400);
});

test('viewer 可读；无 trace.read scope 的 key 被拒；跨租户被拒；未鉴权 401', async () => {
  const v = await get(viewerKeyA, `?seed_kind=requirement&seed_id=${req1.id}`);
  assert.equal(v.status, 200);
  const scoped = await get(noScopeKeyA, `?seed_kind=requirement&seed_id=${req1.id}`);
  assert.equal(scoped.status, 403);
  const cross = await fetch(`${base}/v1/projects/${pA1.id}/trace?seed_kind=requirement&seed_id=${req1.id}`, {
    headers: { Authorization: `Bearer ${adminKeyB}` },
  });
  assert.equal(cross.status, 403);
  const anon = await get(null, `?seed_kind=requirement&seed_id=${req1.id}`);
  assert.equal(anon.status, 401);
});
