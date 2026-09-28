// Phase 6 全链路 live：平台网关 → LiteLLM proxy → mock OpenAI 上游 → Qdrant
// 验证：chat 全链路 + 计量回写；知识文档 embedding→Qdrant 索引；记忆语义召回。
// 前置：infra 全起（start-infra.sh），app 以 LITELLM_URL 指向 :4000 启动。
import assert from 'node:assert';
import { pgQuery as pg } from './pg-cli.mjs';

const BASE = process.env.APP_BASE || 'http://127.0.0.1:18080';
const OP = process.env.OPERATOR_TOKEN || 'op-live-token';
const results = [];
const check = (name, fn) => {
  try { fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', `${name}：${e.message.slice(0, 160)}`]); }
};
async function api(method, path, body, token) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token || OP}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}


// 1. 租户 + actor + key
const { json: jT } = await api('GET', '/v1/admin/tenants');
let tenantId = jT.data?.[0]?.id;
if (!tenantId) {
  const { status: sT, json: jTn } = await api('POST', '/v1/admin/tenants', { name: '链路联调租户', slug: 'chain-' + Date.now().toString(36) });
  check('建租户', () => assert.ok([200, 201].includes(sT), `status=${sT}`));
  tenantId = jTn.data?.id || jTn.id;
}
let actorId = pg(`SELECT id FROM actors WHERE tenant_id='${tenantId}' AND kind='user' LIMIT 1`);
if (!actorId) {
  const { status: sA, json: jA } = await api('POST', `/v1/admin/tenants/${tenantId}/actors`,
    { kind: 'user', name: '链路测试员', email: 'chain@test.local' });
  check('建 actor', () => assert.ok([200, 201].includes(sA), `status=${sA}`));
  actorId = jA.data?.id || jA.id;
  // 绑租户 admin 角色
  await api('POST', `/v1/admin/tenants/${tenantId}/role-bindings`, { actorId, role: 'admin' });
}
const { status: sK, json: jK } = await api('POST', `/v1/admin/tenants/${tenantId}/api-keys`,
  { actorId, name: 'chain-live-' + Date.now() });
check('签发租户 key', () => assert.ok([200, 201].includes(sK), `status=${sK}`));
const KEY = jK.data.key;
const { status: sP, json: jP } = await api('POST', `/v1/admin/tenants/${tenantId}/projects`,
  { name: '链路联调', slug: 'chain-' + Date.now().toString(36) });
check('建项目', () => assert.ok([200, 201].includes(sP)));
const projectId = jP.data.id;

// 2. chat 全链路：网关 → LiteLLM → mock
const { status: sC, json: jC } = await api('POST', '/v1/gw/chat/completions',
  { model: 'deyi-default', messages: [{ role: 'user', content: 'ping' }], project_id: projectId }, KEY);
check('chat 全链路 200', () => assert.strictEqual(sC, 200));
check('chat 回复来自 mock 上游', () =>
  assert.match(jC.data?.choices?.[0]?.message?.content || jC.choices?.[0]?.message?.content || '', /mock/));
const callsChat = Number(pg(`SELECT COUNT(*) FROM model_calls WHERE tenant_id='${tenantId}'`));
check('chat 计量回写 PG', () => assert.ok(callsChat >= 1, `model_calls=${callsChat}`));

// 3. 知识文档：ingest → embedding(LiteLLM) → Qdrant deyi_knowledge
const docText = '得逸智行平台 Phase 6 联调验证文档。';
const { status: sD, json: jD } = await api('POST', `/v1/projects/${projectId}/knowledge/documents`,
  { title: 'chain-doc', content: docText }, KEY);
check('知识文档 ingest 201', () => assert.ok([200, 201].includes(sD), `status=${sD} ${JSON.stringify(jD).slice(0, 120)}`));
const docId = jD.data?.id || jD.id;
await new Promise((r) => setTimeout(r, 3000)); // 等异步索引（若有）
const qk = await fetch('http://127.0.0.1:6333/collections/deyi_knowledge').then((r) => r.json()).catch(() => null);
check('Qdrant deyi_knowledge 存在', () => assert.ok(qk?.result, 'collection 不存在'));
const pts = await fetch('http://127.0.0.1:6333/collections/deyi_knowledge/points/count',
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json()).catch(() => null);
check('知识向量已入 Qdrant', () => assert.ok((pts?.result?.count || 0) >= 1, `count=${pts?.result?.count}`));

// 4. 记忆语义召回：写入 → 向量召回
const { status: sM } = await api('POST', `/v1/tenants/${tenantId}/memory`,
  { projectId, kind: 'episodic', content: '联调记忆：LiteLLM 全链路打通', visibility: 'project' }, KEY);
check('写记忆 201', () => assert.ok([200, 201].includes(sM), `status=${sM}`));
await new Promise((r) => setTimeout(r, 2000));
const { status: sR, json: jR } = await api('GET',
  `/v1/tenants/${tenantId}/memory/recall?q=${encodeURIComponent('LiteLLM 联调')}&mode=semantic&projectId=${projectId}`, null, KEY);
check('记忆语义召回 200', () => assert.strictEqual(sR, 200));
const items = jR.data?.items || jR.data || [];
check('语义召回命中刚才的记忆', () =>
  assert.ok(JSON.stringify(items).includes('LiteLLM'), `items=${JSON.stringify(items).slice(0, 120)}`));

console.log(results.map(([s, n]) => `${s} ${n}`).join('\n'));
const fails = results.filter(([s]) => s === 'FAIL').length;
console.log(fails ? `CHAIN LIVE: ${fails} 项失败` : 'CHAIN LIVE: 全部通过（网关→LiteLLM→mock→Qdrant 全链路）');
process.exit(fails ? 1 : 0);
