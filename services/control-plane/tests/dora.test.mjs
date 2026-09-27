/** V3.6 研发效能度量测试：DORA 四指标口径与手工核算一致 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-dora-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.DEV_IDP_SECRET = 'dev-idp-secret-for-tests-only';
process.env.BOOTSTRAP_ENABLED = 'false';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerDoraRoutes } = await import('../src/modules/dora/routes.mjs');

async function mkKey(tenantId, actorId) {
  const k = mintKey();
  await store.createApiKeyRow({ tenantId, projectId: null, actorId, name: 'k', prefix: k.prefix, keyHash: k.keyHash, scopes: [] });
  return k.secret;
}

const H = 3600000;
const T0 = 1780000000000; // 固定锚点，手工可核算
const W0 = T0, W1 = T0 + 60 * H; // 2.5 天窗口

let tenantA, pA1, pA2, env1, adminKeyA, viewerKeyA, tenantB, pB1, adminKeyB;
let base, appServer;

before(async () => {
  await openDb();
  await migrate(db());

  tenantA = await store.createTenant({ name: 'Dora Tenant A' });
  const adminA = await store.createActor(tenantA.id, { kind: 'user', name: 'Dora Admin A' });
  await store.bindRole(tenantA.id, adminA.id, null, 'admin');
  adminKeyA = await mkKey(tenantA.id, adminA.id);
  pA1 = await store.createProject(tenantA.id, { name: 'Dora P1' });
  pA2 = await store.createProject(tenantA.id, { name: 'Dora P2' });
  const viewerA = await store.createActor(tenantA.id, { kind: 'user', name: 'Dora Viewer A' });
  await store.bindRole(tenantA.id, viewerA.id, pA1.id, 'viewer');
  viewerKeyA = await mkKey(tenantA.id, viewerA.id);
  env1 = { id: 'env_dora1' };
  await db().run(`INSERT INTO deploy_environments(id,tenant_id,project_id,key,name,created_at) VALUES(?,?,?,?,?,?)`,
    [env1.id, tenantA.id, pA1.id, 'prod', '生产', T0]);

  tenantB = await store.createTenant({ name: 'Dora Tenant B' });
  const adminB = await store.createActor(tenantB.id, { kind: 'user', name: 'Dora Admin B' });
  await store.bindRole(tenantB.id, adminB.id, null, 'admin');
  adminKeyB = await mkKey(tenantB.id, adminB.id);
  pB1 = await store.createProject(tenantB.id, { name: 'Dora PB1' });

  // 变更包（前置时间起点；requirement 外键先建一行）
  await db().run(`INSERT INTO requirements(id,tenant_id,project_id,title,created_at,updated_at)
                  VALUES('req_x',?,?, 'Dora 需求', ?, ?)`,
    [tenantA.id, pA1.id, T0, T0]);
  await db().run(`INSERT INTO change_packages(id,tenant_id,project_id,requirement_id,branch,created_by,created_at,updated_at)
                  VALUES('chg_dora1',?,?, 'req_x','feat/a',?, ?, ?)`,
    [tenantA.id, pA1.id, adminA.id, T0, T0]);
  await db().run(`INSERT INTO change_packages(id,tenant_id,project_id,requirement_id,branch,created_by,created_at,updated_at)
                  VALUES('chg_dora2',?,?, 'req_x','feat/b',?, ?, ?)`,
    [tenantA.id, pA1.id, adminA.id, T0 + H, T0 + H]);

  // 发布单（按 updated_at 落窗；R5 失败后无恢复 → unrecovered）
  const rel = (id, status, cpId, updatedAt, projectId = pA1.id, envId = env1.id) =>
    db().run(`INSERT INTO releases(id,tenant_id,project_id,environment_id,change_package_id,version,strategy,status,created_by,created_at,updated_at)
              VALUES(?,?,?,?,?, '1.0','rolling', ?, ?, ?, ?)`,
      [id, tenantA.id, projectId, envId, cpId, status, adminA.id, updatedAt - H, updatedAt]);
  await rel('rel_dora1', 'succeeded', 'chg_dora1', T0 + 10 * H); // lead 10h
  await rel('rel_dora2', 'succeeded', 'chg_dora2', T0 + 30 * H); // lead 29h
  await rel('rel_dora3', 'failed', null, T0 + 40 * H);           // → rel_dora4 恢复 4h
  await rel('rel_dora4', 'succeeded', null, T0 + 44 * H);       // 无变更包 → excluded
  await rel('rel_dora5', 'rolled_back', null, T0 + 50 * H);     // 无恢复 → unrecovered
  await rel('rel_dora_old', 'succeeded', 'chg_dora1', T0 - 10 * H); // 窗外，不计
  await rel('rel_dora_draft', 'deploying', null, T0 + 20 * H);     // 非终态，不计
  await rel('rel_dora_p2', 'succeeded', null, T0 + 12 * H, pA2.id, env1.id); // 另一项目（租户聚合用）

  const app = createApp();
  registerIdentityRoutes(app);
  registerDoraRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;
});
after(async () => { await appServer?.close(); });

const get = (u, key) => fetch(u, { headers: key ? { Authorization: `Bearer ${key}` } : {} })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

test('四指标与手工核算一致', async () => {
  const r = await get(`${base}/v1/projects/${pA1.id}/dora?from=${W0}&to=${W1}`, adminKeyA);
  assert.equal(r.status, 200);
  const d = r.body.data;
  assert.equal(d.methodology, 'dora-v1');
  // 部署频率：3 次成功 / 2.5 天
  assert.equal(d.deployment_frequency.count, 3);
  assert.equal(d.deployment_frequency.window_days, 2.5);
  assert.equal(d.deployment_frequency.per_day, 1.2);
  // 前置时间：[10h, 29h] → 中位 19.5，p90 29；rel_dora4 无变更包被排除
  assert.equal(d.lead_time.median_hours, 19.5);
  assert.equal(d.lead_time.p90_hours, 29);
  assert.equal(d.lead_time.count, 2);
  assert.equal(d.lead_time.excluded_no_change_package, 1);
  // 失败率：2/5=0.4
  assert.equal(d.change_failure_rate.failed, 2);
  assert.equal(d.change_failure_rate.total, 5);
  assert.equal(d.change_failure_rate.rate, 0.4);
  // 恢复时间：[4h] → 中位 4；rel_dora5 未恢复
  assert.equal(d.time_to_restore.median_hours, 4);
  assert.equal(d.time_to_restore.count, 1);
  assert.equal(d.time_to_restore.unrecovered, 1);
});

test('租户级聚合池化多项目；空窗口返回零值', async () => {
  // 租户级：pA1 的 5 条终态 + pA2 的 1 条成功
  const r = await get(
    `${base}/v1/admin/dora?tenant_id=${tenantA.id}&from=${W0}&to=${W1}`,
    process.env.OPERATOR_TOKEN);
  assert.equal(r.status, 200);
  const d = r.body.data;
  assert.equal(d.scope.project_id, null);
  assert.equal(d.deployment_frequency.count, 4); // 3 + pA2 的 1
  assert.equal(d.change_failure_rate.total, 6);
  assert.equal(d.change_failure_rate.failed, 2);

  // 空窗口
  const e = await get(`${base}/v1/projects/${pA1.id}/dora?from=${T0 - 100 * H}&to=${T0 - 90 * H}`, adminKeyA);
  assert.equal(e.status, 200);
  assert.equal(e.body.data.deployment_frequency.count, 0);
  assert.equal(e.body.data.lead_time.median_hours, null);
  assert.equal(e.body.data.change_failure_rate.rate, 0);
  assert.equal(e.body.data.time_to_restore.median_hours, null);
});

test('鉴权：viewer 可读；跨租户 404；未鉴权 401；from>=to 400', async () => {
  const v = await get(`${base}/v1/projects/${pA1.id}/dora?from=${W0}&to=${W1}`, viewerKeyA);
  assert.equal(v.status, 200);
  const cross = await get(`${base}/v1/projects/${pA1.id}/dora?from=${W0}&to=${W1}`, adminKeyB);
  assert.ok([403, 404].includes(cross.status)); // B 租户 key 访问 A 租户项目
  const empty = await get(`${base}/v1/projects/${pB1.id}/dora?from=${W0}&to=${W1}`, adminKeyB);
  assert.equal(empty.status, 200); // 本租户空项目 → 200 空报表
  assert.equal(empty.body.data.deployment_frequency.count, 0);
  const anon = await get(`${base}/v1/projects/${pA1.id}/dora?from=${W0}&to=${W1}`, null);
  assert.equal(anon.status, 401);
  const bad = await get(`${base}/v1/projects/${pA1.id}/dora?from=${W1}&to=${W0}`, adminKeyA);
  assert.equal(bad.status, 400);
  const noTenant = await get(`${base}/v1/admin/dora?from=${W0}&to=${W1}`, process.env.OPERATOR_TOKEN);
  assert.equal(noTenant.status, 400);
});
