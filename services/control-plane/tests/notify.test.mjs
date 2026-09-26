/**
 * tests/notify.test.mjs —— V2.1-C：通知通道（webhook 真实投递）
 * - 通道 CRUD（租户 admin），secret_ref 只存引用、回显不泄露
 * - SSRF 防护：默认拒绝私网/回环目标
 * - 真实 POST 到本地 webhook：签名可验、delivery 账本 sent/failed/skipped
 * - 对账升级走真实通知；载荷脱敏；跨租户隔离
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-notify-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.BOOTSTRAP_ENABLED = 'false';
process.env.NOTIFY_ALLOW_PRIVATE_TARGETS = 'true'; // 测试 webhook 指向 127.0.0.1
process.env.NOTIFY_TEST_SECRET = 'testsecret123';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const { provisionTenant } = await import('../src/modules/identity/provision.mjs');
const notify = await import('../src/modules/notify/service.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerNotifyRoutes } = await import('../src/modules/notify/routes.mjs');

const OPERATOR_TOKEN = 'op_test_token';
let baseUrl, appServer;

// ---- 本地 webhook 接收器 ----
const received = [];
let hookServer, hookPort;
const rawBodies = new Map(); // deliveryId -> raw body（验签用）

let tenantA, keyA; // 有通道的租户
const hookUrl = () => `http://127.0.0.1:${hookPort}/hook`;

// 注意：node:test 的多个 before hook 是并发执行的，DB 初始化必须放在同一个 before 里串行
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
      try {
        const body = JSON.parse(raw);
        if (body.delivery_id) rawBodies.set(body.delivery_id, raw);
      } catch { /* ignore */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => hookServer.listen(0, '127.0.0.1', r));
  hookPort = hookServer.address().port;

  const out = await provisionTenant({ name: 'Notify Corp', adminName: 'n-admin' });
  tenantA = out.tenant.id;
  keyA = out.apiKey.key;
});

after(() => new Promise((r) => hookServer.close(r)));
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

test('建 webhook 通道：201，secret 引用只回显存在性', async () => {
  const { status, json } = await req('POST', `/v1/tenants/${tenantA}/notify/channels`, {
    kind: 'webhook', name: 'ops-hook', target: hookUrl(), secretRef: 'env:NOTIFY_TEST_SECRET',
  }, keyA);
  assert.equal(status, 201);
  assert.ok(json.data.id.startsWith('nch_'));
  assert.equal(json.data.has_secret, undefined); // create 回显 secret_ref:'[ref]'
  assert.equal(json.data.secret_ref, '[ref]');
  assert.ok(!JSON.stringify(json.data).includes('testsecret123'), '响应不得泄露密钥');

  const list = await req('GET', `/v1/tenants/${tenantA}/notify/channels`, undefined, keyA);
  assert.equal(list.status, 200);
  assert.equal(list.json.data.length, 1);
  assert.equal(list.json.data[0].has_secret, true);
  assert.ok(!('secret_ref' in list.json.data[0]), '列表不得回显 secret_ref');
});

test('secret_ref 指向不存在的 env → 400（fail-fast，不存坏引用）', async () => {
  const r = await req('POST', `/v1/tenants/${tenantA}/notify/channels`, {
    kind: 'webhook', name: 'bad-ref', target: hookUrl(), secretRef: 'env:NOTIFY_NO_SUCH_VAR',
  }, keyA);
  assert.equal(r.status, 400);
  assert.equal(r.json.error.details.code, 'SECRET_UNRESOLVED');
});

test('未实现的 kind（email）→ 400，不接受摆设通道', async () => {
  const r = await req('POST', `/v1/tenants/${tenantA}/notify/channels`, {
    kind: 'email', name: 'mail', target: 'mailto:a@b.c',
  }, keyA);
  assert.equal(r.status, 400);
  assert.equal(r.json.error.details.code, 'CHANNEL_KIND_UNSUPPORTED');
});

test('SSRF：默认（不放行私网）127.0.0.1 目标被拒；非 http 协议被拒', async () => {
  // config 对象被冻结，默认拒绝路径走子进程验证（子进程 env 不设 NOTIFY_ALLOW_PRIVATE_TARGETS）
  const { execFileSync } = await import('node:child_process');
  const script = `
    const { assertSafeTarget } = await import('/home/hatch/workspace/deyi-platform/services/control-plane/src/modules/notify/service.mjs');
    try {
      await assertSafeTarget('http://127.0.0.1:9/x');
      console.log('NOT_BLOCKED');
    } catch (e) { console.log('BLOCKED:' + (e.details && e.details.code)); }
    try {
      await assertSafeTarget('gopher://127.0.0.1:70/x');
      console.log('GOPHER_NOT_BLOCKED');
    } catch (e) { console.log('GOPHER_BLOCKED'); }
  `;
  const env = { ...process.env };
  delete env.NOTIFY_ALLOW_PRIVATE_TARGETS;
  const out = execFileSync('node', ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.ok(out.includes('BLOCKED:SSRF_BLOCKED'), `私网目标默认应被拒，实际: ${out}`);
  assert.ok(out.includes('GOPHER_BLOCKED'), '非 http 协议应被拒');
});

test('连通性测试：真实 POST，签名可验，delivery=sent', async () => {
  const list = await req('GET', `/v1/tenants/${tenantA}/notify/channels`, undefined, keyA);
  const chId = list.json.data[0].id;
  received.length = 0;

  const { status, json } = await req('POST', `/v1/tenants/${tenantA}/notify/channels/${chId}/test`, {}, keyA);
  assert.equal(status, 200);
  assert.equal(json.data.delivered, true);

  assert.equal(received.length, 1, '本地 webhook 应收到 1 条 POST');
  const hit = received[0];
  assert.ok(hit.headers['x-deyi-signature'], '应带签名头');
  assert.equal(hit.headers['x-deyi-intent'], 'notify.test');
  const body = JSON.parse(hit.raw);
  assert.ok(notify.verifySignature('testsecret123', hit.raw, hit.headers['x-deyi-signature']),
    'HMAC-SHA256 签名应对原始 body 可验');
  assert.equal(body.tenant_id, tenantA);

  const dl = await req('GET', `/v1/tenants/${tenantA}/notify/deliveries`, undefined, keyA);
  assert.equal(dl.status, 200);
  assert.equal(dl.json.data[0].status, 'sent');
  assert.equal(dl.json.data[0].intent, 'notify.test');
});

test('不可达目标 → delivery=failed，last_error 留痕，不抛 500', async () => {
  const c = await req('POST', `/v1/tenants/${tenantA}/notify/channels`, {
    kind: 'webhook', name: 'dead-hook', target: 'http://127.0.0.1:9/unreachable',
  }, keyA);
  assert.equal(c.status, 201);
  const out = await notify.sendNotification({
    tenantId: tenantA, channelId: c.json.data.id,
    intent: 'notify.test', title: 't', body: 'b',
  });
  assert.equal(out.delivered, false);
  assert.equal(out.results[0].ok, false);
  assert.ok(out.results[0].error, '失败原因应留痕');

  const dl = await req('GET', `/v1/tenants/${tenantA}/notify/deliveries?limit=1`, undefined, keyA);
  assert.equal(dl.json.data[0].status, 'failed');
  assert.ok(dl.json.data[0].last_error);

  await req('DELETE', `/v1/tenants/${tenantA}/notify/channels/${c.json.data.id}`, undefined, keyA);
});

test('无通道租户 → skipped（显式不静默）', async () => {
  const out = await provisionTenant({ name: 'No Channel Co', adminName: 'nc-admin' });
  const r = await notify.sendNotification({
    tenantId: out.tenant.id, intent: 'notify.test', title: 't', body: 'b',
  });
  assert.equal(r.delivered, false);
  assert.equal(r.reason, 'no-channel-configured');
  const rows = await db().query("SELECT * FROM notify_deliveries WHERE tenant_id=? AND status='skipped'", [out.tenant.id]);
  assert.equal(rows.length, 1);
});

test('对账升级通知：intent 正确，载荷脱敏', async () => {
  received.length = 0;
  const out = await notify.notifyReconEscalated({
    tenantId: tenantA, projectId: 'prj_x',
    recon: { id: 'brec_test1', source: 'verify' },
    assignee: 'oncall-zhang',
  });
  assert.equal(out.delivered, true);
  const hit = received.find((x) => {
    try { return JSON.parse(x.raw).intent === 'reconciliation.escalated'; } catch { return false; }
  });
  assert.ok(hit, '应收到 reconciliation.escalated');
  const body = JSON.parse(hit.raw);
  assert.equal(body.assignee, 'oncall-zhang');
  assert.equal(body.reconciliation_id, 'brec_test1');

  // 脱敏：extra 里疑似密钥字段被 [redacted]
  received.length = 0;
  await notify.sendNotification({
    tenantId: tenantA, intent: 'notify.test', title: 't', body: 'b',
    extra: { api_token: 'supersecret', normal: 'visible' },
  });
  const hit2 = received[0];
  const b2 = JSON.parse(hit2.raw);
  assert.equal(b2.api_token, '[redacted]');
  assert.equal(b2.normal, 'visible');
  assert.ok(!hit2.raw.includes('supersecret'), '原始密钥不得出现在投递载荷');
});

test('跨租户隔离：B 租户 admin 建通道到 A 租户 → 403', async () => {
  const outB = await provisionTenant({ name: 'Tenant B', adminName: 'b-admin' });
  const r = await req('POST', `/v1/tenants/${tenantA}/notify/channels`, {
    kind: 'webhook', name: 'evil', target: hookUrl(),
  }, outB.apiKey.key);
  assert.equal(r.status, 403);
});

test('停用通道后不再投递', async () => {
  const list = await req('GET', `/v1/tenants/${tenantA}/notify/channels`, undefined, keyA);
  const ch = list.json.data.find((x) => x.name === 'ops-hook');
  const upd = await req('PATCH', `/v1/tenants/${tenantA}/notify/channels/${ch.id}`, { status: 'disabled' }, keyA);
  assert.equal(upd.status, 200);
  assert.equal(upd.json.data.status, 'disabled');

  const out = await notify.sendNotification({
    tenantId: tenantA, channelId: ch.id, intent: 'notify.test', title: 't', body: 'b',
  }).catch((e) => ({ thrown: e }));
  assert.ok(out.thrown, '停用的通道应 404');
  assert.equal(out.thrown.status, 404);
});
