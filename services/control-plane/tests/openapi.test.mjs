/**
 * tests/openapi.test.mjs —— V2.9：OpenAPI 规范 contract 测试。
 * - 规范由运行时路由表生成；本测试保障"路由表 ⊆ 规范 ⊆ 路由表"双向一致，
 *   新增路由未进规范（或规范中有幽灵路径）即失败，防止文档漂移。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-openapi-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.BOOTSTRAP_ENABLED = 'false';

const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerGatewayRoutes } = await import('../src/modules/gateway/routes.mjs');
const { registerKnowledgeRoutes } = await import('../src/modules/knowledge/routes.mjs');
const { registerOntologyRoutes } = await import('../src/modules/ontology/routes.mjs');
const { registerExecutionRoutes } = await import('../src/modules/execution/routes.mjs');
const { registerEvidenceRoutes } = await import('../src/modules/evidence/routes.mjs');
const { registerDeliveryRoutes } = await import('../src/modules/delivery/routes.mjs');
const { registerBusinessRoutes } = await import('../src/modules/business/routes.mjs');
const { registerNotifyRoutes } = await import('../src/modules/notify/routes.mjs');
const { registerMemoryRoutes } = await import('../src/modules/memory/routes.mjs');
const { registerBillingRoutes } = await import('../src/modules/billing/routes.mjs');
const { registerOpenApiRoutes, OPENAPI_PATH } = await import('../src/modules/openapi/routes.mjs');

const OPERATOR_TOKEN = 'op_test_token';
let base;
let server;
let app;

before(async () => {
  app = createApp();
  // 与 src/index.mjs 同序注册全部业务路由（路由表必须完整，contract 才有意义）
  registerIdentityRoutes(app);
  registerGatewayRoutes(app);
  registerKnowledgeRoutes(app);
  registerOntologyRoutes(app);
  registerExecutionRoutes(app);
  registerEvidenceRoutes(app);
  registerDeliveryRoutes(app);
  registerBusinessRoutes(app);
  registerNotifyRoutes(app);
  registerMemoryRoutes(app);
  registerBillingRoutes(app);
  registerOpenApiRoutes(app);
  server = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const get = async (token) => {
  const r = await fetch(base + OPENAPI_PATH, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: r.status, json: await r.json() };
};

const toOpenApiPath = (p) => p.replace(/:([a-zA-Z_]+)/g, '{$1}');

test('未认证 → 401；规范不公开', async () => {
  const { status } = await get(null);
  assert.equal(status, 401);
});

test('规范是合法的 OpenAPI 3.x 文档', async () => {
  const { status, json } = await get(OPERATOR_TOKEN);
  assert.equal(status, 200);
  assert.match(json.openapi, /^3\./);
  assert.ok(json.info?.title, 'info.title 必填');
  assert.ok(json.info?.version, 'info.version 必填');
  assert.ok(json.paths && Object.keys(json.paths).length > 50, '路径数应与路由规模相当');
  assert.ok(json.components?.securitySchemes?.bearerAuth, '需声明 bearer 鉴权');
});

test('双向一致：路由表 ⊆ 规范 ⊆ 路由表（防漂移）', async () => {
  const { json: spec } = await get(OPERATOR_TOKEN);
  const live = app.routes().filter((r) => r.path !== OPENAPI_PATH);
  // 方向一：每条真实路由都在规范里
  for (const r of live) {
    const p = toOpenApiPath(r.path);
    const entry = spec.paths[p]?.[r.method.toLowerCase()];
    assert.ok(entry, `路由缺失于规范: ${r.method} ${r.path}`);
  }
  // 方向二：规范里没有幽灵路径
  const liveSet = new Set(live.map((r) => `${r.method} ${toOpenApiPath(r.path)}`));
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const m of Object.keys(item)) {
      assert.ok(liveSet.has(`${m.toUpperCase()} ${p}`), `规范中有幽灵路径: ${m.toUpperCase()} ${p}`);
    }
  }
});

test('路径参数正确转换且标记 required', async () => {
  const { json: spec } = await get(OPERATOR_TOKEN);
  const op = spec.paths['/v1/admin/tenants/{tenantId}']?.patch;
  assert.ok(op, '应有 /v1/admin/tenants/{tenantId} PATCH');
  const param = (op.parameters || []).find((x) => x.name === 'tenantId');
  assert.ok(param && param.in === 'path' && param.required === true);
});

test('鉴权标注与中间件链一致（抽查）', async () => {
  const { json: spec } = await get(OPERATOR_TOKEN);
  const provision = spec.paths['/v1/admin/tenants/provision']?.post;
  assert.ok(provision['x-deyi-auth'].includes('operator'), 'provision 应标注 operator');
  assert.ok(provision.security?.length, '需认证的接口应有 security');
  const me = spec.paths['/v1/me']?.get;
  assert.ok(me['x-deyi-auth'].includes('authenticated'));
  assert.ok(!me['x-deyi-auth'].includes('operator'), '/v1/me 不应要求 operator');
  const remember = spec.paths['/v1/tenants/{tenantId}/memory']?.post;
  assert.ok(remember['x-deyi-auth'].some((x) => x.startsWith('scopes:') && x.includes('memory.write')),
    '记忆写入应标注 memory.write scope');
});

test('所有 operation 都有 tag', async () => {
  const { json: spec } = await get(OPERATOR_TOKEN);
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const [m, op] of Object.entries(item)) {
      assert.ok(Array.isArray(op.tags) && op.tags.length > 0, `${m.toUpperCase()} ${p} 缺少 tag`);
      assert.ok(op.operationId, `${m.toUpperCase()} ${p} 缺少 operationId`);
    }
  }
});
