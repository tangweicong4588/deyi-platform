/**
 * tests/apikey-iprestrict.test.mjs —— V2.14：API Key 级 IP 白名单 + 用途备注
 * - 签发时设白名单/备注；白名单内外各一例（403 IP_NOT_ALLOWED vs 200）
 * - 历史 key（空名单）不受影响；非法 CIDR 签发 400
 * - PATCH 更新白名单/备注；轮换继承白名单/备注
 * - TRUST_PROXY=true 时 XFF 生效；resolveClientIp 不信任时代理头被忽略
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-ipr-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.BOOTSTRAP_ENABLED = 'false';
process.env.TRUST_PROXY = 'true'; // 测试 XFF 采信路径；不信任路径走纯函数单测

const { openDb } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const { db } = await import('../src/db/index.mjs');
const { provisionTenant } = await import('../src/modules/identity/provision.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const ipallow = await import('../src/modules/identity/ipallow.mjs');

const OPERATOR_TOKEN = 'op_test_token';
let baseUrl, appServer;
let tenantId, actorId, adminKey;

before(async () => {
  await openDb();
  await migrate(db());
  const app = createApp();
  registerIdentityRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${appServer.address().port}`;

  const out = await provisionTenant({ name: 'IPR Corp', adminName: 'ipr-admin' });
  tenantId = out.tenant.id;
  actorId = out.actor.id;
  adminKey = out.apiKey.key;
});

after(() => new Promise((r) => appServer.close(r)));

const req = async (method, path, body, token, extraHeaders = {}) => {
  const r = await fetch(baseUrl + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
};
const issueKey = (body) =>
  req('POST', `/v1/admin/tenants/${tenantId}/api-keys`, { actorId, name: 'k-' + Math.random().toString(36).slice(2, 8), ...body }, adminKey);

test('签发带白名单+备注的 key：201，名单 canonical 化，备注回显', async () => {
  const { status, json } = await issueKey({ ipAllowlist: ['127.0.0.1', '10.0.0.0/24'], note: '仅办公网' });
  assert.equal(status, 201);
  assert.deepEqual(json.data.ip_allowlist, ['127.0.0.1/32', '10.0.0.0/24']);
  assert.equal(json.data.note, '仅办公网');
  assert.ok(json.data.key.startsWith('dyk_'));

  const list = await req('GET', `/v1/admin/tenants/${tenantId}/api-keys`, undefined, adminKey);
  const row = list.json.data.find((k) => k.id === json.data.id);
  assert.deepEqual(row.ip_allowlist, ['127.0.0.1/32', '10.0.0.0/24']);
  assert.equal(row.note, '仅办公网');
});

test('白名单内（127.0.0.1/32）：200 放行', async () => {
  const { json } = await issueKey({ ipAllowlist: ['127.0.0.1/32'] });
  const r = await req('GET', '/v1/me', undefined, json.data.key);
  assert.equal(r.status, 200);
  assert.equal(r.json.data.authKind, 'api_key');
});

test('白名单外（10.0.0.0/8）：403 IP_NOT_ALLOWED', async () => {
  const { json } = await issueKey({ ipAllowlist: ['10.0.0.0/8'] });
  const r = await req('GET', '/v1/me', undefined, json.data.key);
  assert.equal(r.status, 403);
  assert.equal(r.json.error.details.code, 'IP_NOT_ALLOWED');
});

test('历史 key（空名单）：不受影响，200', async () => {
  const r = await req('GET', '/v1/me', undefined, adminKey);
  assert.equal(r.status, 200);
});

test('非法 CIDR / 超限 / IPv6 CIDR：签发 400', async () => {
  for (const bad of [['999.1.1.1/24'], ['10.0.0.0/33'], ['not-an-ip'], ['2001:db8::/32']]) {
    const r = await issueKey({ ipAllowlist: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  const tooMany = Array.from({ length: 33 }, (_, i) => `10.${i}.0.1`);
  const r2 = await issueKey({ ipAllowlist: tooMany });
  assert.equal(r2.status, 400);
});

test('PATCH 更新白名单：从拒绝变为放行；备注可更新', async () => {
  const { json } = await issueKey({ ipAllowlist: ['10.0.0.0/8'], note: '旧备注' });
  const key = json.data.key;
  const keyId = json.data.id;
  assert.equal((await req('GET', '/v1/me', undefined, key)).status, 403);

  const p = await req('PATCH', `/v1/admin/tenants/${tenantId}/api-keys/${keyId}`,
    { ipAllowlist: ['127.0.0.0/8'], note: '新备注' }, adminKey);
  assert.equal(p.status, 200);
  assert.deepEqual(p.json.data.ip_allowlist, ['127.0.0.0/8']);
  assert.equal(p.json.data.note, '新备注');
  assert.equal((await req('GET', '/v1/me', undefined, key)).status, 200);

  // 清空名单 = 回到不限制
  const p2 = await req('PATCH', `/v1/admin/tenants/${tenantId}/api-keys/${keyId}`, { ipAllowlist: [] }, adminKey);
  assert.equal(p2.status, 200);
  assert.deepEqual(p2.json.data.ip_allowlist, []);
});

test('TRUST_PROXY=true 时 XFF 生效：伪造来源 IP 可放行/被拒', async () => {
  const { json } = await issueKey({ ipAllowlist: ['10.9.9.9'] });
  const key = json.data.key;
  // XFF 声明 10.9.9.9 → 在白名单内 → 放行（证明采信了 XFF）
  const ok = await req('GET', '/v1/me', undefined, key, { 'x-forwarded-for': '10.9.9.9' });
  assert.equal(ok.status, 200);
  // 不带 XFF → 来源为直连 socket（127.0.0.1）→ 拒绝
  const no = await req('GET', '/v1/me', undefined, key);
  assert.equal(no.status, 403);
});

test('resolveClientIp：不信任时代理头被忽略；IP 归一化', () => {
  const fake = (headers, remote) => ({ headers, socket: { remoteAddress: remote } });
  assert.equal(
    ipallow.resolveClientIp(fake({ 'x-forwarded-for': '9.9.9.9' }, '1.2.3.4'), false), '1.2.3.4');
  assert.equal(
    ipallow.resolveClientIp(fake({ 'x-forwarded-for': '9.9.9.9, 1.1.1.1' }, '1.2.3.4'), true), '9.9.9.9');
  assert.equal(ipallow.normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(ipallow.ipAllowed('127.0.0.1', ['127.0.0.0/8']), true);
  assert.equal(ipallow.ipAllowed('128.0.0.1', ['127.0.0.0/8']), false);
  assert.equal(ipallow.ipAllowed(null, ['127.0.0.0/8']), false, '取不到来源 IP 时 fail-closed');
  assert.equal(ipallow.ipAllowed('1.2.3.4', []), true, '空名单不限制');
});

test('轮换继承白名单与备注', async () => {
  const { json } = await issueKey({ ipAllowlist: ['127.0.0.1/32'], note: '轮换继承检查' });
  const r = await req('POST', `/v1/admin/tenants/${tenantId}/api-keys/${json.data.id}/rotate`, { graceHours: 1 }, adminKey);
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.data.newKey.ip_allowlist, ['127.0.0.1/32']);
  assert.equal(r.json.data.newKey.note, '轮换继承检查');
  // 新 key 在白名单内仍可放行
  const me = await req('GET', '/v1/me', undefined, r.json.data.newKey.secret);
  assert.equal(me.status, 200);
});
