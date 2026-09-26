/**
 * modules/execution/service.mjs —— 工具调用编排（自研控制面）。
 *
 * invoke 流程：
 *   载入工具（租户隔离，平台级工具对所有租户可见）→ 策略 decide(tool.invoke)
 *   → 高风险 → 落库 pending_approval + approval 记录 → 抛 APPROVAL_REQUIRED
 *   → 幂等键去重（INSERT … ON CONFLICT DO NOTHING + 唯一约束，防 TOCTOU）
 *   → 注册补偿链（执行前落库）→ 引擎执行（Temporal live / 本地 fallback）
 *   → 结果回写（脱敏）→ 失败则逆序执行补偿。
 *
 * 安全铁律：
 * - args 落库前脱敏（secret/password/token/api_key 等打码），只存 sha256 供审计比对；
 *   密钥材料必须走 tool_credentials/vault_ref，禁止放在 args 里。
 * - runExecution 只被 invokeTool / approveExecution 调用，路由层无直达执行内部函数的路径。
 * - 补偿走本地 runner（同步、可预期；不嵌套 Temporal workflow）。
 */
import { createHash } from 'node:crypto';
import { newId, nowMs } from '../../kernel/ids.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { ctx } from '../../kernel/context.mjs';
import { db } from '../../db/index.mjs';
import { config } from '../../kernel/config.mjs';
import { decide, inputFromRequest } from '../policy/index.mjs';
import { logger } from '../../kernel/logging.mjs';
import * as mcp from './mcp.mjs';
import * as temporal from './temporal.mjs';

// ---------- 脱敏 ----------
const SECRET_KEY_RE = /secret|passwd|password|api[_-]?key|token|authorization|credential|private[_-]?key/i;

/** 平台运维伪 actor：认证层签发的字面量，不是 actors 表里的领域主体，禁止当业务 actor 落库/执行 */
const PLATFORM_PSEUDO_ACTOR = 'operator';
function assertTenantActor(actorId, what) {
  if (!actorId || actorId === PLATFORM_PSEUDO_ACTOR) {
    throw Errors.forbidden(`平台运维不能直接${what}，请使用租户主体凭证`);
  }
}

/** 疑似密钥的 key：按"词段"匹配（camelCase 先转 snake），避免 tokenizer 这类误伤 */
function looksLikeSecretKey(k) {
  const norm = String(k).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return /(^|_)(secret|passwd|password|api_key|token|authorization|credentials?|private_key)($|_)/.test(norm);
}
/** 递归扫描：config 里禁止出现疑似密钥明文字段（非空字符串且非 *** 占位） */
function assertNoPlaintextSecrets(obj, path = 'config') {  if (Array.isArray(obj)) {
    obj.forEach((v, i) => assertNoPlaintextSecrets(v, `${path}[${i}]`));
    return;
  }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (looksLikeSecretKey(k) && typeof v === 'string' && v && v !== '***') {
        throw Errors.badRequest(
          `${path}.${k} 疑似密钥明文：禁止在 config 里存放明文，请用 tool_credentials.vault_ref 引用`);
      }
      assertNoPlaintextSecrets(v, `${path}.${k}`);
    }
  }
}

/**
 * args 禁止携带疑似密钥明文：密钥必须注册为工具凭证（vault_ref），不能 per-call 传递。
 * 原因：落库/跨请求执行用的是脱敏版 args；若静默打码后执行，调用者会误以为真实密钥已被使用。
 */
function assertNoSecretArgs(args, path = 'args') {
  if (Array.isArray(args)) {
    args.forEach((v, i) => assertNoSecretArgs(v, `${path}[${i}]`));
    return;
  }
  if (args && typeof args === 'object') {
    for (const [k, v] of Object.entries(args)) {
      if (looksLikeSecretKey(k) && typeof v === 'string' && v) {
        throw Errors.badRequest(
          `${path}.${k} 疑似密钥：args 禁止携带密钥明文，请将密钥注册为工具凭证（vault_ref）`);
      }
      assertNoSecretArgs(v, `${path}.${k}`);
    }
  }
}
export function redactArgs(v) {  if (Array.isArray(v)) return v.map(redactArgs);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = SECRET_KEY_RE.test(k) ? '***' : redactArgs(val);
    }
    return out;
  }
  return v;
}

/** 错误文本里的常见密钥形状也打码（Bearer / key=… / sk-… 等） */
export function scrubText(s) {
  return String(s || '')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, 'Bearer ***')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)['"]?[^\s'",}]+/gi, '$1***')
    .slice(0, 500);
}

export function hashArgs(args) {
  return createHash('sha256').update(JSON.stringify(args ?? null)).digest('hex');
}

const trunc = (s, n = 4096) => {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n) + '…(truncated)' : t;
};

// ---------- 内置工具（仅开发/测试：echo/fail/delay，明确标记） ----------
const BUILTINS = {
  echo: async ({ action, args }) => ({ ok: true, builtin: 'echo', action, echoed: redactArgs(args) }),
  fail: async () => { throw new Error('builtin fail: intentional failure'); },
  delay: async ({ args, signal }) => {
    const ms = Math.min(Math.max(Number(args?.ms) || 100, 0), 60000);
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal) {
        if (signal.aborted) { clearTimeout(t); reject(new Error('timeout')); return; }
        signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('timeout')); }, { once: true });
      }
    });
    return { ok: true, builtin: 'delay', slept_ms: ms };
  },
};
export const BUILTIN_NAMES = Object.keys(BUILTINS);

// ---------- 工具注册表 ----------
const RISKS = ['low', 'medium', 'high'];
const KINDS = ['mcp', 'http', 'builtin'];

export async function registerTool({ tenantId, projectId, actorId, name, kind, endpoint = null,
  toolConfig = {}, riskLevel = 'low', credentials = [], validate = false, platform = false }) {
  if (!name || typeof name !== 'string') throw Errors.badRequest('工具 name 必填');
  if (!KINDS.includes(kind)) throw Errors.badRequest(`kind 非法: ${kind}`);
  if (!RISKS.includes(riskLevel)) throw Errors.badRequest(`risk_level 非法: ${riskLevel}`);
  if (typeof toolConfig !== 'object' || toolConfig === null) throw Errors.badRequest('config 必须为对象');

  // 凭证明文扫描：递归检查所有 key，config 里禁止出现疑似密钥明文字段（必须用 vault_ref 引用）
  assertNoPlaintextSecrets(toolConfig);

  if (kind === 'builtin') {
    const b = toolConfig.builtin;
    if (!BUILTIN_NAMES.includes(b)) throw Errors.badRequest(`未知内置工具: ${b}`);
    endpoint = null;
  } else {
    if (!endpoint) throw Errors.badRequest('mcp/http 工具 endpoint 必填');
    mcp.assertHttpEndpoint(endpoint); // stdio 等暂不支持，明确拒绝
  }

  // 先校验全部 credentials，再原子写入 tool + credential 引用（防半成品工具）
  const vaultRefs = [];
  for (const c of credentials || []) {
    const vaultRef = typeof c === 'string' ? c : c.vaultRef;
    if (!vaultRef || typeof vaultRef !== 'string') throw Errors.badRequest('credential 需要 vaultRef');
    vaultRefs.push(vaultRef);
  }

  const ownerTenant = platform ? null : tenantId;
  // 平台运维伪 actor 不是领域主体：created_by 置 NULL（平台行为），避免 FK 500
  const createdBy = actorId === PLATFORM_PSEUDO_ACTOR ? null : actorId;
  const now = nowMs();
  const id = newId('tool');
  try {
    await db().transaction(async (tx) => {
      await tx.run(
        `INSERT INTO tools(id,tenant_id,name,kind,endpoint,config,risk_level,status,version,created_by,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,1,?,?,?)`,
        [id, ownerTenant, name, kind, endpoint, JSON.stringify(toolConfig), riskLevel, 'active', createdBy, now, now]);
      for (const vaultRef of vaultRefs) {
        await tx.run('INSERT INTO tool_credentials(id,tool_id,vault_ref,created_at) VALUES (?,?,?,?)',
          [newId('tcr'), id, vaultRef, nowMs()]);
      }
    });
  } catch (e) {
    if (/UNIQUE|unique/i.test(e.message)) throw Errors.conflict(`工具名已存在: ${name}`);
    throw e;
  }

  let probe = null;
  if (validate && kind !== 'builtin') {
    probe = await mcp.probeEndpoint(kind, endpoint, { timeoutMs: Number(config.MCP_TIMEOUT_MS) || 30000 });
  }
  logger.info('tool registered', { tool: id, name, kind, risk: riskLevel, tenant: ownerTenant || 'platform' });
  return { data: await getToolRaw(id), probe };
}

async function getToolRaw(id) {
  const rows = await db().query('SELECT * FROM tools WHERE id=?', [id]);
  return rows[0] || null;
}

/** 租户视角载入工具：本租户 + 平台级（tenant_id IS NULL）可见 */
export async function getTool(tenantId, toolId) {
  const t = await getToolRaw(toolId).catch(() => null);
  if (!t) return null;
  if (t.tenant_id !== null && t.tenant_id !== tenantId) return null;
  return t;
}

export async function listTools(tenantId) {
  const tools = await db().query(
    `SELECT * FROM tools WHERE (tenant_id IS NULL OR tenant_id=?) ORDER BY created_at`, [tenantId]);
  const creds = await db().query(
    `SELECT tool_id, vault_ref FROM tool_credentials WHERE tool_id IN
     (SELECT id FROM tools WHERE (tenant_id IS NULL OR tenant_id=?))`, [tenantId]);
  const byTool = {};
  for (const c of creds) (byTool[c.tool_id] = byTool[c.tool_id] || []).push(c.vault_ref);
  return tools.map((t) => ({ ...t, credentialRefs: byTool[t.id] || [] }));
}

// ---------- 执行 ----------
function policyActor() {
  const c = ctx();
  return { id: c.actorId, kind: c.actorKind, status: 'active', roles: c.roles };
}

async function setExecutionStatus(id, status, extra = {}) {
  const cols = ['status', ...Object.keys(extra)];
  const vals = [status, ...Object.values(extra)];
  await db().run(
    `UPDATE executions SET ${cols.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`,
    [...vals, nowMs(), id]);
}

async function getExecutionRaw(id) {
  const rows = await db().query('SELECT * FROM executions WHERE id=?', [id]);
  return rows[0] || null;
}

/** 项目作用域载入（防跨项目 ID 枚举；不存在/不归属一律 404） */
export async function getExecution(tenantId, projectId, executionId) {
  const e = await getExecutionRaw(executionId).catch(() => null);
  if (!e || e.tenant_id !== tenantId || e.project_id !== projectId) return null;
  return e;
}

export async function listExecutions(tenantId, projectId, { status, toolId, limit = 50 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const conds = ['tenant_id=?', 'project_id=?'];
  const params = [tenantId, projectId];
  if (status) { conds.push('status=?'); params.push(status); }
  if (toolId) { conds.push('tool_id=?'); params.push(toolId); }
  return db().query(
    `SELECT * FROM executions WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT ${n}`, params);
}

async function registerCompensations(executionId, compensations, tenantId) {
  const now = nowMs();
  let seq = 0;
  for (const c of compensations || []) {
    const tool = await getTool(tenantId, c.toolId);
    if (!tool) throw Errors.badRequest(`补偿工具不存在: ${c.toolId}`);
    if (tool.status !== 'active') throw Errors.badRequest(`补偿工具已停用: ${c.toolId}`);
    if (!c.action) throw Errors.badRequest('补偿 action 必填');
    await db().run(
      `INSERT INTO compensations(id,execution_id,seq,tool_id,action,args_redacted,status,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [newId('cmp'), executionId, seq++, tool.id, c.action,
       JSON.stringify(redactArgs(c.args || {})), 'pending', now]);
  }
}

/** 单次工具调用分发（本地 runner；补偿与 fallback 共用） */
export async function executeOne({ tool, action, args, timeoutMs }) {
  const cfg = JSON.parse(tool.config || '{}');
  if (tool.kind === 'builtin') {
    const fn = BUILTINS[cfg.builtin];
    if (!fn) throw Errors.badRequest(`未知内置工具: ${cfg.builtin}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fn({ action, args: args || {}, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
  const headers = mcp.authHeadersFor(tool);
  if (tool.kind === 'mcp') {
    return mcp.callMcpTool(tool.endpoint, action, args || {}, { headers, timeoutMs });
  }
  // http
  return mcp.callHttpTool(tool.endpoint, action, args || {}, { headers, timeoutMs });
}

export async function invokeTool({ tenantId, projectId, actorId, traceId, toolId, action,
  args = {}, idempotencyKey = null, compensations = [] }) {
  // 平台运维伪 actor 不是领域主体：禁止直接执行租户工具（FK 会 500，且副作用无法归因到租户）
  assertTenantActor(actorId, '执行工具');
  const tool = await getTool(tenantId, toolId);
  if (!tool) throw Errors.notFound('工具不存在');
  if (tool.status !== 'active') throw Errors.forbidden('工具已停用');
  if (!action || typeof action !== 'string') throw Errors.badRequest('action 必填');
  // args 密钥拦截（请求校验，fail fast）：疑似密钥字段直接 400，不静默打码执行
  assertNoSecretArgs(args);

  // 策略：风险分级（high → approval_required 义务；medium → operator+；low → 放行）
  const receipt = await decide(inputFromRequest({
    actor: policyActor(),
    tenant: { id: tenantId, status: 'active' },
    project: { id: projectId },
    action: 'tool.invoke',
    resource: { kind: 'tool', id: tool.id, name: tool.name, risk: tool.risk_level },
    context: {},
  }));
  if (!receipt.allow) throw Errors.policyDenied(receipt.reason, { receipt });

  const argsHash = hashArgs(args);
  const argsRedacted = JSON.stringify(redactArgs(args));
  const now = nowMs();
  const exeId = newId('exe');
  const key = idempotencyKey ? String(idempotencyKey).slice(0, 128) : null;

  // 幂等插入：唯一约束 + ON CONFLICT DO NOTHING（TOCTOU 安全；并发第二个请求拿到已存在行）
  const ins = await db().run(
    `INSERT INTO executions(id,tenant_id,project_id,actor_id,trace_id,tool_id,action,args_hash,
      args_redacted,status,idempotency_key,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    [exeId, tenantId, projectId, actorId, traceId, tool.id, action, argsHash,
     argsRedacted, 'pending_approval', key, now, now])
    .catch(async (e) => {
      // 方言兜底：若驱动不支持带 WHERE 的 ON CONFLICT，退化为"查-插"（唯一约束仍是最后一道防线）
      if (/ON CONFLICT|syntax/i.test(e.message) && key) {
        const ex = await db().query(
          'SELECT * FROM executions WHERE tenant_id=? AND idempotency_key=?', [tenantId, key]);
        if (ex[0]) return { changes: 0, __existing: ex[0] };
      }
      throw e;
    });
  if (ins.changes === 0) {
    const existing = ins.__existing || (await db().query(
      'SELECT * FROM executions WHERE tenant_id=? AND idempotency_key=?', [tenantId, key]))[0];
    logger.info('execution deduplicated', { key, exe: existing?.id });
    return { execution: existing, deduplicated: true };
  }

  // 高风险：建审批单，抛 APPROVAL_REQUIRED（调用方凭 approvalId 走审批流）。
  // execution + approval + approval_id 回写放在同一事务：崩溃不留"pending_approval 却无审批单"的孤儿。
  if (receipt.obligations.includes('approval_required')) {
    const aprId = newId('apr');
    await db().transaction(async (tx) => {
      await tx.run(
        `INSERT INTO approvals(id,execution_id,requested_by,status,created_at) VALUES (?,?,?,?,?)`,
        [aprId, exeId, actorId, 'pending', nowMs()]);
      await tx.run('UPDATE executions SET approval_id=?, updated_at=? WHERE id=?',
        [aprId, nowMs(), exeId]);
    });
    logger.info('execution pending approval', { exe: exeId, approval: aprId, tool: tool.name });
    throw Errors.approvalRequired(aprId);
  }

  // 补偿链先落库（执行前注册，保证失败可补偿）
  await registerCompensations(exeId, compensations, tenantId);
  await setExecutionStatus(exeId, 'approved');
  return { execution: await runExecution(exeId), deduplicated: false };
}

/**
 * 执行 execution（仅 invokeTool / approveExecution 调用）。
 * argsForRun：进程内透传的原始 args；审批流（跨请求）用 DB 里的脱敏 args。
 */
/**
 * 经 Temporal 执行。错误语义（防重复执行是核心）：
 * - submit 失败（Temporal 不可用）→ 降级本地执行；
 * - workflow 业务失败（WORKFLOW_FAILED）→ 直接抛，调用方走失败/补偿，绝不本地重跑；
 * - 轮询超时（WORKFLOW_TIMEOUT）→ 先取消远端 workflow，取消成功才本地重跑，
 *   取消失败则抛错（宁可标记失败也不双重执行）。
 */
async function runViaTemporal({ exe, tool, runArgs, timeoutMs }) {
  const namespace = temporal.namespaceFor(exe.tenant_id);
  const toolCfg = JSON.parse(tool.config || '{}');
  try {
    const sub = await temporal.submitWorkflow({
      namespace,
      workflowId: exe.id, // 平台 ID 即 workflowId，跨系统可追踪
      input: {
        execution_id: exe.id, tenant_id: exe.tenant_id, project_id: exe.project_id,
        actor_id: exe.actor_id, trace_id: exe.trace_id, tool_id: tool.id,
        tool_name: tool.name, tool_kind: tool.kind, tool_endpoint: tool.endpoint,
        action: exe.action, args_hash: exe.args_hash,
        args: JSON.parse(exe.args_redacted || '{}'), // 脱敏版；密钥走 vault_ref
        auth_vault_ref: toolCfg.auth?.vault_ref || null, // 引用名（非明文），worker 侧解析
      },
    });
    logger.info('execution submitted to temporal', {
      exe: exe.id, namespace, workflow: sub.workflowId, run: sub.runId,
    });
  } catch (e) {
    logger.warn('execution temporal submit failed, local fallback', { exe: exe.id, err: e.message });
    const result = await executeOne({ tool, action: exe.action, args: runArgs, timeoutMs });
    return { engine: 'local(fallback)', result };
  }
  try {
    const result = await temporal.pollWorkflowResult({
      namespace,
      workflowId: exe.id,
      timeoutMs: Number(config.EXEC_RESULT_TIMEOUT_MS) || 60000,
    });
    return { engine: 'temporal', result };
  } catch (e) {
    if (e?.code === 'WORKFLOW_FAILED') throw e; // 业务失败：不重跑
    if (e?.code === 'WORKFLOW_TIMEOUT') {
      const cancelled = await temporal.cancelWorkflow({ namespace, workflowId: exe.id })
        .then(() => true).catch(() => false);
      if (!cancelled) {
        throw Errors.upstream('Temporal workflow 超时且取消失败，为避免重复执行本次不再本地重跑');
      }
      logger.warn('execution temporal poll timeout, cancelled remotely, local fallback', { exe: exe.id });
    } else {
      logger.warn('execution temporal poll failed, local fallback', { exe: exe.id, err: e.message });
    }
    const result = await executeOne({ tool, action: exe.action, args: runArgs, timeoutMs });
    return { engine: 'local(fallback)', result };
  }
}

export async function runExecution(exeId, argsForRun = null) {
  const exe = await getExecutionRaw(exeId);
  if (!exe) throw Errors.notFound('执行记录不存在');
  if (exe.status !== 'approved') throw Errors.conflict(`执行状态不允许运行: ${exe.status}`);
  const tool = await getToolRaw(exe.tool_id);
  if (!tool || tool.status !== 'active') throw Errors.forbidden('工具不存在或已停用');

  await setExecutionStatus(exeId, 'running');
  const timeoutMs = Number(config.MCP_TIMEOUT_MS) || 30000;
  const runArgs = argsForRun || JSON.parse(exe.args_redacted || '{}');
  const t0 = Date.now();
  let engine = 'local(fallback)';
  let result = null;

  try {
    if (temporal.isTemporalConfigured()) {
      const r = await runViaTemporal({ exe, tool, runArgs, timeoutMs });
      engine = r.engine;
      result = r.result;
    } else {
      result = await executeOne({ tool, action: exe.action, args: runArgs, timeoutMs });
    }
    await setExecutionStatus(exeId, 'succeeded', {
      engine,
      result_ref: trunc(JSON.stringify(redactArgs(result))),
    });
    logger.info('execution succeeded', { exe: exeId, engine, ms: Date.now() - t0 });
  } catch (e) {
    const errText = scrubText(e.message);
    logger.warn('execution failed', { exe: exeId, err: errText });
    const comp = await runCompensations(exeId, timeoutMs);
    if (comp.count > 0 && comp.allOk) {
      await setExecutionStatus(exeId, 'compensated', { engine, error: errText });
    } else if (comp.count > 0) {
      await setExecutionStatus(exeId, 'failed', {
        engine, error: errText + `（补偿部分失败: ${comp.failed} 项）`,
      });
    } else {
      await setExecutionStatus(exeId, 'failed', { engine, error: errText });
    }
  }
  return getExecutionRaw(exeId);
}

/** 补偿：按 seq 逆序执行；返回 { count, allOk, failed } */
async function runCompensations(exeId, timeoutMs) {
  const rows = await db().query(
    'SELECT * FROM compensations WHERE execution_id=? ORDER BY seq DESC', [exeId]);
  let failed = 0;
  for (const c of rows) {
    try {
      const tool = await getToolRaw(c.tool_id);
      if (!tool || tool.status !== 'active') throw new Error('补偿工具不可用');
      await executeOne({ tool, action: c.action, args: JSON.parse(c.args_redacted || '{}'), timeoutMs });
      await db().run('UPDATE compensations SET status=?, executed_at=? WHERE id=?',
        ['done', nowMs(), c.id]);
      logger.info('compensation done', { exe: exeId, cmp: c.id, seq: c.seq });
    } catch (e) {
      failed++;
      await db().run('UPDATE compensations SET status=?, error=?, executed_at=? WHERE id=?',
        ['failed', scrubText(e.message), nowMs(), c.id]);
      logger.error('compensation failed', { exe: exeId, cmp: c.id, err: scrubText(e.message) });
    }
  }
  return { count: rows.length, allOk: failed === 0, failed };
}

// ---------- 审批 ----------
async function getApprovalRaw(approvalId) {
  const rows = await db().query('SELECT * FROM approvals WHERE id=?', [approvalId]);
  return rows[0] || null;
}

/** 项目作用域载入审批单（连带 execution；跨项目一律 404） */
export async function getApproval(tenantId, projectId, approvalId) {
  const a = await getApprovalRaw(approvalId).catch(() => null);
  if (!a) return null;
  const exe = await getExecutionRaw(a.execution_id);
  if (!exe || exe.tenant_id !== tenantId || exe.project_id !== projectId) return null;
  return { approval: a, execution: exe };
}

export async function decideApproval({ tenantId, projectId, approvalId, actorId, roles, approved, reason }) {
  // 平台运维伪 actor 禁止决议租户审批单（decided_by 有 FK，且审批是租户治理动作）
  assertTenantActor(actorId, '审批');
  const found = await getApproval(tenantId, projectId, approvalId);
  if (!found) throw Errors.notFound('审批单不存在');
  const { approval, execution } = found;
  if (approval.status !== 'pending') throw Errors.conflict(`审批单已处理: ${approval.status}`);
  if (execution.status !== 'pending_approval') throw Errors.conflict(`执行状态异常: ${execution.status}`);

  // 审批人需要 operator+（路由层已做 rank 检查，这里纵深防御再查一次）
  const { effectiveRank } = await import('../identity/middleware.mjs');
  if (effectiveRank(roles, projectId) < 1) throw Errors.forbidden('审批需要 operator 及以上角色');

  const now = nowMs();
  const newStatus = approved ? 'approved' : 'rejected';
  // 原子 CAS：只有 pending 的审批单能被决议（防并发双重审批 → 重复执行）
  const upd = await db().run(
    `UPDATE approvals SET status=?, decided_by=?, reason=?, decided_at=? WHERE id=? AND status='pending'`,
    [newStatus, actorId, reason || null, now, approvalId]);
  if (upd.changes === 0) throw Errors.conflict('审批单已被处理（可能并发决议）');
  const exeUpd = await db().run(
    `UPDATE executions SET status=?, updated_at=? WHERE id=? AND status='pending_approval'`,
    [newStatus, nowMs(), execution.id]);
  if (exeUpd.changes === 0) throw Errors.conflict(`执行状态异常: ${execution.status}`);
  logger.info(approved ? 'execution approved' : 'execution rejected',
    { exe: execution.id, approval: approvalId, by: actorId });
  if (!approved) {
    return { approval: await getApprovalRaw(approvalId), execution: await getExecutionRaw(execution.id) };
  }
  // 审批通过后立即执行（脱敏 args；密钥走 vault_ref，不依赖原始 args）
  const finalExe = await runExecution(execution.id);
  return { approval: await getApprovalRaw(approvalId), execution: finalExe };
}
