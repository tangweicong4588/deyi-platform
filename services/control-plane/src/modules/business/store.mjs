/**
 * modules/business/store.mjs —— 业务意图/计划/动作真相源 CRUD（租户隔离）。
 * 状态机与计划逻辑在 plan.mjs，这里只做数据访问。
 */
import { newId, nowMs, assertId } from '../../kernel/ids.mjs';
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
  for (const k of ['status', 'expected_effect', 'dryrun_reasons', 'preconditions', 'ontology_term_ids']) {
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
