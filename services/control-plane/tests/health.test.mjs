/**
 * tests/health.test.mjs —— V2.11 健康检查与就绪探针。
 * - /healthz：200，轻量（形状断言；不碰 DB 由实现保证——liveness() 无任何 I/O）。
 * - /readyz：DB 可写探测通过 → 200；readiness_probe 单行 upsert（幂等）。
 * - 未配置的适配器 → unknown，且不阻塞 ready（HTTP 仍 200）。
 * - DB 断开 → 503（unit + HTTP 注入两层）。
 * - pingHttp / pingTcp：up 与 down 两条路径（fake server / 拒绝连接）。
 * - cachedCheck：10s 缓存语义（二次调用不重复执行 run）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import http from 'node:http';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-health-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.DEV_IDP_SECRET = 'test-dev-idp-secret';
process.env.BOOTSTRAP_ENABLED = 'false';
// 故意不设 QDRANT_URL / DOCLING_URL / TEMPORAL_ADDRESS / LITELLM_URL / OPA_URL / AUDIT_ANCHOR_URL，
// 覆盖"未配置依赖 → unknown 且不阻塞 ready"路径。

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const health = await import('../src/kernel/health.mjs');
const { registerHealthRoutes, checkReadiness, probeDbWritable, pingHttp, pingTcp, cachedCheck, liveness, __clearProbeCache } = health;

let base, httpServer;

before(async () => {
  await openDb();
  await migrate(db());
  const app = createApp();
  registerHealthRoutes(app);
  httpServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${httpServer.address().port}`;
});
after(() => new Promise((r) => httpServer.close(r)));

const get = (path) => fetch(base + path);

test('/healthz 返回 200 且形状正确（轻量存活）', async () => {
  const r = await get('/healthz');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.status, 'ok');
  assert.ok(j.version, '应带版本号');
  assert.ok(Number.isInteger(j.uptime_s), '应带 uptime');
});

test('/readyz：DB 可写探测通过 → 200，checks.database=up', async () => {
  const r = await get('/readyz');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.status, 'ready');
  assert.equal(j.checks.database.status, 'up');
  assert.ok(j.checks.database.latency_ms >= 0);
  assert.ok(j.adapters, '保留 legacy adapters 字段');
  assert.equal(j.adapters.idp, 'local-idp');
});

test('readiness_probe 单行 upsert：写探测落库且幂等', async () => {
  await get('/readyz');
  const rows1 = await db().query('SELECT id, checked_at FROM readiness_probe');
  assert.equal(rows1.length, 1);
  assert.equal(rows1[0].id, 1);
  const t1 = rows1[0].checked_at;
  assert.ok(Date.now() - t1 < 10_000, 'checked_at 应为近期时间戳');
  await new Promise((r) => setTimeout(r, 2));
  await get('/readyz');
  const rows2 = await db().query('SELECT id, checked_at FROM readiness_probe');
  assert.equal(rows2.length, 1, '多次探测仍只有一行（upsert 非 insert）');
  assert.ok(rows2[0].checked_at >= t1, '第二次探测应更新时间戳');
});

test('未配置的适配器 → unknown，且不阻塞 ready（仍 200）', async () => {
  __clearProbeCache();
  const r = await checkReadiness();
  assert.equal(r.ready, true);
  for (const name of ['vector', 'doc_parse', 'workflow', 'model_gateway', 'policy', 'oidc', 'audit_anchor']) {
    assert.equal(r.checks[name].status, 'unknown', `${name} 未配置应为 unknown`);
    assert.equal(r.checks[name].reason, 'not-configured');
  }
  const httpRes = await get('/readyz');
  assert.equal(httpRes.status, 200);
});

test('DB 断开 → checkReadiness 返回 ready=false，database=down', async () => {
  const failing = {
    query: async () => { throw new Error('connection refused'); },
  };
  const r = await checkReadiness(failing);
  assert.equal(r.ready, false);
  assert.equal(r.checks.database.status, 'down');
  assert.ok(r.db_error.includes('connection refused'));
  // 适配器检查仍照常执行（不因 DB 故障跳过）
  assert.equal(r.checks.vector.status, 'unknown');
});

test('/readyz：readiness 注入失败 → HTTP 503 + not-ready', async () => {
  const app = createApp();
  registerHealthRoutes(app, {
    readiness: async () => ({
      ready: false,
      db_error: 'db unreachable',
      checks: { database: { name: 'database', status: 'down', error: 'db unreachable' } },
      adapters: {},
    }),
  });
  const srv = await app.listen(0, '127.0.0.1');
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/readyz`);
    assert.equal(r.status, 503);
    const j = await r.json();
    assert.equal(j.status, 'not-ready');
    assert.equal(j.checks.database.status, 'down');
  } finally {
    await new Promise((res) => srv.close(res));
  }
});

test('pingHttp：fake server 200 → up；拒绝连接 → down', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/health`;
  try {
    const up = await pingHttp('t', url);
    assert.equal(up.status, 'up');
    assert.ok(up.latency_ms >= 0);
  } finally {
    await new Promise((r) => srv.close(r));
  }
  const down = await pingHttp('t', 'http://127.0.0.1:1/health');
  assert.equal(down.status, 'down');
  assert.ok(down.error, 'down 应带错误信息');
});

test('pingTcp：fake TCP server → up；拒绝连接 → down', async () => {
  const srv = net.createServer(() => {});
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const up = await pingTcp('t', `127.0.0.1:${port}`);
    assert.equal(up.status, 'up');
  } finally {
    await new Promise((r) => srv.close(r));
  }
  const down = await pingTcp('t', '127.0.0.1:1');
  assert.equal(down.status, 'down');
});

test('cachedCheck：未配置 → unknown 不执行 run；配置后 10s 内缓存', async () => {
  __clearProbeCache();
  let runs = 0;
  const run = async () => { runs++; return { name: 't', status: 'up' }; };
  const u = await cachedCheck('cache-t', false, run);
  assert.equal(u.status, 'unknown');
  assert.equal(runs, 0, '未配置不应执行 run');
  const r1 = await cachedCheck('cache-t', true, run);
  assert.equal(r1.status, 'up');
  assert.equal(runs, 1);
  const r2 = await cachedCheck('cache-t', true, run);
  assert.equal(r2.status, 'up');
  assert.equal(runs, 1, '缓存期内不应重复执行 run');
  __clearProbeCache();
  await cachedCheck('cache-t', true, run);
  assert.equal(runs, 2, '清缓存后应重新执行');
});

test('probeDbWritable 直接调用：真实 DB 可写', async () => {
  const r = await probeDbWritable(db());
  assert.equal(r.name, 'database');
  assert.equal(r.status, 'up');
});

test('liveness() 不依赖 DB（纯函数形状）', () => {
  const l = liveness();
  assert.equal(l.status, 'ok');
  assert.ok(l.version);
});
