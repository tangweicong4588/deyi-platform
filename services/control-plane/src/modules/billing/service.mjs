/**
 * modules/billing/service.mjs —— V2.3：多租户计费与账单。
 *
 * 数据模型：
 * - 真相源：model_calls（计量）+ tenants.plan（套餐）。账单是财务快照。
 * - billing_invoices：一账期一账单（UNIQUE(tenant_id, period_key)），draft 可重算，
 *   finalized 后总额与行项目冻结；状态机 draft→finalized→paid，draft|finalized→void。
 * - period_key 口径与网关账期一致：本地时区 'YYYY-MM'。
 *
 * 诚实边界：
 * - 只做账单状态机 + 计量对账，不碰真实支付（pay 只是状态标记，对接支付网关是后续工作）。
 * - enterprise 为定制价（PLAN_FEES.enterprise=null）：账单生成时不自动计套餐费，
 *   line item 标记 needs_pricing，由运营线下定价后手动调整（本版本不支持调价，保持如实）。
 */
import { db } from '../../db/index.mjs';
import { newId, nowMs } from '../../kernel/ids.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { logger } from '../../kernel/logging.mjs';
import { ctx } from '../../kernel/context.mjs';
import { tryAudit } from '../evidence/audit.mjs';
import { alertInvoiceFinalized } from '../notify/alerts.mjs';

export const BILLING_STATUSES = ['draft', 'finalized', 'paid', 'void'];

/** 套餐月费（分；enterprise=null=定制价，不自动计费） */
export const PLAN_FEES = {
  trial: 0,
  professional: 9900,
  enterprise: null,
};
export const BILLING_CURRENCY = 'CNY';

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export function assertPeriodKey(pk) {
  if (!PERIOD_RE.test(String(pk || ''))) {
    throw Errors.badRequest(`period_key 非法，应为 YYYY-MM：${pk}`, { code: 'INVALID_PERIOD' });
  }
  return String(pk);
}

/** 账期时间窗（本地时区，与网关 currentPeriodKey 同口径） */
export function periodRange(periodKey) {
  assertPeriodKey(periodKey);
  const [y, m] = periodKey.split('-').map(Number);
  const start = new Date(y, m - 1, 1).getTime();
  const end = new Date(y, m, 1).getTime() - 1;
  return { start, end };
}

function pub(r) {
  return {
    id: r.id, tenant_id: r.tenant_id, period_key: r.period_key, status: r.status,
    currency: r.currency, plan: r.plan,
    plan_fee_cents: r.plan_fee_cents, usage_cost_cents: r.usage_cost_cents,
    usage_tokens: r.usage_tokens, usage_calls: r.usage_calls, total_cents: r.total_cents,
    line_items: JSON.parse(r.line_items_json || '[]'),
    created_at: r.created_at, finalized_at: r.finalized_at, paid_at: r.paid_at, voided_at: r.voided_at,
  };
}

async function getTenant(tenantId) {
  const rows = await db().query(`SELECT * FROM tenants WHERE id=?`, [tenantId]);
  if (!rows[0]) throw Errors.notFound('租户不存在', { code: 'TENANT_NOT_FOUND' });
  return rows[0];
}

/**
 * 生成/重算账单（draft）。
 * - 已 finalize/paid/void 的账单不可重算（财务快照不可变），抛 409；
 * - draft 存在时重算（幂等，同一 id）。
 */
export async function generateInvoice(tenantId, periodKey) {
  const pk = assertPeriodKey(periodKey);
  const c = ctx();
  const actorId = c.actorId || 'unknown';
  const tenant = await getTenant(tenantId);
  const { start, end } = periodRange(pk);

  const usage = await db().query(
    `SELECT COALESCE(SUM(total_tokens),0) AS tokens,
            COALESCE(SUM(cost_cents),0) AS cost,
            COUNT(*) AS calls
     FROM model_calls
     WHERE tenant_id=? AND status='ok' AND created_at>=? AND created_at<=?`,
    [tenantId, start, end]);
  const u = usage[0] || { tokens: 0, cost: 0, calls: 0 };

  const plan = tenant.plan || 'trial';
  const planFee = PLAN_FEES[plan];
  const lineItems = [];
  if (planFee == null) {
    lineItems.push({ type: 'plan', label: `${plan}（定制价，待运营定价）`, amount_cents: 0, needs_pricing: true });
  } else {
    lineItems.push({ type: 'plan', label: `${plan} 月费`, amount_cents: planFee });
  }
  lineItems.push({
    type: 'usage', label: '模型调用计量',
    amount_cents: Number(u.cost) || 0,
    tokens: Number(u.tokens) || 0, calls: Number(u.calls) || 0,
  });
  const planFeeCents = planFee == null ? 0 : planFee;
  const usageCostCents = Number(u.cost) || 0;
  const now = nowMs();

  const existing = await db().query(
    `SELECT * FROM billing_invoices WHERE tenant_id=? AND period_key=?`, [tenantId, pk]);
  if (existing[0] && existing[0].status !== 'draft') {
    throw Errors.conflict(`账期 ${pk} 账单已 ${existing[0].status}，不可重算`, { code: 'INVOICE_LOCKED' });
  }
  let row;
  if (existing[0]) {
    await db().query(
      `UPDATE billing_invoices SET plan=?, plan_fee_cents=?, usage_cost_cents=?, usage_tokens=?,
        usage_calls=?, total_cents=?, line_items_json=? WHERE id=?`,
      [plan, planFeeCents, usageCostCents, Number(u.tokens) || 0, Number(u.calls) || 0,
       planFeeCents + usageCostCents, JSON.stringify(lineItems), existing[0].id]);
    row = (await db().query(`SELECT * FROM billing_invoices WHERE id=?`, [existing[0].id]))[0];
    logger.info('billing invoice recalculated', { tenantId, period: pk, id: row.id });
  } else {
    const id = newId('inv');
    await db().query(
      `INSERT INTO billing_invoices(id, tenant_id, period_key, status, currency, plan,
        plan_fee_cents, usage_cost_cents, usage_tokens, usage_calls, total_cents, line_items_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, tenantId, pk, 'draft', BILLING_CURRENCY, plan,
       planFeeCents, usageCostCents, Number(u.tokens) || 0, Number(u.calls) || 0,
       planFeeCents + usageCostCents, JSON.stringify(lineItems), now]);
    row = (await db().query(`SELECT * FROM billing_invoices WHERE id=?`, [id]))[0];
    logger.info('billing invoice generated', { tenantId, period: pk, id });
  }
  await tryAudit({
    tenantId, projectId: null, actorId, action: 'billing.invoice.generated',
    resourceKind: 'invoice', resourceId: row.id,
    payload: { period_key: pk, plan, total_cents: row.total_cents },
  });
  return pub(row);
}

async function getInvoiceRow(tenantId, invoiceId) {
  const rows = await db().query(
    `SELECT * FROM billing_invoices WHERE id=? AND tenant_id=?`, [invoiceId, tenantId]);
  if (!rows[0]) throw Errors.notFound('账单不存在', { code: 'INVOICE_NOT_FOUND' });
  return rows[0];
}

async function transition(tenantId, invoiceId, from, to, tsCol, auditAction) {
  const c = ctx();
  const actorId = c.actorId || 'unknown';
  const row = await getInvoiceRow(tenantId, invoiceId);
  if (!from.includes(row.status)) {
    throw Errors.badRequest(`账单状态为 ${row.status}，不允许${to}`, { code: 'INVALID_INVOICE_STATUS' });
  }
  const now = nowMs();
  await db().query(
    `UPDATE billing_invoices SET status=?, ${tsCol}=? WHERE id=?`, [to, now, row.id]);
  const updated = await getInvoiceRow(tenantId, invoiceId);
  logger.info('billing invoice status', { tenantId, id: row.id, from: row.status, to });
  await tryAudit({
    tenantId, projectId: null, actorId, action: auditAction,
    resourceKind: 'invoice', resourceId: row.id,
    payload: { from: row.status, to, total_cents: updated.total_cents },
  });
  return pub(updated);
}

/** 定稿：draft→finalized，冻结快照；V2.13：定稿后 best-effort 发 invoice.finalized 告警 */
export async function finalizeInvoice(tenantId, invoiceId) {
  const inv = await transition(tenantId, invoiceId, ['draft'], 'finalized', 'finalized_at', 'billing.invoice.finalized');
  await alertInvoiceFinalized({ tenantId, invoice: inv });
  return inv;
}

/** 标记已付：finalized→paid（仅状态标记，不对接真实支付） */
export async function markInvoicePaid(tenantId, invoiceId) {
  return transition(tenantId, invoiceId, ['finalized'], 'paid', 'paid_at', 'billing.invoice.paid');
}

/** 作废：draft|finalized→void */
export async function voidInvoice(tenantId, invoiceId) {
  return transition(tenantId, invoiceId, ['draft', 'finalized'], 'void', 'voided_at', 'billing.invoice.voided');
}

export async function getInvoice(tenantId, invoiceId) {
  return pub(await getInvoiceRow(tenantId, invoiceId));
}

export async function listInvoices(tenantId, { status = null, limit = 50 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const conds = [`tenant_id=?`];
  const params = [tenantId];
  if (status) {
    if (!BILLING_STATUSES.includes(status)) throw Errors.badRequest(`status 非法：${status}`);
    conds.push(`status=?`); params.push(status);
  }
  const rows = await db().query(
    `SELECT * FROM billing_invoices WHERE ${conds.join(' AND ')} ORDER BY period_key DESC LIMIT ${n}`, params);
  return rows.map(pub);
}

/**
 * 全租户跑批（operator）：为指定账期生成所有 active 租户的 draft 账单。
 * 逐租户 try/catch：单个租户失败不中断整批，汇总返回。
 */
export async function runBilling(periodKey) {
  const pk = assertPeriodKey(periodKey);
  const tenants = await db().query(`SELECT id FROM tenants WHERE status='active' ORDER BY id`);
  const results = [];
  for (const t of tenants) {
    try {
      const inv = await generateInvoice(t.id, pk);
      results.push({ tenant_id: t.id, invoice_id: inv.id, status: inv.status, total_cents: inv.total_cents });
    } catch (e) {
      results.push({ tenant_id: t.id, error: String(e?.message || e).slice(0, 200) });
      logger.warn('billing run failed for tenant', { tenantId: t.id, err: String(e?.message || e).slice(0, 200) });
    }
  }
  logger.info('billing run done', { period: pk, tenants: tenants.length });
  return { period_key: pk, tenants: tenants.length, results };
}
