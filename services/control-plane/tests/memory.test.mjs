/**
 * tests/memory.test.mjs —— V2.2-A：记忆服务（治理：分层/可见性/TTL/遗忘/提升/审计）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// fake LiteLLM（只服务 /v1/embeddings；promote→approve 的 ingest 需要 embedding 走网关）
function fakeEmbed(t) {
  const v = new Array(8).fill(0);
  for (let i = 0; i < t.length; i++) v[i % 8] += t.charCodeAt(i) % 13;
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
const LITELLM_PORT = 18321;
const fakeLitellm = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    if (req.url === '/v1/embeddings') {
      const body = JSON.parse(raw || '{}');
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        data: inputs.map((t, i) => ({ embedding: fakeEmbed(String(t)), index: i })),
        usage: { prompt_tokens: inputs.length * 10, total_tokens: inputs.length * 10 },
      }));
    }
    res.writeHead(404).end('{}');
  });
});
await new Promise((r) => fakeLitellm.listen(LITELLM_PORT, '127.0.0.1', r));

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-memory-')), 'test.db');
process.env.OPERATOR_TOKEN = 'deyi-test-operator-token';
process.env.LITELLM_URL = `http://127.0.0.1:${LITELLM_PORT}`;
process.env.LITELLM_MASTER_KEY = 'test-master';
process.env.GATEWAY_MAX_RETRIES = '0';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerGatewayRoutes } = await import('../src/modules/gateway/routes.mjs');
const { registerMemoryRoutes } = await import('../src/modules/memory/routes.mjs');
const { registerEvidenceRoutes } = await import('../src/modules/evidence/routes.mjs');
const { registerKnowledgeRoutes } = await import('../src/modules/knowledge/routes.mjs');
const { provisionTenant } = await import('../src/modules/identity/provision.mjs');
const { sweepExpired } = await import('../src/modules/memory/service.mjs');
const gstore = await import('../src/modules/gateway/store.mjs');

const OPERATOR = process.env.OPERATOR_TOKEN;

let app, server, base, tenantA, tenantB, projectA, adminKeyA, memberKeyA, adminKeyB;

async function req(path, { method = 'GET', token = adminKeyA, body } = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r;
}
const j = async (r) => (await r.json()).data;

test.before(async () => {
  openDb();
  await migrate(db());
  await gstore.ensureSeedModels();
  app = createApp();
  registerIdentityRoutes(app);
  registerGatewayRoutes(app);
  registerMemoryRoutes(app);
  registerEvidenceRoutes(app);
  registerKnowledgeRoutes(app);
  server = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.address().port}`;

  const outA = await provisionTenant({ name: '记忆租户A', plan: 'professional' });
  tenantA = outA.tenant; projectA = outA.project.id; adminKeyA = outA.apiKey.key;
  const outB = await provisionTenant({ name: '记忆租户B', plan: 'professional' });
  tenantB = outB.tenant; adminKeyB = outB.apiKey.key;

  // 普通成员（无角色绑定）
  const actor = await j(await req(`/v1/admin/tenants/${tenantA.id}/actors`, {
    body: { kind: 'user', name: '记忆成员', email: 'mem@example.com' }, method: 'POST',
  }));
  const keyRow = await j(await req(`/v1/admin/tenants/${tenantA.id}/api-keys`, {
    body: { actorId: actor.id, name: 'member-key' }, method: 'POST',
  }));
  memberKeyA = keyRow.key;
});

test.after(async () => { await server.close(); await new Promise((r) => fakeLitellm.close(r)); });

const MB = (tid) => `/v1/tenants/${tid}/memory`;

// ---------- 写入校验 ----------
test('remember：写入成功，非法输入 400', async () => {
  const r = await req(MB(tenantA.id), {
    method: 'POST', body: { kind: 'episodic', content: '今天开了需求评审会', visibility: 'project', importance: 0.7 },
  });
  assert.equal(r.status, 201);
  const d = await j(r);
  assert.equal(d.kind, 'episodic');
  assert.equal(d.status, 'active');
  assert.equal(d.visibility, 'project');

  for (const body of [
    { kind: 'weird', content: 'x' },
    { kind: 'semantic', content: '   ' },
    { kind: 'semantic', content: 'x', importance: 1.5 },
  ]) {
    const bad = await req(MB(tenantA.id), { method: 'POST', body });
    assert.equal(bad.status, 400, JSON.stringify(body));
  }
});

// ---------- 可见性 ----------
test('recall：private 仅 owner 可见，project 同租户可见', async () => {
  // admin 建 private
  const priv = await j(await req(MB(tenantA.id), {
    method: 'POST', body: { kind: 'semantic', content: '私有笔记-只有我', visibility: 'private' },
  }));
  // 成员召回看不到 admin 的 private
  const seen = await j(await req(MB(tenantA.id) + '/recall?q=私有笔记', { token: memberKeyA }));
  assert.ok(!seen.some((m) => m.id === priv.id), '成员不应看到他人的 private 记忆');
  // 但 admin 自己能看到
  const mine = await j(await req(MB(tenantA.id) + '/recall?q=私有笔记'));
  assert.ok(mine.some((m) => m.id === priv.id));

  // 成员建 project，可被 admin 看到
  const pub = await j(await req(MB(tenantA.id), {
    method: 'POST', token: memberKeyA, body: { kind: 'episodic', content: '项目公开纪要-成员' },
  }));
  const byAdmin = await j(await req(MB(tenantA.id) + '/recall?q=公开纪要'));
  assert.ok(byAdmin.some((m) => m.id === pub.id));
});

// ---------- TTL ----------
test('TTL：过期记忆被 recall 过滤，sweep 标记 expired', async () => {
  const m = await j(await req(MB(tenantA.id), {
    method: 'POST', body: { kind: 'episodic', content: '临时的验证码', ttlMs: 60000 },
  }));
  let list = await j(await req(MB(tenantA.id) + '/recall?q=验证码'));
  assert.ok(list.some((x) => x.id === m.id), '未过期前应可召回');
  // 确定性过期：直接把 expires_at 推到过去
  await db().query(`UPDATE memories SET expires_at=? WHERE id=?`, [Date.now() - 1000, m.id]);
  list = await j(await req(MB(tenantA.id) + '/recall?q=验证码'));
  assert.ok(!list.some((x) => x.id === m.id), '过期后 recall 应过滤（懒过滤）');
  const sw = await sweepExpired(tenantA.id);
  assert.ok(sw.swept >= 1, 'sweep 应标记至少一条过期记忆');
  const rows = await db().query(`SELECT status FROM memories WHERE id=?`, [m.id]);
  assert.equal(rows[0].status, 'expired');
  // sweep 运维路由：operator 可调用，非 operator 被拒绝
  const okSweep = await req('/v1/admin/memory/sweep', { method: 'POST', token: OPERATOR, body: {} });
  assert.equal(okSweep.status, 200);
  const r403 = await req('/v1/admin/memory/sweep', { method: 'POST', body: {} });
  assert.equal(r403.status, 403);
});

// ---------- 事实提升 ----------
test('promote：提案→审批→入知识库；重复审批 400', async () => {
  const m = await j(await req(MB(tenantA.id), {
    method: 'POST', token: memberKeyA, body: { kind: 'semantic', content: '客户偏好：周报用表格' },
  }));
  const prop = await j(await req(MB(tenantA.id) + `/${m.id}/promote`, { method: 'POST', token: memberKeyA, body: { projectId: projectA } }));
  assert.equal(prop.status, 'pending');
  // 同一记忆重复 propose 幂等
  const prop2 = await j(await req(MB(tenantA.id) + `/${m.id}/promote`, { method: 'POST', token: memberKeyA, body: {} }));
  assert.equal(prop2.id, prop.id);
  assert.equal(prop2.deduped, true);

  const appr = await j(await req(MB(tenantA.id) + `/promotions/${prop.id}/approve`, { method: 'POST' }));
  assert.equal(appr.status, 'approved');
  assert.ok(appr.documentId, '审批后应产生 knowledge document');

  // 记忆标 promoted；知识库可查到提升文档
  const docs = await j(await req(`/v1/projects/${projectA}/knowledge/documents`));
  assert.ok(docs.some((d) => d.id === appr.documentId && d.source === 'memory-promotion'));

  const again = await req(MB(tenantA.id) + `/promotions/${prop.id}/approve`, { method: 'POST' });
  assert.equal(again.status, 400);
});

test('promote：驳回路径', async () => {
  const m = await j(await req(MB(tenantA.id), {
    method: 'POST', body: { kind: 'semantic', content: '待验证的猜测' },
  }));
  const prop = await j(await req(MB(tenantA.id) + `/${m.id}/promote`, { method: 'POST', body: {} }));
  const rej = await j(await req(MB(tenantA.id) + `/promotions/${prop.id}/reject`, {
    method: 'POST', body: { reason: '信息不足' },
  }));
  assert.equal(rej.status, 'rejected');
});

// ---------- 遗忘 ----------
test('forget：硬删 + 审计；他人 private 不可删', async () => {
  const m = await j(await req(MB(tenantA.id), {
    method: 'POST', token: memberKeyA, body: { kind: 'episodic', content: '可删的临时记忆' },
  }));
  const del = await j(await req(MB(tenantA.id) + `/${m.id}`, { method: 'DELETE', token: memberKeyA }));
  assert.equal(del.deleted, true);
  const list = await j(await req(MB(tenantA.id) + '/recall?q=可删的临时', { token: memberKeyA }));
  assert.ok(!list.some((x) => x.id === m.id));

  // 审计链有 memory.forgotten
  const ev = await j(await req(`/v1/admin/tenants/${tenantA.id}/evidence/audit?action=memory.forgotten`));
  assert.ok(ev.some((e) => e.resource_id === m.id));

  // 他人 private 不可删
  const priv = await j(await req(MB(tenantA.id), {
    method: 'POST', body: { kind: 'semantic', content: 'admin 私有不可删', visibility: 'private' },
  }));
  const r = await req(MB(tenantA.id) + `/${priv.id}`, { method: 'DELETE', token: memberKeyA });
  assert.equal(r.status, 403);
});

// ---------- 租户隔离 ----------
test('跨租户访问被拒绝', async () => {
  const r = await req(MB(tenantA.id) + '/recall', { token: adminKeyB });
  assert.equal(r.status, 403);
});

// ---------- 关联边 ----------
test('linkMemories：建边 + 非法 relation 400', async () => {
  const a = await j(await req(MB(tenantA.id), { method: 'POST', body: { kind: 'semantic', content: '边起点' } }));
  const b = await j(await req(MB(tenantA.id), { method: 'POST', body: { kind: 'semantic', content: '边终点' } }));
  const link = await j(await req(MB(tenantA.id) + `/${a.id}/links`, {
    method: 'POST', body: { dstId: b.id, relation: 'relates_to' },
  }));
  assert.equal(link.relation, 'relates_to');
  const bad = await req(MB(tenantA.id) + `/${a.id}/links`, {
    method: 'POST', body: { dstId: b.id, relation: 'likes' },
  });
  assert.equal(bad.status, 400);
});
