/**
 * tests/alerts.test.mjs —— V2.13：预算/配额告警 webhook
 * - 四个事件（budget.exhausted / ratelimit.hit / invoice.finalized / tenant.suspended）
 *   触发后投递落库、webhook 真实送达、HMAC 可验证
 * - ratelimit.hit 采样节流（60s/租户内只发一次）
 * - 无通道记 skipped；投递失败记 failed；告警链路永远不抛错、不阻塞主流程
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-alerts-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.BOOTSTRAP_ENABLED = 'false';
process.env.NOTIFY_ALLOW_PRIVATE_TARGETS = 'true'; // 测试 webhook 指向 127.0.0.1
process.env.ALERT_TEST_SECRET = 'alertsecret789';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const { provisionTenant } = await import('../src/modules/identity/provision.mjs');
const { createChannel, listDeliveries, verifySignature } = await import('../src/modules/notify/service.mjs');
const alerts = await import('../src/modules/notify/alerts.mjs');
const billing = await import('../src/modules/billing/service.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerNotifyRoutes } = await import('../src/modules/notify/routes.mjs');

const OPERATOR_TOKEN = 'op_test_token';
const SECRET = 'alertsecret789';
let baseUrl, appServer;
const received = []; // { headers, raw }
let hookServer, hookPort;
let tenantA, tenantB, tenantC;
const hookUrl = () => `http://127.0.0.1:${hookPort}/hook`;

before(async () => {
  await openDb();
  await migrate(db());
  const app = createApp();
  registerIdentityRoutes(app);
  registerNotifyRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${appServer.address().port}`;

  hookServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      received.push({ headers: req.headers, raw });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => hookServer.listen(0, '127.0.0.1', r));
  hookPort = hookServer.address().port;

  tenantA = (await provisionTenant({ name: 'Alerts Corp', adminName: 'a-admin' })).tenant.id;
  tenantB = (await provisionTenant({ name: 'No Channel Ltd', adminName: 'b-admin' })).tenant.id;
  tenantC = (await provisionTenant({ name: 'Dead Hook Inc', adminName: 'c-admin' })).tenant.id;
  await createChannel(tenantA, { kind: 'webhook', name: 'ops-hook', target: hookUrl(), secretRef: 'env:ALERT_TEST_SECRET' });
  // tenantC 的通道指向不可达端口（投递失败路径）
  await createChannel(tenantC, { kind: 'webhook', name: 'dead-hook', target: 'http://127.0.0.1:1/hook', secretRef: 'env:ALERT_TEST_SECRET' });
  alerts.clearAlertSamples();
});

after(() => new Promise((r) => hookServer.close(r)));
after(() => new Promise((r) => appServer.close(r)));

const req = async (method, path, body, token = OPERATOR_TOKEN) => {
  const r = await fetch(baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
};
const deliveriesOf = async (tid, intent) =>
  (await listDeliveries(tid, { limit: 200 })).filter((d) => d.intent === intent);
const lastReceived = () => received[received.length - 1];

test('budget.exhausted：投递落库 sent、webhook 送达、HMAC 可验', async () => {
  const r = await alerts.alertBudgetExhausted({
    tenantId: tenantA, reason: '预算不足', remainingCostCents: 0, remainingTokens: 100,
  });
  assert.equal(r.sent, true);

  const ds = await deliveriesOf(tenantA, 'budget.exhausted');
  assert.equal(ds.length, 1);
  assert.equal(ds[0].status, 'sent');

  const hit = lastReceived();
  const parsed = JSON.parse(hit.raw);
  assert.equal(parsed.intent, 'budget.exhausted');
  assert.equal(parsed.remaining_cost_cents, 0);
  const sig = hit.headers['x-deyi-signature'];
  assert.ok(sig, '应携带签名头');
  assert.equal(verifySignature(SECRET, hit.raw, sig), true, 'HMAC 验签应通过');
});

test('ratelimit.hit：60s 窗口内采样节流，只发一次', async () => {
  alerts.clearAlertSamples();
  const first = await alerts.alertRateLimitHit({ tenantId: tenantA, rpm: 60, retryAfterMs: 1000 });
  assert.equal(first.sent, true);
  const second = await alerts.alertRateLimitHit({ tenantId: tenantA, rpm: 60, retryAfterMs: 1000 });
  assert.equal(second.sent, false);
  assert.equal(second.reason, 'sampled');

  const ds = await deliveriesOf(tenantA, 'ratelimit.hit');
  assert.equal(ds.length, 1, '被采样的第二次不应落库');
});

test('invoice.finalized：账单定稿后自动告警，载荷含账单字段', async () => {
  const inv = await billing.generateInvoice(tenantA, '2026-09');
  const fin = await billing.finalizeInvoice(tenantA, inv.id);
  assert.equal(fin.status, 'finalized');

  const ds = await deliveriesOf(tenantA, 'invoice.finalized');
  assert.equal(ds.length, 1);
  assert.equal(ds[0].status, 'sent');
  const hit = lastReceived();
  const parsed = JSON.parse(hit.raw);
  assert.equal(parsed.intent, 'invoice.finalized');
  assert.equal(parsed.invoice_id, inv.id);
  assert.equal(parsed.period_key, '2026-09');
  assert.ok(typeof parsed.total_cents === 'number');
});

test('tenant.suspended：停用路由触发告警，主流程 200 不受影响', async () => {
  const r = await req('POST', `/v1/admin/tenants/${tenantA}/suspend`);
  assert.equal(r.status, 200);
  assert.equal(r.json.data.status, 'suspended');

  const ds = await deliveriesOf(tenantA, 'tenant.suspended');
  assert.equal(ds.length, 1);
  assert.equal(ds[0].status, 'sent');
  const parsed = JSON.parse(lastReceived().raw);
  assert.equal(parsed.intent, 'tenant.suspended');
});

test('无通道租户：记 skipped，不抛错、不静默', async () => {
  const beforeCount = received.length;
  const r = await alerts.alertBudgetExhausted({ tenantId: tenantB, reason: '预算不足' });
  assert.equal(r.sent, true); // sendNotification 执行成功（skipped 也是一种确定性结果）
  const ds = await deliveriesOf(tenantB, 'budget.exhausted');
  assert.equal(ds.length, 1);
  assert.equal(ds[0].status, 'skipped');
  assert.equal(received.length, beforeCount, '无通道时不应有真实投递');
});

test('投递失败：记 failed，告警链路不抛错', async () => {
  const r = await alerts.alertBudgetExhausted({ tenantId: tenantC, reason: '预算不足' });
  assert.equal(r.sent, true);
  const ds = await deliveriesOf(tenantC, 'budget.exhausted');
  assert.equal(ds.length, 1);
  assert.equal(ds[0].status, 'failed');
  assert.ok(ds[0].last_error, '失败原因应记入 ledger');
});

test('未知 intent：返回 unknown-intent，不抛错', async () => {
  const r = await alerts.emitAlert({ tenantId: tenantA, intent: 'nope.xyz', title: 'x', body: 'y' });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'unknown-intent');
});

test('热路径 fire-and-forget：不等待也不产生未处理拒绝', async () => {
  alerts.clearAlertSamples();
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on('unhandledRejection', onUnhandled);
  try {
    // 模拟网关 429 热路径：void 调用，不 await
    void alerts.alertRateLimitHit({ tenantId: tenantC, rpm: 60 });
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.equal(unhandled, 0, '不应有未处理的 promise 拒绝');
  const ds = await deliveriesOf(tenantC, 'ratelimit.hit');
  assert.equal(ds.length, 1, '后台仍应完成投递记账（失败记 failed）');
});
