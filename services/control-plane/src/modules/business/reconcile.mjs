/**
 * modules/business/reconcile.mjs —— V2.0-C 对账队列消费端。
 *
 * 状态机：open → investigating → resolved | escalated → closed
 *   - open：刚入队（执行失败 / 验证差异），待受理。
 *   - investigating：人工已受理调查中。
 *   - resolved：人工确认差异已处理（必须记录决议 note + 可选证据引用）。
 *   - escalated：升级，指定处理人（assignee）；升级时记"通知"审计事件，
 *     真实通知通道（短信/IM/工单）留扩展点，本阶段只审计留痕。
 *   - closed：终端。resolved/escalated 可关闭；resolved 可打回 investigating 重查。
 *
 * 全部状态变更与决议入 P7 审计链（business.reconciliation.*）。
 */
import { nowMs } from '../../kernel/ids.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { ctx } from '../../kernel/context.mjs';
import * as store from './store.mjs';
import { tryAudit } from '../evidence/audit.mjs';

export const RECON_TRANSITIONS = {
  open: ['investigating', 'escalated'],
  investigating: ['resolved', 'escalated'],
  escalated: ['investigating', 'resolved', 'closed'],
  resolved: ['investigating', 'closed'],
  closed: [],
};

export async function getRecon({ tenantId, projectId, reconId }) {
  const r = await store.getReconciliation(tenantId, reconId);
  if (!r || r.project_id !== projectId) throw Errors.notFound('对账项不存在');
  return r;
}

export async function listRecons({ tenantId, projectId, status, source, limit }) {
  // 租户隔离 + 项目归属二次过滤（表无 project 索引，量小可接受；量大时补索引）
  const rows = status === 'all'
    ? await store.listAllReconciliations(tenantId, { source, limit })
    : await store.listReconciliations(tenantId, { status: status || 'open', source, limit });
  return rows.filter((r) => r.project_id === projectId);
}

/**
 * 对账状态推进。resolve 必须给 note（决议说明）；escalate 必须给 assignee（处理人）。
 * 升级时记 business.reconciliation.notify 审计事件（通知扩展点留痕）。
 */
export async function transitionRecon({ tenantId, projectId, reconId, to, actorId, note, assignee, evidenceRef }) {
  if (!store.RECON_STATUSES.has(to)) throw Errors.badRequest(`非法对账状态: ${to}`);
  const recon = await getRecon({ tenantId, projectId, reconId });
  const allowed = RECON_TRANSITIONS[recon.status] || [];
  if (!allowed.includes(to)) {
    throw Errors.conflict(`对账项状态 ${recon.status} 不允许转到 ${to}`, { code: 'ILLEGAL_TRANSITION' });
  }
  if (to === 'resolved' && !(note && String(note).trim())) {
    throw Errors.badRequest('resolve 必须记录决议说明（note）', { code: 'NOTE_REQUIRED' });
  }
  if (to === 'escalated' && !(assignee && String(assignee).trim())) {
    throw Errors.badRequest('escalate 必须指定处理人（assignee）', { code: 'ASSIGNEE_REQUIRED' });
  }

  const patch = { status: to };
  const c = ctx();
  if (to === 'resolved') {
    patch.decided_at = nowMs();
    patch.resolution = {
      decided_by: actorId, decided_at: patch.decided_at,
      note: String(note).slice(0, 2000), evidence_ref: evidenceRef ? String(evidenceRef).slice(0, 500) : null,
    };
  }
  if (to === 'escalated') {
    patch.assignee = String(assignee).slice(0, 200);
    patch.decided_at = nowMs();
  }
  if (to === 'closed') patch.closed_at = nowMs();

  const updated = await store.updateReconciliation(tenantId, recon.id, patch, recon.status);
  if (!updated) {
    // CAS 未命中：并发推进已改变状态，拒绝覆盖
    throw Errors.conflict('对账项状态已被并发修改，请刷新后重试', { code: 'RECON_CONCURRENT_MODIFIED' });
  }
  const verb = { investigating: 'investigate', resolved: 'resolve', escalated: 'escalate', closed: 'close' }[to] || to;
  await tryAudit({
    tenantId, projectId, actorId, traceId: c.traceId,
    action: `business.reconciliation.${verb}`, resourceKind: 'reconciliation_item', resourceId: recon.id,
    payload: { from: recon.status, to, assignee: patch.assignee || undefined, note: note ? String(note).slice(0, 500) : undefined },
  });
  if (to === 'escalated') {
    // 通知扩展点：真实通知通道（短信/IM/工单）未实现，先记审计事件留痕，绝不静默
    await tryAudit({
      tenantId, projectId, actorId, traceId: c.traceId,
      action: 'business.reconciliation.notify', resourceKind: 'reconciliation_item', resourceId: recon.id,
      payload: {
        to: patch.assignee, channel: 'extension-point',
        message: `对账项 ${recon.id} 已升级，指派给 ${patch.assignee}（真实通知通道待接入）`,
      },
    });
  }
  return updated;
}
