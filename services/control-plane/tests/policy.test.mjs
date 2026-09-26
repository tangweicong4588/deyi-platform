/** policy 测试：内置引擎默认策略 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { decide } = await import('../src/modules/policy/index.mjs');

const base = {
  actor: { id: 'usr_x', kind: 'user', status: 'active', roles: [] },
  tenant: { id: 'ten_x', status: 'active' },
  project: { id: 'prj_x' },
};

test('预算熔断：估算成本超剩余额度 → 拒绝', async () => {
  const r = await decide({ ...base, action: 'model.invoke', context: { budgetRemaining: 10, estimatedCost: 99 } });
  assert.equal(r.allow, false);
  assert.match(r.reason, /预算/);
  assert.equal(r.engine, 'builtin');
});

test('预算充足 → 放行', async () => {
  const r = await decide({ ...base, action: 'model.invoke', context: { budgetRemaining: 100, estimatedCost: 5 } });
  assert.equal(r.allow, true);
});

test('高风险工具调用 → 放行但带 approval_required 义务', async () => {
  const r = await decide({ ...base, action: 'tool.invoke', resource: { kind: 'tool', risk: 'high' } });
  assert.equal(r.allow, true);
  assert.ok(r.obligations.includes('approval_required'));
});

test('中风险工具调用：viewer 拒绝，operator 放行', async () => {
  const viewer = { ...base, actor: { ...base.actor, roles: [{ project_id: 'prj_x', role: 'viewer' }] } };
  const r1 = await decide({ ...viewer, action: 'tool.invoke', resource: { kind: 'tool', risk: 'medium' } });
  assert.equal(r1.allow, false);

  const op = { ...base, actor: { ...base.actor, roles: [{ project_id: null, role: 'operator' }] } };
  const r2 = await decide({ ...op, action: 'tool.invoke', resource: { kind: 'tool', risk: 'medium' } });
  assert.equal(r2.allow, true);
});

test('知识读取禁止跨项目', async () => {
  const r = await decide({
    ...base, action: 'knowledge.read',
    resource: { kind: 'doc', projectId: 'prj_other' },
  });
  assert.equal(r.allow, false);
  assert.match(r.reason, /跨项目/);
});

test('本体发布：viewer 拒绝，operator 放行但需评审', async () => {
  const viewer = { ...base, actor: { ...base.actor, roles: [{ project_id: 'prj_x', role: 'viewer' }] } };
  const r1 = await decide({ ...viewer, action: 'ontology.publish' });
  assert.equal(r1.allow, false);

  const op = { ...base, actor: { ...base.actor, roles: [{ project_id: null, role: 'operator' }] } };
  const r2 = await decide({ ...op, action: 'ontology.publish' });
  assert.equal(r2.allow, true);
  assert.ok(r2.obligations.includes('review_required'));
});

test('本体写入：viewer 拒绝，operator 放行', async () => {
  const viewer = { ...base, actor: { ...base.actor, roles: [{ project_id: 'prj_x', role: 'viewer' }] } };
  const r1 = await decide({ ...viewer, action: 'ontology.write' });
  assert.equal(r1.allow, false);

  const op = { ...base, actor: { ...base.actor, roles: [{ project_id: null, role: 'operator' }] } };
  const r2 = await decide({ ...op, action: 'ontology.write' });
  assert.equal(r2.allow, true);
});

test('未知动作 fail-closed', async () => {
  const r = await decide({ ...base, action: 'nuke.everything' });
  assert.equal(r.allow, false);
});

test('停用租户一律拒绝', async () => {
  const r = await decide({
    ...base, tenant: { id: 'ten_x', status: 'suspended' }, action: 'model.invoke',
  });
  assert.equal(r.allow, false);
});

/* ============ batch1 遗留：OPA 故障 fail-closed ============ */
test('OPA 畸形 body → fail-closed 拒绝（不抛 raw Error）', async () => {
  const { createServer } = await import('node:http');
  const { decideViaOpa } = await import('../src/modules/policy/opa.mjs');
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('this is not json {{{'); // 畸形 body
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const receipt = await decideViaOpa({ action: 'x' }, url);
    assert.equal(receipt.allow, false, '畸形 body 必须拒绝');
    assert.equal(receipt.engine, 'opa');
    assert.ok(receipt.obligations.includes('audit'), '拒绝必须带审计义务');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('OPA 不可达 → fail-closed 拒绝', async () => {
  const { decideViaOpa } = await import('../src/modules/policy/opa.mjs');
  const receipt = await decideViaOpa({ action: 'x' }, 'http://127.0.0.1:1'); // 不可达端口
  assert.equal(receipt.allow, false);
  assert.equal(receipt.policyVersion, 'opa/unreachable');
});

test('OPA 正常 allow → 放行并透出 obligations', async () => {
  const { createServer } = await import('node:http');
  const { decideViaOpa } = await import('../src/modules/policy/opa.mjs');
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result: { allow: true, obligations: ['audit', 'approval_required'], reason: 'ok', policy_version: 'v1' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const receipt = await decideViaOpa({ action: 'x' }, url);
    assert.equal(receipt.allow, true);
    assert.ok(receipt.obligations.includes('approval_required'));
    assert.equal(receipt.engine, 'opa');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
