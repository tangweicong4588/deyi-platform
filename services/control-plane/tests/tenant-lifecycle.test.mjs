/**
 * tests/tenant-lifecycle.test.mjs —— V2.1-B：租户生命周期与 SaaS 运营面
 * - 原子开通：租户+项目+管理员+角色+Key 一次建成
 * - 停用：租户 API Key 立即 401；恢复后可用
 * - 配额：trial 超限 403 QUOTA_EXCEEDED；升级套餐后放行；quotas 可单独覆盖
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-tenant-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.BOOTSTRAP_ENABLED = 'false';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { provisionTenant } = await import('../src/modules/identity/provision.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');

const OPERATOR_TOKEN = 'op_test_token';
let baseUrl;
let appServer;

before(async () => {
  await openDb();
  await migrate(db());
  const app = createApp();
  registerIdentityRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${appServer.address().port}`;
});

after(() => new Promise((r) => appServer.close(r)));

const req = async (method, path, body, token = OPERATOR_TOKEN) => {
  const r = await fetch(baseUrl + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
};

test('原子开通：一次调用建成租户/项目/管理员/角色/Key', async () => {
  const out = await provisionTenant({
    name: 'Acme Corp', plan: 'professional',
    adminName: 'acme-admin', adminEmail: 'admin@acme.example',
  });
  assert.equal(out.tenant.plan, 'professional');
  assert.ok(out.tenant.id.startsWith('ten_'));
  assert.equal(out.project.tenant_id, out.tenant.id);
  assert.equal(out.actor.tenant_id, out.tenant.id);
  assert.ok(out.apiKey.key, 'secret 只返回一次');
  assert.ok(!('key_hash' in out.apiKey), '响应不得含 key_hash');

  const bindings = await store.getRoleBindings(out.tenant.id, out.actor.id);
  assert.ok(bindings.some((b) => b.role === 'admin' && !b.project_id), '管理员应有租户级 admin');

  // 开通的 key 真实可用
  const me = await req('GET', '/v1/me', undefined, out.apiKey.key);
  assert.equal(me.status, 200);
  assert.equal(me.json.data.tenant.id, out.tenant.id);
});

test('开通是原子的：slug 冲突时不留半成品租户', async () => {
  await provisionTenant({ name: 'Dup One', slug: 'dup-slug' });
  const beforeCount = (await store.listTenants()).length;
  await assert.rejects(
    provisionTenant({ name: 'Dup Two', slug: 'dup-slug' }),
    (e) => e.status === 409 || /已存在/.test(e.message));
  const afterCount = (await store.listTenants()).length;
  assert.equal(afterCount, beforeCount, '冲突开通不得留下新租户（事务回滚）');
});

test('HTTP 原子开通端点（operator）', async () => {
  const { status, json } = await req('POST', '/v1/admin/tenants/provision', {
    name: 'HTTP Corp', adminName: 'http-admin',
  });
  assert.equal(status, 201);
  assert.ok(json.data.apiKey.key);
});

test('停用租户：其 API Key 立即 401；恢复后可用', async () => {
  const out = await provisionTenant({ name: 'Suspend Me', adminName: 's-admin' });
  const key = out.apiKey.key;

  let me = await req('GET', '/v1/me', undefined, key);
  assert.equal(me.status, 200);

  const sus = await req('POST', `/v1/admin/tenants/${out.tenant.id}/suspend`, {});
  assert.equal(sus.status, 200);
  assert.equal(sus.json.data.status, 'suspended');

  me = await req('GET', '/v1/me', undefined, key);
  assert.equal(me.status, 401, '停用租户的 key 必须立即失效');

  // 停用期间用该租户 key 新建项目也被拒绝（fail-closed）
  const blocked = await req('POST', `/v1/admin/tenants/${out.tenant.id}/projects`,
    { name: 'nope' }, key);
  assert.ok([401, 403].includes(blocked.status), '停用租户不得新建资源');

  const res = await req('POST', `/v1/admin/tenants/${out.tenant.id}/resume`, {});
  assert.equal(res.status, 200);
  assert.equal(res.json.data.status, 'active');

  me = await req('GET', '/v1/me', undefined, key);
  assert.equal(me.status, 200, '恢复后 key 可用');
});

test('配额：trial 建第 6 个项目 → 403 QUOTA_EXCEEDED；升级 professional 后放行', async () => {
  const out = await provisionTenant({ name: 'Quota Corp', plan: 'trial', adminName: 'q-admin' });
  const tid = out.tenant.id;
  // 开通已建 1 个（default），再建 4 个到上限 5
  for (let i = 0; i < 4; i++) {
    await store.createProject(tid, { name: `p${i}` });
  }
  await assert.rejects(store.createProject(tid, { name: 'overflow' }),
    (e) => e.details?.code === 'QUOTA_EXCEEDED' || /配额/.test(e.message));

  // 升级套餐放行
  const upd = await req('PATCH', `/v1/admin/tenants/${tid}`, { plan: 'professional' });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.data.plan, 'professional');
  const p = await store.createProject(tid, { name: 'after-upgrade' });
  assert.ok(p.id.startsWith('prj_'));

  // quotas 可单独覆盖（不升级套餐也能调）
  const q2 = await req('PATCH', `/v1/admin/tenants/${tid}`, { quotas: { max_projects: 100 } });
  assert.equal(q2.status, 200);
  const quotas = store.getTenantQuotas(await store.getTenant(tid));
  assert.equal(quotas.max_projects, 100);
});

test('配额经 HTTP 也强制（租户 admin 建项目超限 → 403）', async () => {
  const out = await provisionTenant({
    name: 'Quota HTTP', plan: 'trial', quotas: { max_projects: 1 }, adminName: 'qh-admin',
  });
  // 开通已占 1 个项目额度，再建即超限
  const r = await req('POST', `/v1/admin/tenants/${out.tenant.id}/projects`,
    { name: 'second' }, out.apiKey.key);
  assert.equal(r.status, 403);
  assert.equal(r.json.error.details.code, 'QUOTA_EXCEEDED');
});

test('非法套餐被拒绝；suspend 状态机', async () => {
  const bad = await req('POST', '/v1/admin/tenants', { name: 'Bad Plan', plan: 'ultimate' });
  assert.equal(bad.status, 400);
  // 格式非法的 ID → 400（不 500）
  const malformed = await req('POST', '/v1/admin/tenants/ten_nonexistent/suspend', {});
  assert.equal(malformed.status, 400);
  // 格式合法但不存在的 ID → 404
  const ghost = await req('POST', '/v1/admin/tenants/ten_00000000000000000000000000/suspend', {});
  assert.equal(ghost.status, 404);
});
