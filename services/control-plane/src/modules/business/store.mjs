/**
 * modules/business/store.mjs —— 业务意图/计划/动作真相源 CRUD（租户隔离）。
 * 状态机与计划逻辑在 plan.mjs，这里只做数据访问。
 */
import { newId, nowMs, assertId } from '../../kernel/ids.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { db } from '../../db/index.mjs';

export const INTENT_STATUSES = new Set(['draft', 'planned', 'approved', 'executing', 'done', 'rejected', 'cancelled']);
export const PLAN_STATUSES = new Set(['draft', 'dryrun_passed', 'dryrun_blocked', 'approved', 'rejected']);
export const ACTION_STATUSES = new Set(['pending', 'dryrun_ok', 'dryrun_blocked', 'approved', 'executing', 'done', 'failed', 'compensated']);

const J = {
  parse(s, fb) { try { return JSON.parse(s); } catch { return fb; } },
  str(v) { return JSON.stringify(v ?? null); },
};

const normIntent = (r) => r && { ...r };
const normPlan = (r) => r && {
  ...r,
  risk_estimate: J.parse(r.risk_estimate, {}),
  ontology_gaps: J.parse(r.ontology_gaps, []),
  dryrun_report: J.parse(r.dryrun_report, {}),
};
const normAction = (r) => r && {
  ...r,
  args: J.parse(r.args, {}),
  ontology_term_ids: J.parse(r.ontology_term_ids, []),
  preconditions: J.parse(r.preconditions, []),
  expected_effect: J.parse(r.expected_effect, {}),
  dryrun_reasons: J.parse(r.dryrun_reasons, []),
};

// ---------- 意图 ----------
export async function createIntent({ tenantId, projectId, rawText, createdBy }) {
  const row = {
    id: newId('bint'), tenant_id: tenantId, project_id: projectId,
    raw_text: rawText, status: 'draft',
    created_by: createdBy || null, created_at: nowMs(), updated_at: nowMs(),
  };
  await db().query(
    `INSERT INTO business_intents(id,tenant_id,project_id,raw_text,status,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [row.id, row.tenant_id, row.project_id, row.raw_text, row.status, row.created_by, row.created_at, row.updated_at]);
  return normIntent(row);
}

export async function getIntent(tenantId, id) {
  assertId('bint', id);
  const rows = await db().query('SELECT * FROM business_intents WHERE id=? AND tenant_id=?', [id, tenantId]);
  return normIntent(rows[0]) || null;
}

export async function listIntents(tenantId, projectId, { status, limit = 50 } = {}) {
  let sql = 'SELECT * FROM business_intents WHERE tenant_id=? AND project_id=?';
  const args = [tenantId, projectId];
  if (status) { sql += ' AND status=?'; args.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  args.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  return (await db().query(sql, args)).map(normIntent);
}

export async function setIntentStatus(tenantId, id, status) {
  if (!INTENT_STATUSES.has(status)) throw new Error(`非法意图状态: ${status}`);
  await db().query('UPDATE business_intents SET status=?, updated_at=? WHERE id=? AND tenant_id=?',
    [status, nowMs(), id, tenantId]);
  return getIntent(tenantId, id);
}

// ---------- 计划 ----------
export async function createPlan({ tenantId, projectId, intentId, createdBy }) {
  const row = {
    id: newId('bplan'), intent_id: intentId, tenant_id: tenantId, project_id: projectId,
    status: 'draft', risk_estimate: '{}', ontology_gaps: '[]', dryrun_report: '{}',
    created_by: createdBy || null, created_at: nowMs(), updated_at: nowMs(),
  };
  await db().query(
    `INSERT INTO business_plans(id,intent_id,tenant_id,project_id,status,risk_estimate,ontology_gaps,dryrun_report,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [row.id, row.intent_id, row.tenant_id, row.project_id, row.status, row.risk_estimate,
     row.ontology_gaps, row.dryrun_report, row.created_by, row.created_at, row.updated_at]);
  return normPlan(row);
}

export async function getPlan(tenantId, id) {
  assertId('bplan', id);
  const rows = await db().query('SELECT * FROM business_plans WHERE id=? AND tenant_id=?', [id, tenantId]);
  return normPlan(rows[0]) || null;
}

export async function listPlansByIntent(tenantId, intentId) {
  const rows = await db().query(
    'SELECT * FROM business_plans WHERE intent_id=? AND tenant_id=? ORDER BY created_at DESC', [intentId, tenantId]);
  return rows.map(normPlan);
}

export async function updatePlan(tenantId, id, patch) {
  const sets = [];
  const args = [];
  for (const k of ['status', 'risk_estimate', 'ontology_gaps', 'dryrun_report']) {
    if (patch[k] !== undefined) {
      if (k === 'status' && !PLAN_STATUSES.has(patch[k])) throw new Error(`非法计划状态: ${patch[k]}`);
      sets.push(`${k}=?`);
      args.push(k === 'status' ? patch[k] : J.str(patch[k]));
    }
  }
  if (!sets.length) return getPlan(tenantId, id);
  sets.push('updated_at=?');
  args.push(nowMs(), id, tenantId);
  await db().query(`UPDATE business_plans SET ${sets.join(',')} WHERE id=? AND tenant_id=?`, args);
  return getPlan(tenantId, id);
}

// ---------- 动作 ----------
export async function createAction({ tenantId, projectId, planId, seq, toolRef, toolName, args,
  idempotencyKey, ontologyTermIds = [], preconditions = [], expectedEffect = {} }) {
  const row = {
    id: newId('bact'), plan_id: planId, tenant_id: tenantId, project_id: projectId, seq,
    tool_ref: toolRef || null, tool_name: toolName || '',
    args: J.str(args || {}), idempotency_key: idempotencyKey,
    ontology_term_ids: J.str(ontologyTermIds), preconditions: J.str(preconditions),
    expected_effect: J.str(expectedEffect), status: 'pending', dryrun_reasons: '[]',
    created_at: nowMs(), updated_at: nowMs(),
  };
  await db().query(
    `INSERT INTO business_actions(id,plan_id,tenant_id,project_id,seq,tool_ref,tool_name,args,
      idempotency_key,ontology_term_ids,preconditions,expected_effect,status,dryrun_reasons,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [row.id, row.plan_id, row.tenant_id, row.project_id, row.seq, row.tool_ref, row.tool_name,
     row.args, row.idempotency_key, row.ontology_term_ids, row.preconditions, row.expected_effect,
     row.status, row.dryrun_reasons, row.created_at, row.updated_at]);
  return normAction(row);
}

export async function listActions(tenantId, planId) {
  const rows = await db().query(
    'SELECT * FROM business_actions WHERE plan_id=? AND tenant_id=? ORDER BY seq ASC', [planId, tenantId]);
  return rows.map(normAction);
}

export async function updateAction(tenantId, id, patch) {
  const sets = [];
  const args = [];
  for (const k of ['status', 'expected_effect', 'dryrun_reasons', 'preconditions', 'ontology_term_ids', 'args']) {
    if (patch[k] !== undefined) {
      if (k === 'status' && !ACTION_STATUSES.has(patch[k])) throw new Error(`非法动作状态: ${patch[k]}`);
      sets.push(`${k}=?`);
      args.push(k === 'status' ? patch[k] : J.str(patch[k]));
    }
  }
  if (!sets.length) return null;
  sets.push('updated_at=?');
  args.push(nowMs(), id, tenantId);
  await db().query(`UPDATE business_actions SET ${sets.join(',')} WHERE id=? AND tenant_id=?`, args);
  const rows = await db().query('SELECT * FROM business_actions WHERE id=? AND tenant_id=?', [id, tenantId]);
  return normAction(rows[0]) || null;
}

/** 按 ID 取单个动作（租户隔离；V2.0-B 执行入口用） */
export async function getAction(tenantId, id) {
  assertId('bact', id);
  const rows = await db().query('SELECT * FROM business_actions WHERE id=? AND tenant_id=?', [id, tenantId]);
  return normAction(rows[0]) || null;
}

/**
 * H-3 业务 review：失败动作重置为可重试。
 * 仅 failed/compensated/executing 可重置 → approved + 新幂等键（旧键已关联失败的执行记录，
 * 复用会导致"重复执行直接返回旧失败结果"）。返回重置后的动作；状态不符抛 409。
 */
export async function resetActionForRetry(tenantId, actionId, newIdempotencyKey) {
  const upd = await db().run(
    `UPDATE business_actions SET status='approved', idempotency_key=?, updated_at=?
     WHERE id=? AND tenant_id=? AND status IN ('failed','compensated','executing')`,
    [newIdempotencyKey, nowMs(), actionId, tenantId]);
  if (upd.changes === 0) {
    const cur = await getAction(tenantId, actionId).catch(() => null);
    throw Errors.conflict(
      `动作当前状态 ${cur?.status || '未知'} 不允许重置（仅 failed/compensated/executing 可重置）`,
      { code: 'INVALID_ACTION_STATE' });
  }
  return getAction(tenantId, actionId);
}

/** 该动作已有的执行记录数（重试时生成第 N+1 个幂等键） */
export async function countActionExecutions(tenantId, actionId) {
  const rows = await db().query(
    'SELECT COUNT(*) AS n FROM action_executions WHERE tenant_id=? AND action_id=?', [tenantId, actionId]);
  return Number(rows[0]?.n || 0);
}

// ---------- 计划审批记录（V2.0-B：高风险动作执行的硬检查依据） ----------
export async function recordPlanApproval({ tenantId, planId, approverId }) {
  const now = nowMs();
  const row = {
    id: newId('bpar'), plan_id: planId, tenant_id: tenantId,
    approver_id: approverId, decided_at: now, created_at: now,
  };
  // 同一计划重新审批时覆盖旧记录（UNIQUE(plan_id)）
  await db().query(
    `INSERT INTO plan_approvals(id,plan_id,tenant_id,approver_id,decided_at,created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(plan_id) DO UPDATE SET approver_id=excluded.approver_id,
       decided_at=excluded.decided_at, created_at=excluded.created_at, id=excluded.id`,
    [row.id, row.plan_id, row.tenant_id, row.approver_id, row.decided_at, row.created_at]);
  return row;
}

export async function getPlanApproval(tenantId, planId) {
  const rows = await db().query(
    'SELECT * FROM plan_approvals WHERE plan_id=? AND tenant_id=?', [planId, tenantId]);
  return rows[0] || null;
}

// ---------- 短期授权（credential_grants） ----------
const normGrant = (r) => r && { ...r, scope: J.parse(r.scope, {}) };

export async function insertGrant({ tenantId, projectId, actionId, scope, expiresAt, createdBy, grantedTo }) {
  const row = {
    id: newId('grant'), tenant_id: tenantId, project_id: projectId, action_id: actionId,
    scope: J.str(scope), expires_at: expiresAt, status: 'active', used_at: null,
    created_by: createdBy || null, granted_to: grantedTo || null, created_at: nowMs(),
  };
  await db().query(
    `INSERT INTO credential_grants(id,tenant_id,project_id,action_id,scope,expires_at,status,used_at,created_by,granted_to,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [row.id, row.tenant_id, row.project_id, row.action_id, row.scope, row.expires_at,
     row.status, row.used_at, row.created_by, row.granted_to, row.created_at]);
  return normGrant(row);
}

export async function getGrant(tenantId, id) {
  assertId('grant', id);
  const rows = await db().query('SELECT * FROM credential_grants WHERE id=? AND tenant_id=?', [id, tenantId]);
  return normGrant(rows[0]) || null;
}

export async function setGrantStatus(tenantId, id, status) {
  const now = nowMs();
  await db().query(
    `UPDATE credential_grants SET status=?, used_at=CASE WHEN ? IN ('used','revoked') THEN ? ELSE used_at END
     WHERE id=? AND tenant_id=?`,
    [status, status, now, id, tenantId]);
  return getGrant(tenantId, id);
}

/**
 * 原子消费 grant：active→used 的 CAS（L-5 安全 / M1 数据 review）。
 * 返回 true=本次消费成功；false=已被消费/过期/吊销（调用方应视为并发冲突，拒绝重复执行）。
 */
export async function consumeGrant(tenantId, id) {
  const upd = await db().run(
    `UPDATE credential_grants SET status='used', used_at=? WHERE id=? AND tenant_id=? AND status='active'`,
    [nowMs(), id, tenantId]);
  return upd.changes === 1;
}

// ---------- 执行记录（action_executions） ----------
const normExec = (r) => r && {
  ...r,
  result_summary: r.result_summary ?? '{}',
  verify_result: (() => { try { return JSON.parse(r.verify_result ?? '{}'); } catch { return {}; } })(),
};

export async function getBusinessExecution(tenantId, id) {
  assertId('bxn', id);
  const rows = await db().query('SELECT * FROM action_executions WHERE id=? AND tenant_id=?', [id, tenantId]);
  return normExec(rows[0]) || null;
}

export async function getBusinessExecutionByKey(tenantId, idempotencyKey) {
  const rows = await db().query(
    'SELECT * FROM action_executions WHERE tenant_id=? AND idempotency_key=?', [tenantId, idempotencyKey]);
  return normExec(rows[0]) || null;
}

export async function insertBusinessExecution({ tenantId, projectId, actionId, grantId, idempotencyKey }) {
  const row = {
    id: newId('bxn'), tenant_id: tenantId, project_id: projectId, action_id: actionId,
    grant_id: grantId || null, idempotency_key: idempotencyKey,
    external_ref: null, result_summary: '{}', status: 'running',
    started_at: nowMs(), finished_at: null, created_at: nowMs(),
  };
  await db().query(
    `INSERT INTO action_executions(id,tenant_id,project_id,action_id,grant_id,idempotency_key,
       external_ref,result_summary,status,started_at,finished_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [row.id, row.tenant_id, row.project_id, row.action_id, row.grant_id, row.idempotency_key,
     row.external_ref, row.result_summary, row.status, row.started_at, row.finished_at, row.created_at]);
  return normExec(row);
}

export const VERIFY_STATUSES = new Set(['unverified', 'verified', 'mismatched', 'unverifiable']);

export async function updateBusinessExecution(tenantId, id, patch) {
  const sets = [];
  const args = [];
  for (const k of ['external_ref', 'result_summary', 'status', 'verify_status', 'verify_result', 'verified_at']) {
    if (patch[k] !== undefined) {
      if (k === 'verify_status' && !VERIFY_STATUSES.has(patch[k])) throw new Error(`非法验证状态: ${patch[k]}`);
      sets.push(`${k}=?`); args.push(patch[k]);
    }
  }
  if (!sets.length) return getBusinessExecution(tenantId, id);
  sets.push('finished_at=CASE WHEN ? IN (\'succeeded\',\'failed\',\'compensated\') THEN ? ELSE finished_at END');
  args.push(patch.status || '', nowMs());
  await db().query(`UPDATE action_executions SET ${sets.join(',')} WHERE id=? AND tenant_id=?`,
    [...args, id, tenantId]);
  return getBusinessExecution(tenantId, id);
}

// ---------- 对账队列（reconciliation_items；V2.0-C 消费） ----------
export const RECON_STATUSES = new Set(['open', 'investigating', 'resolved', 'escalated', 'closed']);
export const RECON_SOURCES = new Set(['execute', 'verify']);

const normRecon = (r) => r && { ...r, resolution: J.parse(r.resolution, {}) };

export async function insertReconciliation({ tenantId, projectId, actionId, executionId, reason, source = 'execute' }) {
  if (!RECON_SOURCES.has(source)) throw new Error(`非法对账来源: ${source}`);
  const now = nowMs();
  const row = {
    id: newId('brec'), tenant_id: tenantId, project_id: projectId,
    action_id: actionId || null, execution_id: executionId || null,
    reason: String(reason || '').slice(0, 1000), source, status: 'open',
    assignee: null, resolution: '{}',
    created_at: now, updated_at: now, decided_at: null, closed_at: null,
  };
  await db().query(
    `INSERT INTO reconciliation_items(id,tenant_id,project_id,action_id,execution_id,reason,source,
       status,assignee,resolution,created_at,updated_at,decided_at,closed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [row.id, row.tenant_id, row.project_id, row.action_id, row.execution_id,
     row.reason, row.source, row.status, row.assignee, row.resolution,
     row.created_at, row.updated_at, row.decided_at, row.closed_at]);
  return normRecon(row);
}

export async function getReconciliation(tenantId, id) {
  assertId('brec', id);
  const rows = await db().query('SELECT * FROM reconciliation_items WHERE id=? AND tenant_id=?', [id, tenantId]);
  return normRecon(rows[0]) || null;
}

/** 同一执行记录的未关闭对账项（防重复建队；open/investigating/escalated 视为未关闭） */
export async function getOpenReconciliationByExecution(tenantId, executionId) {
  const rows = await db().query(
    `SELECT * FROM reconciliation_items WHERE tenant_id=? AND execution_id=?
     AND status IN ('open','investigating','escalated') ORDER BY created_at DESC LIMIT 1`,
    [tenantId, executionId]);
  return normRecon(rows[0]) || null;
}

export async function listReconciliations(tenantId, { status = 'open', source = null, executionId = null, limit = 200 } = {}) {
  let sql = 'SELECT * FROM reconciliation_items WHERE tenant_id=?';
  const args = [tenantId];
  if (status) {
    if (!RECON_STATUSES.has(status)) throw new Error(`非法对账状态: ${status}`);
    sql += ' AND status=?'; args.push(status);
  }
  if (source) {
    if (!RECON_SOURCES.has(source)) throw new Error(`非法对账来源: ${source}`);
    sql += ' AND source=?'; args.push(source);
  }
  if (executionId) { sql += ' AND execution_id=?'; args.push(executionId); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  args.push(Math.min(Math.max(Number(limit) || 200, 1), 500));
  return (await db().query(sql, args)).map(normRecon);
}

/** 列出全部状态的对账项（运营视角；默认仍按创建时间倒序） */
export async function listAllReconciliations(tenantId, { source = null, limit = 200 } = {}) {
  return listReconciliations(tenantId, { status: null, source, limit });
}

export async function updateReconciliation(tenantId, id, patch) {
  const sets = [];
  const args = [];
  for (const k of ['status', 'assignee', 'resolution', 'decided_at', 'closed_at']) {
    if (patch[k] !== undefined) {
      if (k === 'status' && !RECON_STATUSES.has(patch[k])) throw new Error(`非法对账状态: ${patch[k]}`);
      sets.push(`${k}=?`);
      args.push(k === 'resolution' ? J.str(patch[k]) : patch[k]);
    }
  }
  if (!sets.length) return getReconciliation(tenantId, id);
  sets.push('updated_at=?');
  args.push(nowMs(), id, tenantId);
  await db().query(`UPDATE reconciliation_items SET ${sets.join(',')} WHERE id=? AND tenant_id=?`, args);
  return getReconciliation(tenantId, id);
}
