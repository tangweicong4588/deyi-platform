/**
 * modules/business/metrics.mjs —— V2.0-C 运营指标（只读聚合）。
 *
 * 方案 p24 退出条件要求"审计与运营指标"：意图→计划→执行→验证→对账全链路漏斗。
 * 本模块只做 SELECT 聚合，绝不写真相源；租户/项目隔离由调用方传入的
 * tenantId/projectId 保证（所有查询都带 tenant_id 条件）。
 */
import { db } from '../../db/index.mjs';

function windowClause({ since, until }, col = 'created_at') {
  const parts = [];
  const args = [];
  if (since != null) { parts.push(`${col}>=?`); args.push(Number(since)); }
  if (until != null) { parts.push(`${col}<=?`); args.push(Number(until)); }
  return { parts, args };
}

async function groupBy(table, statusCol, { tenantId, projectId, since, until, timeCol = 'created_at' }) {
  const { parts, args } = windowClause({ since, until }, timeCol);
  const rows = await db().query(
    `SELECT ${statusCol} AS s, COUNT(*) AS n FROM ${table}
     WHERE tenant_id=? ${projectId ? 'AND project_id=?' : ''} ${parts.length ? `AND ${parts.join(' AND ')}` : ''}
     GROUP BY ${statusCol}`,
    [tenantId, ...(projectId ? [projectId] : []), ...args]);
  const by = {};
  let total = 0;
  for (const r of rows) { by[r.s] = Number(r.n); total += Number(r.n); }
  return { total, by };
}

const rate = (a, b) => (b > 0 ? Number((a / b).toFixed(4)) : null);

/**
 * 全链路漏斗 + 对账率 + 平均执行耗时 + 补偿率。
 * { tenantId, projectId?, since?, until? }（时间戳毫秒；只读）。
 */
export async function funnelMetrics({ tenantId, projectId = null, since = null, until = null }) {
  const opts = { tenantId, projectId, since, until };
  const intents = await groupBy('business_intents', 'status', opts);
  const plans = await groupBy('business_plans', 'status', opts);
  const executions = await groupBy('action_executions', 'status', { ...opts, timeCol: 'started_at' });
  const verified = await groupBy('action_executions', 'verify_status', { ...opts, timeCol: 'started_at' });
  const recons = await groupBy('reconciliation_items', 'status', opts);

  const { parts, args } = windowClause({ since, until }, 'started_at');
  const dur = await db().query(
    `SELECT AVG(finished_at - started_at) AS avg_ms, COUNT(*) AS n FROM action_executions
     WHERE tenant_id=? ${projectId ? 'AND project_id=?' : ''}
     ${parts.length ? `AND ${parts.join(' AND ')}` : ''} AND finished_at IS NOT NULL`,
    [tenantId, ...(projectId ? [projectId] : []), ...args]);

  const executed = executions.total;
  const succeeded = executions.by.succeeded || 0;
  const compensated = executions.by.compensated || 0;
  return {
    tenant_id: tenantId,
    project_id: projectId,
    window: { since, until },
    funnel: {
      intents: intents.total,
      plans: plans.total,
      dryrun_passed: plans.by.dryrun_passed || 0,
      dryrun_blocked: plans.by.dryrun_blocked || 0,
      approved: plans.by.approved || 0,
      executed, // 至少发起过执行的动作数
      verified: verified.by.verified || 0,
      mismatched: verified.by.mismatched || 0,
      unverifiable: verified.by.unverifiable || 0,
      unverified: verified.by.unverified || 0,
    },
    rates: {
      dryrun_pass_rate: rate(plans.by.dryrun_passed || 0, plans.total),
      execution_success_rate: rate(succeeded, executed),
      compensation_rate: rate(compensated, executed),
      verify_rate: rate(verified.by.verified || 0, executed),
      recon_rate: rate(recons.total, executed), // 对账率：对账项 / 执行数
    },
    execution: {
      avg_duration_ms: dur[0]?.avg_ms != null ? Math.round(Number(dur[0].avg_ms)) : null,
      finished_samples: Number(dur[0]?.n || 0),
      by_status: executions.by,
    },
    reconciliation: { total: recons.total, by_status: recons.by },
  };
}
