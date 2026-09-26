/**
 * modules/business/plan.mjs —— V2.0-A 业务意图与计划（只建模+计划，不触发真实执行）。
 *
 * 流程：createIntent（意图落库，raw_text 脱敏+截断）→ generatePlan（模板匹配 →
 * 槽位抽取 → 可选 LLM 补槽 → 工具解析 → 本体映射/缺口 → 动作落库，幂等键确定性生成）
 * → dryRun（逐动作静态评估：工具存在性、风险分级、本体命中、前置条件四类检查、
 * expected_effect 生成）→ approve/reject（职责分离：审批人不得是意图创建人）。
 *
 * 硬约束：
 * - dry-run 必须能回答"如果执行会发生什么"（目标系统/对象/金额/可逆性/补偿），
 *   任一动作答不清 → dryrun_blocked，绝不静默放行。
 * - 未映射的业务概念走"本体缺口"（candidate 建议），不静默捏造映射。
 * - 动作 args 禁止密钥明文字段（复用 P6 rejectPlaintextSecrets 模式）。
 * - 计划/日志不保存外部系统敏感原文，只存 external_ref 与脱敏摘要。
 *
 * 语义声明（防漂移）：dry-run 是静态评估，不是真实预演；dryrun_passed ≠ 执行一定成功。
 * 真实执行的幂等/审批/补偿语义在 V2.0-B 落实，本阶段只保证"计划可回答、不可执行"。
 */
import { createHash } from 'node:crypto';
import { Errors } from '../../kernel/errors.mjs';
import { ctx } from '../../kernel/context.mjs';
import { nowMs, newId } from '../../kernel/ids.mjs';
import { db } from '../../db/index.mjs';
import { logger } from '../../kernel/logging.mjs';
import * as store from './store.mjs';
import { submitCandidate } from '../ontology/service.mjs';
import { listTerms, normalizeName } from '../ontology/store.mjs';
import { listTools, looksLikeSecretKey } from '../execution/service.mjs';
import { tryAudit } from '../evidence/audit.mjs';

import purchaseRequest from './templates/purchase_request.mjs';
import reimbursement from './templates/reimbursement.mjs';
import stockTransfer from './templates/stock_transfer.mjs';

const TEMPLATES = [purchaseRequest, reimbursement, stockTransfer];

// ---------- raw_text 脱敏 ----------
const RAW_MAX = 4000;
/** 与 P6 scrubText 同形状的密钥打码（业务意图文本可能含"密码：xxx"等写法） */
export function sanitizeRawText(s) {
  let t = String(s || '');
  if (!t.trim()) throw Errors.badRequest('意图文本不能为空');
  if (t.length > RAW_MAX) t = t.slice(0, RAW_MAX) + '…(truncated)';
  return t
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, 'Bearer ***')
    .replace(/\bsk-[A-Za-z0-9]{8,}\b/g, 'sk-***')
    .replace(/((?:api[_-]?key|token|secret|password|密码)\s*[:=：]\s*)['"]?[^\s'",}，；;]+/gi, '$1***');
}

// ---------- args 密钥铁律（复用 P6 rejectPlaintextSecrets 模式） ----------
function assertNoPlaintextSecretsInArgs(obj, path = 'args') {
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => assertNoPlaintextSecretsInArgs(v, `${path}[${i}]`));
    return;
  }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (looksLikeSecretKey(k) && typeof v === 'string' && v && v !== '***') {
        throw Errors.badRequest(`动作参数禁止携带密钥明文字段: ${path}.${k}`, { code: 'SECRET_IN_ARGS' });
      }
      assertNoPlaintextSecretsInArgs(v, `${path}.${k}`);
    }
  }
}

// ---------- 模板匹配与槽位抽取 ----------
function matchTemplate(rawText) {
  const scored = TEMPLATES
    .map((t) => ({ t, hits: t.keywords.filter((k) => rawText.includes(k)).length }))
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  return scored[0]?.t || null;
}

function coerceSlotValue(slot, raw) {
  if (raw == null) return null;
  if (slot.type === 'number') {
    const n = Number(String(raw).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  const s = String(raw).trim().slice(0, 200);
  return s || null;
}

/** 金额抽取：支持"5000元 / 5万元"写法，统一换算为元 */
function extractAmount(rawText) {
  const m = /(\d+(?:\.\d+)?)\s*(万)?\s*元/.exec(rawText);
  if (!m) return null;
  return Number(m[1]) * (m[2] ? 10000 : 1);
}

function extractSlots(template, rawText) {
  const slots = {};
  for (const slot of template.slots) {
    let v = null;
    if (slot.name === 'amount') {
      v = extractAmount(rawText);
    } else if (slot.extract) {
      const m = slot.extract.exec(rawText);
      if (m) v = coerceSlotValue(slot, m[1]);
    }
    slots[slot.name] = v;
  }
  return slots;
}

function missingRequired(template, slots) {
  return template.slots.filter((s) => s.required && (slots[s.name] == null || slots[s.name] === ''));
}

// ---------- 可选 LLM 槽位增强（走 P3 网关；失败一律回落模板） ----------
const LLM_SYS = `你是业务意图槽位抽取器。只输出一个 JSON 对象，键必须限定在用户消息给出的槽位名集合内，值类型按标注（string/number）。
规则：绝不输出动作、工具、目标系统或多余键；无法确定的槽位置 null；不要解释。`;

function buildLlmPrompt(template, rawText) {
  const schema = template.slots.map((s) => `  "${s.name}": ${s.type}  // ${s.label}${s.required ? '（必填）' : ''}`).join('\n');
  // 用户意图用显式分隔符包裹：指令与数据分离，防模板/提示注入
  return `槽位 schema（只允许这些键）：\n{\n${schema}\n}\n<<<USER_INTENT>>>\n${rawText.slice(0, 2000)}\n<<<END_USER_INTENT>>>\n只输出 JSON 对象：`;
}

function extractJsonObject(text) {
  const m = /{[\s\S]*}/.exec(String(text || ''));
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/** LLM 补槽：只填模板正则没抽到的槽位；任何异常 → null（回落模板正则结果） */
async function tryLlmSlots(template, rawText, baseSlots, { projectId }) {
  const missing = template.slots.filter((s) => baseSlots[s.name] == null);
  if (!missing.length) return baseSlots;
  try {
    const { chatInternal } = await import('../gateway/routes.mjs');
    const { text } = await chatInternal({
      model: 'deyi-default',
      messages: [
        { role: 'system', content: LLM_SYS },
        { role: 'user', content: buildLlmPrompt(template, rawText) },
      ],
      project: { id: projectId },
      dataClass: 'internal',
      maxTokens: 512,
    });
    const parsed = extractJsonObject(text);
    if (!parsed || typeof parsed !== 'object') return baseSlots;
    const merged = { ...baseSlots };
    for (const s of missing) {
      if (!(s.name in parsed)) continue;
      const v = coerceSlotValue(s, parsed[s.name]);
      if (v != null) merged[s.name] = v; // 未知键一律丢弃，不进入槽位
    }
    logger.info('business llm slot fill', { template: template.id, filled: missing.filter((s) => merged[s.name] != null).map((s) => s.name) });
    return merged;
  } catch (e) {
    // 模型不可用/超时/预算/解析失败：记录并回落，绝不因增强失败而整体失败
    logger.warn('business llm enhance fallback', { template: template.id, err: String(e?.message || e).slice(0, 160) });
    return baseSlots;
  }
}

// ---------- 本体映射 / 缺口 ----------
/**
 * 把模板声明的业务概念映射到已发布本体术语（按名称归一化匹配）。
 * 未命中 → 生成 ontology candidate 建议（状态 candidate），记入 gaps，不静默捏造。
 * @returns { termIds: string[], gaps: [{concept, candidate_term_id}] }
 */
async function resolveOntologyTerms({ tenantId, projectId, actorId }, terms, actionSeq) {
  const published = await listTerms(tenantId, projectId, { status: 'published' });
  const byNorm = new Map(published.map((t) => [normalizeName(t.name), t]));
  // 去重：同名 candidate/in_review 已存在则复用，不重复建议
  const pending = await listTerms(tenantId, projectId);
  const pendingByNorm = new Map(
    pending.filter((t) => t.status === 'candidate' || t.status === 'in_review')
      .map((t) => [normalizeName(t.name), t]));
  const termIds = [];
  const gaps = [];
  for (const term of terms || []) {
    const norm = normalizeName(term.name);
    const hit = byNorm.get(norm);
    if (hit) { termIds.push(hit.id); continue; }
    const reuse = pendingByNorm.get(norm);
    if (reuse) {
      gaps.push({ concept: term.name, candidate_term_id: reuse.id, action_seq: actionSeq, reused: true });
      continue;
    }
    // 本体缺口：走 P5 candidate 接口，状态 candidate，等待评审
    try {
      const { term: cand } = await submitCandidate({
        tenantId, projectId, name: term.name, kind: term.kind || 'concept',
        definition: term.definition || `业务计划自动建议：${term.name}`,
        evidence: [`business_plan:auto-suggest`], actorId,
      });
      gaps.push({ concept: term.name, candidate_term_id: cand.id, action_seq: actionSeq });
      logger.info('business ontology gap', { concept: term.name, candidate: cand.id });
    } catch (e) {
      // 缺口建议失败也不阻断计划生成本身（dry-run 会据此阻断）
      logger.warn('business ontology gap suggest failed', { concept: term.name, err: String(e?.message || e).slice(0, 160) });
      gaps.push({ concept: term.name, candidate_term_id: null, action_seq: actionSeq });
    }
  }
  return { termIds, gaps };
}

// ---------- 工具解析 ----------
async function resolveTool(tenantId, toolName) {
  const tools = await listTools(tenantId).catch(() => []);
  const hit = tools.find((t) => t.name === toolName);
  return hit || null;
}

// ---------- 幂等键：计划时生成，执行时沿用（确定性） ----------
function idempotencyKeyFor(planId, seq) {
  return createHash('sha256').update(`${planId}:${seq}`).digest('hex').slice(0, 32);
}

// ---------- 意图 ----------
export async function createIntent({ tenantId, projectId, rawText, actorId }) {
  const clean = sanitizeRawText(rawText);
  const intent = await store.createIntent({ tenantId, projectId, rawText: clean, createdBy: actorId });
  const c = ctx();
  await tryAudit({
    tenantId, projectId, actorId, traceId: c.traceId,
    action: 'business.intent.create', resourceKind: 'business_intent', resourceId: intent.id,
    payload: { status: intent.status },
  });
  return intent;
}

// ---------- 计划生成 ----------
export async function generatePlan({ tenantId, projectId, intentId, actorId }) {
  const intent = await store.getIntent(tenantId, intentId);
  if (!intent) throw Errors.notFound('业务意图不存在');
  if (intent.project_id !== projectId) throw Errors.forbidden('意图不属于该项目');
  if (!['draft', 'rejected'].includes(intent.status)) {
    throw Errors.badRequest(`意图当前状态 ${intent.status} 不允许重新生成计划`, { code: 'INVALID_INTENT_STATE' });
  }

  const template = matchTemplate(intent.raw_text);
  if (!template) {
    throw Errors.badRequest('意图未命中任何业务场景模板（当前支持：采购申请/报销/库存调拨）', { code: 'NO_TEMPLATE_MATCH' });
  }

  // 1) 槽位抽取（正则，确定性）→ 2) LLM 可选补槽（失败回落）
  let slots = extractSlots(template, intent.raw_text);
  slots = await tryLlmSlots(template, intent.raw_text, slots, { projectId });

  const missing = missingRequired(template, slots);
  if (missing.length) {
    throw Errors.badRequest(
      `意图缺少必填槽位: ${missing.map((s) => s.label).join('、')}（模板：${template.name}）`,
      { code: 'MISSING_SLOTS', missing: missing.map((s) => s.name) });
  }

  const plan = await store.createPlan({ tenantId, projectId, intentId: intent.id, createdBy: actorId });
  const allGaps = [];
  let seq = 0;
  for (const a of template.actions) {
    seq += 1;
    const args = a.args(slots);
    assertNoPlaintextSecretsInArgs(args); // 密钥铁律：模板装配出的参数同样要过检
    const tool = await resolveTool(tenantId, a.tool); // 未注册 → tool_ref=null，dry-run 阻断
    const { termIds, gaps } = await resolveOntologyTerms({ tenantId, projectId, actorId }, a.ontologyTerms, seq);
    allGaps.push(...gaps);
    const effect = a.effect(slots);
    await store.createAction({
      tenantId, projectId, planId: plan.id, seq,
      toolRef: tool ? tool.id : null, toolName: a.tool, args,
      idempotencyKey: idempotencyKeyFor(plan.id, seq),
      ontologyTermIds: termIds,
      preconditions: a.preconditions.map((p) => ({ ...p, passed: null })),
      expectedEffect: {
        ...effect,
        approval_required: a.risk === 'high',
        template_risk: a.risk || 'low',
      },
    });
  }
  await store.updatePlan(tenantId, plan.id, { ontology_gaps: allGaps, dryrun_report: { template: template.id } });
  await store.setIntentStatus(tenantId, intent.id, 'planned');

  const c = ctx();
  await tryAudit({
    tenantId, projectId, actorId, traceId: c.traceId,
    action: 'business.plan.generate', resourceKind: 'business_plan', resourceId: plan.id,
    payload: { intent_id: intent.id, template: template.id, actions: seq, ontology_gaps: allGaps.length },
  });
  return { plan: await store.getPlan(tenantId, plan.id), template: template.id, actions: await store.listActions(tenantId, plan.id) };
}

// ---------- dry-run 四类前置检查器 ----------
const RISK_RANK = { low: 0, medium: 1, high: 2 };

function checkPreconditions(template, actionDef, args) {
  const results = [];
  const fail = (kind, detail) => results.push({ kind, detail, passed: false });
  const pass = (kind, detail) => results.push({ kind, detail, passed: true });

  const amountCents = Number(args.amount_cents);
  if (template.maxAmountCents != null && Number.isFinite(amountCents)) {
    if (amountCents > template.maxAmountCents) fail('amount', `金额 ${amountCents / 100} 元超过模板上限 ${template.maxAmountCents / 100} 元`);
    else pass('amount', `金额 ${amountCents / 100} 元在模板上限内`);
  }
  const quantity = Number(args.quantity);
  if (template.maxQuantity != null && Number.isFinite(quantity)) {
    if (quantity > template.maxQuantity) fail('quantity', `数量 ${quantity} 超过模板上限 ${template.maxQuantity}`);
    else pass('quantity', `数量 ${quantity} 在模板上限内`);
  }
  const target = actionDef.target_system;
  if (!(template.allowedTargets || []).includes(target)) fail('target', `目标系统 ${target} 不在允许清单内`);
  else pass('target', `目标系统 ${target} 在允许清单内`);
  // 对象边界：库存调拨的仓库清单 + 调出≠调入
  if (template.allowedWarehouses) {
    const { from_warehouse: f, to_warehouse: t } = args;
    if (!template.allowedWarehouses.includes(f) || !template.allowedWarehouses.includes(t)) {
      fail('object', `仓库 ${f}→${t} 不在已知清单内`);
    } else if (f === t) fail('object', '调出与调入仓库不能相同');
    else pass('object', `仓库对象边界合法（${f}→${t}）`);
  }
  // 职责分离：声明的字段对取值不能相同（且审批人不能为空时才有意义）
  for (const p of actionDef.preconditions.filter((x) => x.kind === 'sod')) {
    const [f1, f2] = p.fields || [];
    const v1 = args[f1]; const v2 = args[f2];
    if (v1 && v2 && String(v1).trim() === String(v2).trim()) fail('sod', `${f1} 与 ${f2} 为同一人，违反职责分离`);
    else pass('sod', p.detail);
  }
  return results;
}

// ---------- dry-run ----------
/**
 * 逐动作静态评估，回答"如果执行会发生什么"。
 * 任一动作失败 → 动作 dryrun_blocked + 计划 dryrun_blocked，并如实返回原因。
 */
export async function dryRun({ tenantId, projectId, planId, actorId }) {
  const plan = await store.getPlan(tenantId, planId);
  if (!plan) throw Errors.notFound('业务计划不存在');
  if (plan.project_id !== projectId) throw Errors.forbidden('计划不属于该项目');
  if (!['draft', 'dryrun_blocked'].includes(plan.status)) {
    throw Errors.badRequest(`计划当前状态 ${plan.status} 不允许 dry-run`, { code: 'INVALID_PLAN_STATE' });
  }

  const template = TEMPLATES.find((t) => plan.dryrun_report?.template === t.id)
    || matchTemplate((await store.getIntent(tenantId, plan.intent_id))?.raw_text || '');
  const actions = await store.listActions(tenantId, planId);
  const gapsBySeq = new Map();
  for (const g of plan.ontology_gaps || []) {
    if (!gapsBySeq.has(g.action_seq)) gapsBySeq.set(g.action_seq, []);
    gapsBySeq.get(g.action_seq).push(g);
  }

  const report = { actions: [], blocked: 0, template: template?.id || null };
  let totalAmount = 0;
  let maxRisk = 'low';
  let approvalRequired = false;
  const impactScope = new Set();
  let allReversible = true;

  let ai = 0;
  for (const action of actions) {
    ai += 1;
    const actionDef = template?.actions?.[ai - 1];
    const reasons = [];
    const checks = [];

    // 1) 工具存在性
    const tool = action.tool_ref ? await resolveTool(tenantId, action.tool_name) : null;
    if (!tool) {
      reasons.push(`工具未注册: ${action.tool_name}（需先在执行平面注册 MCP/HTTP 工具）`);
      checks.push({ kind: 'tool', passed: false, detail: `工具 ${action.tool_name} 不存在` });
    } else {
      checks.push({ kind: 'tool', passed: true, detail: `工具 ${action.tool_name} 已注册（风险 ${tool.risk_level}）` });
    }

    // 2) 风险分级：模板风险与工具注册风险取高；high → 需审批（V1.0-B 审批语义）
    const eff = action.expected_effect || {};
    const effRisk = RISK_RANK[eff.template_risk] >= RISK_RANK[tool?.risk_level || 'low']
      ? (eff.template_risk || 'low') : (tool?.risk_level || 'low');
    if (RISK_RANK[effRisk] > RISK_RANK[maxRisk]) maxRisk = effRisk;
    const needApproval = effRisk === 'high';
    if (needApproval) approvalRequired = true;

    // 3) 本体映射：该动作声明的概念必须全部命中已发布术语
    const declared = actionDef?.ontologyTerms?.length || 0;
    const gaps = gapsBySeq.get(action.seq) || [];
    if (declared > 0 && gaps.length > 0) {
      reasons.push(`本体映射缺口: ${gaps.map((g) => g.concept).join('、')} 尚未发布（已生成 candidate 建议）`);
      checks.push({ kind: 'ontology', passed: false, detail: `缺口 ${gaps.length} 个概念` });
    } else if (declared > 0) {
      checks.push({ kind: 'ontology', passed: true, detail: `${action.ontology_term_ids.length} 个概念命中已发布术语` });
    }

    // 4) 前置条件（金额/数量/对象边界/职责分离）
    let preconds = [];
    if (actionDef && template) {
      preconds = checkPreconditions(
        template,
        { target_system: (action.expected_effect || {}).target_system, preconditions: actionDef.preconditions },
        action.args);
      for (const p of preconds) {
        if (!p.passed) reasons.push(`前置条件不满足 [${p.kind}]: ${p.detail}`);
      }
    }

    // expected_effect 完整性：答不清"会发生什么"就不许过
    const effectComplete = eff.target_system && Array.isArray(eff.objects) && eff.objects.length > 0
      && typeof eff.reversible === 'boolean';
    if (!effectComplete) {
      reasons.push('expected_effect 不完整：无法回答执行影响（目标系统/对象/可逆性缺失）');
    }

    const ok = reasons.length === 0;
    const finalEffect = {
      ...eff,
      approval_required: needApproval,
      compensation_available: tool ? Boolean(eff.compensation_tool) : false,
    };
    if (typeof finalEffect.amount_cents === 'number') totalAmount += finalEffect.amount_cents;
    if (finalEffect.target_system) impactScope.add(finalEffect.target_system);
    if (finalEffect.reversible === false) allReversible = false;

    await store.updateAction(tenantId, action.id, {
      status: ok ? 'dryrun_ok' : 'dryrun_blocked',
      expected_effect: finalEffect,
      dryrun_reasons: reasons,
      preconditions: preconds,
    });
    report.actions.push({ action_id: action.id, seq: action.seq, ok, reasons, checks, expected_effect: finalEffect });
    if (!ok) report.blocked += 1;
  }

  const riskEstimate = {
    actions: actions.length,
    total_amount_cents: totalAmount,
    max_risk: maxRisk,
    approval_required: approvalRequired,
    reversible_all: allReversible,
    impact_scope: [...impactScope],
  };
  const planStatus = report.blocked > 0 ? 'dryrun_blocked' : 'dryrun_passed';
  await store.updatePlan(tenantId, planId, {
    status: planStatus, risk_estimate: riskEstimate, dryrun_report: report,
  });

  const c = ctx();
  await tryAudit({
    tenantId, projectId, actorId, traceId: c.traceId,
    action: 'business.plan.dryrun', resourceKind: 'business_plan', resourceId: planId,
    payload: { status: planStatus, blocked: report.blocked, risk_estimate: riskEstimate },
  });
  return { plan: await store.getPlan(tenantId, planId), report };
}

// ---------- 审批 ----------
export async function approvePlan({ tenantId, projectId, planId, actorId }) {
  const plan = await store.getPlan(tenantId, planId);
  if (!plan) throw Errors.notFound('业务计划不存在');
  if (plan.project_id !== projectId) throw Errors.forbidden('计划不属于该项目');
  if (plan.status !== 'dryrun_passed') {
    throw Errors.badRequest(`计划未通过 dry-run（当前 ${plan.status}），不允许批准`, { code: 'DRYRUN_REQUIRED' });
  }
  const intent = await store.getIntent(tenantId, plan.intent_id);
  // 职责分离：审批人不得是意图创建人
  if (intent && intent.created_by && intent.created_by === actorId) {
    throw Errors.forbidden('审批人与意图创建人必须职责分离', { code: 'SOD_VIOLATION' });
  }
  // M-4 业务 review：批准是多表写（计划+审批记录+动作+意图），必须同一事务 + CAS，
  // 防"计划已 approved 但审批记录/动作状态没写上"的不一致，以及并发双重批准。
  const now = nowMs();
  await db().transaction(async (tx) => {
    const upd = await tx.run(
      `UPDATE business_plans SET status='approved', updated_at=? WHERE id=? AND tenant_id=? AND status='dryrun_passed'`,
      [now, planId, tenantId]);
    if (upd.changes === 0) throw Errors.conflict('计划已被并发处理（非 dryrun_passed 状态）');
    await tx.run(
      `INSERT INTO plan_approvals(id,plan_id,tenant_id,approver_id,decided_at,created_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(plan_id) DO UPDATE SET approver_id=excluded.approver_id,
         decided_at=excluded.decided_at, created_at=excluded.created_at, id=excluded.id`,
      [newId('bpar'), planId, tenantId, actorId, now, now]);
    await tx.run(
      `UPDATE business_actions SET status='approved', updated_at=? WHERE plan_id=? AND tenant_id=? AND status='dryrun_ok'`,
      [now, planId, tenantId]);
    await tx.run(
      `UPDATE business_intents SET status='approved', updated_at=? WHERE id=? AND tenant_id=?`,
      [now, plan.intent_id, tenantId]);
  });
  const c = ctx();
  await tryAudit({
    tenantId, projectId, actorId, traceId: c.traceId,
    action: 'business.plan.approve', resourceKind: 'business_plan', resourceId: planId, payload: {},
  });
  return store.getPlan(tenantId, planId);
}

export async function rejectPlan({ tenantId, projectId, planId, actorId, reason }) {
  const plan = await store.getPlan(tenantId, planId);
  if (!plan) throw Errors.notFound('业务计划不存在');
  if (plan.project_id !== projectId) throw Errors.forbidden('计划不属于该项目');
  if (!['draft', 'dryrun_passed', 'dryrun_blocked'].includes(plan.status)) {
    throw Errors.badRequest(`计划当前状态 ${plan.status} 不允许驳回`, { code: 'INVALID_PLAN_STATE' });
  }
  // M-4：驳回同样 CAS + 事务（计划+意图两表），防并发双重决议
  const now = nowMs();
  await db().transaction(async (tx) => {
    const upd = await tx.run(
      `UPDATE business_plans SET status='rejected', updated_at=?
       WHERE id=? AND tenant_id=? AND status IN ('draft','dryrun_passed','dryrun_blocked')`,
      [now, planId, tenantId]);
    if (upd.changes === 0) throw Errors.conflict('计划已被并发处理');
    await tx.run(
      `UPDATE business_intents SET status='rejected', updated_at=? WHERE id=? AND tenant_id=?`,
      [now, plan.intent_id, tenantId]);
  });
  const c = ctx();
  await tryAudit({
    tenantId, projectId, actorId, traceId: c.traceId,
    action: 'business.plan.reject', resourceKind: 'business_plan', resourceId: planId,
    payload: { reason: String(reason || '').slice(0, 500) },
  });
  return store.getPlan(tenantId, planId);
}

/**
 * H-3 业务 review：失败计划的恢复路径。
 * executePlan 失败后计划停在 approved、失败动作卡在 failed/compensated（executeAction
 * 不接受这些状态），原来没有任何 API 能把它救回来，只能废弃重建。
 * resetPlan：把失败/补偿/执行中的动作重置为 approved + 新幂等键（旧键已关联失败记录，
 * 复用会导致"重复执行直接返回旧失败结果"），意图回到 approved，随后可重新 executePlan。
 */
export async function resetPlan({ tenantId, projectId, planId, actorId }) {
  const plan = await store.getPlan(tenantId, planId);
  if (!plan) throw Errors.notFound('业务计划不存在');
  if (plan.project_id !== projectId) throw Errors.forbidden('计划不属于该项目');
  if (!['dryrun_passed', 'approved'].includes(plan.status)) {
    throw Errors.badRequest(`计划当前状态 ${plan.status} 不允许重置（仅 dryrun_passed/approved 可重置）`,
      { code: 'INVALID_PLAN_STATE' });
  }
  const actions = await store.listActions(tenantId, planId);
  const retryable = actions.filter((a) => ['failed', 'compensated', 'executing'].includes(a.status));
  if (!retryable.length) {
    throw Errors.badRequest('没有可重置的失败动作', { code: 'NOTHING_TO_RESET' });
  }
  const reset = [];
  for (const a of retryable) {
    const n = await store.countActionExecutions(tenantId, a.id);
    const newKey = createHash('sha256').update(`${planId}:${a.seq}:retry:${n + 1}`).digest('hex').slice(0, 32);
    const ra = await store.resetActionForRetry(tenantId, a.id, newKey);
    reset.push({ action_id: a.id, seq: a.seq, idempotency_key: newKey, status: ra.status });
  }
  await store.setIntentStatus(tenantId, plan.intent_id, 'approved');
  const c = ctx();
  await tryAudit({
    tenantId, projectId, actorId, traceId: c.traceId,
    action: 'business.plan.reset', resourceKind: 'business_plan', resourceId: planId,
    payload: { reset_actions: reset.map((r) => r.action_id) },
  });
  return { plan: await store.getPlan(tenantId, planId), reset };
}

export { TEMPLATES };
export const __internal = { sanitizeRawText, matchTemplate, extractSlots, idempotencyKeyFor, assertNoPlaintextSecretsInArgs };
