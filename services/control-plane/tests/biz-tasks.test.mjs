/** V4.1 业务任务域模型：创建/状态机/改派/审批SoD/SLA升级/隔离/审计 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-task-')), 'test.db');
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
const { registerTaskRoutes } = await import('../src/modules/tasks/routes.mjs');

let tenant, project, adminSecret, adminId, admin2Secret, admin2Id, viewerSecret, otherSecret, otherProjectId;
before(async () => {
  await openDb();
  await migrate(db());
  await audit.initEvidence();
  tenant = await store.createTenant({ name: 'TASK Tenant' });
  project = await store.createProject(tenant.id, { name: 'TASK Project' });

  const mkActor = async (name, role, pid) => {
    const a = await store.createActor(tenant.id, { kind: 'user', name });
    await store.bindRole(tenant.id, a.id, pid === undefined ? null : pid, role);
    const k = mintKey();
    await store.createApiKeyRow({ tenantId: tenant.id, actorId: a.id, name, prefix: k.prefix, keyHash: k.keyHash });
    return { id: a.id, secret: k.secret };
  };
  const admin = await mkActor('TASK Admin', 'admin');
  adminSecret = admin.secret; adminId = admin.id;
  const admin2 = await mkActor('TASK Admin2', 'admin');
  admin2Secret = admin2.secret; admin2Id = admin2.id;
  const viewer = await mkActor('TASK Viewer', 'viewer', project.id);
  viewerSecret = viewer.secret;

  const t2 = await store.createTenant({ name: 'TASK Tenant B' });
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
  registerTaskRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;
});
after(() => new Promise((r) => appServer.close(r)));

const T = (pid) => `${base}/v1/projects/${pid}/tasks`;
const post = (url, body, token = adminSecret) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const get = (url, token = adminSecret) =>
  fetch(url, { headers: { authorization: `Bearer ${token}` } });
const P = () => T(project.id);

async function mkTask(over = {}, token = adminSecret) {
  const r = await post(P(), { kind: 'ticket', title: '测试任务', ...over }, token);
  assert.equal(r.status, 201);
  return (await r.json()).data;
}
const transition = (id, to, note = '', token = adminSecret) =>
  post(`${P()}/${id}/transition`, { to, note }, token);

test('V4.1：创建工单 → open，发起人=创建者，SLA 按小时折算', async () => {
  const before = Date.now();
  const t = await mkTask({ title: '修登录 bug', priority: 'high', slaHours: 4 });
  assert.equal(t.status, 'open');
  assert.equal(t.kind, 'ticket');
  assert.equal(t.priority, 'high');
  assert.equal(t.requester_id, adminId);
  assert.ok(Math.abs(t.sla_due_at - (before + 4 * 3600_000)) < 5000);
  assert.equal(t.escalated, false);
});

test('V4.1：非法 kind/priority/slaHours → 400', async () => {
  assert.equal((await post(P(), { kind: 'nope', title: 'x' })).status, 400);
  assert.equal((await post(P(), { kind: 'ticket', title: 'x', priority: 'p0' })).status, 400);
  assert.equal((await post(P(), { kind: 'ticket', title: 'x', slaHours: -1 })).status, 400);
  assert.equal((await post(P(), { kind: 'ticket', title: '  ' })).status, 400);
});

test('V4.1：状态机全链 open→in_progress→pending→in_progress→resolved→closed', async () => {
  const t = await mkTask({ title: '全链任务' });
  let cur = t.id;
  for (const to of ['in_progress', 'pending', 'in_progress', 'resolved', 'closed']) {
    const r = await transition(cur, to);
    assert.equal(r.status, 200);
    const body = (await r.json()).data;
    cur = body.id;
    assert.equal(body.status, to);
  }
  const detail = (await (await get(`${P()}/${t.id}`)).json()).data;
  assert.equal(detail.transitions.length, 6); // 创建 + 5 次流转
  assert.ok(detail.task.closed_at);
});

test('V4.1：非法跃迁 open→closed / 终态再流转 → 400', async () => {
  const t = await mkTask({ title: '非法跃迁' });
  assert.equal((await transition(t.id, 'closed')).status, 400);
  const r = await transition(t.id, 'cancelled');
  assert.equal(r.status, 200);
  assert.equal((await transition(t.id, 'in_progress')).status, 400);
});

test('V4.1：resolved 可打回 in_progress（重做）', async () => {
  const t = await mkTask({ title: '打回任务' });
  await transition(t.id, 'in_progress');
  await transition(t.id, 'resolved');
  const r = await transition(t.id, 'in_progress', '验收不通过，打回');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).data.status, 'in_progress');
});

test('V4.1：改派——本租户主体 ok；外租户主体 400；终态不可改派', async () => {
  const t = await mkTask({ title: '改派任务' });
  const r = await post(`${P()}/${t.id}/assign`, { assigneeId: admin2Id });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).data.assignee_id, admin2Id);
  const bad = await post(`${P()}/${t.id}/assign`, { assigneeId: 'actor_not_exist' });
  assert.equal(bad.status, 400);
  await transition(t.id, 'cancelled');
  assert.equal((await post(`${P()}/${t.id}/assign`, { assigneeId: admin2Id })).status, 400);
});

test('V4.1：审批单——发起人自批 403（SoD）；他人 approve → resolved；重复决议幂等', async () => {
  const t = await mkTask({ kind: 'approval', title: '费用审批' });
  assert.equal(t.payload.decision, 'pending');
  await transition(t.id, 'in_progress');
  const selfDecide = await post(`${P()}/${t.id}/decide`, { approved: true }, adminSecret);
  assert.equal(selfDecide.status, 403);
  const r = await post(`${P()}/${t.id}/decide`, { approved: true, note: '同意' }, admin2Secret);
  assert.equal(r.status, 200);
  const d = (await r.json()).data;
  assert.equal(d.status, 'resolved');
  assert.equal(d.payload.decision, 'approved');
  assert.equal(d.payload.decided_by, admin2Id);
  // 重复决议幂等
  const r2 = await post(`${P()}/${t.id}/decide`, { approved: true }, admin2Secret);
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).data.status, 'resolved');
});

test('V4.1：审批单 reject → cancelled', async () => {
  const t = await mkTask({ kind: 'approval', title: '驳回审批' });
  await transition(t.id, 'in_progress');
  const r = await post(`${P()}/${t.id}/decide`, { approved: false, note: '预算不足' }, admin2Secret);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).data.status, 'cancelled');
});

test('V4.1：非审批单 decide → 400', async () => {
  const t = await mkTask({ kind: 'ticket', title: '普通工单' });
  await transition(t.id, 'in_progress');
  assert.equal((await post(`${P()}/${t.id}/decide`, { approved: true }, admin2Secret)).status, 400);
});

test('V4.1：SLA 扫描——超时未终态任务被升级；未超时/已终态/已升级的不动', async () => {
  const overdue = await mkTask({ title: '超时任务', slaHours: 1 });
  const fresh = await mkTask({ title: '未超时任务', slaHours: 72 });
  const done = await mkTask({ title: '已终态任务', slaHours: 1 });
  await transition(done.id, 'cancelled');
  // 人为把 overdue 的 sla_due_at 拨到过去
  const past = Date.now() - 60_000;
  await db().run('UPDATE biz_tasks SET sla_due_at=? WHERE id=?', [past, overdue.id]);
  const r = await post(`${P()}/sla-sweep`, {});
  assert.equal(r.status, 200);
  const { escalated } = (await r.json()).data;
  assert.deepEqual(escalated, [overdue.id]);
  const got = await db().query('SELECT escalated, escalated_at FROM biz_tasks WHERE id=?', [overdue.id]);
  assert.equal(got[0].escalated, 1);
  assert.ok(got[0].escalated_at);
  // 再扫一次：已升级的不重复
  const r2 = await post(`${P()}/sla-sweep`, {});
  assert.deepEqual((await r2.json()).data.escalated, []);
  // 未超时任务未被升级
  const f = await db().query('SELECT escalated FROM biz_tasks WHERE id=?', [fresh.id]);
  assert.equal(f[0].escalated, 0);
});

test('V4.1：列表过滤（status/kind）', async () => {
  await mkTask({ kind: 'doc_task', title: '文档任务A' });
  const docs = (await (await get(`${P()}?kind=doc_task`)).json()).data;
  assert.ok(docs.length >= 1 && docs.every((x) => x.kind === 'doc_task'));
  const open = (await (await get(`${P()}?status=open`)).json()).data;
  assert.ok(open.every((x) => x.status === 'open'));
});

test('V4.1：viewer 可读不可写', async () => {
  assert.equal((await get(P(), viewerSecret)).status, 200);
  assert.equal((await post(P(), { kind: 'ticket', title: 'x' }, viewerSecret)).status, 403);
  const t = await mkTask({ title: 'viewer 流转' });
  assert.equal((await transition(t.id, 'in_progress', '', viewerSecret)).status, 403);
});

test('V4.1：跨租户隔离', async () => {
  const t = await mkTask({ title: '隔离任务' });
  assert.equal((await get(`${P()}/${t.id}`, otherSecret)).status, 403);
  const otherTasks = await get(T(otherProjectId), otherSecret);
  assert.equal(otherTasks.status, 200);
  assert.equal((await otherTasks.json()).data.length, 0);
});

test('V4.1：任务变更进审计链', async () => {
  const t = await mkTask({ kind: 'approval', title: '审计审批' });
  await transition(t.id, 'in_progress');
  await post(`${P()}/${t.id}/decide`, { approved: true }, admin2Secret);
  const rows = async (action) => db().query(
    `SELECT * FROM audit_events WHERE tenant_id=? AND action=? AND resource_id=?`,
    [tenant.id, action, t.id]);
  assert.equal((await rows('biz_task.create')).length, 1);
  assert.equal((await rows('biz_task.transition')).length, 1);
  assert.equal((await rows('biz_task.decide')).length, 1);

  const overdue = await mkTask({ title: '审计升级', slaHours: 1 });
  await db().run('UPDATE biz_tasks SET sla_due_at=? WHERE id=?', [Date.now() - 1000, overdue.id]);
  await post(`${P()}/sla-sweep`, {});
  assert.equal((await rows('biz_task.escalated')).length, 0); // 不同任务
  const er = await db().query(
    `SELECT * FROM audit_events WHERE tenant_id=? AND action='biz_task.escalated' AND resource_id=?`,
    [tenant.id, overdue.id]);
  assert.equal(er.length, 1);
});
