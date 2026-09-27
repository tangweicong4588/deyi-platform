/** V4.2 Agent 编排运行时：注册/版本/执行/HITL 审批/拒绝分支/SoD/工具节点/隔离/审计 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-ag-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.DEV_IDP_SECRET = 'dev_secret_for_test_only_32bytes!';
process.env.BOOTSTRAP_ENABLED = 'false';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const audit = await import('../src/modules/evidence/audit.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerAgentRoutes } = await import('../src/modules/agents/routes.mjs');
const { registerExecutionRoutes } = await import('../src/modules/execution/routes.mjs');

// fake MCP：tool 节点真实调用链（invokeTool → MCP）
const MCP_PORT = 14561;
const fakeMcp = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const reply = (result, error) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result, error }));
    };
    if (body.method === 'tools/list') return reply({ tools: [{ name: 'notify', description: 't' }] });
    if (body.method === 'tools/call') {
      return reply({ content: [{ type: 'text', text: 'sent:' + JSON.stringify(body.params?.arguments) }] });
    }
    res.writeHead(404).end('{}');
  });
});
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;

let tenant, project, adminSecret, admin2Secret, viewerSecret, otherSecret, otherProjectId;
let base, appServer;
before(async () => {
  await openDb();
  await migrate(db());
  await audit.initEvidence();
  tenant = await store.createTenant({ name: 'AG Tenant' });
  project = await store.createProject(tenant.id, { name: 'AG Project' });

  const mkActor = async (name, role, pid) => {
    const a = await store.createActor(tenant.id, { kind: 'user', name });
    await store.bindRole(tenant.id, a.id, pid === undefined ? null : pid, role);
    const k = mintKey();
    await store.createApiKeyRow({ tenantId: tenant.id, actorId: a.id, name, prefix: k.prefix, keyHash: k.keyHash });
    return { id: a.id, secret: k.secret };
  };
  adminSecret = (await mkActor('AG Admin', 'admin')).secret;
  admin2Secret = (await mkActor('AG Admin2', 'admin')).secret;
  viewerSecret = (await mkActor('AG Viewer', 'viewer', project.id)).secret;

  const t2 = await store.createTenant({ name: 'AG Tenant B' });
  const p2 = await store.createProject(t2.id, { name: 'B Project' });
  otherProjectId = p2.id;
  const a2 = await store.createActor(t2.id, { kind: 'user', name: 'B Admin' });
  await store.bindRole(t2.id, a2.id, null, 'admin');
  const bk = mintKey();
  await store.createApiKeyRow({ tenantId: t2.id, actorId: a2.id, name: 'b-admin', prefix: bk.prefix, keyHash: bk.keyHash });
  otherSecret = bk.secret;

  // 注意：本仓库 before hook 并发执行，所有初始化必须在同一个 hook 内串行
  const app = createApp();
  registerIdentityRoutes(app);
  registerExecutionRoutes(app);
  registerAgentRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;
  await new Promise((r) => fakeMcp.listen(MCP_PORT, '127.0.0.1', r));
});
after(() => Promise.all([
  new Promise((r) => appServer.close(r)),
  new Promise((r) => fakeMcp.close(r)),
]));

const A = (pid) => `${base}/v1/projects/${pid}/agents`;
const AR = (pid, runId) => `${base}/v1/projects/${pid}/agent-runs/${runId}`;
const P = () => A(project.id);
const post = (url, body, token = adminSecret) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const get = (url, token = adminSecret) =>
  fetch(url, { headers: { authorization: `Bearer ${token}` } });

const FLOW_DEF = {
  entry: 'intake',
  nodes: [
    { id: 'intake', type: 'llm', name: '需求理解', prompt: '整理需求：{{input.requirement}}', next: 'review' },
    { id: 'review', type: 'hitl', name: '人工复核', title: '请复核需求要点', on_approve: 'publish', on_reject: 'revise' },
    { id: 'publish', type: 'llm', name: '发布文案', prompt: '生成发布文案', next: null },
    { id: 'revise', type: 'llm', name: '修订', prompt: '修订需求', next: null },
  ],
};

async function mkAgent(key = `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, token = adminSecret) {
  const r = await post(P(), { key, name: '需求处理流' }, token);
  assert.equal(r.status, 201);
  const agent = (await r.json()).data;
  const v = await post(`${P()}/${agent.id}/versions`, { definition: FLOW_DEF }, token);
  assert.equal(v.status, 201);
  return agent;
}

async function startRun(agentId, body = {}, token = adminSecret) {
  const r = await post(`${P()}/${agentId}/runs`, { input: { requirement: '做一个登录页' }, mode: 'simulated', ...body }, token);
  assert.equal(r.status, 201);
  return (await r.json()).data;
}

test('注册 Agent：201；重复 key 409；viewer 不能注册但可读', async () => {
  const r = await post(P(), { key: 'dup-key', name: 'A' });
  assert.equal(r.status, 201);
  const r2 = await post(P(), { key: 'dup-key', name: 'B' });
  assert.equal(r2.status, 409);
  const rv = await post(P(), { key: 'viewer-key', name: 'V' }, viewerSecret);
  assert.equal(rv.status, 403);
  const g = await get(P(), viewerSecret);
  assert.equal(g.status, 200);
});

test('发版校验：坏定义 400（未知引用/环/hitl 缺分支/llm 缺 prompt）', async () => {
  const agent = (await (await post(P(), { key: 'bad-def', name: 'B' })).json()).data;
  const bads = [
    { entry: 'a', nodes: [{ id: 'a', type: 'llm', prompt: 'x', next: 'ghost' }] },                       // 未知引用
    { entry: 'a', nodes: [                                                                               // 环
      { id: 'a', type: 'llm', prompt: 'x', next: 'b' },
      { id: 'b', type: 'llm', prompt: 'y', next: 'a' }] },
    { entry: 'a', nodes: [{ id: 'a', type: 'hitl', name: 'h' }] },                                        // hitl 缺分支
    { entry: 'a', nodes: [{ id: 'a', type: 'llm', next: null }] },                                       // llm 缺 prompt
    { entry: 'a', nodes: [{ id: 'a', type: 'tool', action: 'x', next: null }] },                         // tool 缺 tool
  ];
  for (const definition of bads) {
    const r = await post(`${P()}/${agent.id}/versions`, { definition });
    assert.equal(r.status, 400, JSON.stringify(definition));
  }
});

test('版本不可变：v1 快照不受后续发版影响', async () => {
  const agent = (await (await post(P(), { key: 'immut', name: 'I' })).json()).data;
  await post(`${P()}/${agent.id}/versions`, { definition: FLOW_DEF });
  const def2 = { ...FLOW_DEF, nodes: [...FLOW_DEF.nodes, { id: 'extra', type: 'llm', prompt: 'x', next: null }] };
  const v2 = await post(`${P()}/${agent.id}/versions`, { definition: def2 });
  assert.equal((await v2.json()).data.version, 2);
  const v1rows = await db().query('SELECT definition FROM agent_versions WHERE agent_id=? AND version=1', [agent.id]);
  assert.equal(JSON.parse(v1rows[0].definition).nodes.length, FLOW_DEF.nodes.length);
});

test('审批通过分支：llm → hitl 中断 → approve → 走 on_approve 跑完', async () => {
  const agent = await mkAgent();
  const run = await startRun(agent.id);
  assert.equal(run.status, 'waiting_approval');
  assert.equal(run.current_node, 'review');

  const detail = (await (await get(AR(project.id, run.id))).json()).data;
  assert.equal(detail.status, 'waiting_approval');
  assert.deepEqual(detail.steps.map((s) => [s.node_id, s.status]), [['intake', 'ok']]);
  assert.equal(detail.steps[0].output.simulated, true); // simulated 明确标注
  assert.equal(detail.approvals.length, 1);
  assert.equal(detail.approvals[0].status, 'pending');

  const ap = await post(AR(project.id, run.id) + '/approve', { approved: true, note: 'ok' }, admin2Secret);
  assert.equal(ap.status, 200);
  const done = (await ap.json()).data;
  assert.equal(done.status, 'succeeded');

  const d2 = (await (await get(AR(project.id, run.id))).json()).data;
  assert.deepEqual(d2.steps.map((s) => [s.node_id, s.status]),
    [['intake', 'ok'], ['review', 'approved'], ['publish', 'ok']]);
  assert.equal(d2.approvals[0].status, 'approved');
  assert.equal(d2.approvals[0].decided_by !== undefined, true);
});

test('审批拒绝分支：reject → 走 on_reject 跑完，publish 未执行', async () => {
  const agent = await mkAgent();
  const run = await startRun(agent.id);
  const ap = await post(AR(project.id, run.id) + '/approve', { approved: false, note: '打回' }, admin2Secret);
  assert.equal(ap.status, 200);
  const done = (await ap.json()).data;
  assert.equal(done.status, 'succeeded');
  const d = (await (await get(AR(project.id, run.id))).json()).data;
  assert.deepEqual(d.steps.map((s) => [s.node_id, s.status]),
    [['intake', 'ok'], ['review', 'rejected'], ['revise', 'ok']]);
  assert.equal(d.approvals[0].status, 'rejected');
});

test('SoD：发起人不能审批自己的 run；决议后重复审批 409', async () => {
  const agent = await mkAgent();
  const run = await startRun(agent.id);
  const self = await post(AR(project.id, run.id) + '/approve', { approved: true }, adminSecret);
  assert.equal(self.status, 403);
  const ok = await post(AR(project.id, run.id) + '/approve', { approved: true }, admin2Secret);
  assert.equal(ok.status, 200);
  const again = await post(AR(project.id, run.id) + '/approve', { approved: true }, admin2Secret);
  assert.equal(again.status, 409);
});

test('tool 节点：经 invokeTool 真实调用 MCP（simulated 下工具仍真实执行）', async () => {
  // 注册低风险 MCP 工具
  const t = await post(`${base}/v1/projects/${project.id}/tools`,
    { name: 't-notify', kind: 'mcp', endpoint: MCP_URL, riskLevel: 'low' });
  assert.equal(t.status, 201);
  const toolId = (await t.json()).data.id;

  const agent = (await (await post(P(), { key: 'toolflow', name: 'T' })).json()).data;
  const def = {
    entry: 'n1',
    nodes: [
      { id: 'n1', type: 'tool', name: '发通知', tool: toolId, action: 'notify',
        args: { channel: '{{input.channel}}', text: 'hello' }, next: null },
    ],
  };
  const v = await post(`${P()}/${agent.id}/versions`, { definition: def });
  assert.equal(v.status, 201);
  const run = await startRun(agent.id, { input: { channel: 'ops' } });
  assert.equal(run.status, 'succeeded');
  const d = (await (await get(AR(project.id, run.id))).json()).data;
  assert.equal(d.steps.length, 1);
  assert.equal(d.steps[0].node_type, 'tool');
  assert.match(JSON.stringify(d.steps[0].output), /sent:/);
  assert.match(JSON.stringify(d.steps[0].output), /ops/); // 模板插值生效
});

test('live 模式无上游：run 失败并如实报错，不伪造输出', async () => {
  const agent = await mkAgent();
  const run = await startRun(agent.id, { mode: 'live' });
  assert.equal(run.status, 'failed');
  assert.match(run.error, /模型网关未配置|不在白名单/);
});

test('租户隔离：他租户读不到 Agent 与执行记录', async () => {
  const agent = await mkAgent();
  const g = await get(`${A(otherProjectId)}/${agent.id}`, otherSecret);
  assert.equal(g.status, 404);
  const l = await get(A(otherProjectId), otherSecret);
  assert.equal(l.status, 200);
  assert.equal((await l.json()).data.length, 0);
});

test('审计链：run 生命周期与审批动作全部进审计', async () => {
  const agent = await mkAgent();
  const run = await startRun(agent.id);
  await post(AR(project.id, run.id) + '/approve', { approved: true }, admin2Secret);
  const rows = await db().query(
    `SELECT action FROM audit_events WHERE tenant_id=? AND resource_id IN (SELECT id FROM agent_approvals WHERE run_id=?) OR (tenant_id=? AND resource_id=?) ORDER BY seq ASC`,
    [tenant.id, run.id, tenant.id, run.id]);
  const actions = rows.map((r) => r.action);
  for (const a of ['agent.run.start', 'agent.run.waiting_approval', 'agent.approval.requested',
    'agent.approval.approved', 'agent.run.succeeded']) {
    assert.ok(actions.includes(a), `缺审计事件: ${a}`);
  }
});
