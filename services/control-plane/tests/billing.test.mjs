/**
 * tests/billing.test.mjs —— V2.3：多租户计费与账单。
 * 生成/重算幂等、状态机（draft→finalized→paid；draft|finalized→void）、
 * 定稿后不可变、账期校验、跨租户隔离、operator 跑批、审计。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-billing-')), 'test.db');
process.env.OPERATOR_TOKEN='test-operator-token-billing';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerBillingRoutes } = await import('../src/modules/billing/routes.mjs');
const { provisionTenant } = await import('../src/modules/identity/provision.mjs');

const OPERATOR = process.env.OPERATOR_TOKEN;
const PERIOD = '2026-09';

let app, server, base, tenantA, tenantB, adminKeyA, adminKeyB, actorA;

async function req(path, { method = 'GET', token = adminKeyA, body } = {}) {
  return fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const j = async (r) => (await r.json()).data;
const B = (tid) => `/v1/tenants/${tid}/billing`;

// 本地时区口径的时间戳（与网关 periodKey 一致）
const ts = (y, m, d) => new Date(y, m - 1, d, 12).getTime();

async function seedUsage(tenantId, { tokens, cost, calls, y = 2026, m = 9 }) {
  for (let i = 0; i < calls; i++) {
    await db().query(
      `INSERT INTO model_calls(id, tenant_id, project_id, actor_id, trace_id, model, endpoint,
        prompt_tokens, completion_tokens, total_tokens, cost_cents, latency_ms, status, cached, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [`call_b${tenantId.slice(-4)}_${y}${m}_${i}_${Date.now()}`, tenantId, null, actorA,
       `tr_${i}`, 'deyi-chat', 'chat.completions',
       0, 0, tokens, cost, 5, 'ok', 0, ts(y, m, 10 + i)]);
  }
}

test.before(async () => {
  openDb();
  await migrate(db());
  app = createApp();
  registerIdentityRoutes(app);
  registerBillingRoutes(app);
  server = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.address().port}`;

  const outA = await provisionTenant({ name: '账单租户A', plan: 'professional' });
  tenantA = outA.tenant; adminKeyA = outA.apiKey.key;
  const outB = await provisionTenant({ name: '账单租户B', plan: 'trial' });
  tenantB = outB.tenant; adminKeyB = outB.apiKey.key;
  actorA = (await db().query(`SELECT id FROM actors WHERE tenant_id=? LIMIT 1`, [tenantA.id]))[0].id;

  // A：9 月 3 次调用（tokens=300, cost=150）；8 月 1 次（应被排除）
  await seedUsage(tenantA.id, { tokens: 100, cost: 50, calls: 3, y: 2026, m: 9 });
  await seedUsage(tenantA.id, { tokens: 999, cost: 999, calls: 1, y: 2026, m: 8 });
});

test.after(async () => { await server.close(); });

test('generate：draft 账单 = 套餐月费 + 当月计量；跨月调用不计入', async () => {
  const r = await req(B(tenantA.id) + '/invoices', { method: 'POST', body: { period_key: PERIOD } });
  assert.equal(r.status, 201);
  const inv = await j(r);
  assert.equal(inv.status, 'draft');
  assert.equal(inv.period_key, PERIOD);
  assert.equal(inv.plan, 'professional');
  assert.equal(inv.plan_fee_cents, 9900);
  assert.equal(inv.usage_tokens, 300);
  assert.equal(inv.usage_calls, 3);
  assert.equal(inv.usage_cost_cents, 150);
  assert.equal(inv.total_cents, 9900 + 150);
  assert.equal(inv.line_items.length, 2);
});

test('generate 幂等：draft 重算用同一 id；period_key 非法 400', async () => {
  const first = await j(await req(B(tenantA.id) + '/invoices', { method: 'POST', body: { period_key: PERIOD } }));
  // 再加一次调用后重算：总额更新，id 不变
  await seedUsage(tenantA.id, { tokens: 10, cost: 10, calls: 1, y: 2026, m: 9 });
  const second = await j(await req(B(tenantA.id) + '/invoices', { method: 'POST', body: { period_key: PERIOD } }));
  assert.equal(second.id, first.id);
  assert.equal(second.usage_calls, 4);
  assert.equal(second.total_cents, 9900 + 160);

  for (const bad of ['2026-13', '2026-9', 'abc', '']) {
    const r = await req(B(tenantA.id) + '/invoices', { method: 'POST', body: { period_key: bad } });
    assert.equal(r.status, 400, bad);
  }
});

test('状态机：finalize 冻结；finalized 后重算 409、二次 finalize 400', async () => {
  const inv = await j(await req(B(tenantA.id) + '/invoices', { method: 'POST', body: { period_key: PERIOD } }));
  const fin = await j(await req(B(tenantA.id) + `/invoices/${inv.id}/finalize`, { method: 'POST' }));
  assert.equal(fin.status, 'finalized');
  assert.ok(fin.finalized_at);

  const regen = await req(B(tenantA.id) + '/invoices', { method: 'POST', body: { period_key: PERIOD } });
  assert.equal(regen.status, 409);
  const fin2 = await req(B(tenantA.id) + `/invoices/${inv.id}/finalize`, { method: 'POST' });
  assert.equal(fin2.status, 400);
  // draft 直接 pay 不允许
  const draftB = await j(await req(B(tenantB.id) + '/invoices', { method: 'POST', body: { period_key: PERIOD }, token: adminKeyB }));
  const payDraft = await req(B(tenantB.id) + `/invoices/${draftB.id}/pay`, { method: 'POST', token: adminKeyB });
  assert.equal(payDraft.status, 400);
});

test('pay：finalized→paid；paid 后 void 400', async () => {
  const inv = await j(await req(B(tenantA.id) + '/invoices', { method: 'POST', body: { period_key: '2026-08' } }));
  await req(B(tenantA.id) + `/invoices/${inv.id}/finalize`, { method: 'POST' });
  const paid = await j(await req(B(tenantA.id) + `/invoices/${inv.id}/pay`, { method: 'POST' }));
  assert.equal(paid.status, 'paid');
  assert.ok(paid.paid_at);
  const v = await req(B(tenantA.id) + `/invoices/${inv.id}/void`, { method: 'POST' });
  assert.equal(v.status, 400);
});

test('void：draft 可作废；作废后重算 409', async () => {
  const inv = await j(await req(B(tenantB.id) + '/invoices', { method: 'POST', body: { period_key: '2026-08' }, token: adminKeyB }));
  const vd = await j(await req(B(tenantB.id) + `/invoices/${inv.id}/void`, { method: 'POST', token: adminKeyB }));
  assert.equal(vd.status, 'void');
  const regen = await req(B(tenantB.id) + '/invoices', { method: 'POST', body: { period_key: '2026-08' }, token: adminKeyB });
  assert.equal(regen.status, 409);
});

test('trial 套餐月费为 0；列表与详情；跨租户隔离', async () => {
  const inv = await j(await req(B(tenantB.id) + '/invoices', { method: 'POST', body: { period_key: '2026-07' }, token: adminKeyB }));
  assert.equal(inv.plan, 'trial');
  assert.equal(inv.plan_fee_cents, 0);
  assert.equal(inv.total_cents, inv.usage_cost_cents);

  const list = await j(await req(B(tenantB.id) + '/invoices', { token: adminKeyB }));
  assert.ok(list.length >= 2);
  const drafts = await j(await req(B(tenantB.id) + '/invoices?status=draft', { token: adminKeyB }));
  assert.ok(drafts.every((x) => x.status === 'draft'));
  const one = await j(await req(B(tenantB.id) + `/invoices/${inv.id}`, { token: adminKeyB }));
  assert.equal(one.id, inv.id);

  // B 的账单，A 看不到
  const cross = await req(B(tenantA.id) + `/invoices/${inv.id}`);
  assert.equal(cross.status, 404);
});

test('权限：租户 token 不可调 operator 跑批；operator 跑批为全租户生成 draft', async () => {
  const r403 = await req('/v1/admin/billing/run', { method: 'POST', body: { period_key: '2026-06' } });
  assert.equal(r403.status, 403);

  const run = await j(await req('/v1/admin/billing/run', {
    method: 'POST', token: OPERATOR, body: { period_key: '2026-06' },
  }));
  assert.equal(run.period_key, '2026-06');
  assert.equal(run.tenants, 2);
  assert.ok(run.results.every((x) => x.invoice_id && !x.error), JSON.stringify(run.results));

  const listA = await j(await req(B(tenantA.id) + '/invoices'));
  assert.ok(listA.some((x) => x.period_key === '2026-06' && x.status === 'draft'));
});

test('审计：账单关键动作写入 audit_events', async () => {
  const rows = await db().query(
    `SELECT action FROM audit_events WHERE tenant_id=? AND resource_kind='invoice'`,
    [tenantA.id]);
  const actions = new Set(rows.map((r) => r.action));
  for (const a of ['billing.invoice.generated', 'billing.invoice.finalized', 'billing.invoice.paid']) {
    assert.ok(actions.has(a), `缺少审计 ${a}`);
  }
});
