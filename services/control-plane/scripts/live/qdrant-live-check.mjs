/**
 * scripts/live/qdrant-live-check.mjs —— Phase 6：Qdrant live 联调验证。
 * 用法：QDRANT_URL=http://127.0.0.1:6333 node scripts/live/qdrant-live-check.mjs
 * 验证：连通性 → collection 自动创建 → upsert → 租户过滤召回隔离 → 按租户删除。
 * 向量为合成向量（不依赖 embedding 上游），验证的是 Qdrant HTTP 契约。
 */
import assert from 'node:assert/strict';

const { probeMemoryVector, upsertMemories, searchMemories, deleteMemoriesByTenant, getMemoryVectorStatus } =
  await import('../../src/modules/memory/vector.mjs');

const DIM = 8;
const vec = (seed) => Array.from({ length: DIM }, (_, i) => Math.sin(seed * 7 + i));
const results = [];
const check = (name, fn) => {
  try { fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', `${name}：${e.message}`]); }
};

const probe = await probeMemoryVector();
console.log('probe status:', probe, '| cached:', getMemoryVectorStatus());
assert.equal(probe, 'qdrant(live)', 'Qdrant 不可达');

const tidA = 'live-tenant-a', tidB = 'live-tenant-b';
await upsertMemories([
  { id: 'live-mem-a1', vector: vec(1), payload: { memory_id: 'live-mem-a1', tenant_id: tidA } },
  { id: 'live-mem-b1', vector: vec(2), payload: { memory_id: 'live-mem-b1', tenant_id: tidB } },
]);
console.log('upsert ok');

const ra = await searchMemories({ vector: vec(1), filter: { tenant_id: tidA }, limit: 10 });
check('A 租户召回只含 A 的记忆', () => {
  assert.ok(ra.length > 0, 'A 应召回至少一条');
  assert.ok(ra.every((r) => r.engine === 'qdrant'), '应走 qdrant 引擎');
  assert.ok(!ra.some((r) => r.memory_id === 'live-mem-b1'), '泄露了 B 租户记忆');
});
const rb = await searchMemories({ vector: vec(2), filter: { tenant_id: tidB }, limit: 10 });
check('B 租户召回只含 B 的记忆', () => {
  assert.ok(rb.some((r) => r.memory_id === 'live-mem-b1'), 'B 应召回自己的记忆');
  assert.ok(!rb.some((r) => r.memory_id === 'live-mem-a1'), '泄露了 A 租户记忆');
});

await deleteMemoriesByTenant(tidA);
const ra2 = await searchMemories({ vector: vec(1), filter: { tenant_id: tidA }, limit: 10 });
check('按租户删除后 A 召回为空', () => {
  assert.equal(ra2.length, 0, `A 仍有 ${ra2.length} 条残留`);
});
const rb2 = await searchMemories({ vector: vec(2), filter: { tenant_id: tidB }, limit: 10 });
check('按租户删除不影响 B', () => {
  assert.ok(rb2.some((r) => r.memory_id === 'live-mem-b1'), 'B 的记忆被误删');
});
await deleteMemoriesByTenant(tidB);

for (const [s, n] of results) console.log(`${s} ${n}`);
const failed = results.filter(([s]) => s === 'FAIL');
if (failed.length) { console.error(`QDRANT LIVE CHECK: ${failed.length} 项失败`); process.exit(1); }
console.log('QDRANT LIVE CHECK: 全部通过');
