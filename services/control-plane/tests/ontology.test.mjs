/** ontology 测试：状态机 / 版本链 / 冲突阻塞与裁决 / 影响分析 / 鉴权 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-ont-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.DEV_IDP_SECRET = 'test-dev-secret';
process.env.BOOTSTRAP_ENABLED = 'false';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerOntologyRoutes } = await import('../src/modules/ontology/routes.mjs');
const { newId, nowMs } = await import('../src/kernel/ids.mjs');

let tenant, project, adminSecret, viewerSecret, otherSecret, otherProject;
before(async () => {
  await openDb();
  await migrate(db());
  tenant = await store.createTenant({ name: 'ONT Tenant' });
  project = await store.createProject(tenant.id, { name: 'ONT Project' });
  otherProject = await store.createProject(tenant.id, { name: 'ONT Other' });

  const admin = await store.createActor(tenant.id, { kind: 'user', name: 'ONT Admin' });
  await store.bindRole(tenant.id, admin.id, null, 'admin');
  const ak = mintKey();
  await store.createApiKeyRow({ tenantId: tenant.id, actorId: admin.id, name: 'ont-admin', prefix: ak.prefix, keyHash: ak.keyHash });
  adminSecret = ak.secret;

  const viewer = await store.createActor(tenant.id, { kind: 'user', name: 'ONT Viewer' });
  await store.bindRole(tenant.id, viewer.id, project.id, 'viewer');
  const vk = mintKey();
  await store.createApiKeyRow({ tenantId: tenant.id, actorId: viewer.id, name: 'ont-viewer', prefix: vk.prefix, keyHash: vk.keyHash });
  viewerSecret = vk.secret;

  const t2 = await store.createTenant({ name: 'ONT Tenant B' });
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
  registerOntologyRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;
});
after(() => new Promise((r) => appServer.close(r)));

const T = (pid) => `${base}/v1/projects/${pid}/ontology`;
const url = (p) => (p.startsWith('http') ? p : base + p);
const post = (path, body, token = adminSecret) =>
  fetch(url(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {}),
  });
const get = (path, token = adminSecret) =>
  fetch(url(path), { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) } });

async function lifecycle(name, kind = 'concept', definition = '') {
  const s = await post(`${T(project.id)}/terms`, { name, kind, definition });
  assert.equal(s.status, 201, `submit ${name}`);
  const { term } = await s.json();
  assert.equal(term.status, 'candidate');
  const r = await post(`${T(project.id)}/terms/${term.id}/review`, {});
  assert.equal(r.status, 200);
  const p = await post(`${T(project.id)}/terms/${term.id}/publish`, {});
  assert.equal(p.status, 200);
  return (await p.json()).term;
}

test('候选→评审→发布全链路', async () => {
  const term = await lifecycle('客户', 'concept', '购买产品或服务的组织或个人');
  assert.equal(term.status, 'published');
  assert.equal(term.version, 1);
});

test('候选直接发布 → 400（状态机防绕过）', async () => {
  const s = await post(`${T(project.id)}/terms`, { name: '直接发布', kind: 'concept' });
  const { term } = await s.json();
  const p = await post(`${T(project.id)}/terms/${term.id}/publish`, {});
  assert.equal(p.status, 400);
  const { error } = await p.json();
  assert.equal(error.details.code, 'INVALID_TRANSITION');
});

test('viewer 不能 publish/submit → 403', async () => {
  const s = await post(`${T(project.id)}/terms`, { name: 'V 术语', kind: 'concept' }, viewerSecret);
  assert.equal(s.status, 403);
  // viewer 可以读
  const g = await get(`${T(project.id)}/terms`, viewerSecret);
  assert.equal(g.status, 200);
});

test('版本链：v2 发布后 v1 自动 deprecated，supersedes 链接正确', async () => {
  const v1 = await lifecycle('订单', 'concept', '客户的购买单据');
  const s = await post(`${T(project.id)}/terms`, {
    name: '订单', kind: 'concept', definition: '客户的购买单据（含明细行）', supersedesId: v1.id,
  });
  assert.equal(s.status, 201);
  const { term: v2cand } = await s.json();
  await post(`${T(project.id)}/terms/${v2cand.id}/review`, {});
  const p = await post(`${T(project.id)}/terms/${v2cand.id}/publish`, {});
  assert.equal(p.status, 200);
  const { term: v2, deprecatedOld } = await p.json();
  assert.equal(v2.status, 'published');
  assert.equal(v2.version, 1); // 新行 version 从 1 起，链由 supersedes_id 表达
  assert.equal(v2.supersedes_id, v1.id);
  assert.equal(deprecatedOld.id, v1.id);
  assert.equal(deprecatedOld.status, 'deprecated');

  const d = await get(`${T(project.id)}/terms/${v2.id}`);
  const { chain } = await d.json();
  assert.deepEqual(chain.map((t) => t.id), [v1.id, v2.id]);
});

test('冲突阻塞发布：同名（归一化）→ 409，裁决后放行', async () => {
  await lifecycle('供应商', 'concept', '提供货物或服务的合作方');
  const s = await post(`${T(project.id)}/terms`, { name: '供 应 商', kind: 'concept', definition: '完全不同的定义文本内容填充' });
  assert.equal(s.status, 201);
  const { term, conflicts } = await s.json();
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, 'duplicate_name');

  await post(`${T(project.id)}/terms/${term.id}/review`, {});
  const p = await post(`${T(project.id)}/terms/${term.id}/publish`, {});
  assert.equal(p.status, 409);

  const cl = await get(`${T(project.id)}/conflicts?status=open`);
  const { data } = await cl.json();
  assert.ok(data.length >= 1);

  const r = await post(`${T(project.id)}/conflicts/${conflicts[0].id}/resolve`, {
    strategy: 'supersede', note: '新术语替代旧术语',
  });
  assert.equal(r.status, 200);
  const p2 = await post(`${T(project.id)}/terms/${term.id}/publish`, {});
  assert.equal(p2.status, 200);
});

test('定义高度重叠也触发冲突', async () => {
  await lifecycle('发票', 'concept', '销售方开具的付款凭证记录交易金额税额');
  const s = await post(`${T(project.id)}/terms`, {
    name: '发票凭证', kind: 'concept', definition: '销售方开具的付款凭证记录交易金额税额明细',
  });
  const { conflicts } = await s.json();
  assert.ok(conflicts.some((c) => c.reason === 'overlapping_definition'));
});

test('影响分析：列出提及术语的 facts 与 documents', async () => {
  const term = await lifecycle('退款', 'concept', '订单金额返还');
  // 直插一条引用该术语的 fact（模拟知识平面已索引内容）
  const docId = newId('doc'), cndId = newId('cnd'), factId = newId('fct');
  const t = nowMs();
  await db().query(
    `INSERT INTO documents(id,tenant_id,project_id,title,source,mime,data_class,status,raw_content,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [docId, tenant.id, project.id, '售后政策', 'upload', 'text/markdown', 'internal', 'ready', 'x', t, t]);
  await db().query(
    `INSERT INTO canonical_docs(id,document_id,tenant_id,project_id,version,content,content_hash,parse_engine,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [cndId, docId, tenant.id, project.id, 1, '退款政策…', 'h', 'builtin', t]);
  await db().query(
    `INSERT INTO facts(id,canonical_doc_id,document_id,tenant_id,project_id,chunk_index,content,source_span,embedding_model,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [factId, cndId, docId, tenant.id, project.id, 0, '发起退款后 3 个工作日内到账', '{}', 'deyi-embedding', 'active', t]);

  const r = await get(`${T(project.id)}/terms/${term.id}/impact`);
  assert.equal(r.status, 200);
  const { facts, documents } = await r.json();
  assert.equal(facts.length, 1);
  assert.equal(facts[0].id, factId);
  assert.equal(documents.length, 1);
  assert.equal(documents[0].id, docId);
});

test('非法跃迁：published 不能回评审，deprecated 不能再发布', async () => {
  const term = await lifecycle('废止测试', 'concept', '定义');
  const r1 = await post(`${T(project.id)}/terms/${term.id}/review`, {});
  assert.equal(r1.status, 400);
  await post(`${T(project.id)}/terms/${term.id}/deprecate`, {});
  const p = await post(`${T(project.id)}/terms/${term.id}/publish`, {});
  assert.equal(p.status, 400);
});

test('驳回需 reason；驳回后可重新评审', async () => {
  const s = await post(`${T(project.id)}/terms`, { name: '驳回测试', kind: 'concept' });
  const { term } = await s.json();
  const r1 = await post(`${T(project.id)}/terms/${term.id}/reject`, {});
  assert.equal(r1.status, 400);
  const r2 = await post(`${T(project.id)}/terms/${term.id}/reject`, { reason: '定义不清' });
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).data.status, 'rejected');
  const r3 = await post(`${T(project.id)}/terms/${term.id}/review`, {});
  assert.equal(r3.status, 200);
  assert.equal((await r3.json()).term.status, 'in_review');
});

test('格式非法的冲突 ID → 404（不 500、不泄露）', async () => {
  const r = await post(`${T(project.id)}/conflicts/not-a-real-id/resolve`, { strategy: 'keep' });
  assert.equal(r.status, 404);
});

test('跨租户访问 → 403', async () => {
  const r = await get(`${T(project.id)}/terms`, otherSecret);
  assert.equal(r.status, 403);
});

test('未认证 → 401', async () => {
  const r = await get(`${T(project.id)}/terms`, null);
  assert.equal(r.status, 401);
});

test('supersedes 非已发布术语 → 400', async () => {
  const s = await post(`${T(project.id)}/terms`, { name: '草稿基', kind: 'concept' });
  const { term: draft } = await s.json();
  const s2 = await post(`${T(project.id)}/terms`, {
    name: '草稿基', kind: 'concept', supersedesId: draft.id,
  });
  assert.equal(s2.status, 400);
});
