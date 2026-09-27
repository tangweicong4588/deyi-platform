/** V4.6 业务权限测试：行级权限 / key scope 衔接 / 审批人指派规则 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-perm-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.DEV_IDP_SECRET = 'dev-idp-secret-for-tests-only';
process.env.BOOTSTRAP_ENABLED = 'false';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerTaskRoutes } = await import('../src/modules/tasks/routes.mjs');
const { registerAgentRoutes } = await import('../src/modules/agents/routes.mjs');
const { registerReleaseRoutes } = await import('../src/modules/release/routes.mjs');

async function mkKey(tenantId, actorId, scopes = []) {
  const k = mintKey();
  await store.createApiKeyRow({ tenantId, projectId: null, actorId, name: 'k', prefix: k.prefix, keyHash: k.keyHash, scopes });
  return k.secret;
}

let tenant, p1, adminA, opA, opB, viewerA, outsider;
let adminKey, readOnlyKey, opAKey, opBKey, viewerKey, outsiderKey, relReadKey;
let base, appServer;

before(async () => {
  await openDb();
  await migrate(db());
  tenant = await store.createTenant({ name: 'Perm Tenant' });
  adminA = await store.createActor(tenant.id, { kind: 'user', name: 'Admin' });
  await store.bindRole(tenant.id, adminA.id, null, 'admin');
  opA = await store.createActor(tenant.id, { kind: 'user', name: 'OpA' });
  opB = await store.createActor(tenant.id, { kind: 'user', name: 'OpB' });
  viewerA = await store.createActor(tenant.id, { kind: 'user', name: 'Viewer' });
  outsider = await store.createActor(tenant.id, { kind: 'user', name: 'Outsider' }); // 同租户，非项目成员
  p1 = await store.createProject(tenant.id, { name: 'Perm P1' });
  await store.bindRole(tenant.id, opA.id, p1.id, 'operator');
  await store.bindRole(tenant.id, opB.id, p1.id, 'operator');
  await store.bindRole(tenant.id, viewerA.id, p1.id, 'viewer');
  adminKey = await mkKey(tenant.id, adminA.id, []);
  readOnlyKey = await mkKey(tenant.id, adminA.id, ['tasks.read']);
  relReadKey = await mkKey(tenant.id, adminA.id, ['release.read']);
  opAKey = await mkKey(tenant.id, opA.id, []);
  opBKey = await mkKey(tenant.id, opB.id, []);
  viewerKey = await mkKey(tenant.id, viewerA.id, []);
  outsiderKey = await mkKey(tenant.id, outsider.id, []);

  const app = createApp();
  registerIdentityRoutes(app);
  registerTaskRoutes(app);
  registerAgentRoutes(app);
  registerReleaseRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;
  // 发布环境
  const er = await post(`${base}/v1/projects/${p1.id}/deploy-environments/ensure-defaults`, {}, adminKey);
  assert.equal(er.status, 200);
});
after(async () => { await appServer?.close(); });

const post = (url, body, token) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const get = (url, token) => fetch(url, { headers: { Authorization: `Bearer ${token}` } });
const j = (r) => r.json().then((b) => ({ status: r.status, body: b }));
const T = () => `${base}/v1/projects/${p1.id}/tasks`;
const AG = () => `${base}/v1/projects/${p1.id}/agents`;
const AR = (rid) => `${base}/v1/projects/${p1.id}/agent-runs/${rid}`;
const RL = () => `${base}/v1/projects/${p1.id}/releases`;
const auditCount = async (action) =>
  (await db().query('SELECT COUNT(*) AS n FROM audit_events WHERE tenant_id=? AND action=?', [tenant.id, action]))[0].n;

test('key scope 衔接：只读 key 可读不可写', async () => {
  const g = await j(await get(T(), readOnlyKey));
  assert.equal(g.status, 200);
  const w = await j(await post(T(), { kind: 'ticket', title: 'x' }, readOnlyKey));
  assert.equal(w.status, 403);
  const rw = await j(await post(RL(), { environment_key: 'staging', version: 'v1', strategy: 'rolling', strategy_config: { batches: 2 } }, relReadKey));
  assert.equal(rw.status, 403);
});

test('行级权限：改派只能给项目成员', async () => {
  // 创建时直接指派非成员 → 403
  const bad = await j(await post(T(), { kind: 'ticket', title: 't1', assigneeId: outsider.id }, adminKey));
  assert.equal(bad.status, 403);
  assert.match(bad.body.error.message, /项目成员/);
  // 指派项目成员 → 201
  const ok = await j(await post(T(), { kind: 'ticket', title: 't2', assigneeId: opB.id }, adminKey));
  assert.equal(ok.status, 201);
  // 改派给非成员 → 403
  const tid = ok.body.data.id;
  const re = await j(await post(`${T()}/${tid}/assign`, { assigneeId: outsider.id }, adminKey));
  assert.equal(re.status, 403);
});

test('审批人指派（任务）：只有被指派人可决议；拒绝记审计', async () => {
  const mk = (approverId) => post(T(), { kind: 'approval', title: '审批单', payload: { approver_id: approverId } }, adminKey).then(j);
  // 指派非成员 → 403；指派自己 → 400 SoD
  assert.equal((await mk(outsider.id)).status, 403);
  assert.match((await mk(adminA.id)).body.error.message, /SoD/);
  const r = await mk(opB.id);
  assert.equal(r.status, 201);
  assert.equal(r.body.data.payload.approver_id, opB.id);
  const tid = r.body.data.id;
  // 非指派 operator 决议 → 403 APPROVER_MISMATCH
  const before = await auditCount('biz_task.decide.denied');
  const no = await j(await post(`${T()}/${tid}/decide`, { approved: true }, opAKey));
  assert.equal(no.status, 403);
  assert.match(no.body.error.message, /指派他人/);
  assert.equal(await auditCount('biz_task.decide.denied'), before + 1);
  // 被指派人决议 → 200（先流转到 in_progress）
  const tr = await j(await post(`${T()}/${tid}/transition`, { to: 'in_progress' }, adminKey));
  assert.equal(tr.status, 200);
  const yes = await j(await post(`${T()}/${tid}/decide`, { approved: true, note: '同意' }, opBKey));
  assert.equal(yes.status, 200);
  assert.equal(yes.body.data.status, 'resolved');
});

test('审批人指派（Agent HITL）：发版校验 + 决议校验', async () => {
  const def = (approverId) => ({
    entry: 'review',
    nodes: [{ id: 'review', type: 'hitl', name: '复核', title: '请复核', approver_id: approverId, on_approve: 'done', on_reject: 'done' },
            { id: 'done', type: 'llm', name: '收尾', prompt: 'ok', next: null }],
  });
  // 发版时指派非成员 → 403
  const ag = await j(await post(AG(), { key: 'perm-flow', name: '权限流' }, adminKey));
  assert.equal(ag.status, 201);
  const badV = await j(await post(`${AG()}/${ag.body.data.id}/versions`, { definition: def(outsider.id) }, adminKey));
  assert.equal(badV.status, 403);
  const v = await j(await post(`${AG()}/${ag.body.data.id}/versions`, { definition: def(opB.id) }, adminKey));
  assert.equal(v.status, 201);
  const run = await j(await post(`${AG()}/${ag.body.data.id}/runs`, { mode: 'simulated' }, adminKey));
  assert.equal(run.status, 201);
  assert.equal(run.body.data.status, 'waiting_approval');
  const rid = run.body.data.id;
  // 非指派人审批 → 403；被指派人 → 200
  const no = await j(await post(`${AR(rid)}/approve`, { approved: true }, opAKey));
  assert.equal(no.status, 403);
  assert.match(no.body.error.message, /指派他人/);
  assert.equal(await auditCount('agent.approval.denied'), 1);
  const yes = await j(await post(`${AR(rid)}/approve`, { approved: true }, opBKey));
  assert.equal(yes.status, 200);
});

test('审批人指派（发布）：request 指派 + 决议校验', async () => {
  const rel = await j(await post(RL(), { environment_key: 'prod', version: 'v9.9', strategy: 'rolling', strategy_config: { batches: 2 } }, adminKey));
  assert.equal(rel.status, 201);
  const rid = rel.body.data.id;
  const req = await j(await post(`${RL()}/${rid}/request-approval`, { approverId: opB.id }, adminKey));
  assert.equal(req.status, 200);
  assert.equal(req.body.data.approval.approver_id, opB.id);
  const no = await j(await post(`${RL()}/${rid}/approve`, { approved: true }, opAKey));
  assert.equal(no.status, 403);
  assert.match(no.body.error.message, /指派他人/);
  assert.equal(await auditCount('release.approval.denied'), 1);
  const yes = await j(await post(`${RL()}/${rid}/approve`, { approved: true }, opBKey));
  assert.equal(yes.status, 200);
  assert.equal(yes.body.data.status, 'approved');
});

test('越权发起被拒绝且记审计', async () => {
  const before = await auditCount('biz_task.access.denied');
  const r = await j(await post(T(), { kind: 'ticket', title: 'viewer 发起' }, viewerKey));
  assert.equal(r.status, 403); // viewer 无 tasks.write
  assert.equal(await auditCount('biz_task.access.denied'), before + 1);
});
