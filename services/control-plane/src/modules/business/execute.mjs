/**
 * modules/business/execute.mjs —— V2.0-B 授权执行。
 *
 * 流程：executeAction（单动作）/ executePlan（按 seq 串行）。
 *
 * 硬约束：
 * 1. dry-run 未通过（dryrun_blocked）的动作绝不允许执行 —— service 层硬拦截。
 * 2. 短期授权：执行前签发 credential grant（grant_，默认 TTL 15 分钟，scope 绑定
 *    本次动作的工具+参数哈希），单次使用后立即失效；长期密钥绝不进执行链路。
 * 3. 执行走 P6 工具链路（invokeTool 语义：策略检查 → 幂等 → 补偿链注册 → 引擎执行），
 *    不另起一套执行器。幂等键沿用计划时生成的 idempotency_key，重复执行直接返回
 *    首次结果，不重复调用外部。
 * 4. 外部系统响应只存 external_ref + 脱敏摘要，敏感原文禁止落库（落库前过脱敏器）。
 * 5. 高风险动作（expected_effect.approval_required）要求计划已批准且有审批记录
 *    （审批人≠创建人）；P6 侧的高风险执行审批由该业务审批自动放行（审计链入）。
 * 6. 失败语义：动作失败 → P6 Saga 补偿链已在引擎内逆序执行 → 映射为 compensated；
 *    不可补偿（failed）→ 进对账队列；补偿本身失败也如实进对账，不静默。
 *
 * TOCTOU 防护（dry-run 与执行之间的时间差）：
 * - 执行时重验：工具存在且 active、plan 仍处于可执行状态、grant scope 与当前
 *   工具+参数哈希逐项核对（签发后被篡改则吊销 grant 并拒绝）。
 * - 幂等占位先行 + 唯一约束兜底，并发重复执行只产生一条执行记录。
 */
import { nowMs } from '../../kernel/ids.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { ctx } from '../../kernel/context.mjs';
import { config } from '../../kernel/config.mjs';
import { db } from '../../db/index.mjs';
import { logger } from '../../kernel/logging.mjs';
import * as store from './store.mjs';
import {
  invokeTool, decideApproval, executeOne, getTool, listTools,
  redactArgs, scrubText, hashArgs,
} from '../execution/service.mjs';
import { tryAudit } from '../evidence/audit.mjs';

/** 业务动作在 P6 工具链路中的 action 名（固定常量，grant scope 绑定其中） */
export const BUSINESS_TOOL_ACTION = 'execute';
/** 平台运维伪 actor：不是租户领域主体，禁止直接执行业务动作（与 P6 同规则） */
const PLATFORM_PSEUDO_ACTOR = 'operator';
const SUMMARY_MAX = 4096;

function grantTtlMs() {
  const n = Number(config.BUSINESS_GRANT_TTL_MS);
  const ttl = Number.isFinite(n) && n > 0 ? n : 15 * 60 * 1000;
  // M-8 业务 review：TTL 上限钳制（默认 15 分钟，最大 60 分钟），防超长有效 grant
  return Math.min(ttl, 60 * 60 * 1000);
}

/** grant scope：本次动作允许的工具+参数范围 */
function scopeFor(action, tool) {
  return { tool_id: tool.id, tool_action: BUSINESS_TOOL_ACTION, args_hash: hashArgs(action.args) };
}

/** 结果脱敏：P6 已打码，这里再过一遍（纵深；防未来 P6 变更漏网） */
export function scrubResultText(s) {
  return scrubText(String(s || '')).replace(/\bsk-[A-Za-z0-9]{8,}\b/g, 'sk-***');
}

// ---------- 短期授权 ----------
export async function issueGrant({ tenantId, projectId, actionId, actorId, ttlMs }) {
  const action = await store.getAction(tenantId, actionId);
  if (!action) throw Errors.notFound('业务动作不存在');
  if (action.project_id !== projectId) throw Errors.forbidden('动作不属于该项目');
  const tool = await getTool(tenantId, action.tool_ref);
  if (!tool || tool.status !== 'active') {
    throw Errors.conflict('工具不存在或已停用，无法签发授权', { code: 'TOOL_UNAVAILABLE' });
  }
  const grant = await store.insertGrant({
    tenantId, projectId, actionId: action.id,
    scope: scopeFor(action, tool),
    expiresAt: nowMs() + (ttlMs || grantTtlMs()),
    createdBy: actorId,
    // H-2 安全 review：grant 绑定持有人——签发给谁，只有谁能用
    grantedTo: actorId,
  });
  const c = ctx();
  await tryAudit({
    tenantId, projectId, actorId, traceId: c.traceId,
    action: 'business.grant.issue', resourceKind: 'credential_grant', resourceId: grant.id,
    payload: { action_id: action.id, tool_id: tool.id, expires_at: grant.expires_at },
  });
  return { grant, tool };
}

/** 校验外部传入的 grant：存在性 / 归属 / 持有人 / 状态 / 有效期 / scope 逐项核对 */
export async function validateGrant({ tenantId, grantId, action, actorId }) {
  const grant = await store.getGrant(tenantId, grantId);
  if (!grant) throw Errors.notFound('授权不存在');
  if (grant.action_id !== action.id) {
    throw Errors.forbidden('授权与动作不匹配', { code: 'GRANT_SCOPE_MISMATCH' });
  }
  // H-2 安全 review：持有人绑定——grant 只能由被签发人消费（fail-closed：历史 NULL 视为无效）
  if (!grant.granted_to || grant.granted_to !== actorId) {
    await store.setGrantStatus(tenantId, grant.id, 'revoked');
    logger.warn('business grant holder mismatch, revoked', { grant: grant.id, actor: actorId });
    throw Errors.forbidden('授权持有人与当前执行人不一致，已吊销', { code: 'GRANT_HOLDER_MISMATCH' });
  }
  if (grant.status !== 'active') {
    throw Errors.forbidden(`授权不可用: ${grant.status}`, { code: 'GRANT_NOT_ACTIVE' });
  }
  if (grant.expires_at <= nowMs()) {
    await store.setGrantStatus(tenantId, grant.id, 'expired');
    throw Errors.forbidden('授权已过期', { code: 'GRANT_EXPIRED' });
  }
  // TOCTOU：scope 与"当前"工具+参数哈希逐项核对，签发后被篡改则吊销并拒绝
  const tool = await getTool(tenantId, action.tool_ref);
  if (!tool || tool.status !== 'active') {
    throw Errors.conflict('工具不存在或已停用', { code: 'TOOL_UNAVAILABLE' });
  }
  const expect = scopeFor(action, tool);
  const got = grant.scope || {};
  if (got.tool_id !== expect.tool_id || got.tool_action !== expect.tool_action || got.args_hash !== expect.args_hash) {
    await store.setGrantStatus(tenantId, grant.id, 'revoked');
    logger.warn('business grant scope mismatch, revoked', { grant: grant.id, action: action.id });
    throw Errors.forbidden('授权 scope 与当前动作不一致（工具或参数已变更），已吊销', { code: 'GRANT_SCOPE_MISMATCH' });
  }
  return { grant, tool };
}

// ---------- 补偿链装配 ----------
/** 从 expected_effect.compensation_tool 按名称解析已注册工具；未注册则不纳入（只告警） */
async function buildCompensations({ tenantId, action }) {
  const name = action.expected_effect?.compensation_tool;
  if (!name) return [];
  try {
    const tools = await listTools(tenantId);
    const tool = tools.find((t) => t.name === name && t.status === 'active');
    if (!tool) {
      logger.warn('business compensation tool not registered, skipped', { action: action.id, name });
      return [];
    }
    return [{ toolId: tool.id, action: BUSINESS_TOOL_ACTION, args: action.args }];
  } catch (e) {
    logger.warn('business compensation resolve failed', {
      action: action.id, err: String(e?.message || e).slice(0, 160),
    });
    return [];
  }
}

/**
 * P6 高风险执行审批自动放行：业务计划已批准（审批人≠创建人）即视为治理授权。
 * 审批记录链入业务审批（reason 注明来源），P6 approvals 表保留完整审计轨迹。
 */
async function resolveP6Approval({ tenantId, projectId, approvalId, planApproval, planId }) {
  if (!approvalId) throw Errors.internal('P6 审批单 ID 缺失，无法放行');
  const { effectiveRank } = await import('../identity/middleware.mjs');
  const bindings = await db().query(
    'SELECT project_id, role FROM role_bindings WHERE tenant_id=? AND actor_id=?',
    [tenantId, planApproval.approver_id]);
  if (effectiveRank(bindings, projectId) < 1) {
    throw Errors.forbidden('业务审批人缺少 operator 角色，无法放行 P6 执行审批', { code: 'APPROVER_RANK' });
  }
  const out = await decideApproval({
    tenantId, projectId, approvalId, actorId: planApproval.approver_id,
    roles: bindings, approved: true,
    reason: `业务计划 ${planId} 已批准（审批人≠创建人），自动放行`,
  });
  logger.info('business auto-resolved P6 approval', {
    approval: approvalId, by: planApproval.approver_id, plan: planId,
  });
  return { execution: out.execution, deduplicated: false };
}

/** P6 执行结果 → 业务执行记录：抽 external_ref + 脱敏摘要（敏感原文禁止落库） */
function summarizeResult(p6exe) {
  let parsed = null;
  try { parsed = JSON.parse(p6exe.result_ref || '{}'); }
  catch { parsed = { raw: scrubResultText(p6exe.result_ref) }; }
  let externalRef = null;
  if (parsed && typeof parsed === 'object') {
    externalRef = parsed.external_ref || parsed.externalRef || null;
  }
  const summary = scrubResultText(JSON.stringify(redactArgs(parsed))).slice(0, SUMMARY_MAX);
  return { externalRef: externalRef ? String(externalRef).slice(0, 200) : null, summary };
}

// ---------- 单动作执行 ----------
export async function executeAction({ tenantId, projectId, actionId, actorId, grantId = null }) {
  if (!actorId || actorId === PLATFORM_PSEUDO_ACTOR) {
    throw Errors.forbidden('平台运维不能直接执行业务动作，请使用租户主体凭证');
  }
  const action = await store.getAction(tenantId, actionId);
  if (!action) throw Errors.notFound('业务动作不存在');
  if (action.project_id !== projectId) throw Errors.forbidden('动作不属于该项目');
  const plan = await store.getPlan(tenantId, action.plan_id);
  if (!plan) throw Errors.notFound('业务计划不存在');

  // ---- 硬检查 1：dry-run 未通过绝不允许执行 ----
  if (action.status === 'dryrun_blocked' || plan.status === 'dryrun_blocked') {
    throw Errors.forbidden('动作未通过 dry-run，绝不允许执行', { code: 'DRYRUN_BLOCKED' });
  }
  if (!['dryrun_passed', 'approved', 'executing'].includes(plan.status)) {
    throw Errors.conflict(`计划状态 ${plan.status} 不允许执行`, { code: 'INVALID_PLAN_STATE' });
  }
  if (!['dryrun_ok', 'approved', 'executing', 'done'].includes(action.status)) {
    throw Errors.conflict(`动作状态 ${action.status} 不允许执行`, { code: 'INVALID_ACTION_STATE' });
  }

  // ---- 硬检查 2：高风险动作必须有计划审批记录（审批人≠创建人） ----
  const needApproval = action.expected_effect?.approval_required === true;
  let planApproval = null;
  if (needApproval) {
    if (plan.status !== 'approved') {
      throw Errors.forbidden('高风险动作需计划先批准', { code: 'PLAN_APPROVAL_REQUIRED' });
    }
    planApproval = await store.getPlanApproval(tenantId, plan.id);
    if (!planApproval || !planApproval.approver_id) {
      throw Errors.forbidden('高风险动作缺少审批记录', { code: 'PLAN_APPROVAL_REQUIRED' });
    }
    // M-6 业务 review：SoD 基准统一为意图创建人（与 approvePlan 一致）。
    // plan.created_by 与 intent.created_by 理论同源，但字段不同源会导致审计口径不统一。
    const intent = await store.getIntent(tenantId, plan.intent_id);
    const creatorId = intent?.created_by || plan.created_by;
    if (creatorId && planApproval.approver_id === creatorId) {
      throw Errors.forbidden('审批人与意图创建人必须职责分离', { code: 'SOD_VIOLATION' });
    }
  }

  // ---- 幂等：重复执行直接返回首次结果，不碰外部 ----
  const existing = await store.getBusinessExecutionByKey(tenantId, action.idempotency_key);
  if (existing) {
    logger.info('business action deduplicated', { action: action.id, bxn: existing.id });
    return { execution: existing, action: await store.getAction(tenantId, action.id), deduplicated: true };
  }

  // ---- 授权：外部传入则校验，否则签发短期 grant ----
  let grant;
  let tool;
  if (grantId) {
    ({ grant, tool } = await validateGrant({ tenantId, grantId, action, actorId }));
  } else {
    ({ grant, tool } = await issueGrant({ tenantId, projectId, actionId: action.id, actorId }));
  }

  // ---- 执行记录占位（唯一约束防并发双写；冲突则回读首次结果） ----
  let bxn;
  try {
    bxn = await store.insertBusinessExecution({
      tenantId, projectId, actionId: action.id, grantId: grant.id,
      idempotencyKey: action.idempotency_key,
    });
  } catch (e) {
    if (/UNIQUE|unique|duplicate/i.test(e.message || '')) {
      const dup = await store.getBusinessExecutionByKey(tenantId, action.idempotency_key);
      if (dup) {
        logger.info('business action deduplicated (race)', { action: action.id, bxn: dup.id });
        return { execution: dup, action: await store.getAction(tenantId, action.id), deduplicated: true };
      }
    }
    throw e;
  }
  await store.updateAction(tenantId, action.id, { status: 'executing' });
  const c = ctx();

  // ---- batch4 遗留修复：grant 在外部副作用之前原子消费 ----
  // active→used + 未过期 CAS 一次完成。消费失败=已被并发消费/撤销/过期→拒绝执行，
  // 绝不触碰外部工具。注意：消费后若执行异常，grant 已燃烧（动作失败，不可重试），
  // 这是有意为之——grant 是"一次性执行权"，不是"重试券"。
  if (!(await store.consumeGrant(tenantId, grant.id))) {
    await store.updateBusinessExecution(tenantId, bxn.id, { result_summary: '{}', status: 'failed' });
    await store.updateAction(tenantId, action.id, { status: 'failed' });
    throw Errors.conflict('授权已被消费、撤销或过期，拒绝执行', { code: 'GRANT_CONSUMED' });
  }

  // ---- 经 P6 工具链路执行 ----
  // 高风险工具的 P6 审批由业务审批自动放行；放行失败与执行异常走统一失败处理
  let inv;
  try {
    inv = await invokeTool({
      tenantId, projectId, actorId, traceId: c.traceId,
      toolId: tool.id, action: BUSINESS_TOOL_ACTION, args: action.args,
      idempotencyKey: action.idempotency_key,
      compensations: await buildCompensations({ tenantId, action }),
    }).catch(async (e) => {
      if (e?.code === 'APPROVAL_REQUIRED' && needApproval && planApproval) {
        return resolveP6Approval({
          tenantId, projectId, approvalId: e?.details?.approvalId,
          planApproval, planId: plan.id,
        });
      }
      throw e;
    });
  } catch (e) {
    // 执行异常（策略拒绝/引擎失败/审批放行失败等）：落库失败 + 对账，再抛给上层。
    // grant 已在副作用前原子消费，这里不再重复消费（重复消费会静默失败，但语义上 grant
    // 在 invokeTool 之前就已燃烧）。
    await store.updateBusinessExecution(tenantId, bxn.id, { result_summary: '{}', status: 'failed' });
    await store.updateAction(tenantId, action.id, { status: 'failed' });
    await store.insertReconciliation({
      tenantId, projectId, actionId: action.id, executionId: bxn.id,
      reason: `动作执行异常: ${scrubText(e.message).slice(0, 500)}`,
    });
    await tryAudit({
      tenantId, projectId, actorId, traceId: c.traceId,
      action: 'business.action.execute.failed', resourceKind: 'business_action', resourceId: action.id,
      payload: { execution_id: bxn.id, code: e?.code || 'EXECUTE_FAILED' },
    });
    throw e;
  }

  // ---- 结果落库：external_ref + 脱敏摘要；状态机推进；grant 单次失效 ----
  const p6exe = inv.execution;
  const { externalRef, summary } = summarizeResult(p6exe);
  const finalStatus = p6exe.status === 'succeeded' ? 'succeeded'
    : p6exe.status === 'compensated' ? 'compensated' : 'failed';
  const actionStatus = finalStatus === 'succeeded' ? 'done' : finalStatus;
  await store.updateBusinessExecution(tenantId, bxn.id, {
    external_ref: externalRef, result_summary: summary, status: finalStatus,
  });
  await store.updateAction(tenantId, action.id, { status: actionStatus });
  // grant 已在副作用前原子消费（active→used + 未过期 CAS），成功路径无需再次消费。
  if (finalStatus === 'failed') {
    // P6 引擎内补偿已尝试仍失败（或无补偿）：进对账队列，人工处理
    await store.insertReconciliation({
      tenantId, projectId, actionId: action.id, executionId: bxn.id,
      reason: `动作失败且不可补偿: ${scrubText(p6exe.error || '未知错误').slice(0, 500)}`,
    });
  }
  await tryAudit({
    tenantId, projectId, actorId, traceId: c.traceId,
    action: 'business.action.execute', resourceKind: 'business_action', resourceId: action.id,
    payload: {
      execution_id: bxn.id, status: finalStatus, external_ref: externalRef,
      grant_id: grant.id, deduplicated: false,
    },
  });
  return {
    execution: await store.getBusinessExecution(tenantId, bxn.id),
    action: await store.getAction(tenantId, action.id),
    deduplicated: false,
  };
}

// ---------- 计划级回滚：逆序补偿已成功的动作 ----------
async function compensateBusinessAction({ tenantId, projectId, action, actorId, reason }) {
  const c = ctx();
  const fail = async (why, detail) => {
    await store.insertReconciliation({
      tenantId, projectId, actionId: action.id, executionId: null,
      reason: `计划回滚补偿失败 [${why}]: ${scrubText(detail).slice(0, 500)}`,
    });
    await tryAudit({
      tenantId, projectId, actorId, traceId: c.traceId,
      action: 'business.action.compensate.failed', resourceKind: 'business_action', resourceId: action.id,
      payload: { reason: why },
    });
    return { compensated: false, reason: why };
  };
  const name = action.expected_effect?.compensation_tool;
  if (!name) return fail('no-compensation-tool', `动作无补偿工具声明，需人工处理（${reason}）`);
  const tools = await listTools(tenantId).catch(() => []);
  const tool = tools.find((t) => t.name === name && t.status === 'active');
  if (!tool) return fail('compensation-tool-unavailable', `补偿工具 ${name} 未注册或已停用`);
  // M-9 业务 review：补偿原来直调 executeOne，完全绕过 grant/审批/幂等。
  // batch4 遗留修复——统一补偿授权合同（诚实版）：
  // 补偿 grant 不是"审批"，而是"单次执行凭证"：它证明此次补偿由回滚发起人（actorId）
  // 发起、scope 绑定补偿工具+参数哈希、TTL 5 分钟、一次性。真正的授权链是：
  // (1) 调用方必须在已授权的 executePlan 回滚路径内（compensateBusinessAction 不对外暴露）；
  // (2) 补偿工具必须在动作创建时声明于 expected_effect.compensation_tool；
  // (3) CAS done→compensated 认领防重复补偿；
  // (4) 执行前校验 grant 仍有效（active/未过期/持有人一致/scope 一致），任一不符即拒绝执行。
  const grant = await store.insertGrant({
    tenantId, projectId, actionId: action.id,
    scope: { tool_id: tool.id, tool_action: BUSINESS_TOOL_ACTION, args_hash: hashArgs(action.args) },
    expiresAt: nowMs() + 5 * 60 * 1000,
    createdBy: actorId, grantedTo: actorId,
  });
  const claimed = await db().run(
    `UPDATE business_actions SET status='compensated', updated_at=?
     WHERE id=? AND tenant_id=? AND status='done'`,
    [nowMs(), action.id, tenantId]);
  if (claimed.changes === 0) {
    // 已被认领/补偿过：幂等跳过，回收 grant
    await store.setGrantStatus(tenantId, grant.id, 'revoked');
    logger.info('business compensation deduplicated', { action: action.id });
    return { compensated: true, deduplicated: true };
  }
  // 执行前校验补偿凭证：grant 必须仍 active、未过期、持有人为回滚发起人、scope 与签发时一致
  const cg = await store.getGrant(tenantId, grant.id);
  const cgScope = cg?.scope || {};
  if (!cg || cg.status !== 'active' || cg.expires_at <= nowMs()
      || cg.granted_to !== actorId
      || cgScope.tool_id !== tool.id || cgScope.args_hash !== hashArgs(action.args)) {
    await store.setGrantStatus(tenantId, grant.id, 'revoked').catch(() => {});
    await db().run(
      `UPDATE business_actions SET status='done', updated_at=? WHERE id=? AND tenant_id=? AND status='compensated'`,
      [nowMs(), action.id, tenantId]);
    return fail('compensation-grant-invalid', '补偿凭证校验失败（状态/过期/持有人/scope 不符），拒绝执行');
  }
  // R6 复核修复：补偿凭证必须在外部副作用前原子消费。原实现先 executeOne 后 consume，
  // 若进程在两者之间崩溃/consume 失败，grant 仍为 active 可被重放。consume 是 CAS
  //（active→used，含过期检查），失败说明 grant 已被并发消费/过期/吊销→回滚补偿认领并拒绝执行。
  if (!(await store.consumeGrant(tenantId, grant.id))) {
    await store.setGrantStatus(tenantId, grant.id, 'revoked').catch(() => {});
    await db().run(
      `UPDATE business_actions SET status='done', updated_at=? WHERE id=? AND tenant_id=? AND status='compensated'`,
      [nowMs(), action.id, tenantId]);
    return fail('compensation-grant-consumed', '补偿凭证消费失败（并发消费/过期/吊销），拒绝执行补偿');
  }
  try {
    // 补偿走本地同步执行（与 P6 runCompensations 同哲学）：可预期、不嵌套审批；
    // 密钥走 vault_ref，args 已脱敏校验
    await executeOne({
      tool, action: BUSINESS_TOOL_ACTION, args: action.args,
      timeoutMs: Number(config.MCP_TIMEOUT_MS) || 30000,
    });
    await tryAudit({
      tenantId, projectId, actorId, traceId: c.traceId,
      action: 'business.action.compensate', resourceKind: 'business_action', resourceId: action.id,
      payload: { compensation_tool: name, grant_id: grant.id },
    });
    logger.info('business plan rollback compensated', { action: action.id, tool: name });
    return { compensated: true };
  } catch (e) {
    // 补偿本身失败：grant 已在副作用前消费（不可重放）；动作状态回滚为 done
    //（允许后续重试补偿——重试会签发新 grant），如实进对账，不静默
    await db().run(
      `UPDATE business_actions SET status='done', updated_at=? WHERE id=? AND tenant_id=? AND status='compensated'`,
      [nowMs(), action.id, tenantId]);
    return fail('compensation-failed', e.message);
  }
}

// ---------- 整计划串行执行 ----------
export async function executePlan({ tenantId, projectId, planId, actorId }) {
  if (!actorId || actorId === PLATFORM_PSEUDO_ACTOR) {
    throw Errors.forbidden('平台运维不能直接执行业务计划，请使用租户主体凭证');
  }
  const plan = await store.getPlan(tenantId, planId);
  if (!plan) throw Errors.notFound('业务计划不存在');
  if (plan.project_id !== projectId) throw Errors.forbidden('计划不属于该项目');
  // dry-run 未通过的计划绝不允许执行（与单动作硬检查同规则）
  if (plan.status === 'dryrun_blocked') {
    throw Errors.forbidden('计划未通过 dry-run，绝不允许执行', { code: 'DRYRUN_BLOCKED' });
  }
  // dryrun_blocked/draft/rejected 等直接拒绝；executing 放行给 CAS 认领处理
  //（返回 PLAN_EXECUTION_CONFLICT 而非 INVALID_PLAN_STATE，语义更准确）
  if (!['dryrun_passed', 'approved', 'executing'].includes(plan.status)) {
    throw Errors.conflict(`计划状态 ${plan.status} 不允许执行`, { code: 'INVALID_PLAN_STATE' });
  }
  const preStatus = plan.status; // 释放认领时恢复
  // batch4 遗留修复：计划级执行认领 CAS（approved/dryrun_passed → executing）。
  // 两个并发 executePlan 只有一个能认领成功，另一个直接 409，防重复执行整计划。
  if (!(await store.claimPlanForExecution(tenantId, plan.id))) {
    throw Errors.conflict('计划正被并发执行或状态已变更，拒绝重复执行', { code: 'PLAN_EXECUTION_CONFLICT' });
  }
  // R6 复核修复：try 必须紧跟认领成功——认领之后、原 try 之前的 listActions /
  // setIntentStatus 若抛异常，计划会卡死在 executing（原缺口）。finally 释放是幂等的
  //（releasePlanExecution 只在 status='executing' 时生效），早退路径无需重复释放。
  try {
  const actions = await store.listActions(tenantId, planId);
  if (!actions.length) {
    throw Errors.badRequest('计划没有可执行动作', { code: 'NO_ACTIONS' });
  }
  // 纵深：即使计划状态异常，dryrun_blocked 的动作也绝不执行
  const blocked = actions.filter((a) => a.status === 'dryrun_blocked');
  if (blocked.length) {
    throw Errors.forbidden(
      `计划含 ${blocked.length} 个 dry-run 未通过的动作，绝不允许执行`, { code: 'DRYRUN_BLOCKED' });
  }

  const c = ctx();
  await store.setIntentStatus(tenantId, plan.intent_id, 'executing');
  const results = [];
  const succeeded = [];
  let failedAction = null;
  const compensations = [];

  // 认领释放必须走 finally：任何异常都不能让计划卡死在 executing
  for (const a of actions) {
    try {
      const r = await executeAction({ tenantId, projectId, actionId: a.id, actorId });
      results.push({
        action_id: a.id, seq: a.seq, status: r.action.status,
        execution_id: r.execution.id, deduplicated: r.deduplicated,
      });
      if (r.action.status === 'done') {
        succeeded.push(r.action);
      } else {
        failedAction = r.action; // compensated / failed：停止后续
        break;
      }
    } catch (e) {
      // 硬检查失败等异常：动作可能已标 failed（executeAction 内部处理），这里保底
      const cur = await store.getAction(tenantId, a.id);
      if (cur && cur.status === 'executing') {
        await store.updateAction(tenantId, a.id, { status: 'failed' });
      }
      results.push({ action_id: a.id, seq: a.seq, status: 'error', error: e?.code || 'EXECUTE_FAILED' });
      failedAction = await store.getAction(tenantId, a.id);
      break;
    }
  }

  if (failedAction) {
    // 任一失败 → 停止后续 → 已成功动作逆序补偿
    for (const s of [...succeeded].reverse()) {
      const cr = await compensateBusinessAction({
        tenantId, projectId, action: s, actorId,
        reason: `计划 ${planId} 动作 ${failedAction.id} 失败`,
      });
      compensations.push({ action_id: s.id, ...cr });
    }
    // 回到执行前状态：可修复后重试（意图状态机无 failed，approved 即待处理）
    // 计划认领锁由外层 finally 统一释放
    await store.setIntentStatus(tenantId, plan.intent_id, 'approved');
    await tryAudit({
      tenantId, projectId, actorId, traceId: c.traceId,
      action: 'business.plan.execute.failed', resourceKind: 'business_plan', resourceId: planId,
      payload: { failed_action_id: failedAction.id, compensated: compensations.filter((x) => x.compensated).length },
    });
  } else {
    // 成功：意图 done（履约完成）。计划回到执行前状态（approved/dryrun_passed）——这是有意设计：
    // 计划状态描述的是"蓝图生命周期"（草案→dry-run→批准），意图状态描述的是"履约生命周期"
    //（待处理→执行中→done）。计划执行过与否，看意图 done + 动作全 done + 审计事件
    // business.plan.execute.done；动作级幂等键保证重放不重复副作用。
    // 计划认领锁由外层 finally 统一释放。
    await store.setIntentStatus(tenantId, plan.intent_id, 'done');
    await tryAudit({
      tenantId, projectId, actorId, traceId: c.traceId,
      action: 'business.plan.execute.done', resourceKind: 'business_plan', resourceId: planId,
      payload: { actions: results.length },
    });
  }
    return {
      plan: await store.getPlan(tenantId, planId),
      results,
      failed_action_id: failedAction?.id || null,
      compensations,
    };
  } finally {
    // 认领锁必须释放：成功/失败/异常都回到执行前状态
    await store.releasePlanExecution(tenantId, plan.id, preStatus);
  }
}
