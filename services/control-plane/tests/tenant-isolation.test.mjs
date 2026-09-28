/**
 * tests/tenant-isolation.test.mjs —— V2.19：租户隔离验证 sweep。
 *
 * 双租户 harness：B 租户预埋带标记（ISO_MARK_B）的数据，逐模块用 A 租户
 * token 发起跨租户读取，断言 401/403/404 且无数据泄露。
 * 覆盖清单见 tests/isolation-manifest.mjs（新模块必须登记，否则 manifest
 * 完整性测试失败）。
 *
 * 边界：只覆盖 API 面，不含直接 DB 访问。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import http from 'node:http';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-iso-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op-' + randomBytes(8).toString('hex');
process.env.DEV_IDP_SECRET = 'dev-' + randomBytes(8).toString('hex');
process.env.BOOTSTRAP_ENABLED = 'false';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { provisionTenant } = await import('../src/modules/identity/provision.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { registerKnowledgeRoutes } = await import('../src/modules/knowledge/routes.mjs');
const { registerTaskRoutes } = await import('../src/modules/tasks/routes.mjs');
const { registerMemoryRoutes } = await import('../src/modules/memory/routes.mjs');
const { registerArtifactRoutes } = await import('../src/modules/artifacts/routes.mjs');
const { registerReleaseRoutes } = await import('../src/modules/release/routes.mjs');
const { registerBillingRoutes } = await import('../src/modules/billing/routes.mjs');
const { registerNotifyRoutes } = await import('../src/modules/notify/routes.mjs');
const { generateInvoice } = await import('../src/modules/billing/service.mjs');
const { ISOLATION_MANIFEST } = await import('./isolation-manifest.mjs');

const MARK = 'ISO_MARK_B_TENANT';
let tenantA, tenantB, keyA, keyB, projB, taskB, app, server, base;
const OP = () => process.env.OPERATOR_TOKEN;

function req(path, { method = 'GET', token = null, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + path, {
      method,
      headers: {
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode, raw }));
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
// 跨租户读取探针：返回 {status, leaked}
async function probe(path, token, opts = {}) {
  const r = await req(path, { token, ...opts });
  return { status: r.status, leaked: r.raw.includes(MARK) };
}
const BLOCKED = [401, 403, 404];
function assertBlocked(p, label) {
  assert.ok(BLOCKED.includes(p.status), `${label}：期望被拒绝，实际 ${p.status}`);
  assert.equal(p.leaked, false, `${label}：响应泄露了 B 租户数据！`);
}

before(async () => {
  await openDb();
  await migrate(db());
  app = createApp();
  registerIdentityRoutes(app);
  registerKnowledgeRoutes(app);
  registerTaskRoutes(app);
  registerMemoryRoutes(app);
  registerArtifactRoutes(app);
  registerReleaseRoutes(app);
  registerBillingRoutes(app);
  registerNotifyRoutes(app);
  server = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.address().port}`;

  const outA = await provisionTenant({ name: '隔离租户A' });
  const outB = await provisionTenant({ name: '隔离租户B' });
  tenantA = outA.tenant; keyA = outA.apiKey.key;
  tenantB = outB.tenant; keyB = outB.apiKey.key;

  projB = await store.createProject(tenantB.id, { name: 'B项目', slug: 'iso-proj-b' });
  const actorB = await store.createActor(tenantB.id, { kind: 'user', name: 'B成员' });
  const now = Date.now();
  await db().query(
    `INSERT INTO documents(id, tenant_id, project_id, title, source, mime, data_class, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ['doc_iso_b', tenantB.id, projB.id, `B机密文档 ${MARK}`, 'upload', 'text/markdown', 'confidential', 'ready', now, now]);
  const { createTask } = await import('../src/modules/tasks/task.mjs');
  taskB = (await createTask({
    tenantId: tenantB.id, projectId: projB.id, actorId: actorB.id,
    body: { kind: 'ticket', title: `B任务 ${MARK}` },
  })).id;
  await db().query(
    `INSERT INTO memories(id, tenant_id, project_id, actor_id, kind, content, visibility, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ['mem_iso_b', tenantB.id, projB.id, actorB.id, 'semantic', `B记忆 ${MARK}`, 'project', now, now]);
  await db().query(
    `INSERT INTO artifact_packages(id, tenant_id, project_id, name, created_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
    ['apkg_iso_b', tenantB.id, projB.id, `B制品 ${MARK}`, now, now]);
  await db().query(
    `INSERT INTO deploy_environments(id, tenant_id, project_id, key, name, created_at) VALUES (?,?,?,?,?,?)`,
    ['env_iso_b', tenantB.id, projB.id, 'prod', 'prod', now]);
  await db().query(
    `INSERT INTO releases(id, tenant_id, project_id, environment_id, version, strategy, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ['rel_iso_b', tenantB.id, projB.id, 'env_iso_b', 'v1', 'rolling', actorB.id, now, now]);
  await db().query(
    `INSERT INTO notify_channels(id, tenant_id, kind, name, target, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
    ['ch_iso_b', tenantB.id, 'webhook', `B通道 ${MARK}`, 'https://example.com/hook', now, now]);
  const d = new Date();
  await generateInvoice(tenantB.id, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
});

after(() => new Promise((r) => server.close(r)));

// sweep 用例注册表（module 名必须与 isolation-manifest 一致）
const SWEEP = [];
function sweep(module, name, fn) { SWEEP.push({ module, name, fn }); }

sweep('projects', '跨租户读项目详情', async () => {
  assertBlocked(await probe(`/v1/projects/${projB.id}`, keyA), '读B项目详情');
});
sweep('projects', '项目列表不含B项目', async () => {
  const p = await probe('/v1/projects', keyA);
  assert.equal(p.status, 200);
  assert.equal(p.leaked, false, '项目列表泄露B项目');
});

sweep('knowledge', '跨租户读知识文档', async () => {
  assertBlocked(await probe(`/v1/projects/${projB.id}/knowledge/documents`, keyA), '读B知识文档');
  assertBlocked(await probe(`/v1/projects/${projB.id}/knowledge/search`, keyA, {
    method: 'POST', body: { query: '机密' },
  }), '跨租户知识检索');
});

sweep('tasks', '跨租户读任务', async () => {
  assertBlocked(await probe(`/v1/projects/${projB.id}/tasks`, keyA), '读B任务列表');
  assertBlocked(await probe(`/v1/projects/${projB.id}/tasks/${taskB}`, keyA), '读B任务详情');
  assertBlocked(await probe(`/v1/projects/${projB.id}/tasks/${taskB}/cost`, keyA), '读B任务成本');
});

sweep('memory', '跨租户记忆 recall', async () => {
  assertBlocked(await probe(`/v1/tenants/${tenantB.id}/memory/recall?query=x`, keyA), 'B租户记忆recall');
});

sweep('artifacts', '跨租户读制品包', async () => {
  assertBlocked(await probe(`/v1/projects/${projB.id}/artifact-packages`, keyA), '读B制品包');
});

sweep('releases', '跨租户读发布', async () => {
  assertBlocked(await probe(`/v1/projects/${projB.id}/releases`, keyA), '读B发布列表');
});

sweep('billing', '跨租户读账单', async () => {
  assertBlocked(await probe(`/v1/tenants/${tenantB.id}/billing/invoices`, keyA), '读B账单');
});

sweep('notify', '跨租户读通知通道', async () => {
  assertBlocked(await probe(`/v1/tenants/${tenantB.id}/notify/channels`, keyA), '读B通知通道');
});

sweep('admin-platform', '租户key打运营面API', async () => {
  for (const p of [
    `/v1/admin/tenants/${tenantB.id}/api-keys`,
    `/v1/admin/tenants/${tenantB.id}/cost/breakdown`,
    `/v1/admin/tenants/${tenantB.id}/compliance/export`,
    `/v1/admin/tenants/${tenantB.id}/usage`,
  ]) {
    assertBlocked(await probe(p, keyA), `租户key访问 ${p}`);
  }
});

sweep('positive-control', 'B读自己 + operator读B', async () => {
  const own = await probe(`/v1/projects/${projB.id}/knowledge/documents`, keyB);
  assert.equal(own.status, 200, 'B读自己应200');
  assert.equal(own.leaked, true, 'B读自己应看到数据');
  const op = await probe(`/v1/admin/tenants/${tenantB.id}/cost/breakdown`, OP());
  assert.equal(op.status, 200, 'operator读B应200');
});

test('manifest 完整性：清单每个 module 都有 sweep 用例', () => {
  const covered = new Set(SWEEP.map((s) => s.module));
  for (const m of ISOLATION_MANIFEST) {
    assert.ok(covered.has(m.module), `清单 module 未被 sweep 覆盖: ${m.module}`);
  }
});

sweep('mutation', '中间件被绕过时 sweep 必须抓到', async () => {
  // 模拟"开发误删 tenantScope"：同一 handler，不带隔离中间件
  const { authenticate } = await import('../src/modules/identity/middleware.mjs');
  const broken = createApp();
  registerIdentityRoutes(broken);
  broken.get('/v1/tenants/:tenantId/mutated-notes', authenticate, async (req, res, next) => { await next(); },
    async (req, res) => {
      const rows = await db().query('SELECT id, title FROM documents WHERE tenant_id=?', [req.params.tenantId]);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: rows }));
    });
  const srv = await broken.listen(0, '127.0.0.1');
  const b2 = `http://127.0.0.1:${srv.address().port}`;
  try {
    const raw = await new Promise((resolve, reject) => {
      http.get(b2 + `/v1/tenants/${tenantB.id}/mutated-notes`,
        { headers: { authorization: 'Bearer ' + keyA } }, (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => resolve({ status: res.statusCode, body: d }));
        }).on('error', reject);
    });
    // mutation 下：A 的 token 读到了 B 的数据 → sweep 探针必须判定为泄露
    assert.equal(raw.status, 200, 'mutation 应用应返回 200（隔离已失效）');
    assert.ok(raw.body.includes(MARK), 'mutation 应用应泄露 B 数据');
    const verdict = { status: raw.status, leaked: raw.body.includes(MARK) };
    assert.equal(verdict.leaked, true, 'sweep 探针必须标记此次访问为泄露');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

// sweep 用例全部注册完毕后统一生成测试
for (const s of SWEEP) {
  test(`[sweep:${s.module}] ${s.name}`, s.fn);
}
