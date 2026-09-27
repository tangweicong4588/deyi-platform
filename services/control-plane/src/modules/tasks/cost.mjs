/**
 * modules/tasks/cost.mjs —— V4.5 执行成本归因（Track B）。
 *
 * 业务任务 ↔ 执行 trace 的关联边（biz_task_cost_links）：
 * - agent_run / ai_assist_run 在为任务执行时登记 trace；
 * - 任务成本视图：按 trace 从 model_calls（网关统一计量口径）汇总，
 *   任务成本 == 其下调用的网关计量之和（同一查询口径，结构上成立）。
 *
 * 预留：V2.17 分摊报表可直接消费本视图的按 kind 明细。
 */
import { newId, nowMs } from '../../kernel/ids.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { db } from '../../db/index.mjs';
import { tryAudit } from '../evidence/audit.mjs';

export const LINK_KINDS = new Set(['agent_run', 'ai_assist_run', 'pipeline_run', 'tool_execution']);

/** 登记一条归因边（幂等：同一任务同一实体只记一次）。 */
export async function linkCost({ tenantId, projectId, taskId, kind, refId, traceId, actorId }) {
  if (!LINK_KINDS.has(kind)) throw Errors.badRequest(`kind 非法（可用：${[...LINK_KINDS].join(',')}）`);
  if (!refId || !traceId) throw Errors.badRequest('refId/traceId 必填');
  const task = (await db().query(
    'SELECT id FROM biz_tasks WHERE id=? AND tenant_id=? AND project_id=?', [taskId, tenantId, projectId]))[0];
  if (!task) throw Errors.notFound('业务任务不存在');
  const id = newId('btcl');
  const now = nowMs();
  const r = await db().run(
    `INSERT OR IGNORE INTO biz_task_cost_links
     (id,tenant_id,project_id,task_id,kind,ref_id,trace_id,created_by,created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, projectId, taskId, kind, refId, traceId, actorId, now],
  );
  const created = (r?.changes ?? 0) > 0;
  if (created) {
    await tryAudit({ tenantId, projectId, actorId, action: 'task.cost.link',
      resourceKind: 'biz_task', resourceId: taskId,
      payload: { kind, ref_id: refId, trace_id: traceId } });
  }
  return { id: created ? id : null, created };
}

const ZERO = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_cents: 0, calls: 0 };

/** 任务成本视图：按 trace 从 model_calls 汇总（网关计量口径）。 */
export async function getTaskCost({ tenantId, projectId, taskId }) {
  const task = (await db().query(
    'SELECT id, title, kind, status FROM biz_tasks WHERE id=? AND tenant_id=? AND project_id=?',
    [taskId, tenantId, projectId]))[0];
  if (!task) throw Errors.notFound('业务任务不存在');
  const links = await db().query(
    `SELECT kind, ref_id, trace_id, created_at FROM biz_task_cost_links
     WHERE tenant_id=? AND task_id=? ORDER BY created_at`,
    [tenantId, taskId],
  );
  const byKind = [];
  const total = { ...ZERO };
  for (const kind of [...new Set(links.map((l) => l.kind))]) {
    const traces = links.filter((l) => l.kind === kind).map((l) => l.trace_id);
    const rows = await db().query(
      `SELECT COALESCE(SUM(prompt_tokens),0) AS p, COALESCE(SUM(completion_tokens),0) AS c,
              COALESCE(SUM(total_tokens),0) AS t, COALESCE(SUM(cost_cents),0) AS cost, COUNT(*) AS n
       FROM model_calls WHERE tenant_id=? AND status='ok'
         AND trace_id IN (${traces.map(() => '?').join(',')})`,
      [tenantId, ...traces],
    );
    const r = rows[0] || {};
    const sub = {
      kind, ref_count: traces.length,
      prompt_tokens: r.p || 0, completion_tokens: r.c || 0,
      total_tokens: r.t || 0, cost_cents: r.cost || 0, calls: r.n || 0,
    };
    byKind.push(sub);
    total.prompt_tokens += sub.prompt_tokens;
    total.completion_tokens += sub.completion_tokens;
    total.total_tokens += sub.total_tokens;
    total.cost_cents += sub.cost_cents;
    total.calls += sub.calls;
  }
  return {
    task_id: task.id, task_title: task.title, task_kind: task.kind, task_status: task.status,
    links: links.map((l) => ({ kind: l.kind, ref_id: l.ref_id, trace_id: l.trace_id, created_at: l.created_at })),
    by_kind: byKind,
    total, // == 其下 trace 的网关计量之和（同一查询口径）
  };
}
