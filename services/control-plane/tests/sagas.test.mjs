/** V4.3 长流程与补偿：Saga 定义校验/正向执行/超时重试/补偿分支/重放/Temporal 契约/隔离 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-saga-')), 'test.db');
process.env.BOOTSTRAP_ENABLED = 'false';
process.env.TEMPORAL_ADDRESS = 'http://127.0.0.1:14572'; // fake Temporal；import 前设置（config 快照惯例）

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const audit = await import('../src/modules/evidence/audit.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerExecutionRoutes } = await import('../src/modules/execution/routes.mjs');
const { registerSagaRoutes } = await import('../src/modules/sagas/routes.mjs');
const { assertTemporalConfigured } = await import('../src/modules/sagas/sagas.mjs');

// ---- fake MCP：echo 成功 / boom 失败 / slow 延迟 400ms ----
const MCP_PORT = 14571;
const mcpCalls = [];
const fakeMcp = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    const body = JSON.parse(raw || '{}');
    const reply = (result, error) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result, error }));
    };
    if (body.method === 'tools/list') {
      return reply({ tools: [{ name: 'echo' }, { name: 'boom' }, { name: 'slow' }, { name: 'undo' }] });
    }
    if (body.method === 'tools/call') {
      const name = body.params?.name;
      mcpCalls.push(name);
      if (name === 'boom') return reply(undefined, { code: -32000, message: 'boom failed intentionally' });
      if (name === 'slow') { await new Promise((r) => setTimeout(r, 400)); return reply({ content: [{ type: 'text', text: 'slow-ok' }] }); }
      return reply({ content: [{ type: 'text', text: `${name}:` + JSON.stringify(body.params?.arguments) }] });
    }
    res.writeHead(404).end('{}');
  });
});
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;

// ---- fake Temporal：最小 HTTP API + 内联 worker（测试替身，仿 execution.test.mjs） ----
// 工具执行（deyi.toolCall 输入）：提交时内联调 fake MCP，结果实时落终态；
// saga run（deyi.sagaRun 输入）：只记录为 RUNNING，供契约测试走查询/取消。
const TEMPORAL_PORT = 14572;
const temporalSeen = [];
const wfStore = new Map(); // workflowId -> { status, result?, error? }

async function workerCallMcp(input) {
  const res = await fetch(input.tool_endpoint.replace(/\/$/, ''), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'w1', method: 'tools/call',
      params: { name: input.action, arguments: input.args || {} },
    }),
    signal: AbortSignal.timeout(10000),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || 'mcp error');
  return j.result;
}

const fakeTemporal = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    const body = raw ? JSON.parse(raw) : {};
    temporalSeen.push({ method: req.method, url: req.url, body });
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    // 真实 Temporal HTTP API：submit 是 POST /workflows/{workflowId}（ID 在路径）
    const sm = req.method === 'POST' && req.url.match(/\/workflows\/([^/?]+)$/);
    if (sm && !/\/cancel$/.test(req.url)) {
      const wid = decodeURIComponent(sm[1]);
      let input = {};
      try {
        const b64 = body.input?.payloads?.[0]?.data;
        if (b64) input = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      } catch { /* ignore */ }
      if (input.run_id && input.definition) {
        wfStore.set(wid, { status: 'WORKFLOW_EXECUTION_STATUS_RUNNING' });
      } else {
        try {
          const result = await workerCallMcp(input);
          wfStore.set(wid, { status: 'WORKFLOW_EXECUTION_STATUS_COMPLETED', result });
        } catch (e) {
          wfStore.set(wid, { status: 'WORKFLOW_EXECUTION_STATUS_FAILED', error: e.message });
        }
      }
      return json({ runId: 'wf-run-1' });
    }
    const m = req.url.match(/\/workflows\/([^/?]+)(\/cancel)?$/);
    if (m && !m[2]) {
      const st = wfStore.get(decodeURIComponent(m[1])) || { status: 'WORKFLOW_EXECUTION_STATUS_RUNNING' };
      return json(st);
    }
    if (m && m[2]) {
      const st = wfStore.get(decodeURIComponent(m[1]));
      if (st) st.status = 'WORKFLOW_EXECUTION_STATUS_CANCELED';
      return json({});
    }
    res.writeHead(404).end('{}');
  });
});

let tenant, project, adminSecret, viewerSecret, otherSecret, otherProjectId;
let base, appServer;
let toolEcho, toolBoom, toolSlow, toolUndo;
before(async () => {
  await openDb();
  await migrate(db());
  await audit.initEvidence();
  tenant = await store.createTenant({ name: 'SAGA Tenant' });
  project = await store.createProject(tenant.id, { name: 'SAGA Project' });

  const mkActor = async (name, role, pid) => {
    const a = await store.createActor(tenant.id, { kind: 'user', name });
    await store.bindRole(tenant.id, a.id, pid === undefined ? null : pid, role);
    const k = mintKey();
    await store.createApiKeyRow({ tenantId: tenant.id, actorId: a.id, name, prefix: k.prefix, keyHash: k.keyHash });
    return { id: a.id, secret: k.secret };
  };
  adminSecret = (await mkActor('SAGA Admin', 'admin')).secret;
  viewerSecret = (await mkActor('SAGA Viewer', 'viewer', project.id)).secret;

  const t2 = await store.createTenant({ name: 'SAGA Tenant B' });
  const p2 = await store.createProject(t2.id, { name: 'B Project' });
  otherProjectId = p2.id;
  const a2 = await store.createActor(t2.id, { kind: 'user', name: 'B Admin' });
  await store.bindRole(t2.id, a2.id, null, 'admin');
  const bk = mintKey();
  await store.createApiKeyRow({ tenantId: t2.id, actorId: a2.id, name: 'b-admin', prefix: bk.prefix, keyHash: bk.keyHash });
  otherSecret = bk.secret;

  const app = createApp();
  registerIdentityRoutes(app);
  registerExecutionRoutes(app);
  registerSagaRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;
  await new Promise((r) => fakeMcp.listen(MCP_PORT, '127.0.0.1', r));
  await new Promise((r) => fakeTemporal.listen(TEMPORAL_PORT, '127.0.0.1', r));

  // 注册 4 个低风险 MCP 工具（echo/boom/slow/undo 共用同一 endpoint，按 action 区分）
  const reg = async (name) => {
    const r = await fetch(`${base}/v1/projects/${project.id}/tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminSecret}` },
      body: JSON.stringify({ name, kind: 'mcp', endpoint: MCP_URL, risk_level: 'low' }),
    });
    assert.equal(r.status, 201, `register tool ${name}`);
    return (await r.json()).data;
  };
  toolEcho = await reg('saga-echo');
  toolBoom = await reg('saga-boom');
  toolSlow = await reg('saga-slow');
  toolUndo = await reg('saga-undo');
});
after(() => Promise.all([
  new Promise((r) => appServer.close(r)),
  new Promise((r) => fakeMcp.close(r)),
  new Promise((r) => fakeTemporal.close(r)),
]));

const S = (pid) => `${base}/v1/projects/${pid}/sagas`;
const P = () => S(project.id);
const post = (url, body, token = adminSecret) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const get = (url, token = adminSecret) =>
  fetch(url, { headers: { authorization: `Bearer ${token}` } });

const step = (key, toolId, action, extra = {}) => ({ key, tool: toolId, action, args: {}, ...extra });
async function mkSaga(definition, name = `saga-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, token = adminSecret) {
  const r = await post(P(), { name, definition }, token);
  const body = await r.json();
  assert.equal(r.status, 201, `mkSaga ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body.data;
}
async function startRun(sagaId, body = {}, token = adminSecret) {
  const r = await post(`${P()}/${sagaId}/runs`, { input: {}, ...body }, token);
  return r;
}

test('建 saga：201；定义校验；重名 409；viewer 403 但可读', async () => {
  const bad1 = await post(P(), { name: 'bad1', definition: { steps: [] } });
  assert.equal(bad1.status, 400);
  const bad2 = await post(P(), { name: 'bad2', definition: { steps: [step('a', toolEcho.id, 'echo'), step('a', toolEcho.id, 'echo')] } });
  assert.equal(bad2.status, 400);
  const bad3 = await post(P(), { name: 'bad3', definition: { steps: [step('has space', toolEcho.id, 'echo')] } });
  assert.equal(bad3.status, 400);
  const bad4 = await post(P(), { name: 'bad4', definition: { steps: [step('a', toolEcho.id, 'echo', { retries: 99 })] } });
  assert.equal(bad4.status, 400);

  const s = await mkSaga({ steps: [step('s1', toolEcho.id, 'echo')] }, 'dup-name-test');
  const dup = await post(P(), { name: 'dup-name-test', definition: { steps: [step('s1', toolEcho.id, 'echo')] } });
  assert.equal(dup.status, 409);

  const v = await post(P(), { name: 'viewer-saga', definition: { steps: [step('s1', toolEcho.id, 'echo')] } }, viewerSecret);
  assert.equal(v.status, 403);
  const g = await get(P(), viewerSecret);
  assert.equal(g.status, 200);
  assert.ok(Array.isArray((await g.json()).data));
  const one = await get(`${P()}/${s.id}`, viewerSecret);
  assert.equal(one.status, 200);
});

test('全成功 run：succeeded，历史完整有序', async () => {
  const saga = await mkSaga({ steps: [step('s1', toolEcho.id, 'echo'), step('s2', toolEcho.id, 'echo')] });
  const r = await startRun(saga.id);
  assert.equal(r.status, 201);
  const run = (await r.json()).data;
  assert.equal(run.status, 'succeeded');
  assert.equal(run.engine, 'local');

  const h = await get(`${P()}/${saga.id}/runs/${run.id}/history`);
  assert.equal(h.status, 200);
  const { run: hr, steps } = (await h.json()).data;
  assert.equal(hr.id, run.id);
  assert.equal(steps.length, 2);
  assert.deepEqual(steps.map((s) => s.kind), ['forward', 'forward']);
  assert.deepEqual(steps.map((s) => s.seq), [1, 2]);
  assert.ok(steps.every((s) => s.status === 'succeeded' && s.attempts === 1));
  assert.ok(steps[0].finished_at >= steps[0].started_at);
});

test('失败走补偿分支：逆序补偿，run=compensated', async () => {
  mcpCalls.length = 0;
  const saga = await mkSaga({
    steps: [
      step('s1', toolEcho.id, 'echo', { compensate: { tool: toolUndo.id, action: 'undo' } }),
      step('s2', toolBoom.id, 'boom', { compensate: { tool: toolUndo.id, action: 'undo' } }),
      step('s3', toolEcho.id, 'echo'),
    ],
  });
  const r = await startRun(saga.id);
  assert.equal(r.status, 201);
  const run = (await r.json()).data;
  assert.equal(run.status, 'compensated');

  // MCP 调用序：s1.echo → s2.boom(失败) → 只补偿已完成的 s1；s3 从未执行，失败的 s2 无需补偿
  assert.deepEqual(mcpCalls, ['echo', 'boom', 'undo']);

  const h = await get(`${P()}/${saga.id}/runs/${run.id}/history`);
  const { steps } = (await h.json()).data;
  assert.deepEqual(steps.map((s) => `${s.kind}:${s.step_key}:${s.status}`), [
    'forward:s1:compensated',
    'forward:s2:failed',
    'compensate:s1:succeeded',
  ]);
  assert.deepEqual(steps.map((s) => s.seq), [1, 2, 3]);
});

test('重试：boom retries=2 → attempts=3 后进补偿', async () => {
  const saga = await mkSaga({
    steps: [step('only', toolBoom.id, 'boom', { retries: 2, retry_backoff_ms: 5 })],
  });
  const r = await startRun(saga.id);
  const run = (await r.json()).data;
  assert.equal(run.status, 'compensated'); // 无补偿动作：补偿分支直接完成
  const h = await get(`${P()}/${saga.id}/runs/${run.id}/history`);
  const { steps } = (await h.json()).data;
  assert.equal(steps[0].attempts, 3);
  assert.equal(steps[0].status, 'failed');
});

test('超时：slow 工具 400ms，timeout_ms=100 → STEP_TIMEOUT', async () => {
  const saga = await mkSaga({
    steps: [step('t1', toolSlow.id, 'slow', { timeout_ms: 100 })],
  });
  const r = await startRun(saga.id);
  const run = (await r.json()).data;
  assert.equal(run.status, 'compensated');
  const h = await get(`${P()}/${saga.id}/runs/${run.id}/history`);
  const { steps } = (await h.json()).data;
  assert.equal(steps[0].status, 'failed');
  assert.match(steps[0].error, /STEP_TIMEOUT/);
});

test('补偿失败：run=failed，compensation_failed 有记录', async () => {
  const saga = await mkSaga({
    steps: [
      step('s1', toolEcho.id, 'echo', { compensate: { tool: toolBoom.id, action: 'boom' } }),
      step('s2', toolBoom.id, 'boom'),
    ],
  });
  const r = await startRun(saga.id);
  const run = (await r.json()).data;
  assert.equal(run.status, 'failed');
  const h = await get(`${P()}/${saga.id}/runs/${run.id}/history`);
  const { steps } = (await h.json()).data;
  assert.deepEqual(steps.map((s) => `${s.kind}:${s.step_key}:${s.status}`), [
    'forward:s1:compensation_failed',
    'forward:s2:failed',
    'compensate:s1:failed',
  ]);
});

test('重放：新 run，replay_of 指向原 run', async () => {
  const saga = await mkSaga({ steps: [step('s1', toolEcho.id, 'echo')] });
  const r1 = await startRun(saga.id);
  const run1 = (await r1.json()).data;
  assert.equal(run1.status, 'succeeded');
  const r2 = await post(`${P()}/${saga.id}/runs/${run1.id}/replay`, {});
  assert.equal(r2.status, 201);
  const run2 = (await r2.json()).data;
  assert.notEqual(run2.id, run1.id);
  assert.equal(run2.replay_of, run1.id);
  assert.equal(run2.status, 'succeeded');
});

test('engine 非法值 400；未配置 temporal 时 guard 503（不静默降级）', async () => {
  const saga = await mkSaga({ steps: [step('s1', toolEcho.id, 'echo')] });
  const bad = await startRun(saga.id, { engine: 'nope' });
  assert.equal(bad.status, 400);
  // guard 单元测试：空地址 → TEMPORAL_NOT_CONFIGURED/503（config 快照在 import 时确定，此处直接测 guard 逻辑）
  assert.throws(() => assertTemporalConfigured(''), (e) => e.code === 'TEMPORAL_NOT_CONFIGURED' && e.status === 503);
  assert.throws(() => assertTemporalConfigured(null), (e) => e.code === 'TEMPORAL_NOT_CONFIGURED');
  assert.doesNotThrow(() => assertTemporalConfigured('http://x'));
});

test('temporal 契约：提交/查询/取消走 fake Temporal，namespace 隔离', async () => {
  temporalSeen.length = 0;
  {
    const saga = await mkSaga({ steps: [step('s1', toolEcho.id, 'echo')] });
    const r = await startRun(saga.id, { engine: 'temporal' });
    assert.equal(r.status, 201);
    const run = (await r.json()).data;
    assert.equal(run.engine, 'temporal');
    assert.equal(run.status, 'running');
    assert.ok(run.workflow_id);

    const submitted = temporalSeen.find((s) => s.method === 'POST' && /\/workflows\//.test(s.url));
    assert.ok(submitted, '应提交 workflow');
    const ns = ('deyi-' + tenant.id).replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 63);
    // 真实 Temporal HTTP API：workflowId 在路径里（2026-09-28 live 验证修正）
    assert.match(submitted.url, new RegExp(`/api/v1/namespaces/${ns}/workflows/${run.id}$`));
    assert.equal(submitted.body.workflowType.name, 'deyi.sagaRun');
    assert.equal(submitted.body.taskQueue.name, 'deyi-sagas');
    const payload = JSON.parse(Buffer.from(submitted.body.input.payloads[0].data, 'base64').toString());
    assert.equal(payload.run_id, run.id);
    assert.equal(payload.definition.steps.length, 1);

    // 读 run：远端 RUNNING → 本地保持 running
    const g = await get(`${P()}/${saga.id}/runs/${run.id}`);
    assert.equal(g.status, 200);
    assert.equal((await g.json()).data.status, 'running');

    // 取消：fake Temporal 收到 cancel，本地终态 cancelled
    const c = await post(`${P()}/${saga.id}/runs/${run.id}/cancel`, {});
    assert.equal(c.status, 200);
    assert.equal((await c.json()).data.status, 'cancelled');
    assert.ok(temporalSeen.some((s) => s.method === 'POST' && /\/cancel$/.test(s.url)), '应调用 cancel');

    // 终态 run 再取消 → 409
    const c2 = await post(`${P()}/${saga.id}/runs/${run.id}/cancel`, {});
    assert.equal(c2.status, 409);
  }
});

test('租户隔离：B 租户看不到 A 的 saga', async () => {
  const saga = await mkSaga({ steps: [step('s1', toolEcho.id, 'echo')] });
  const g = await get(`${S(otherProjectId)}/${saga.id}`, otherSecret);
  assert.equal(g.status, 404);
  const l = await get(S(otherProjectId), otherSecret);
  assert.equal(l.status, 200);
  assert.deepEqual((await l.json()).data, []);
});

test('审计：saga 关键动作有记录', async () => {
  const saga = await mkSaga({ steps: [step('s1', toolEcho.id, 'echo')] });
  const r = await startRun(saga.id);
  const run = (await r.json()).data;
  const rows = await db().query(
    `SELECT action FROM audit_events WHERE tenant_id=? AND resource_id IN (?,?,?) ORDER BY seq`,
    [tenant.id, saga.id, run.id, run.id]);
  const actions = rows.map((x) => x.action);
  assert.ok(actions.includes('saga.create'), actions.join(','));
  assert.ok(actions.includes('saga.run.start'), actions.join(','));
  assert.ok(actions.includes('saga.step.succeeded'), actions.join(','));
  assert.ok(actions.includes('saga.run.succeeded'), actions.join(','));
});
