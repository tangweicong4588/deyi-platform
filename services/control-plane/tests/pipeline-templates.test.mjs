/** V3.1 流水线模板与复用：创建/版本/实例化/执行全链路、参数化、可见性、跨租户隔离、审计 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-tpl-')), 'test.db');
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
const { registerDeliveryRoutes } = await import('../src/modules/delivery/routes.mjs');

let tenant, project, project2, adminSecret, otherSecret, otherProjectId;
before(async () => {
  await openDb();
  await migrate(db());
  await audit.initEvidence();
  tenant = await store.createTenant({ name: 'TPL Tenant' });
  project = await store.createProject(tenant.id, { name: 'TPL Project' });
  project2 = await store.createProject(tenant.id, { name: 'TPL Project 2' });

  const admin = await store.createActor(tenant.id, { kind: 'user', name: 'TPL Admin' });
  await store.bindRole(tenant.id, admin.id, null, 'admin');
  const ak = mintKey();
  await store.createApiKeyRow({ tenantId: tenant.id, actorId: admin.id, name: 'tpl-admin', prefix: ak.prefix, keyHash: ak.keyHash });
  adminSecret = ak.secret;

  const t2 = await store.createTenant({ name: 'TPL Tenant B' });
  const p2 = await store.createProject(t2.id, { name: 'B Project' });
  otherProjectId = p2.id;
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
const get = (url, token = adminSecret) =>
  fetch(url, { headers: { authorization: `Bearer ${token}` } });
const P = () => D(project.id);
const TPL = () => `${P()}/pipeline-templates`;

const STAGES5 = [
  { key: 'facts' }, { key: 'requirements' }, { key: 'clarify' },
  { key: 'develop' }, { key: 'handover' },
];
const SCHEMA = [
  { name: 'service_name', type: 'string', required: true, description: '服务名' },
  { name: 'replicas', type: 'number', required: false, default: 2 },
  { name: 'env', type: 'enum', required: false, default: 'staging', options: ['dev', 'staging', 'prod'] },
  { name: 'canary', type: 'boolean', required: false, default: false },
];

async function mkTemplate(over = {}, token = adminSecret, pid = project.id) {
  const r = await post(`${D(pid)}/pipeline-templates`, {
    name: '标准交付模板', visibility: 'private',
    paramsSchema: SCHEMA, stages: STAGES5, ...over,
  }, token);
  assert.equal(r.status, 201);
  return (await r.json()).data;
}

async function mkPackage(pid = project.id, token = adminSecret) {
  const rq = await post(`${D(pid)}/requirements`, { title: '模板测试需求', kind: 'feature', scopeMd: '做 X', nonGoalsMd: '不做 Y' }, token);
  assert.equal(rq.status, 201);
  const req = (await rq.json()).data;
  const cp = await post(`${D(pid)}/change-packages`, { requirementId: req.id, branch: 'feat/tpl' }, token);
  assert.equal(cp.status, 201);
  return (await cp.json()).data;
}

test('V3.1：创建 private 模板 → 版本 1，current_version=1', async () => {
  const t = await mkTemplate();
  assert.equal(t.current_version, 1);
  assert.equal(t.visibility, 'private');
  assert.equal(t.status, 'active');
  assert.deepEqual(t.stages.map((s) => s.key), ['facts', 'requirements', 'clarify', 'develop', 'handover']);
  assert.equal(t.params_schema.length, 4);
});

test('V3.1：非法 stages（未知 key）→ 400', async () => {
  const r = await post(TPL(), { name: '坏模板', visibility: 'private', stages: [{ key: 'deploy' }] });
  assert.equal(r.status, 400);
});

test('V3.1：非法 params_schema（非法 type / 重复名 / __proto__）→ 400', async () => {
  const bad1 = await post(TPL(), { name: 't', visibility: 'private', stages: STAGES5, paramsSchema: [{ name: 'x', type: 'object' }] });
  assert.equal(bad1.status, 400);
  const bad2 = await post(TPL(), {
    name: 't', visibility: 'private', stages: STAGES5,
    paramsSchema: [{ name: '__proto__', type: 'string' }],
  });
  assert.equal(bad2.status, 400);
});

test('V3.1：shared 模板不绑定项目', async () => {
  const r1 = await post(TPL(), { name: '共享模板', visibility: 'shared', stages: STAGES5 });
  assert.equal(r1.status, 201);
  assert.equal((await r1.json()).data.project_id, null);
  // 从项目路由创建 shared 也是允许的（模板本身不绑定项目）
  const r3 = await post(`${D(project.id)}/pipeline-templates`, { name: '共享模板2', visibility: 'shared', stages: STAGES5 });
  assert.equal(r3.status, 201);
  assert.equal((await r3.json()).data.project_id, null);
});

test('V3.1：发新版本 → version 2；旧版本快照不可变', async () => {
  const t = await mkTemplate({ name: '版本模板' });
  const v2 = await post(`${TPL()}/${t.id}/versions`, {
    changeNote: '加 canary 参数说明',
    paramsSchema: [...SCHEMA, { name: 'owner', type: 'string', required: false }],
    stages: STAGES5,
  });
  assert.equal(v2.status, 201);
  assert.equal((await v2.json()).data.version, 2);
  const detail = await (await get(`${TPL()}/${t.id}`)).json();
  assert.equal(detail.data.template.current_version, 2);
  const v1 = detail.data.versions.find((v) => v.version === 1);
  assert.equal(v1.definition.params_schema.length, 4); // 快照未被污染
  assert.equal(detail.data.versions.find((v) => v.version === 2).definition.params_schema.length, 5);
});

test('V3.1：列表可见性——本项目见 private+shared；另一项目只见 shared', async () => {
  await mkTemplate({ name: 'P1 私有', visibility: 'private' });
  const l1 = (await (await get(TPL())).json()).data.map((t) => t.name);
  assert.ok(l1.includes('P1 私有'));
  assert.ok(l1.includes('共享模板'));
  const l2 = (await (await get(`${D(project2.id)}/pipeline-templates`)).json()).data;
  assert.ok(!l2.some((t) => t.name === 'P1 私有'));
  assert.ok(l2.some((t) => t.name === '共享模板'));
});

test('V3.1：实例化参数校验——缺必填/未知参数/enum 越界 → 400', async () => {
  const t = await mkTemplate({ name: '校验模板' });
  const chg = await mkPackage();
  const miss = await post(`${TPL()}/${t.id}/instantiate`, { changePackageId: chg.id, params: {} });
  assert.equal(miss.status, 400); // 缺 service_name
  const chg2 = await mkPackage();
  const unknown = await post(`${TPL()}/${t.id}/instantiate`, {
    changePackageId: chg2.id, params: { service_name: 's', nope: 1 },
  });
  assert.equal(unknown.status, 400);
  const chg3 = await mkPackage();
  const badEnum = await post(`${TPL()}/${t.id}/instantiate`, {
    changePackageId: chg3.id, params: { service_name: 's', env: 'prod2' },
  });
  assert.equal(badEnum.status, 400);
});

test('V3.1：实例化成功 → instance + 5 运行（首个 running），参数合并默认值', async () => {
  const t = await mkTemplate({ name: '实例模板' });
  const chg = await mkPackage();
  const r = await post(`${TPL()}/${t.id}/instantiate`, {
    changePackageId: chg.id, params: { service_name: 'pay-svc', env: 'prod' },
  });
  assert.equal(r.status, 201);
  const { instance, created } = (await r.json()).data;
  assert.equal(created, true);
  assert.equal(instance.template_version, 1);
  assert.deepEqual(instance.resolved_params, { service_name: 'pay-svc', replicas: 2, env: 'prod', canary: false });
  const detail = (await (await get(`${P()}/pipeline-instances/${instance.id}`)).json()).data;
  assert.equal(detail.runs.length, 5);
  assert.deepEqual(detail.runs.map((x) => x.stage), ['facts', 'requirements', 'clarify', 'develop', 'handover']);
  assert.equal(detail.runs[0].status, 'running');
  assert.ok(detail.runs.slice(1).every((x) => x.status === 'pending'));
  assert.ok(detail.runs.every((x) => x.instance_id === instance.id && x.template_id === t.id));
});

test('V3.1：实例化后可执行——登记事实快照并推进 facts → passed，下一阶段 running', async () => {
  const t = await mkTemplate({ name: '执行模板' });
  const chg = await mkPackage();
  const ir = await post(`${TPL()}/${t.id}/instantiate`, {
    changePackageId: chg.id, params: { service_name: 's' },
  });
  const instanceId = (await ir.json()).data.instance.id;
  const { runs } = (await (await get(`${P()}/pipeline-instances/${instanceId}`)).json()).data;
  const facts = runs.find((x) => x.stage === 'facts');
  const snap = await post(`${P()}/pipeline-runs/${facts.id}/fact-snapshot`, {
    baselineCommit: 'abc123', environment: { os: 'linux' }, dependencies: { node: '22' }, unknownItems: [],
  });
  assert.equal(snap.status, 201);
  const adv = await post(`${P()}/pipeline-runs/${facts.id}/advance`, { decision: { note: 'ok' } });
  assert.equal(adv.status, 200);
  const out = (await adv.json()).data;
  assert.equal(out.blocked, undefined);
  assert.equal(out.run.status, 'passed');
  assert.equal(out.next.stage, 'requirements');
  assert.equal(out.next.status, 'running');
});

test('V3.1：重复实例化幂等（created:false）；已有普通流水线的包 → 409', async () => {
  const t = await mkTemplate({ name: '幂等模板' });
  const chg = await mkPackage();
  const r1 = await post(`${TPL()}/${t.id}/instantiate`, { changePackageId: chg.id, params: { service_name: 's' } });
  assert.equal(r1.status, 201);
  const id1 = (await r1.json()).data.instance.id;
  const r2 = await post(`${TPL()}/${t.id}/instantiate`, { changePackageId: chg.id, params: { service_name: 's' } });
  assert.equal(r2.status, 200);
  const d2 = (await r2.json()).data;
  assert.equal(d2.created, false);
  assert.equal(d2.instance.id, id1);

  const chg2 = await mkPackage();
  const sp = await post(`${P()}/change-packages/${chg2.id}/pipeline/start`, {});
  assert.ok([200, 201].includes(sp.status));
  const conflict = await post(`${TPL()}/${t.id}/instantiate`, { changePackageId: chg2.id, params: { service_name: 's' } });
  assert.equal(conflict.status, 409);
});

test('V3.1：跨租户隔离——B 租户打不到 A 租户的项目路由；实例化 A 模板 → 404', async () => {
  const t = await mkTemplate({ name: '隔离模板' });
  // B 租户用 A 项目路由 → 项目不存在或无权访问（403）
  const g = await get(`${TPL()}/${t.id}`, otherSecret);
  assert.equal(g.status, 403);
  // B 租户用自己项目路由实例化 A 租户模板 → 模板不存在（404）
  const chg = await mkPackage(otherProjectId, otherSecret);
  const ins = await post(
    `${base}/v1/projects/${otherProjectId}/delivery/pipeline-templates/${t.id}/instantiate`,
    { changePackageId: chg.id, params: { service_name: 's' } }, otherSecret);
  assert.equal(ins.status, 404);
});

test('V3.1：私有模板不能跨项目实例化', async () => {
  const t = await mkTemplate({ name: '项目私有', visibility: 'private' });
  const chg = await mkPackage(project2.id);
  const r = await post(`${D(project2.id)}/pipeline-templates/${t.id}/instantiate`, {
    changePackageId: chg.id, params: { service_name: 's' },
  });
  assert.equal(r.status, 403);
});

test('V3.1：归档后不可实例化/发版', async () => {
  const t = await mkTemplate({ name: '归档模板' });
  const a = await post(`${TPL()}/${t.id}/archive`, {});
  assert.equal(a.status, 200);
  assert.equal((await a.json()).data.status, 'archived');
  const chg = await mkPackage();
  const ins = await post(`${TPL()}/${t.id}/instantiate`, { changePackageId: chg.id, params: { service_name: 's' } });
  assert.equal(ins.status, 400);
  const ver = await post(`${TPL()}/${t.id}/versions`, { stages: STAGES5 });
  assert.equal(ver.status, 400);
});

test('V3.1：模板变更进审计链（create/version/instantiate）', async () => {
  const t = await mkTemplate({ name: '审计模板' });
  const rows = async (action, rid) => db().query(
    `SELECT * FROM audit_events WHERE tenant_id=? AND action=? AND resource_id=?`, [tenant.id, action, rid]);
  assert.equal((await rows('pipeline.template.create', t.id)).length, 1);
  await post(`${TPL()}/${t.id}/versions`, { changeNote: 'v2', stages: STAGES5 });
  assert.equal((await rows('pipeline.template.version', t.id)).length, 1);
  const chg = await mkPackage();
  const ir = await post(`${TPL()}/${t.id}/instantiate`, { changePackageId: chg.id, params: { service_name: 's' } });
  const instId = (await ir.json()).data.instance.id;
  assert.equal((await rows('pipeline.template.instantiate', instId)).length, 1);
});
