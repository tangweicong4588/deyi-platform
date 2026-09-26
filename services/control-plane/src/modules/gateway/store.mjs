/**
 * modules/gateway/store.mjs —— 模型目录 / 预算 / 调用账本。
 */
import { newId, nowMs } from '../../kernel/ids.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { db } from '../../db/index.mjs';

const parseArr = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; }; };
const normModel = (r) => r && ({
  ...r,
  fallback_litellm_models: parseArr(r.fallback_litellm_models),
  data_classes: parseArr(r.data_classes),
});

export async function upsertModel({ name, litellmModel, fallback = [], dataClasses = ['public', 'internal'],
  costPromptPerMtokCents = 0, costCompletionPerMtokCents = 0, status = 'active' }) {
  if (!name || !litellmModel) throw Errors.badRequest('name / litellmModel 必填');
  const existing = await db().query('SELECT id FROM models WHERE name=?', [name]);
  const row = {
    litellm_model: litellmModel,
    fallback_litellm_models: JSON.stringify(fallback),
    data_classes: JSON.stringify(dataClasses),
    cost_prompt_per_mtok_cents: costPromptPerMtokCents,
    cost_completion_per_mtok_cents: costCompletionPerMtokCents,
    status,
  };
  if (existing[0]) {
    await db().query(
      `UPDATE models SET litellm_model=?, fallback_litellm_models=?, data_classes=?,
       cost_prompt_per_mtok_cents=?, cost_completion_per_mtok_cents=?, status=? WHERE name=?`,
      [row.litellm_model, row.fallback_litellm_models, row.data_classes,
       row.cost_prompt_per_mtok_cents, row.cost_completion_per_mtok_cents, row.status, name]);
    return normModel((await db().query('SELECT * FROM models WHERE name=?', [name]))[0]);
  }
  const full = { id: newId('mdl'), name, ...row, created_at: nowMs() };
  await db().query(
    `INSERT INTO models(id,name,litellm_model,fallback_litellm_models,data_classes,
     cost_prompt_per_mtok_cents,cost_completion_per_mtok_cents,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [full.id, full.name, full.litellm_model, full.fallback_litellm_models, full.data_classes,
     full.cost_prompt_per_mtok_cents, full.cost_completion_per_mtok_cents, full.status, full.created_at]);
  return normModel(full);
}

export async function getModel(name) {
  const rows = await db().query('SELECT * FROM models WHERE name=?', [name]);
  return normModel(rows[0]) || null;
}

export async function listModels() {
  return (await db().query("SELECT * FROM models WHERE status='active' ORDER BY name")).map(normModel);
}

/** 启动时播种示例目录（费率是示例值，运维必须按实际供应商复核） */
export async function ensureSeedModels() {
  const n = await db().query('SELECT COUNT(*) AS c FROM models');
  if (Number(n[0].c) > 0) return;
  await upsertModel({
    name: 'deyi-default', litellmModel: 'deyi-default',
    dataClasses: ['public', 'internal'],
    costPromptPerMtokCents: 15, costCompletionPerMtokCents: 60, // 示例费率（对标 gpt-4o-mini 量级）
  });
  await upsertModel({
    name: 'deyi-embedding', litellmModel: 'deyi-embedding',
    dataClasses: ['public', 'internal'],
    costPromptPerMtokCents: 2, costCompletionPerMtokCents: 0,
  });
}

// ---------- 预算 ----------
export function currentPeriodKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export async function getBudget(tenantId, projectId, periodKey, period = 'monthly') {
  const rows = await db().query(
    `SELECT * FROM budgets WHERE tenant_id=? AND COALESCE(project_id,'')=COALESCE(?,'')
     AND period=? AND period_key=?`,
    [tenantId, projectId, period, periodKey]);
  return rows[0] || null;
}

export async function setBudget({ tenantId, projectId = null, period = 'monthly', costLimitCents = null, tokenLimit = null }) {
  const { getTenant, getProject } = await import('../identity/store.mjs');
  const t = await getTenant(tenantId).catch(() => null);
  if (!t) throw Errors.badRequest('租户不存在');
  if (projectId) {
    const p = await getProject(tenantId, projectId).catch(() => null);
    if (!p) throw Errors.badRequest('项目不存在或不属于该租户');
  }
  const periodKey = period === 'monthly' ? currentPeriodKey() : 'total';
  const existing = await getBudget(tenantId, projectId, periodKey, period);
  if (existing) {
    await db().query(
      `UPDATE budgets SET cost_limit_cents=?, token_limit=?, status='active', updated_at=? WHERE id=?`,
      [costLimitCents, tokenLimit, nowMs(), existing.id]);
    return (await getBudget(tenantId, projectId, periodKey, period));
  }
  const row = {
    id: newId('bdg'), tenant_id: tenantId, project_id: projectId, period,
    cost_limit_cents: costLimitCents, token_limit: tokenLimit,
    used_cost_cents: 0, used_tokens: 0, period_key: periodKey,
    status: 'active', created_at: nowMs(), updated_at: nowMs(),
  };
  await db().query(
    `INSERT INTO budgets(id,tenant_id,project_id,period,cost_limit_cents,token_limit,
     used_cost_cents,used_tokens,period_key,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [row.id, row.tenant_id, row.project_id, row.period, row.cost_limit_cents, row.token_limit,
     row.used_cost_cents, row.used_tokens, row.period_key, row.status, row.created_at, row.updated_at]);
  return row;
}

export async function listBudgets(tenantId) {
  return db().query('SELECT * FROM budgets WHERE tenant_id=? ORDER BY created_at', [tenantId]);
}

/** 原子累加用量（并发安全：单条 UPDATE） */
export async function addUsage(budgetId, tokens, costCents) {
  await db().query(
    `UPDATE budgets SET used_cost_cents=used_cost_cents+?, used_tokens=used_tokens+?, updated_at=? WHERE id=?`,
    [costCents, tokens, nowMs(), budgetId]);
}

// ---------- 调用账本 ----------
export async function recordCall(row) {
  const full = { id: newId('call'), created_at: nowMs(), ...row };
  await db().query(
    `INSERT INTO model_calls(id,tenant_id,project_id,actor_id,trace_id,model,litellm_model,endpoint,
     prompt_tokens,completion_tokens,total_tokens,cost_cents,latency_ms,status,cached,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [full.id, full.tenant_id, full.project_id, full.actor_id, full.trace_id, full.model,
     full.litellm_model, full.endpoint, full.prompt_tokens, full.completion_tokens,
     full.total_tokens, full.cost_cents, full.latency_ms, full.status, full.cached ? 1 : 0, full.created_at]);
  return full;
}

export async function listCalls(tenantId, limit = 100) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return db().query(
    `SELECT id,tenant_id,project_id,actor_id,trace_id,model,endpoint,prompt_tokens,
            completion_tokens,total_tokens,cost_cents,latency_ms,status,created_at
     FROM model_calls WHERE tenant_id=? ORDER BY created_at DESC LIMIT ${n}`, [tenantId]);
}

// ---------- 计量 outbox（M-16）：记账失败时暂存，等待补记 ----------
export async function enqueueUsageOutbox(tenantId, payload, lastError) {
  const row = {
    id: newId('uob'), tenant_id: tenantId, payload_json: JSON.stringify(payload),
    attempts: 0, last_error: String(lastError || '').slice(0, 2000),
    created_at: nowMs(), processed_at: null,
  };
  await db().query(
    `INSERT INTO gateway_usage_outbox(id,tenant_id,payload_json,attempts,last_error,created_at,processed_at)
     VALUES (?,?,?,?,?,?,?)`,
    [row.id, row.tenant_id, row.payload_json, row.attempts, row.last_error, row.created_at, row.processed_at]);
  return row;
}

export async function listPendingUsageOutbox(limit = 100) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return db().query(
    `SELECT * FROM gateway_usage_outbox WHERE processed_at IS NULL ORDER BY created_at LIMIT ${n}`);
}

export async function markUsageOutboxProcessed(id) {
  await db().query(`UPDATE gateway_usage_outbox SET processed_at=? WHERE id=?`, [nowMs(), id]);
}

export async function bumpUsageOutboxAttempt(id, err) {
  await db().query(
    `UPDATE gateway_usage_outbox SET attempts=attempts+1, last_error=? WHERE id=?`,
    [String(err || '').slice(0, 2000), id]);
}

export async function countPendingUsageOutbox() {
  const rows = await db().query(
    `SELECT COUNT(*) AS c FROM gateway_usage_outbox WHERE processed_at IS NULL`);
  return rows[0]?.c || 0;
}

export async function getCallById(id) {
  const rows = await db().query(`SELECT id FROM model_calls WHERE id=?`, [id]);
  return rows[0] || null;
}
