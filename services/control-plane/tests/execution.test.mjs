/** execution 测试：MCP 网关 / 审批流 / 幂等 / 补偿 / Temporal 适配与降级 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

const MCP_PORT = 14551;
const TEMPORAL_PORT = 14552;

// ---- fake MCP server（JSON-RPC over HTTP） ----
const mcpCalls = [];
const fakeMcp = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    mcpCalls.push({ method: body.method, params: body.params, auth: req.headers['authorization'] || null });
    const reply = (result, error) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result, error }));
    };
    if (body.method === 'tools/list') {
      return reply({ tools: [{ name: 'echo', description: 'test' }, { name: 'boom', description: 'fails' }] });
    }
    if (body.method === 'tools/call') {
      const name = body.params?.name;
      if (name === 'sse-echo') {
        // SSE 形态的 MCP 响应（Streamable HTTP 可能返回事件流）
        const payload = JSON.stringify({
          jsonrpc: '2.0', id: body.id,
          result: { content: [{ type: 'text', text: 'sse-ok' }] },
        });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`event: message\ndata: ${payload}\n\n`);
        return;
      }
      if (name === 'boom') return reply(undefined, { code: -32000, message: 'boom failed intentionally' });
      return reply({ content: [{ type: 'text', text: 'echo:' + JSON.stringify(body.params?.arguments) }] });
    }
    res.writeHead(404).end('{}');
  });
});
await new Promise((r) => fakeMcp.listen(MCP_PORT, '127.0.0.1', r));
after(() => new Promise((r) => fakeMcp.close(r)));

// ---- fake Temporal server（HTTP API 最小实现 + 内联 worker，测试替身） ----
// 生产对应关系：control-plane 只做 submit/poll，真正的工具执行发生在 Temporal worker；
// 这里的内联 worker 模拟 worker 行为（调 fake MCP、vault_ref 在 worker 侧从环境解析）。
const temporalSeen = [];
let temporalDown = false;
const wfStore = new Map(); // workflowId -> { status, result?, error? }

async function workerCallMcp(input) {
  const headers = { 'content-type': 'application/json' };
  if (input.auth_vault_ref && process.env[input.auth_vault_ref]) {
    headers['authorization'] = `Bearer ${process.env[input.auth_vault_ref]}`;
  }
  const res = await fetch(input.tool_endpoint.replace(/\/$/, ''), {
    method: 'POST', headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'w1', method: 'tools/call',
      params: { name: input.action, arguments: input.args || {} },
    }),
    signal: AbortSignal.timeout(10000),
  });
  const j = await parseWorkerMcpResponse(res);
  // 注意：调用已由 fake MCP server 的 handler 记录（含 auth 头），这里不再重复 push
  if (j.error) throw new Error(j.error.message || 'mcp error');
  return j.result;
}

/** worker 侧响应解析：与生产 client 同行为，支持 text/event-stream（data: 行取最后一个 JSON-RPC 响应） */
async function parseWorkerMcpResponse(res) {
  if (/text\/event-stream/i.test(res.headers.get('content-type') || '')) {
    const text = await res.text();
    const datas = text.split('\n').map((l) => l.trim())
      .filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    for (let i = datas.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(datas[i]);
        if (o && (o.result !== undefined || o.error)) return o;
      } catch { /* 继续往前找 */ }
    }
    throw new Error('worker: SSE 响应中没有可解析的 JSON-RPC 结果');
  }
  return res.json();
}

const fakeTemporal = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    temporalSeen.push({ method: req.method, url: req.url });
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'GET' && req.url === '/api/v1/namespaces') return json(200, { namespaces: [] });
    // 真实 Temporal HTTP API：submit 是 POST /workflows/{workflowId}（ID 在路径）
    const sm = req.method === 'POST' && req.url.match(/\/workflows\/([^/?]+)$/);
    if (sm) {
      if (temporalDown) return json(500, { error: 'temporal down in test' });
      const body = JSON.parse(raw || '{}');
      const wid = decodeURIComponent(sm[1]);
      let input = {};
      try {
        const b64 = body.input?.payloads?.[0]?.data;
        if (b64) input = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      } catch { /* ignore */ }
      // worker 内联执行（同步完成，测试替身）
      try {
        let result;
        if (input.tool_kind === 'builtin') {
          if (input.action === 'fail' || /fail/.test(input.tool_name || '')) {
            throw new Error('builtin fail: intentional failure');
          }
          result = { ok: true, builtin: 'echo', echoed: input.args };
        } else if (input.tool_kind === 'mcp' && input.tool_endpoint) {
          result = await workerCallMcp(input);
        } else {
          result = { ok: true };
        }
        wfStore.set(wid, { status: 'WORKFLOW_EXECUTION_STATUS_COMPLETED', result });
      } catch (e) {
        wfStore.set(wid, { status: 'WORKFLOW_EXECUTION_STATUS_FAILED', error: e.message });
      }
      return json(200, { runId: 'run-test-1' });
    }
    const m = req.url.match(/\/workflows\/([^/?]+)(\/cancel)?$/);
    if (m && !m[2]) {
      const st = wfStore.get(m[1]) || { status: 'WORKFLOW_EXECUTION_STATUS_RUNNING' };
      return json(200, st);
    }
    if (m && m[2]) return json(200, {});
    res.writeHead(404).end('{}');
  });
});
await new Promise((r) => fakeTemporal.listen(TEMPORAL_PORT, '127.0.0.1', r));
after(() => new Promise((r) => fakeTemporal.close(r)));

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-ex-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.DEV_IDP_SECRET = 'test-dev-secret';
process.env.BOOTSTRAP_ENABLED = 'false';
process.env.TEMPORAL_ADDRESS = `http://127.0.0.1:${TEMPORAL_PORT}`;
process.env.TOOL_TEST_API_KEY = 'test-secret-xyz';
process.env.MCP_TIMEOUT_MS = '10000';
process.env.EXEC_RESULT_TIMEOUT_MS = '15000';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerExecutionRoutes } = await import('../src/modules/execution/routes.mjs');
const temporal = await import('../src/modules/execution/temporal.mjs');

let tenant, tenantB, project, adminKey, approverKey, viewerKey, tenantBKey, opToken = 'op_test_token';
before(async () => {
  await openDb();
  await migrate(db());
  tenant = await store.createTenant({ name: 'EX Tenant' });
  project = await store.createProject(tenant.id, { name: 'EX Project' });
  const admin = await store.createActor(tenant.id, { kind: 'user', name: 'EX Admin' });
  await store.bindRole(tenant.id, admin.id, null, 'admin');
  const k1 = mintKey();
  await store.createApiKeyRow({ tenantId: tenant.id, actorId: admin.id, name: 'ex-admin', prefix: k1.prefix, keyHash: k1.keyHash });
  adminKey = k1.secret;
  // H-1 安全 review：审批人必须≠申请人，单独一个审批人 actor
  const approver = await store.createActor(tenant.id, { kind: 'user', name: 'EX Approver' });
  await store.bindRole(tenant.id, approver.id, null, 'admin');
  const ka = mintKey();
  await store.createApiKeyRow({ tenantId: tenant.id, actorId: approver.id, name: 'ex-approver', prefix: ka.prefix, keyHash: ka.keyHash });
  approverKey = ka.secret;
  const viewer = await store.createActor(tenant.id, { kind: 'user', name: 'EX Viewer' });
  await store.bindRole(tenant.id, viewer.id, null, 'viewer');
  const k2 = mintKey();
  await store.createApiKeyRow({ tenantId: tenant.id, actorId: viewer.id, name: 'ex-viewer', prefix: k2.prefix, keyHash: k2.keyHash });
  viewerKey = k2.secret;
  // 租户 B（跨租户测试）
  tenantB = await store.createTenant({ name: 'EX Tenant B' });
  const bAdmin = await store.createActor(tenantB.id, { kind: 'user', name: 'B Admin' });
  await store.bindRole(tenantB.id, bAdmin.id, null, 'admin');
  const k3 = mintKey();
  await store.createApiKeyRow({ tenantId: tenantB.id, actorId: bAdmin.id, name: 'b-admin', prefix: k3.prefix, keyHash: k3.keyHash });
  tenantBKey = k3.secret;
});

let base, appServer;
before(async () => {
  const app = createApp();
  registerIdentityRoutes(app);
  registerExecutionRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;
});
after(() => new Promise((r) => appServer.close(r)));

const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const req = (method, path, { token = adminKey, body, headers = {} } = {}) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const post = (p, o) => req('POST', p, o);
const get = (p, o) => req('GET', p, o);

async function registerTool(body, token = adminKey) {
  const r = await post(`/v1/projects/${project.id}/tools`, { token, body });
  assert.equal(r.status, 201);
  return (await r.json()).data;
}

test('工具注册：operator+ 可注册，viewer 被 403；stdio 被 400 拒绝', async () => {
  const t = await registerTool({ name: 't-low', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'low' });
  assert.ok(t.id.startsWith('tool_'));
  const r = await post(`/v1/projects/${project.id}/tools`, {
    token: viewerKey, body: { name: 't-viewer', kind: 'mcp', endpoint: MCP_URL },
  });
  assert.equal(r.status, 403);
  const r2 = await post(`/v1/projects/${project.id}/tools`, {
    token: adminKey, body: { name: 't-stdio', kind: 'mcp', endpoint: 'stdio://local' },
  });
  assert.equal(r2.status, 400);
});

test('高风险调用 → 审批流：pending_approval → approve 后执行', async () => {
  const tool = await registerTool({ name: 't-high', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'high' });
  const before = mcpCalls.length;
  const r = await post(`/v1/projects/${project.id}/tools/${tool.id}/invoke`, {
    body: { action: 'echo', args: { hello: 'world' } },
  });
  assert.equal(r.status, 403);
  const err = await r.json();
  assert.equal(err.error.code, 'APPROVAL_REQUIRED');
  const approvalId = err.error.details.approvalId;
  assert.ok(approvalId);
  assert.equal(mcpCalls.length, before); // 审批前不上游

  const ra = await post(`/v1/projects/${project.id}/approvals/${approvalId}/approve`, { token: approverKey, body: {} });
  assert.equal(ra.status, 200);
  const { execution } = await ra.json();
  assert.equal(execution.status, 'succeeded');
  assert.equal(mcpCalls.length, before + 1);
  assert.equal(mcpCalls[mcpCalls.length - 1].params.name, 'echo');
});

test('审批驳回 → rejected 且不执行', async () => {  const tool = await registerTool({ name: 't-high2', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'high' });
  const before = mcpCalls.length;
  const r = await post(`/v1/projects/${project.id}/tools/${tool.id}/invoke`, {
    body: { action: 'echo', args: {} },
  });
  const approvalId = (await r.json()).error.details.approvalId;
  const rr = await post(`/v1/projects/${project.id}/approvals/${approvalId}/reject`, { token: approverKey, body: { reason: 'no need' } });
  assert.equal(rr.status, 200);
  const { execution } = await rr.json();
  assert.equal(execution.status, 'rejected');
  assert.equal(mcpCalls.length, before); // 驳回后不执行
});

test('职责分离：申请人自己审批 → 403（H-1 安全 review）', async () => {
  const tool = await registerTool({ name: 't-sod', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'high' });
  const r = await post(`/v1/projects/${project.id}/tools/${tool.id}/invoke`, {
    body: { action: 'echo', args: {} },
  });
  const approvalId = (await r.json()).error.details.approvalId;
  // 发起人（adminKey 的 actor）自己点 approve → 403
  const ra = await post(`/v1/projects/${project.id}/approvals/${approvalId}/approve`, { body: {} });
  assert.equal(ra.status, 403);
  const err = await ra.json();
  assert.match(err.error.message, /职责分离/);
  // 换审批人批准 → 200，且审批单仍可用（自审批未消费）
  const ra2 = await post(`/v1/projects/${project.id}/approvals/${approvalId}/approve`, { token: approverKey, body: {} });
  assert.equal(ra2.status, 200);
});

test('hashArgs 键序无关：语义相同键序不同 → 同一哈希（M-5）', async () => {
  const { hashArgs } = await import('../src/modules/execution/service.mjs');
  assert.equal(hashArgs({ a: 1, b: { x: 1, y: 2 } }), hashArgs({ b: { y: 2, x: 1 }, a: 1 }));
  assert.notEqual(hashArgs({ a: 1 }), hashArgs({ a: 2 }));
});

test('审批并发：两个同时 approve 只有一个成功（防重复执行）', async () => {
  const tool = await registerTool({ name: 't-race', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'high' });
  const r = await post(`/v1/projects/${project.id}/tools/${tool.id}/invoke`, {
    body: { action: 'echo', args: {} },
  });
  const approvalId = (await r.json()).error.details.approvalId;
  const [r1, r2] = await Promise.all([
    post(`/v1/projects/${project.id}/approvals/${approvalId}/approve`, { token: approverKey, body: {} }),
    post(`/v1/projects/${project.id}/approvals/${approvalId}/approve`, { token: approverKey, body: {} }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  const ok = r1.status === 200 ? r1 : r2;
  assert.equal((await ok.json()).execution.status, 'succeeded');
});

test('低风险直接执行 + 凭证注入 + 无明文落库', async () => {
  const tool = await registerTool({
    name: 't-cred', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'low',
    config: { auth: { type: 'bearer', vault_ref: 'TOOL_TEST_API_KEY' } },
    credentials: [{ vaultRef: 'TOOL_TEST_API_KEY' }],
  });
  mcpCalls.length = 0;
  const r = await post(`/v1/projects/${project.id}/tools/${tool.id}/invoke`, {
    body: { action: 'echo', args: { q: 1 } },
  });
  assert.equal(r.status, 200);
  const { execution } = await r.json();
  assert.equal(execution.status, 'succeeded');
  assert.equal(mcpCalls[0].auth, 'Bearer test-secret-xyz'); // 凭证运行时注入
  // DB 无明文
  const credRows = await db().query('SELECT * FROM tool_credentials WHERE tool_id=?', [tool.id]);
  assert.equal(credRows[0].vault_ref, 'TOOL_TEST_API_KEY');
  assert.ok(!('secret' in credRows[0]));
  assert.ok(!JSON.stringify(credRows[0]).includes('test-secret-xyz'));
  const cols = await db().query('PRAGMA table_info(tool_credentials)');
  assert.ok(!cols.some((c) => /secret|password|key/i.test(c.name) && c.name !== 'vault_ref'));
});

test('幂等键：同 key 两次只执行一次', async () => {
  const tool = await registerTool({ name: 't-idem', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'low' });
  mcpCalls.length = 0;
  const h = { 'Idempotency-Key': 'idem-key-001' };
  const r1 = await post(`/v1/projects/${project.id}/tools/${tool.id}/invoke`, {
    body: { action: 'echo', args: { n: 1 } }, headers: h,
  });
  const r2 = await post(`/v1/projects/${project.id}/tools/${tool.id}/invoke`, {
    body: { action: 'echo', args: { n: 999 } }, headers: h, // args 不同也视为同一操作
  });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  const j1 = await r1.json(), j2 = await r2.json();
  assert.equal(j1.deduplicated, false);
  assert.equal(j2.deduplicated, true);
  assert.equal(j1.execution.id, j2.execution.id);
  assert.equal(mcpCalls.length, 1); // 只执行一次
});

test('补偿链：主失败 → 补偿逆序执行 → compensated', async () => {
  const main = await registerTool({ name: 't-boom', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'low' });
  const ca = await registerTool({ name: 't-comp-a', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'low' });
  const cb = await registerTool({ name: 't-comp-b', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'low' });
  mcpCalls.length = 0;
  const r = await post(`/v1/projects/${project.id}/tools/${main.id}/invoke`, {
    body: {
      action: 'boom', args: {},
      compensations: [
        { toolId: ca.id, action: 'echo', args: { undo: 'a' } },
        { toolId: cb.id, action: 'echo', args: { undo: 'b' } },
      ],
    },
  });
  assert.equal(r.status, 200);
  const { execution } = await r.json();
  assert.equal(execution.status, 'compensated');
  const calls = mcpCalls.filter((c) => c.method === 'tools/call').map((c) => c.params.name);
  assert.deepEqual(calls, ['boom', 'echo', 'echo']);
  // 补偿参数顺序：先 b 后 a（逆序）
  const compArgs = mcpCalls.filter((c) => c.method === 'tools/call').slice(1)
    .map((c) => c.params.arguments.undo);
  assert.deepEqual(compArgs, ['b', 'a']);
  // 补偿记录落库
  const detail = await (await get(`/v1/projects/${project.id}/executions/${execution.id}`)).json();
  assert.equal(detail.compensations.length, 2);
  assert.ok(detail.compensations.every((c) => c.status === 'done'));
});

test('中风险：viewer 被 403，operator 可执行', async () => {
  const tool = await registerTool({ name: 't-med', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'medium' });
  const rv = await post(`/v1/projects/${project.id}/tools/${tool.id}/invoke`, {
    token: viewerKey, body: { action: 'echo', args: {} },
  });
  assert.equal(rv.status, 403);
  const ro = await post(`/v1/projects/${project.id}/tools/${tool.id}/invoke`, {
    body: { action: 'echo', args: {} },
  });
  assert.equal(ro.status, 200);
});

test('Temporal live：namespace 租户隔离 + workflowId=execution ID', async () => {
  temporalSeen.length = 0;
  const tool = await registerTool({ name: 't-temporal', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'low' });
  const r = await post(`/v1/projects/${project.id}/tools/${tool.id}/invoke`, {
    body: { action: 'echo', args: {} },
  });
  assert.equal(r.status, 200);
  const { execution } = await r.json();
  assert.equal(execution.status, 'succeeded');
  assert.equal(execution.engine, 'temporal');
  const expectedNs = temporal.namespaceFor(tenant.id);
  const submit = temporalSeen.find((s) => s.method === 'POST' && /\/workflows\//.test(s.url));
  assert.ok(submit, '应有 workflow 提交');
  assert.ok(submit.url.includes(`/namespaces/${expectedNs}/workflows/${execution.id}`), `namespace 与 workflowId 应正确`);
  const describe = temporalSeen.find((s) => s.method === 'GET' && s.url.includes(execution.id));
  assert.ok(describe, 'workflowId 应为 execution 平台 ID');
});

test('Temporal 提交失败 → 降级 local(fallback) 且仍成功', async () => {
  temporalDown = true;
  try {
    const tool = await registerTool({ name: 't-tmpdown', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'low' });
    const r = await post(`/v1/projects/${project.id}/tools/${tool.id}/invoke`, {
      body: { action: 'echo', args: {} },
    });
    assert.equal(r.status, 200);
    const { execution } = await r.json();
    assert.equal(execution.status, 'succeeded');
    assert.equal(execution.engine, 'local(fallback)');
  } finally {
    temporalDown = false;
  }
});

test('builtin 工具：echo 成功，fail → failed（无补偿时）', async () => {
  const echo = await registerTool({
    name: 't-bi-echo', kind: 'builtin', config: { builtin: 'echo' }, riskLevel: 'low',
  });
  const r = await post(`/v1/projects/${project.id}/tools/${echo.id}/invoke`, {
    body: { action: 'echo', args: { x: 1 } },
  });
  assert.equal((await r.json()).execution.status, 'succeeded');
  const fail = await registerTool({
    name: 't-bi-fail', kind: 'builtin', config: { builtin: 'fail' }, riskLevel: 'low',
  });
  const r2 = await post(`/v1/projects/${project.id}/tools/${fail.id}/invoke`, {
    body: { action: 'fail', args: {} },
  });
  assert.equal((await r2.json()).execution.status, 'failed');
});

test('跨租户：他租户 key 访问本租户项目 → 403', async () => {
  const tool = await registerTool({ name: 't-x', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'low' });
  const r = await post(`/v1/projects/${project.id}/tools/${tool.id}/invoke`, {
    body: { action: 'echo', args: {} },
  });
  const exeId = (await r.json()).execution.id;
  const rb = await get(`/v1/projects/${project.id}/executions/${exeId}`, { token: tenantBKey });
  assert.equal(rb.status, 403); // 项目归属校验先拦截：租户隔离
});

test('args 密钥拦截：password 字段直接 400（不静默打码执行）', async () => {
  const tool = await registerTool({ name: 't-redact', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'low' });
  const before = (await db().query('SELECT COUNT(*) c FROM executions'))[0].c;
  const r = await post(`/v1/projects/${project.id}/tools/${tool.id}/invoke`, {
    body: { action: 'echo', args: { username: 'u1', password: 's3cr3t-pw' } },
  });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error.message, /vault_ref/);
  // 拒绝发生在落库前：无执行记录残留
  assert.equal((await db().query('SELECT COUNT(*) c FROM executions'))[0].c, before);
});

test('args 脱敏函数：redactArgs 对疑似密钥打码（纵深防御）', async () => {
  const { redactArgs } = await import('../src/modules/execution/service.mjs');
  const out = redactArgs({ username: 'u1', password: 's3cr3t', nested: { apiKey: 'k' } });
  assert.deepEqual(out, { username: 'u1', password: '***', nested: { apiKey: '***' } });
});

test('工具列表不泄露密钥；执行列表/详情正常', async () => {
  const r = await get(`/v1/projects/${project.id}/tools`);
  assert.equal(r.status, 200);
  const { data } = await r.json();
  assert.ok(data.length > 0);
  assert.ok(!JSON.stringify(data).includes('test-secret-xyz'));
  const re = await get(`/v1/projects/${project.id}/executions?limit=5`);
  assert.equal(re.status, 200);
  assert.ok((await re.json()).data.length > 0);
});

test('未认证 → 401', async () => {
  const r = await post(`/v1/projects/${project.id}/tools`, { token: null, body: {} });
  assert.equal(r.status, 401);
});

test('MCP SSE 响应：text/event-stream 的 data: 行可解析', async () => {
  const tool = await registerTool({ name: 't-sse', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'low' });
  const r = await post(`/v1/projects/${project.id}/tools/${tool.id}/invoke`, {
    body: { action: 'sse-echo', args: {} },
  });
  assert.equal(r.status, 200);
  const { execution } = await r.json();
  assert.equal(execution.status, 'succeeded');
  assert.match(execution.result_ref, /sse-ok/);
});

test('平台 operator 注册工具：created_by 为 NULL（伪 actor 不落库）', async () => {
  const r = await post(`/v1/projects/${project.id}/tools`, {
    token: opToken,
    body: { name: 't-platform', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'low', platform: true },
  });
  assert.equal(r.status, 201);
  const tool = (await r.json()).data;
  assert.equal(tool.tenant_id, null); // 平台级工具
  const rows = await db().query('SELECT created_by FROM tools WHERE id=?', [tool.id]);
  assert.equal(rows[0].created_by, null);
});

test('平台 operator 不能直接执行租户工具 → 403', async () => {
  const tool = await registerTool({ name: 't-op-invoke', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'low' });
  const r = await post(`/v1/projects/${project.id}/tools/${tool.id}/invoke`, {
token: opToken,
    body: { action: 'echo', args: {} },
  });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error.message, /租户主体凭证/);
});

test('平台 operator 不能决议审批单 → 403', async () => {
  const tool = await registerTool({ name: 't-op-apr', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'high' });
  const r = await post(`/v1/projects/${project.id}/tools/${tool.id}/invoke`, {
    body: { action: 'echo', args: {} },
  });
  const approvalId = (await r.json()).error.details.approvalId;
  const rr = await post(`/v1/projects/${project.id}/approvals/${approvalId}/approve`, {
token: opToken,
    body: {},
  });
  assert.equal(rr.status, 403);
});

test('config 明文扫描：嵌套/驼峰 key 被拒，tokenizer 不误伤', async () => {
  const bad = await post(`/v1/projects/${project.id}/tools`, {
    body: { name: 't-bad-cfg', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'low',
      config: { nested: { accessToken: 'sk-xxx' } } },
  });
  assert.equal(bad.status, 400);
  const bad2 = await post(`/v1/projects/${project.id}/tools`, {
    body: { name: 't-bad-cfg2', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'low',
      config: { auth: { type: 'bearer', apiKey: 'plain' } } },
  });
  assert.equal(bad2.status, 400);
  const ok = await registerTool({ name: 't-ok-cfg', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'low',
    config: { tokenizer: 'gpt-4', model: 'x' } });
  assert.ok(ok.id.startsWith('tool_'));
});

test('半成品防护：credential 非法时整个注册回滚，工具名可重用', async () => {
  const bad = await post(`/v1/projects/${project.id}/tools`, {
    body: { name: 't-half', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'low',
      credentials: [{ vaultRef: 'OK_REF' }, { nope: 1 }] },
  });
  assert.equal(bad.status, 400);
  const rows = await db().query('SELECT id FROM tools WHERE name=?', ['t-half']);
  assert.equal(rows.length, 0); // 无半成品残留
  const ok = await registerTool({ name: 't-half', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'low',
    credentials: [{ vaultRef: 'OK_REF' }] });
  assert.ok(ok.id.startsWith('tool_'));
});

test('config 带密钥明文 → 400 拒绝', async () => {
  const r = await post(`/v1/projects/${project.id}/tools`, {
    body: { name: 't-leak', kind: 'http', endpoint: 'http://x/', config: { auth: { apiKey: 'sk-live-123' } } },
  });
  assert.equal(r.status, 400);
});
