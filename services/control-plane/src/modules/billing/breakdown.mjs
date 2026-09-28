/**
 * modules/billing/breakdown.mjs —— V2.17：成本分摊报表。
 *
 * GET /v1/admin/tenants/:tenantId/cost/breakdown?by=project|actor&from&to
 *
 * 口径（与账单一致，记账铁律：以 model_calls 为真相源）：
 * - 明细可用时（查询区间在 model_calls 保留期内）：直接聚合 model_calls（status='ok'），
 *   与账单 finalize 同口径 → 同一账期分摊总和 == 账单 usage 总额。
 * - 明细已归档（区间超出保留期）：by=project 降级读 cost_ledger（物化聚合，不被清扫）；
 *   by=actor 无处可查 → groups 为空，detail_archived=true，note 明确"明细已归档，仅账单总额"。
 * - 账单对账：汇总区间内完整账期（period_key）的账单 usage 行；reconciled 表示
 *   分摊总额与账单总额一致。
 *
 * 边界：分摊能力受 retention 保留期约束（既定语义）；cost_ledger 是 rollup 物化结果，
 * 明细可用时不依赖它（避免 rollup 未跑导致口径漂移）。
 */
import { db } from '../../db/index.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { nowMs } from '../../kernel/ids.mjs';
import { getTenant } from '../identity/store.mjs';
import { getRetentionPolicy } from '../evidence/retention.mjs';
import { periodRange } from './service.mjs';

const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const dayStart = (d) => new Date(d + 'T00:00:00').getTime();
const dayEnd = (d) => new Date(d + 'T00:00:00').getTime() + DAY_MS - 1;
const dayOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const monthOf = (dayStr) => dayStr.slice(0, 7);

function assertDay(v, name) {
  if (!DATE_RE.test(v || '') || Number.isNaN(dayStart(v))) {
    throw Errors.badRequest(`${name} 非法（期望 YYYY-MM-DD）：${v}`);
  }
  return v;
}

export async function getCostBreakdown(tenantId, { by = 'project', from = null, to = null } = {}) {
  if (!['project', 'actor'].includes(by)) throw Errors.badRequest(`by 非法：${by}（可选 project|actor）`);
  const tenant = await getTenant(tenantId).catch(() => null);
  if (!tenant) throw Errors.notFound('租户不存在');
  const today = dayOf(nowMs());
  const toDay = to ? assertDay(to, 'to') : today;
  const fromDay = from ? assertDay(from, 'from') : dayOf(nowMs() - 29 * DAY_MS);
  if (dayStart(fromDay) > dayEnd(toDay)) throw Errors.badRequest('from 不能晚于 to');

  // 明细可用性：区间起点是否在 model_calls 保留期内
  const policy = getRetentionPolicy(tenant);
  const cutoff = nowMs() - policy.model_calls_days * DAY_MS;
  const detailArchived = dayStart(fromDay) < cutoff;

  let groups = [];
  if (!detailArchived) {
    groups = await aggregateModelCalls(tenantId, by, dayStart(fromDay), dayEnd(toDay));
  } else if (by === 'project') {
    groups = await aggregateLedger(tenantId, fromDay, toDay);
  }
  // by=actor 且明细已归档：cost_ledger 无 actor 维度 → groups 为空（见 note）

  const total = groups.reduce((t, g) => ({
    calls: t.calls + g.calls, tokens: t.tokens + g.tokens, cost_cents: t.cost_cents + g.cost_cents,
  }), { calls: 0, tokens: 0, cost_cents: 0 });

  // 账单对账：区间内完整账期（period_key）的 usage 行汇总（void 排除）
  const invoices = await db().query(
    `SELECT period_key, status, currency, usage_cost_cents, usage_tokens, usage_calls
     FROM billing_invoices
     WHERE tenant_id=? AND status!='void' AND period_key>=? AND period_key<=?
     ORDER BY period_key`,
    [tenantId, monthOf(fromDay), monthOf(toDay)]);
  const fullyCovered = invoices.filter((inv) => {
    const { start, end } = periodRange(inv.period_key);
    return start >= dayStart(fromDay) && end <= dayEnd(toDay);
  });
  const invoiceUsage = fullyCovered.reduce((t, inv) => ({
    cost_cents: t.cost_cents + (Number(inv.usage_cost_cents) || 0),
    tokens: t.tokens + (Number(inv.usage_tokens) || 0),
    calls: t.calls + (Number(inv.usage_calls) || 0),
  }), { cost_cents: 0, tokens: 0, calls: 0 });

  // reconciled：有完整账期覆盖且分摊总额 == 账单 usage 总额
  const reconciled = fullyCovered.length > 0
    && total.cost_cents === invoiceUsage.cost_cents
    && total.tokens === invoiceUsage.tokens
    && total.calls === invoiceUsage.calls;

  return {
    tenant_id: tenantId,
    from: fromDay,
    to: toDay,
    by,
    currency: invoices[0]?.currency || 'CNY',
    groups,
    total,
    invoices: invoices.map((inv) => ({
      period_key: inv.period_key, status: inv.status,
      usage_cost_cents: Number(inv.usage_cost_cents) || 0,
      usage_tokens: Number(inv.usage_tokens) || 0,
      usage_calls: Number(inv.usage_calls) || 0,
    })),
    invoice_usage_total: invoiceUsage,
    reconciled,
    detail_archived: detailArchived,
    note: detailArchived
      ? (by === 'actor'
        ? '明细已归档（超出 model_calls 保留期），actor 维度无明细，仅账单总额可供参考'
        : '明细已归档（超出 model_calls 保留期），project 维度来自 cost_ledger 物化聚合，仅账单总额为财务口径')
      : null,
  };
}

async function aggregateModelCalls(tenantId, by, startMs, endMs) {
  const col = by === 'project' ? 'project_id' : 'actor_id';
  const rows = await db().query(
    `SELECT ${col} AS k, COALESCE(SUM(total_tokens),0) AS tokens,
            COALESCE(SUM(cost_cents),0) AS cost, COUNT(*) AS calls
     FROM model_calls
     WHERE tenant_id=? AND status='ok' AND created_at>=? AND created_at<=?
     GROUP BY ${col}`,
    [tenantId, startMs, endMs]);
  return withNames(tenantId, by, rows);
}

async function aggregateLedger(tenantId, fromDay, toDay) {
  const rows = await db().query(
    `SELECT project_id AS k, COALESCE(SUM(tokens),0) AS tokens,
            COALESCE(SUM(cost_cents),0) AS cost, COALESCE(SUM(calls),0) AS calls
     FROM cost_ledger
     WHERE tenant_id=? AND day>=? AND day<=?
     GROUP BY project_id`,
    [tenantId, fromDay, toDay]);
  return withNames(tenantId, 'project', rows);
}

async function withNames(tenantId, by, rows) {
  const out = [];
  for (const r of rows) {
    const key = r.k || null;
    let name = key;
    if (by === 'project') {
      if (!key) name = '(租户级)';
      else {
        const p = (await db().query('SELECT name FROM projects WHERE id=? AND tenant_id=?', [key, tenantId]))[0];
        name = p?.name || key;
      }
    } else {
      const a = key
        ? (await db().query('SELECT name FROM actors WHERE id=? AND tenant_id=?', [key, tenantId]))[0]
        : null;
      name = a?.name || key || '(未知)';
    }
    out.push({
      key, name,
      calls: Number(r.calls) || 0,
      tokens: Number(r.tokens) || 0,
      cost_cents: Number(r.cost) || 0,
    });
  }
  out.sort((a, b) => b.cost_cents - a.cost_cents);
  return out;
}
