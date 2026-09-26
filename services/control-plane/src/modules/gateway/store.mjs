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

/**
 * R7 遗留（V2.1-E）：从调用发生时间推导账期（与 currentPeriodKey 同一本地时区口径）。
 * 老 outbox payload 没有 periodKey 时用它回放，避免跨月补记串到当前账期。
 * 输入非法时返回 null，调用方再回退 currentPeriodKey()。
 */
export function periodKeyFromCreatedAt(createdAt) {
  const t = Number(createdAt);
  if (!Number.isFinite(t) || t <= 0) return null;
  const d = new Date(t);
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

/**
 * R6 数据 review 重构：记账原子单元。
 * call（调用账本）+ 租户预算 + 项目预算在同一事务内提交——任一步失败整体回滚，
 * 彻底消除"call 已落库但预算没累加"的中间态。补记（outbox）整体重放同一 callRow 即可，
 * 不再需要"call 存在则跳过全部"的分阶段逻辑（该逻辑正是漏记预算的根因）。
 * 幂等：callRow.id 为主键；并发重放命中唯一约束时视为已记账（返回 null），不抛错。
 */
export async function persistUsageAtomic({ callRow, tenantId, projectId, periodKey }) {
  // id/created_at 在调用方预生成：补记重试复用同一 id，防重复记账
  const full = { id: newId('call'), created_at: nowMs(), ...callRow };
  try {
    await db().transaction(async (tx) => {
      await tx.query(
        `INSERT INTO model_calls(id,tenant_id,project_id,actor_id,trace_id,model,litellm_model,endpoint,
         prompt_tokens,completion_tokens,total_tokens,cost_cents,latency_ms,status,cached,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [full.id, full.tenant_id, full.project_id, full.actor_id, full.trace_id, full.model,
         full.litellm_model, full.endpoint, full.prompt_tokens, full.completion_tokens,
         full.total_tokens, full.cost_cents, full.latency_ms, full.status, full.cached ? 1 : 0, full.created_at]);
      const now = nowMs();
      const tokens = full.total_tokens || 0;
      const cents = full.cost_cents || 0;
      const tRows = await tx.query(
        `SELECT id FROM budgets WHERE tenant_id=? AND COALESCE(project_id,'')=COALESCE(?,'')
         AND period='monthly' AND period_key=?`,
        [tenantId, null, periodKey]);
      if (tRows[0]) {
        await tx.query(
          `UPDATE budgets SET used_cost_cents=used_cost_cents+?, used_tokens=used_tokens+?, updated_at=?
           WHERE id=?`, [cents, tokens, now, tRows[0].id]);
      }
      if (projectId) {
        const pRows = await tx.query(
          `SELECT id FROM budgets WHERE tenant_id=? AND COALESCE(project_id,'')=COALESCE(?,'')
           AND period='monthly' AND period_key=?`,
          [tenantId, projectId, periodKey]);
        if (pRows[0]) {
          await tx.query(
            `UPDATE budgets SET used_cost_cents=used_cost_cents+?, used_tokens=used_tokens+?, updated_at=?
             WHERE id=?`, [cents, tokens, now, pRows[0].id]);
        }
      }
    });
    return full;
  } catch (e) {
    // 幂等重放：call 主键冲突说明该调用已记过账（并发补记/重试），不视为失败
    if (/unique|duplicate|23505/i.test(e.message || '') && await getCallById(full.id)) {
      return null;
    }
    throw e;
  }
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
