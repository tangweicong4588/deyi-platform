/** CI/仓库适配器契约测试：Review-R6（fake/live simulated 标记统一、Run 形状校验） */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createPipelineAdapter, assertRunShape } = await import('../src/adapters/pipeline/adapter.mjs');
const { createRepoClient } = await import('../src/adapters/gitea/client.mjs');

const fakeBinding = { provider: 'gitea', remote_url: 'https://gitea.example.com/org/repo.git' };

test('R6 pipeline fake：trigger/getRunStatus/listArtifacts 全部 simulated:true（M-14）', async () => {
  const a = createPipelineAdapter({ provider: 'gitea-actions', binding: fakeBinding });
  const run = await a.triggerRun({ kind: 'build', ref: 'main' });
  assert.equal(run.simulated, true);
  const st = await a.getRunStatus(run.id);
  assert.equal(st.simulated, true);
  await a.getRunStatus(run.id); // running
  const done = await a.getRunStatus(run.id); // passed
  assert.equal(done.status, 'passed');
  const arts = await a.listArtifacts(run.id);
  assert.ok(arts.length > 0);
  assert.ok(arts.every((x) => x.simulated === true), 'artifact 列表也必须显式标记');
});

test('R6 assertRunShape：simulated 非布尔值直接拒绝（M-15）', async () => {
  const good = { kind: 'build', status: 'queued', simulated: false };
  assertRunShape(good); // 不抛
  for (const bad of ['false', 'true', 0, 1, null, undefined]) {
    assert.throws(
      () => assertRunShape({ kind: 'build', status: 'queued', simulated: bad }),
      /simulated/,
      `simulated=${String(bad)} 应被拒绝`);
  }
});

test('R6 repo fake client：list 方法显式 simulated:true（M-14）', async () => {
  const c = createRepoClient({ binding: fakeBinding });
  for (const b of await c.listBranches()) assert.equal(b.simulated, true);
  for (const p of await c.listPulls()) assert.equal(p.simulated, true);
  const cm = await c.listCommits('main');
  for (const x of cm) assert.equal(x.simulated, true);
  const br = await c.createBranch({ branch: 'feat-r6', from: '0'.repeat(40) });
  assert.equal(br.simulated, true);
});
