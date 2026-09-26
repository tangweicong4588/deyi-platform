/**
 * modules/business/verify.mjs —— V2.0-C 执行后验证（read-back）。
 *
 * 方案依据（实现方案 p24 V2.0 执行阶段）：关键写入后**主动读取**外部系统当前
 * 状态进行验证；不一致进入对账队列；不可自动判断则人工处理。
 *
 * 验证手段：用**只读工具** read-back 外部系统当前状态，与动作的
 * `expected_effect.verify` 声明比对。事件消费（webhook/轮询）是扩展点，
 * 本阶段不做：verifyExecution 预留了 `consumeExternalEvent` 入口，
 * 事件驱动时可复用同一套规则评估（见文件尾注释）。
 *
 * 验证声明（expected_effect.verify）：
 *   {
 *     tool: 'biz.payment.query',        // 只读工具名（必需；未声明→unverifiable）
 *     action: 'read',                   // 工具 action（默认 'read'）
 *     args: { order_no: '$external_ref' }, // 占位符：$external_ref / $effect.x / $args.x
 *     rules: [                          // 比对规则（至少一条；缺字段/未知 op→unverifiable）
 *       { field: 'amount_cents', op: 'eq', expected: '$effect.amount_cents' },
 *       { field: 'status', op: 'eq', expected: 'completed' },
 *     ]
 *   }
 *
 * 结论（verify_status，执行 status 原样保留——验证失败≠执行失败）：
 * - verified：全部规则通过。
 * - mismatched：任一规则明确失败 → 自动建 brec_ 对账项（source=verify）。
 * - unverifiable：无验证声明 / 只读工具不可用 / read-back 多次失败 / 规则覆盖不到
 *   → 同样进人工队列（reason 注明原因），绝不静默"通过"。
 *
 * 最终一致性窗口（如实标注）：执行后外部系统可能尚未最终一致。read-back 对
 * transient 结果（抛错/超时，或返回 status∈{pending,processing,not_found,error}）
 * 按 BUSINESS_VERIFY_ATTEMPTS（默认 3）/ BUSINESS_VERIFY_RETRY_DELAY_MS（默认
 * 1500ms）重试；耗尽仍无定论 → unverifiable 进人工队列。重试只针对"无定论"，
 * 规则明确失败（mismatched）不重试——那是真差异，不是传播延迟。
 */
import { nowMs } from '../../kernel/ids.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { ctx } from '../../kernel/context.mjs';
import { config } from '../../kernel/config.mjs';
import { logger } from '../../kernel/logging.mjs';
import * as store from './store.mjs';
import {
  listTools, executeOne, redactArgs, scrubText, looksLikeSecretKey,
} from '../execution/service.mjs';
import { tryAudit } from '../evidence/audit.mjs';

/** read-back 视为"无定论"的外部状态（传播延迟中），触发重试；规则明确失败不重试 */
const TRANSIENT_READBACK_STATUS = new Set(['pending', 'processing', 'not_found', 'error']);

function attempts() {
  const n = Number(config.BUSINESS_VERIFY_ATTEMPTS);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 10) : 3;
}
function retryDelayMs() {
  const n = Number(config.BUSINESS_VERIFY_RETRY_DELAY_MS);
  return Number.isFinite(n) && n >= 0 ? n : 1500;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 占位符解析 ----------
function getPath(obj, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function resolveValue(v, sub) {
  if (typeof v === 'string') {
    if (v === '$external_ref') return sub.externalRef;
    if (v.startsWith('$effect.')) return getPath(sub.effect, v.slice('$effect.'.length));
    if (v.startsWith('$args.')) return getPath(sub.args, v.slice('$args.'.length));
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => resolveValue(x, sub));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = resolveValue(x, sub);
    return out;
  }
  return v;
}

// ---------- 规则评估 ----------
const NUM = (x) => {
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x);
  return null;
};
function deepEq(a, b) {
  const na = NUM(a); const nb = NUM(b);
  if (na !== null && nb !== null) return na === nb; // 金额/数量：精确数值比对
  if (na !== null || nb !== null) return false;     // 一边是数另一边不是→不等（不做宽松猜测）
  if (a && typeof a === 'object' && b && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

const RULE_OPS = new Set(['eq', 'neq', 'in', 'not_in', 'gte', 'lte', 'abs_diff_lte', 'exists', 'contains']);

function evalRule(rule, readback, sub) {
  const op = rule?.op;
  if (!RULE_OPS.has(op)) {
    return { field: rule?.field, op, passed: false, uncoverable: true, detail: `未知规则操作: ${op}` };
  }
  const actual = getPath(readback, rule.field);
  if (actual === undefined && op !== 'exists') {
    return { field: rule.field, op, passed: false, uncoverable: true, detail: `read-back 缺少字段: ${rule.field}` };
  }
  const expected = resolveValue(rule.expected, sub);
  let passed = false;
  let detail = '';
  switch (op) {
    case 'eq': passed = deepEq(actual, expected); detail = `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`; break;
    case 'neq': passed = !deepEq(actual, expected); detail = `要求不等 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`; break;
    case 'in': passed = Array.isArray(expected) && expected.some((e) => deepEq(actual, e)); detail = `期望 ∈ ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`; break;
    case 'not_in': passed = Array.isArray(expected) && !expected.some((e) => deepEq(actual, e)); detail = `要求 ∉ ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`; break;
    case 'gte': { const a = NUM(actual); const e = NUM(expected); passed = a !== null && e !== null && a >= e; detail = `要求 ≥ ${expected}，实际 ${JSON.stringify(actual)}`; break; }
    case 'lte': { const a = NUM(actual); const e = NUM(expected); passed = a !== null && e !== null && a <= e; detail = `要求 ≤ ${expected}，实际 ${JSON.stringify(actual)}`; break; }
    case 'abs_diff_lte': {
      // 差异阈值：如金额差异>0 即 mismatch（expected 为阈值，通常 0）
      const a = NUM(actual); const e = NUM(expected); const t = NUM(rule.threshold ?? 0);
      passed = a !== null && e !== null && t !== null && Math.abs(a - e) <= t;
      detail = `|${a}-${e}| ≤ ${t} ? 实际差 ${a !== null && e !== null ? Math.abs(a - e) : 'N/A'}`;
      break;
    }
    case 'exists': passed = actual !== undefined && actual !== null; detail = `字段存在性: ${rule.field}`; break;
    case 'contains': {
      if (typeof actual === 'string') passed = actual.includes(String(expected));
      else if (Array.isArray(actual)) passed = actual.some((x) => deepEq(x, expected));
      else passed = false;
      detail = `要求包含 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`;
      break;
    }
    default: return { field: rule.field, op, passed: false, uncoverable: true, detail: `未知规则操作: ${op}` };
  }
  return { field: rule.field, op, passed, uncoverable: false, detail };
}

// ---------- 只读工具解析 ----------
async function resolveVerifyTool(tenantId, name) {
  const tools = await listTools(tenantId).catch(() => []);
  return tools.find((t) => t.name === name) || null;
}

function assertNoSecretVerifyArgs(args) {
  const bad = [];
  const walk = (v, path) => {
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (looksLikeSecretKey(k)) bad.push(path ? `${path}.${k}` : k);
        walk(x, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(args, '');
  if (bad.length) throw Errors.badRequest(`验证参数含疑似密钥字段: ${bad.join(', ')}`, { code: 'SECRET_IN_VERIFY_ARGS' });
}

// ---------- 对账入队（去重：同一执行的未关闭项只保留一条） ----------
async function ensureRecon({ tenantId, projectId, actionId, executionId, reason, actorId }) {
  const existing = await store.getOpenReconciliationByExecution(tenantId, executionId);
  if (existing) {
    logger.info('verify recon deduplicated', { execution: executionId, recon: existing.id });
    return { recon: existing, created: false };
  }
  const recon = await store.insertReconciliation({
    tenantId, projectId, actionId, executionId,
    reason: scrubText(reason).slice(0, 1000), source: 'verify',
  });
  const c = ctx();
  await tryAudit({
    tenantId, projectId, actorId, traceId: c.traceId,
    action: 'business.reconciliation.create', resourceKind: 'reconciliation_item', resourceId: recon.id,
    payload: { execution_id: executionId, action_id: actionId, source: 'verify' },
  });
  return { recon, created: true };
}

// ---------- 主入口 ----------
export async function verifyExecution({ tenantId, projectId, executionId, actorId }) {
  const bxn = await store.getBusinessExecution(tenantId, executionId);
  if (!bxn || bxn.project_id !== projectId) throw Errors.notFound('执行记录不存在');
  const action = await store.getAction(tenantId, bxn.action_id);
  if (!action) throw Errors.notFound('业务动作不存在');
  const c = ctx();
  const sub = { externalRef: bxn.external_ref, effect: action.expected_effect || {}, args: action.args || {} };

  const finish = async (verdict, result) => {
    const verifyResult = {
      verdict, checked_at: nowMs(), tool: result.tool || null,
      attempts: result.attempts || 0,
      rules: result.rules || [],
      readback: result.readback || null,
      reason: result.reason || null,
      recon_id: result.reconId || null,
    };
    const updated = await store.updateBusinessExecution(tenantId, bxn.id, {
      verify_status: verdict, verify_result: JSON.stringify(verifyResult), verified_at: nowMs(),
    });
    await tryAudit({
      tenantId, projectId, actorId, traceId: c.traceId,
      action: 'business.execution.verify', resourceKind: 'action_execution', resourceId: bxn.id,
      payload: { verdict, recon_id: result.reconId || null },
    });
    return { execution: updated, verdict, rules: result.rules || [], reconId: result.reconId || null };
  };

  // 只有执行成功的才值得验证；失败/补偿的已有对账路径，不新增
  if (bxn.status !== 'succeeded') {
    return finish('unverifiable', { reason: `执行状态为 ${bxn.status}，无需 read-back 验证` });
  }

  const spec = action.expected_effect?.verify;
  const noTool = async (why) => finish('unverifiable', {
    reason: why,
    ...(await ensureRecon({ tenantId, projectId, actionId: action.id, executionId: bxn.id, reason: why, actorId })
      .then((r) => ({ reconId: r.recon.id }))),
  });

  // 1) 无验证声明 → 人工队列（绝不静默通过）
  if (!spec || typeof spec !== 'object' || !spec.tool) {
    return noTool('未声明验证方式（expected_effect.verify 缺失），转人工核查');
  }
  // 2) 只读工具不可用 → 人工队列
  const tool = await resolveVerifyTool(tenantId, spec.tool);
  if (!tool || tool.status !== 'active') {
    return noTool(`验证工具 ${spec.tool} 未注册或已停用，转人工核查`);
  }
  // 3) fail-closed：高风险工具不许当只读验证通道（可能有副作用）
  if (tool.risk_level === 'high') {
    return noTool(`验证工具 ${spec.tool} 风险等级为 high，拒绝作为只读验证通道（fail-closed），转人工核查`);
  }
  // 4) 验证参数密钥拦截（配置错误 fail fast）
  let verifyArgs;
  try {
    verifyArgs = resolveValue(spec.args || {}, sub);
    assertNoSecretVerifyArgs(verifyArgs);
  } catch (e) {
    return noTool(`验证参数非法: ${e.message}`);
  }
  const rules = Array.isArray(spec.rules) ? spec.rules : [];
  if (!rules.length) {
    return noTool('验证声明缺少比对规则（rules 为空），无法自动判断，转人工核查');
  }

  // 5) read-back（transient 结果重试；规则明确失败不重试）
  const toolAction = spec.action || 'read';
  const timeoutMs = Number(config.MCP_TIMEOUT_MS) || 30000;
  let readback = null;
  let readErr = null;
  let n = 0;
  for (; n < attempts(); n += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      readback = await executeOne({ tool, action: toolAction, args: verifyArgs, timeoutMs });
      readErr = null;
      const rs = readback && typeof readback === 'object' ? readback.status : undefined;
      if (typeof rs === 'string' && TRANSIENT_READBACK_STATUS.has(rs)) {
        readErr = new Error(`read-back 返回暂态状态: ${rs}`);
        readback = null;
      } else {
        break;
      }
    } catch (e) {
      readErr = e;
      readback = null;
    }
    if (n + 1 < attempts() && retryDelayMs() > 0) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(retryDelayMs());
    }
  }
  if (!readback) {
    const why = `read-back ${n} 次未获定论（${scrubText(readErr?.message || '未知错误').slice(0, 300)}），转人工核查`;
    return finish('unverifiable', {
      reason: why, tool: spec.tool, attempts: n,
      ...(await ensureRecon({ tenantId, projectId, actionId: action.id, executionId: bxn.id, reason: why, actorId })
        .then((r) => ({ reconId: r.recon.id }))),
    });
  }

  // 6) 规则评估
  const evaluated = rules.map((r) => evalRule(r, readback, sub));
  const redactedReadback = JSON.parse(JSON.stringify(redactArgs(readback)));
  const uncoverable = evaluated.filter((r) => r.uncoverable);
  if (uncoverable.length) {
    const why = `比对规则覆盖不到（${uncoverable.map((r) => r.detail).join('；').slice(0, 400)}），转人工核查`;
    return finish('unverifiable', {
      reason: why, tool: spec.tool, attempts: n + 1, rules: evaluated, readback: redactedReadback,
      ...(await ensureRecon({ tenantId, projectId, actionId: action.id, executionId: bxn.id, reason: why, actorId })
        .then((r) => ({ reconId: r.recon.id }))),
    });
  }
  const failed = evaluated.filter((r) => !r.passed);
  if (failed.length) {
    const why = `read-back 与预期不一致: ${failed.map((r) => `${r.field}: ${r.detail}`).join('；').slice(0, 500)}`;
    return finish('mismatched', {
      reason: why, tool: spec.tool, attempts: n + 1, rules: evaluated, readback: redactedReadback,
      ...(await ensureRecon({ tenantId, projectId, actionId: action.id, executionId: bxn.id, reason: why, actorId })
        .then((r) => ({ reconId: r.recon.id }))),
    });
  }
  return finish('verified', { tool: spec.tool, attempts: n + 1, rules: evaluated, readback: redactedReadback });
}

// ---------- 事件消费扩展点（本阶段未实现） ----------
// 外部系统事件（webhook/轮询）到达时，调用 consumeExternalEvent({tenantId, projectId,
// executionId, event})：用同一套 evalRule 对事件 payload 做规则评估，结论写入
// verify_status。事件源同样只走只读语义（不触发写入），事件签名校验在接入时补。
export async function consumeExternalEvent() {
  throw Errors.badRequest('事件消费通道尚未实现（扩展点），请使用 read-back 验证', { code: 'NOT_IMPLEMENTED' });
}
