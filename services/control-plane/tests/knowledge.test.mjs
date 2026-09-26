/** knowledge 测试：ingest / ACL 预过滤 / 版本链 / 解析失败 / 网关计量 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

const DOCLING_PORT = 14541;
const LITELLM_PORT = 14542;

// ---- fake Docling ----
const fakeDocling = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200).end('{}');
    return;
  }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const src = body.sources?.[0] || {};
    if (/pdf/.test(src.mime_type || '')) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'cannot parse pdf in test double' }));
    }
    const text = Buffer.from(src.base64_content || '', 'base64').toString('utf8');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ document: { md_content: '# 解析结果\n\n' + text } }));
  });
});
await new Promise((r) => fakeDocling.listen(DOCLING_PORT, '127.0.0.1', r));
after(() => new Promise((r) => fakeDocling.close(r)));

// ---- fake LiteLLM：确定性"语义"向量（字符桶直方图，共享词汇越多余弦越高） ----
function fakeEmbed(text) {
  const v = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const ch of String(text)) v[ch.codePointAt(0) % 8]++;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}
const seenEmbed = [];
const fakeLitellm = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    if (req.headers['authorization'] !== 'Bearer test-master') {
      res.writeHead(401).end('{}');
      return;
    }
    const body = JSON.parse(raw || '{}');
    if (req.url === '/v1/embeddings') {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      seenEmbed.push({ model: body.model, user: body.user, metadata: body.metadata, n: inputs.length });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        data: inputs.map((t, i) => ({ embedding: fakeEmbed(t), index: i })),
        usage: { prompt_tokens: inputs.length * 10, total_tokens: inputs.length * 10 },
      }));
    }
    res.writeHead(404).end('{}');
  });
});
await new Promise((r) => fakeLitellm.listen(LITELLM_PORT, '127.0.0.1', r));
after(() => new Promise((r) => fakeLitellm.close(r)));

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-kn-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.DEV_IDP_SECRET = 'test-dev-secret';
process.env.BOOTSTRAP_ENABLED = 'false';
process.env.LITELLM_URL = `http://127.0.0.1:${LITELLM_PORT}`;
process.env.LITELLM_MASTER_KEY = 'test-master';
process.env.DOCLING_URL = `http://127.0.0.1:${DOCLING_PORT}`;
process.env.GATEWAY_MAX_RETRIES = '0';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const gstore = await import('../src/modules/gateway/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerGatewayRoutes } = await import('../src/modules/gateway/routes.mjs');
const { registerKnowledgeRoutes } = await import('../src/modules/knowledge/routes.mjs');
const { parseBuiltin } = await import('../src/modules/knowledge/docling.mjs');

async function mkKey(tenantId, actorId, projectId = null) {
  const k = mintKey();
  await store.createApiKeyRow({ tenantId, projectId, actorId, name: 'k', prefix: k.prefix, keyHash: k.keyHash });
  return k.secret;
}

let tenantA, tenantB, adminA, adminB, viewerA;
let pA1, pA2, pA3, pB1;
let adminKeyA, adminKeyB, viewerKeyA, boundKeyA1;
before(async () => {
  await openDb();
  await migrate(db());
  await gstore.ensureSeedModels();

  tenantA = await store.createTenant({ name: 'K Tenant A' });
  adminA = await store.createActor(tenantA.id, { kind: 'user', name: 'Admin A' });
  await store.bindRole(tenantA.id, adminA.id, null, 'admin');
  adminKeyA = await mkKey(tenantA.id, adminA.id);

  viewerA = await store.createActor(tenantA.id, { kind: 'user', name: 'Viewer A' });
  pA1 = await store.createProject(tenantA.id, { name: 'KA Project 1' });
  pA2 = await store.createProject(tenantA.id, { name: 'KA Project 2' });
  pA3 = await store.createProject(tenantA.id, { name: 'KA Project 3' });
  await store.bindRole(tenantA.id, viewerA.id, pA1.id, 'viewer');
  viewerKeyA = await mkKey(tenantA.id, viewerA.id);
  boundKeyA1 = await mkKey(tenantA.id, adminA.id, pA1.id); // 绑定到 pA1 的 key

  tenantB = await store.createTenant({ name: 'K Tenant B' });
  adminB = await store.createActor(tenantB.id, { kind: 'user', name: 'Admin B' });
  await store.bindRole(tenantB.id, adminB.id, null, 'admin');
  adminKeyB = await mkKey(tenantB.id, adminB.id);
  pB1 = await store.createProject(tenantB.id, { name: 'KB Project 1' });
});

let base, appServer;
before(async () => {
  const app = createApp();
  registerIdentityRoutes(app);
  registerGatewayRoutes(app);
  registerKnowledgeRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;
});
after(() => new Promise((r) => appServer.close(r)));

const post = (path, body, token) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
const get = (path, token) => fetch(base + path, { headers: { authorization: `Bearer ${token}` } });

const DOC_TEXT_A1 = '得逸智行企业级 AI 平台知识库。平台采用自研控制面加开源执行底座的架构，模型网关负责多租户预算与计量。';

test('ingest：Docling 解析 → embedding(网关) → 索引 → 可检索', async () => {
  const r = await post(`/v1/projects/${pA1.id}/knowledge/documents`,
    { title: '架构说明', content: DOC_TEXT_A1, mime: 'text/markdown' }, adminKeyA);
  assert.equal(r.status, 201);
  const out = await r.json();
  assert.equal(out.document.status, 'ready');
  assert.equal(out.canonical.version, 1);
  assert.equal(out.canonical.parse_engine, 'docling');
  assert.ok(out.chunks > 0);

  // embedding 走了网关：上游收到了身份归属
  const last = seenEmbed[seenEmbed.length - 1];
  assert.equal(last.metadata.deyi_tenant_id, tenantA.id);
  assert.equal(last.metadata.deyi_project_id, pA1.id);
  assert.equal(last.user, adminA.id);

  const s = await post(`/v1/projects/${pA1.id}/knowledge/search`, { query: '模型网关多租户预算', limit: 5 }, adminKeyA);
  assert.equal(s.status, 200);
  const { data, total } = await s.json();
  assert.ok(total > 0);
  assert.equal(data[0].document_id, out.document.id);
  assert.ok(data[0].text.includes('模型网关'));
  assert.ok(typeof data[0].score === 'number');
  assert.ok(data[0].span && data[0].span.start >= 0);
  assert.ok(data[0].fact_id.startsWith('fct_'));
});

test('ACL 预过滤：A2 看不到 A1 的文档；共享后可见', async () => {
  // pA2 搜索：A1 的文档不可见
  const s1 = await post(`/v1/projects/${pA2.id}/knowledge/search`, { query: '模型网关', limit: 5 }, adminKeyA);
  assert.equal(s1.status, 200);
  assert.equal((await s1.json()).total, 0);

  // 找到 A1 的文档并共享给 A2
  const docs = await (await get(`/v1/projects/${pA1.id}/knowledge/documents`, adminKeyA)).json();
  const docId = docs.data[0].id;
  const sh = await post(`/v1/projects/${pA1.id}/knowledge/documents/${docId}/share`, { projectId: pA2.id }, adminKeyA);
  assert.equal(sh.status, 201);

  const s2 = await post(`/v1/projects/${pA2.id}/knowledge/search`, { query: '模型网关', limit: 5 }, adminKeyA);
  assert.equal(s2.status, 200);
  assert.ok((await s2.json()).total > 0);
});

test('版本链：reparse 生成 v2，旧 facts 标记 superseded', async () => {
  const r = await post(`/v1/projects/${pA3.id}/knowledge/documents`,
    { title: '版本测试', content: '第一版内容：旧架构说明。', mime: 'text/markdown' }, adminKeyA);
  const docId = (await r.json()).document.id;

  const rp = await post(`/v1/projects/${pA3.id}/knowledge/documents/${docId}/reparse`,
    { content: '第二版内容：全新架构说明，引入向量检索。' }, adminKeyA);
  assert.equal(rp.status, 200);
  const out = await rp.json();
  assert.equal(out.canonical.version, 2);

  const facts = await db().query(`SELECT status, COUNT(*) AS n FROM facts WHERE document_id=? GROUP BY status`, [docId]);
  const byStatus = Object.fromEntries(facts.map((f) => [f.status, Number(f.n)]));
  assert.ok(byStatus.superseded > 0);
  assert.ok(byStatus.active > 0);

  const s = await post(`/v1/projects/${pA3.id}/knowledge/search`, { query: '向量检索', limit: 5 }, adminKeyA);
  const { data } = await s.json();
  assert.ok(data.length > 0);
  assert.ok(data.some((d) => d.text.includes('向量检索')));
  assert.ok(!data.some((d) => d.text.includes('旧架构')));
});

test('解析失败：pdf 无 Docling 真服务时 400，文档标记 failed', async () => {
  const r = await post(`/v1/projects/${pA1.id}/knowledge/documents`,
    { title: 'bad.pdf', content: '%PDF-1.4 fake', mime: 'application/pdf' }, adminKeyA);
  assert.equal(r.status, 400);
  const docs = await (await get(`/v1/projects/${pA1.id}/knowledge/documents`, adminKeyA)).json();
  const bad = docs.data.find((d) => d.title === 'bad.pdf');
  assert.ok(bad);
  assert.equal(bad.status, 'failed');
  assert.ok(bad.fail_reason);
});

test('未认证 → 401', async () => {
  const r = await fetch(base + `/v1/projects/${pA1.id}/knowledge/search`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'x' }),
  });
  assert.equal(r.status, 401);
});

test('跨租户隔离：B 租户搜 A 租户项目 → 403', async () => {
  const r = await post(`/v1/projects/${pA1.id}/knowledge/search`, { query: '模型网关' }, adminKeyB);
  assert.equal(r.status, 403);
});

test('Key 项目绑定：绑定到 A1 的 key 搜 A2 → 403', async () => {
  const r = await post(`/v1/projects/${pA2.id}/knowledge/search`, { query: '模型网关' }, boundKeyA1);
  assert.equal(r.status, 403);
});

test('RBAC：viewer 可搜但不可 ingest', async () => {
  const s = await post(`/v1/projects/${pA1.id}/knowledge/search`, { query: '模型网关' }, viewerKeyA);
  assert.equal(s.status, 200);
  const w = await post(`/v1/projects/${pA1.id}/knowledge/documents`,
    { title: 'no', content: 'no', mime: 'text/markdown' }, viewerKeyA);
  assert.equal(w.status, 403);
});

test('网关计量：embedding 调用写入了预算账本', async () => {
  const calls = await gstore.listCalls(tenantA.id, 500);
  const emb = calls.filter((c) => c.endpoint === 'embeddings' && c.status === 'ok');
  assert.ok(emb.length > 0);
  assert.ok(emb.every((c) => c.total_tokens > 0));
  assert.ok(emb.every((c) => c.trace_id));
  // 账本不含原文
  assert.ok(!JSON.stringify(emb).includes('得逸智行企业级'));
});

test('内置降级解析单元：md 直接通过，pdf 明确失败', async () => {
  const ok = parseBuiltin({ mime: 'text/markdown', content: '# hi' });
  assert.equal(ok.ok, true);
  assert.equal(ok.markdown, '# hi');
  assert.equal(ok.engine, 'builtin');
  const fail = parseBuiltin({ mime: 'application/pdf', content: 'xxx' });
  assert.equal(fail.ok, false);
  assert.match(fail.reason, /Docling/);
});

test('chunkText：重复文本的 span 精确定位，不错位', async () => {
  const { chunkText } = await import('../src/modules/knowledge/service.mjs');
  const md = '相同段落。\n\n不同段落 B。\n\n相同段落。';
  const chunks = chunkText(md);
  assert.equal(chunks.length, 1);
  const c = chunks[0];
  // span 切片必须精确还原块文本
  assert.equal(md.slice(c.span.start, c.span.end), c.text);

  // 多块场景：每块的 span 切片精确还原，且块按原文顺序不重叠
  const long = Array.from({ length: 20 }, (_, i) => `第${i}段，内容各不相同 ${'x'.repeat(40)}。`).join('\n\n');
  const cs = chunkText(long);
  assert.ok(cs.length > 1);
  for (const ch of cs) {
    assert.equal(long.slice(ch.span.start, ch.span.end), ch.text);
  }
  for (let i = 1; i < cs.length; i++) assert.ok(cs[i].span.start >= cs[i - 1].span.end);
});
