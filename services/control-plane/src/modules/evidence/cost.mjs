/**
 * modules/evidence/cost.mjs —— 成本账本。
 *
 * 记账铁律：以 model_calls 为唯一真相源，绝不重复记账。
 * - 查询 API：实时从 model_calls 聚合（MVP 数据量可接受）。
 * - cost_ledger：物化聚合表（按 tenant/project/day/model），rollupCostLedger()
 *   幂等重算，供未来数据量大时加速；与实时聚合的数字必须一致（测试锁定）。
 */
import { newId, nowMs } from '../../kernel/ids.mjs';
import { db } from '../../db/index.mjs';

const dayOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dayStart = (dayStr) => new Date(dayStr + 'T00:00:00').getTime();
const dayEnd = (dayStr) => new Date(dayStr + 'T00:00:00').getTime() + 86400000 - 1;

/**
 * 实时聚合。groupBy: day | model | project。
 * from/to: YYYY-MM-DD（闭区间），缺省最近 30 天。
 */
export async function queryCost(tenantId, { from = null, to = null, groupBy = 'day' } = {}) {
  if (!['day', 'model', 'project'].includes(groupBy)) throw new Error('groupBy 非法');
  const toDay = to || dayOf(nowMs());
  const fromDay = from || dayOf(nowMs() - 29 * 86400000);
  const rows = await db().query(
    `SELECT project_id, model, total_tokens, cost_cents, created_at, status
     FROM model_calls WHERE tenant_id=? AND created_at>=? AND created_at<=? AND status='ok'`,
    [tenantId, dayStart(fromDay), dayEnd(toDay)]);
  const groups = new Map();
  const keyOf = (r) => groupBy === 'day' ? dayOf(r.created_at)
    : groupBy === 'model' ? r.model : (r.project_id || '(租户级)');
  for (const r of rows) {
    const k = keyOf(r);
    const g = groups.get(k) || { key: k, tokens: 0, cost_cents: 0, calls: 0 };
    g.tokens += Number(r.total_tokens) || 0;
    g.cost_cents += Number(r.cost_cents) || 0;
    g.calls += 1;
    groups.set(k, g);
  }
  const data = [...groups.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const total = data.reduce((t, g) => ({
    tokens: t.tokens + g.tokens, cost_cents: t.cost_cents + g.cost_cents, calls: t.calls + g.calls,
  }), { tokens: 0, cost_cents: 0, calls: 0 });
  return { from: fromDay, to: toDay, groupBy, data, total };
}

/**
 * 物化 rollup：把 model_calls 按 (tenant, project, day, model) 聚合写入
 * cost_ledger（先删后插，事务内，幂等；按天分组在 JS 里做，保持跨方言可移植）。
 * 返回写入行数。
 */
export async function rollupCostLedger({ from = null, to = null } = {}) {
  const toDay = to || dayOf(nowMs());
  const fromDay = from || dayOf(nowMs() - 29 * 86400000);
  const detail = await db().query(
    `SELECT tenant_id, project_id, model, total_tokens, cost_cents, created_at
     FROM model_calls WHERE created_at>=? AND created_at<=? AND status='ok'`,
    [dayStart(fromDay), dayEnd(toDay)]);
  const buckets = new Map();
  for (const r of detail) {
    const k = [r.tenant_id, r.project_id || '', dayOf(r.created_at), r.model].join('');
    const b = buckets.get(k) || {
      tenant_id: r.tenant_id, project_id: r.project_id, day: dayOf(r.created_at),
      model: r.model, tokens: 0, cost_cents: 0, calls: 0,
    };
    b.tokens += Number(r.total_tokens) || 0;
    b.cost_cents += Number(r.cost_cents) || 0;
    b.calls += 1;
    buckets.set(k, b);
  }
  let written = 0;
  await db().transaction(async (tx) => {
    for (const b of buckets.values()) {
      await tx.query(
        `DELETE FROM cost_ledger WHERE tenant_id=? AND COALESCE(project_id,'')=? AND day=? AND model=?`,
        [b.tenant_id, b.project_id || '', b.day, b.model]);
      await tx.query(
        `INSERT INTO cost_ledger(id, tenant_id, project_id, day, model, tokens, cost_cents, calls, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [newId('cst'), b.tenant_id, b.project_id, b.day, b.model, b.tokens, b.cost_cents, b.calls, nowMs()]);
      written++;
    }
  });
  return { written, from: fromDay, to: toDay };
}

/** 读物化表（与 queryCost 对照用） */
export async function readLedger(tenantId, { from = null, to = null } = {}) {
  const toDay = to || dayOf(nowMs());
  const fromDay = from || dayOf(nowMs() - 29 * 86400000);
  return db().query(
    `SELECT project_id, day, model, tokens, cost_cents, calls FROM cost_ledger
     WHERE tenant_id=? AND day>=? AND day<=? ORDER BY day, model`,
    [tenantId, fromDay, toDay]);
}
