/**
 * tests/cost-breakdown.test.mjs —— V2.17：成本分摊报表。
 * - by=project / by=actor 分摊；同一账期分摊总和 == 账单 usage 总额（reconciled）
 * - 明细归档区间：detail_archived=true + 标注"明细已归档，仅账单总额"；
 *   project 走 cost_ledger，actor 无明细
 * - 参数校验 / 鉴权 / 404
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import http from 'node:http';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-costbr-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op-' + randomBytes(8).toString('hex');
process.env.DEV_IDP_SECRET = 'dev-' + randomBytes(8).toString('hex');
process.env.BOOTSTRAP_ENABLED = 'false';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerBillingRoutes } = await import('../src/modules/billing/routes.mjs');
const { generateInvoice, periodRange } = await import('../src/modules/billing/service.mjs');
const { rollupCostLedger } = await import('../src/modules/evidence/cost.mjs');

let tenant, proj1, proj2, actor1, actor2, app, server, base;
const OP = () => process.env.OPERATOR_TOKEN;

const now = new Date();
const PERIOD = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const { start: P_START, end: P_END } = periodRange(PERIOD);
const dayISO = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const FROM = dayISO(P_START), TO = dayISO(P_END);

async function seedCall({ projectId, actorId, tokens, cost, at }) {
  await db().query(
    `INSERT INTO model_calls(id, tenant_id, project_id, actor_id, trace_id, model, endpoint,
      prompt_tokens, completion_tokens, total_tokens, cost_cents, latency_ms, status, cached, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [`call_cb_${randomBytes(4).toString('hex')}`, tenant.id, projectId, actorId,
     'tr_' + randomBytes(4).toString('hex'), 'deyi-chat', 'chat.completions',
     0, 0, tokens, cost, 5, 'ok', 0, at]);
}

function req(path, { method = 'GET', token = OP(), qs = '' } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + path + qs, {
      method, headers: token ? { authorization: 'Bearer ' + token } : {},
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    r.on('error', reject);
    r.end();
  });
}
const j = (r) => r.body.data;
const BR = (tid) => `/v1/admin/tenants/${tid}/cost/breakdown`;

before(async () => {
  await openDb();
  await migrate(db());
  app = createApp();
  registerIdentityRoutes(app);
  registerBillingRoutes(app);
  server = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.address().port}`;

  tenant = await store.createTenant({ name: '分摊租户', plan: 'professional' });
  proj1 = await store.createProject(tenant.id, { name: '项目甲', slug: 'proj-jia' });
  proj2 = await store.createProject(tenant.id, { name: '项目乙', slug: 'proj-yi' });
  actor1 = await store.createActor(tenant.id, { kind: 'user', name: '成员一' });
  actor2 = await store.createActor(tenant.id, { kind: 'user', name: '成员二' });

  const d5 = P_START + 4 * 86400000, d10 = P_START + 9 * 86400000, d15 = P_START + 14 * 86400000;
  // 项目甲/成员一：2 次（tokens 200, cost 100）；项目乙/成员二：1 次（100, 60）；租户级/成员一：1 次（50, 40）
  await seedCall({ projectId: proj1.id, actorId: actor1.id, tokens: 100, cost: 50, at: d5 });
  await seedCall({ projectId: proj1.id, actorId: actor1.id, tokens: 100, cost: 50, at: d10 });
  await seedCall({ projectId: proj2.id, actorId: actor2.id, tokens: 100, cost: 60, at: d15 });
  await seedCall({ projectId: null, actorId: actor1.id, tokens: 50, cost: 40, at: d15 });
  // error 调用不计入
  await db().query(
    `INSERT INTO model_calls(id, tenant_id, project_id, actor_id, trace_id, model, endpoint,
      prompt_tokens, completion_tokens, total_tokens, cost_cents, latency_ms, status, cached, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['call_cb_err', tenant.id, proj1.id, actor1.id, 'tr_err', 'deyi-chat', 'chat.completions',
     0, 0, 999, 999, 5, 'error', 0, d10]);

  // 归档区间数据（200 天前，超 180 天保留期）
  const oldAt = Date.now() - 200 * 86400000;
  await seedCall({ projectId: proj1.id, actorId: actor1.id, tokens: 1000, cost: 500, at: oldAt });
  // 给旧区间跑 rollup（project 归档路径用 ledger）
  const oldDay = dayISO(oldAt);
  await rollupCostLedger({ from: oldDay, to: oldDay });
});

after(() => new Promise((r) => server.close(r)));

test('by=project：分摊总和 == 账单 usage 总额（reconciled）', async () => {
  const inv = await generateInvoice(tenant.id, PERIOD);
  assert.equal(inv.status, 'draft');
  const r = await req(BR(tenant.id), { qs: `?by=project&from=${FROM}&to=${TO}` });
  assert.equal(r.status, 200);
  const d = j(r);
  assert.equal(d.by, 'project');
  assert.equal(d.detail_archived, false);
  assert.equal(d.groups.length, 3, '项目甲/项目乙/租户级');
  const byName = Object.fromEntries(d.groups.map((g) => [g.name, g]));
  assert.equal(byName['项目甲'].cost_cents, 100);
  assert.equal(byName['项目甲'].calls, 2);
  assert.equal(byName['项目乙'].cost_cents, 60);
  assert.equal(byName['(租户级)'].cost_cents, 40);
  assert.equal(d.total.cost_cents, 200);
  assert.equal(d.total.tokens, 350);
  assert.equal(d.total.calls, 4);
  // 账单对账
  assert.equal(d.invoice_usage_total.cost_cents, inv.usage_cost_cents);
  assert.equal(d.total.cost_cents, d.invoice_usage_total.cost_cents, '分摊总和 == 账单总额');
  assert.equal(d.reconciled, true);
});

test('by=actor：按成员分摊，总额同样对账', async () => {
  const r = await req(BR(tenant.id), { qs: `?by=actor&from=${FROM}&to=${TO}` });
  assert.equal(r.status, 200);
  const d = j(r);
  const byName = Object.fromEntries(d.groups.map((g) => [g.name, g]));
  assert.equal(byName['成员一'].cost_cents, 140); // 100 + 40
  assert.equal(byName['成员一'].calls, 3);
  assert.equal(byName['成员二'].cost_cents, 60);
  assert.equal(d.total.cost_cents, 200);
  assert.equal(d.reconciled, true);
});

test('部分区间：reconciled=false（非完整账期）', async () => {
  const mid = dayISO(P_START + 9 * 86400000);
  const r = await req(BR(tenant.id), { qs: `?by=project&from=${FROM}&to=${mid}` });
  assert.equal(r.status, 200);
  assert.equal(j(r).reconciled, false);
});

test('归档区间 by=project：detail_archived + ledger 数据 + 标注', async () => {
  const oldDay = dayISO(Date.now() - 200 * 86400000);
  const r = await req(BR(tenant.id), { qs: `?by=project&from=${oldDay}&to=${oldDay}` });
  assert.equal(r.status, 200);
  const d = j(r);
  assert.equal(d.detail_archived, true);
  assert.ok(d.note.includes('明细已归档'), `note 应标注归档: ${d.note}`);
  const g = d.groups.find((x) => x.name === '项目甲');
  assert.ok(g, 'project 维度走 cost_ledger');
  assert.equal(g.cost_cents, 500);
});

test('归档区间 by=actor：无明细，仅账单总额', async () => {
  const oldDay = dayISO(Date.now() - 200 * 86400000);
  const r = await req(BR(tenant.id), { qs: `?by=actor&from=${oldDay}&to=${oldDay}` });
  assert.equal(r.status, 200);
  const d = j(r);
  assert.equal(d.detail_archived, true);
  assert.equal(d.groups.length, 0);
  assert.ok(d.note.includes('明细已归档'));
});

test('参数校验与鉴权', async () => {
  const bad1 = await req(BR(tenant.id), { qs: '?by=model' });
  assert.equal(bad1.status, 400);
  const bad2 = await req(BR(tenant.id), { qs: `?from=${TO}&to=${FROM}` });
  assert.equal(bad2.status, 400);
  const bad3 = await req(BR(tenant.id), { qs: '?from=not-a-date' });
  assert.equal(bad3.status, 400);
  const noAuth = await req(BR(tenant.id), { token: null });
  assert.equal(noAuth.status, 401);
  const notFound = await req(BR('ten_nope'), {});
  assert.equal(notFound.status, 404);
});
