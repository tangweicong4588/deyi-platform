/**
 * modules/tasks/task.mjs —— V4.1 业务任务域模型。
 *
 * task/case：工单（ticket）、审批单（approval）、文档处理任务（doc_task）。
 * - 状态机：open → in_progress → pending ⇄ / resolved → closed；cancelled 终态。
 *   所有流转经 CAS（UPDATE … WHERE status=from），非法跃迁 400。
 * - SLA：创建时 sla_hours → sla_due_at；slaSweep 把超时的非终态任务标 escalated，
 *   写审计事件 biz_task.escalated。定时触发由部署侧 cron 调 sweep 接口（V4.1 不内置调度器）。
 * - 审批单：decide（approve/reject），SoD——发起人不能审批自己的单；
 *   approve → resolved，reject → cancelled。
 * - 任务绑定租户/项目/发起人（requester_id=创建 actor）；全链路审计。
 *
 * 边界：escalation 为单级（escalated 布尔）；doc_task 仅为任务类型标记，
 * 文档处理执行语义随 V4.2+ 展开，此处不伪造。
 */
import { Errors } from '../../kernel/errors.mjs';
import { newId } from '../../kernel/ids.mjs';
import { db } from '../../db/index.mjs';
import { tryAudit } from '../evidence/audit.mjs';
import { assertProjectRole } from '../identity/permissions.mjs';

const nowMs = () => Date.now();

export const TASK_KINDS = new Set(['ticket', 'approval', 'doc_task']);
export const TASK_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
export const TERMINAL_STATUSES = new Set(['closed', 'cancelled']);

/** 状态机：允许的跃迁表 */
export const TRANSITIONS = {
  open: ['in_progress', 'cancelled'],
  in_progress: ['pending', 'resolved', 'cancelled'],
  pending: ['in_progress', 'cancelled'],
  resolved: ['closed', 'in_progress'], // in_progress = 打回重做
  closed: [],
  cancelled: [],
};

function parseJson(v, fallback) {
  try {
    const o = JSON.parse(v);
    return o === undefined ? fallback : o;
  } catch { return fallback; }
}

export function rowToTask(r) {
  if (!r) return null;
  return { ...r, escalated: !!r.escalated, payload: parseJson(r.payload, {}) };
}

async function getTaskRow(tenantId, projectId, taskId) {
  const rows = await db().query(
    'SELECT * FROM biz_tasks WHERE id=? AND tenant_id=? AND project_id=?',
    [taskId, tenantId, projectId]);
  const t = rowToTask(rows[0]);
  if (!t) throw Errors.notFound('业务任务不存在');
  return t;
}

export async function getTask(tenantId, projectId, taskId) {
  const task = await getTaskRow(tenantId, projectId, taskId);
  const transitions = await db().query(
    'SELECT * FROM biz_task_transitions WHERE task_id=? ORDER BY created_at ASC', [taskId]);
  return { task, transitions };
}

export async function listTasks(tenantId, projectId, { status, kind, assigneeId, escalated } = {}) {
  const conds = ['tenant_id=?', 'project_id=?'];
  const args = [tenantId, projectId];
  if (status) {
    if (!TRANSITIONS[status]) throw Errors.badRequest(`非法状态: ${status}`);
    conds.push('status=?'); args.push(status);
  }
  if (kind) {
    if (!TASK_KINDS.has(kind)) throw Errors.badRequest(`非法任务类型: ${kind}`);
    conds.push('kind=?'); args.push(kind);
  }
  if (assigneeId) { conds.push('assignee_id=?'); args.push(assigneeId); }
  if (escalated !== undefined) { conds.push('escalated=?'); args.push(escalated ? 1 : 0); }
  const rows = await db().query(
    `SELECT * FROM biz_tasks WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, args);
  return rows.map(rowToTask);
}

export async function createTask({ tenantId, projectId, actorId, body }) {
  const {
    kind, title, description = '', priority = 'normal',
    assigneeId = null, slaHours = null, payload = {},
  } = body || {};
  if (!TASK_KINDS.has(kind)) throw Errors.badRequest(`kind 必须为 ${[...TASK_KINDS].join('/')}`);
  if (!String(title || '').trim()) throw Errors.badRequest('title 必填');
  if (!TASK_PRIORITIES.has(priority)) throw Errors.badRequest(`priority 非法: ${priority}`);
  if (payload !== null && (typeof payload !== 'object' || Array.isArray(payload))) {
    throw Errors.badRequest('payload 必须为 JSON 对象');
  }
  let slaDueAt = null;
  let slaH = null;
  if (slaHours !== null && slaHours !== undefined) {
    slaH = Number(slaHours);
    if (!Number.isFinite(slaH) || slaH <= 0 || slaH > 24 * 365) {
      throw Errors.badRequest('slaHours 必须为 (0, 8760] 小时');
    }
    slaDueAt = nowMs() + Math.round(slaH * 3600_000);
  }
  // V4.6 行级权限：assignee 必须为本项目成员（viewer+），替代原来的"本租户主体"检查
  if (assigneeId) {
    await assertProjectRole(tenantId, projectId, assigneeId, 'viewer', '任务改派');
  }
  // V4.6 审批人指派：approval 单可在创建时指定 approver_id
  let approverId = null;
  if (kind === 'approval' && payload && payload.approver_id) {
    approverId = String(payload.approver_id);
    if (approverId === actorId) {
      throw Errors.badRequest('审批人不能是发起人自己（SoD）', { code: 'SOD_VIOLATION' });
    }
    await assertProjectRole(tenantId, projectId, approverId, 'operator', '审批人指派');
  }
  const now = nowMs();
  const id = newId('bzt');
  const initPayload = kind === 'approval'
    ? { decision: 'pending', ...(payload || {}), approver_id: approverId }
    : { ...(payload || {}) };
  await db().run(
    `INSERT INTO biz_tasks(id,tenant_id,project_id,kind,title,description,status,priority,
      requester_id,assignee_id,sla_due_at,sla_hours,escalated,payload,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, projectId, kind, String(title).trim(), String(description).slice(0, 5000),
      'open', priority, actorId, assigneeId, slaDueAt, slaH, 0,
      JSON.stringify(initPayload), actorId, now, now]);
  await logTransition({ tenantId, taskId: id, from: null, to: 'open', actorId, note: '创建' });
  await tryAudit({
    tenantId, projectId, actorId, action: 'biz_task.create',
    resourceKind: 'biz_task', resourceId: id,
    payload: { kind, title: String(title).trim(), priority, sla_hours: slaH },
  });
  return getTaskRow(tenantId, projectId, id);
}

async function logTransition({ tenantId, taskId, from, to, actorId, note }) {
  await db().run(
    `INSERT INTO biz_task_transitions(id,tenant_id,task_id,from_status,to_status,actor_id,note,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [newId('bztt'), tenantId, taskId, from || '', to, actorId, String(note || '').slice(0, 2000), nowMs()]);
}

/** 状态流转（CAS 防并发）。terminal 状态不可再流转。 */
export async function transitionTask({ tenantId, projectId, actorId, taskId, to, note = '' }) {
  const task = await getTaskRow(tenantId, projectId, taskId);
  if (!TRANSITIONS[task.status]) throw Errors.badRequest(`未知当前状态: ${task.status}`);
  if (!TRANSITIONS[task.status].includes(to)) {
    throw Errors.badRequest(`非法状态跃迁: ${task.status} → ${to}`, { code: 'INVALID_TRANSITION' });
  }
  const now = nowMs();
  const terminal = TERMINAL_STATUSES.has(to);
  const upd = await db().run(
    `UPDATE biz_tasks SET status=?, updated_at=?, closed_at=?
     WHERE id=? AND tenant_id=? AND status=?`,
    [to, now, terminal ? now : task.closed_at, taskId, tenantId, task.status]);
  if (upd.changes === 0) throw Errors.conflict('任务状态已被并发修改');
  await logTransition({ tenantId, taskId, from: task.status, to, actorId, note });
  await tryAudit({
    tenantId, projectId, actorId, action: 'biz_task.transition',
    resourceKind: 'biz_task', resourceId: taskId,
    payload: { from: task.status, to, note: String(note).slice(0, 2000) },
  });
  return getTaskRow(tenantId, projectId, taskId);
}

export async function assignTask({ tenantId, projectId, actorId, taskId, assigneeId }) {
  const task = await getTaskRow(tenantId, projectId, taskId);
  if (TERMINAL_STATUSES.has(task.status)) throw Errors.badRequest(`任务已终态(${task.status})，不能改派`);
  if (assigneeId) {
    // V4.6 行级权限：只能改派给本项目成员（viewer+）
    await assertProjectRole(tenantId, projectId, assigneeId, 'viewer', '任务改派');
  }
  await db().run(
    'UPDATE biz_tasks SET assignee_id=?, updated_at=? WHERE id=? AND tenant_id=?',
    [assigneeId || null, nowMs(), taskId, tenantId]);
  await tryAudit({
    tenantId, projectId, actorId, action: 'biz_task.assign',
    resourceKind: 'biz_task', resourceId: taskId,
    payload: { assignee_id: assigneeId || null },
  });
  return getTaskRow(tenantId, projectId, taskId);
}

/**
 * 审批单决议。SoD：发起人不能审批自己的单（复用门禁例外审批的职责分离语义）。
 * approve → resolved；reject → cancelled。幂等：已决议的单重复决议直接返回。
 */
export async function decideTask({ tenantId, projectId, actorId, taskId, approved, note = '' }) {
  const task = await getTaskRow(tenantId, projectId, taskId);
  if (task.kind !== 'approval') throw Errors.badRequest('只有审批单可以决议', { code: 'NOT_APPROVAL_TASK' });
  const denied = (code, reason) => tryAudit({
    tenantId, projectId, actorId, action: 'biz_task.decide.denied',
    resourceKind: 'biz_task', resourceId: taskId,
    payload: { code, reason, approved: !!approved },
  });
  if (task.requester_id === actorId) {
    await denied('SOD_VIOLATION', '发起人不能审批自己的审批单');
    throw Errors.forbidden('审批需职责分离：发起人不能审批自己的审批单', { code: 'SOD_VIOLATION' });
  }
  // V4.6 审批人指派：指定了 approver_id 的单，只有被指派人可决议
  const payload = task.payload || {};
  if (payload.approver_id && payload.approver_id !== actorId) {
    await denied('APPROVER_MISMATCH', `该审批单已指派给 ${payload.approver_id} 决议`);
    throw Errors.forbidden('该审批单已指派他人决议，无权审批', { code: 'APPROVER_MISMATCH' });
  }
  if (payload.decision && payload.decision !== 'pending') return task; // 已决议，幂等返回
  if (!['in_progress', 'pending'].includes(task.status)) {
    throw Errors.badRequest(`审批单当前状态 ${task.status} 不可决议`, { code: 'INVALID_TRANSITION' });
  }
  const decision = approved ? 'approved' : 'rejected';
  const to = approved ? 'resolved' : 'cancelled';
  const now = nowMs();
  const nextPayload = {
    ...payload, decision, decided_by: actorId, decided_at: now,
    decide_note: String(note).slice(0, 2000),
  };
  const upd = await db().run(
    `UPDATE biz_tasks SET status=?, payload=?, updated_at=?, closed_at=?
     WHERE id=? AND tenant_id=? AND status=?`,
    [to, JSON.stringify(nextPayload), now, approved ? task.closed_at : now, taskId, tenantId, task.status]);
  if (upd.changes === 0) throw Errors.conflict('任务状态已被并发修改');
  await logTransition({ tenantId, taskId, from: task.status, to, actorId, note: `审批${approved ? '通过' : '驳回'}${note ? ': ' + note : ''}` });
  await tryAudit({
    tenantId, projectId, actorId, action: 'biz_task.decide',
    resourceKind: 'biz_task', resourceId: taskId,
    payload: { decision, requested_by: task.requester_id, note: String(note).slice(0, 2000) },
  });
  return getTaskRow(tenantId, projectId, taskId);
}

/**
 * SLA 扫描：超时未终态且未升级的任务 → escalated=1。返回升级的任务 id 列表。
 * best-effort 逐条处理，单条失败不影响其他（先查 id 再逐条 CAS）。
 */
export async function slaSweep({ tenantId, projectId, actorId }) {
  const now = nowMs();
  const rows = await db().query(
    `SELECT id FROM biz_tasks
     WHERE tenant_id=? AND project_id=? AND sla_due_at IS NOT NULL AND sla_due_at < ?
       AND escalated=0 AND status NOT IN ('closed','cancelled')`,
    [tenantId, projectId, now]);
  const escalatedIds = [];
  for (const r of rows) {
    const upd = await db().run(
      `UPDATE biz_tasks SET escalated=1, escalated_at=?, updated_at=?
       WHERE id=? AND tenant_id=? AND escalated=0 AND status NOT IN ('closed','cancelled')`,
      [now, now, r.id, tenantId]);
    if (upd.changes === 0) continue; // 并发已处理
    escalatedIds.push(r.id);
    await tryAudit({
      tenantId, projectId, actorId, action: 'biz_task.escalated',
      resourceKind: 'biz_task', resourceId: r.id,
      payload: { reason: 'sla_breach' },
    });
  }
  return { escalated: escalatedIds, swept_at: now };
}
