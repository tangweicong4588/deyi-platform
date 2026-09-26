/**
 * modules/execution/temporal.mjs —— Temporal 薄适配 + 状态上报。
 *
 * - TEMPORAL_ADDRESS 设置 → 尝试走 Temporal HTTP API（workflow 提交/查询/取消）；
 *   任何失败都抛错，由 service 层降级为本地执行（engine 明确标记 local(fallback)）。
 * - 租户隔离：namespace = deyi-<tenantId>（清洗非法字符），workflowId = execution 平台 ID（exe_）。
 * - /readyz 上报：probeTemporal() 在启动时探测；temporalLive() 仅供状态展示，
 *   执行路径不依赖缓存状态（提交失败即降级，防"探活时正常、执行时挂了"的竞态）。
 */
import { config } from '../../kernel/config.mjs';
import { logger } from '../../kernel/logging.mjs';

const TASK_QUEUE = 'deyi-tools';

let cachedStatus = config.TEMPORAL_ADDRESS ? 'temporal(configured)' : 'local(fallback)';
export function getWorkflowStatus() { return cachedStatus; }
export function isTemporalConfigured() { return !!config.TEMPORAL_ADDRESS; }
export function temporalLive() { return cachedStatus === 'temporal(live)'; }

/** 租户隔离 namespace：deyi-<tenantId>，非法字符清洗（Temporal 命名约束） */
export function namespaceFor(tenantId) {
  return ('deyi-' + String(tenantId)).replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 63);
}

const base = () => config.TEMPORAL_ADDRESS.replace(/\/$/, '');

async function tfetch(path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  const res = await fetch(base() + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`temporal ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json().catch(() => ({}));
}

/** 启动探测：只影响状态上报，不决定执行路径 */
export async function probeTemporal() {
  if (!isTemporalConfigured()) {
    cachedStatus = 'local(fallback)';
  } else {
    try {
      await tfetch('/api/v1/namespaces', { timeoutMs: 5000 });
      cachedStatus = 'temporal(live)';
    } catch (e) {
      cachedStatus = 'temporal(unreachable→local fallback)';
      logger.warn('temporal probe failed', { err: e.message });
    }
  }
  logger.info('temporal probe', { status: cachedStatus });
  return cachedStatus;
}

/**
 * 提交 workflow。input 为平台侧执行上下文（tenant/project/actor/trace/tool/action/argsHash，
 * 注意：args 原文不进 workflow input，只进脱敏版——密钥材料走 vault_ref）。
 * 返回 { workflowId, runId }；失败抛错 → 调用方降级本地执行。
 */
export async function submitWorkflow({ namespace, workflowId, input }) {
  const json = await tfetch(`/api/v1/namespaces/${encodeURIComponent(namespace)}/workflows`, {
    method: 'POST',
    body: {
      workflowId,
      workflowType: { name: 'deyi.toolCall' },
      taskQueue: { name: TASK_QUEUE },
      workflowExecutionTimeout: '3600s',
      input: {
        payloads: [{ data: Buffer.from(JSON.stringify(input)).toString('base64') }],
      },
    },
  });
  return { workflowId, runId: json.runId || json?.workflowExecution?.runId || null };
}

/** 查询 workflow 状态（MVP：轮询到终态或超时） */
export async function describeWorkflow({ namespace, workflowId }) {
  return tfetch(
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/workflows/${encodeURIComponent(workflowId)}`,
    { timeoutMs: 10000 },
  );
}

/** 取消 workflow */
export async function cancelWorkflow({ namespace, workflowId }) {
  await tfetch(
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/workflows/${encodeURIComponent(workflowId)}/cancel`,
    { method: 'POST' },
  );
  return { cancelled: true };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** workflow 业务失败（终态 FAILED 等）：调用方不得本地重跑，直接走失败/补偿流程 */
export class WorkflowFailedError extends Error {
  constructor(status) {
    super(`temporal workflow 终态异常: ${status}`);
    this.name = 'WorkflowFailedError';
    this.code = 'WORKFLOW_FAILED';
    this.workflowStatus = status;
  }
}

/** 结果轮询超时：调用方应先取消远端 workflow 再决定是否本地重跑（防双重执行） */
export class WorkflowTimeoutError extends Error {
  constructor() {
    super('temporal workflow 结果轮询超时');
    this.name = 'WorkflowTimeoutError';
    this.code = 'WORKFLOW_TIMEOUT';
  }
}

/**
 * 轮询 workflow 结果。终态 COMPLETED → 返回 result；
 * FAILED/TIMED_OUT/CANCELED → 抛错；超时 → 抛错（调用方可降级或标记）。
 * 状态字符串兼容 Temporal HTTP API 的 WORKFLOW_EXECUTION_STATUS_* 枚举。
 */
export async function pollWorkflowResult({ namespace, workflowId, timeoutMs = 60000, intervalMs = 500 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const desc = await describeWorkflow({ namespace, workflowId });
    const st = desc.status || desc?.workflowExecutionInfo?.status || '';
    if (/COMPLETED/.test(st)) return desc.result ?? desc;
    if (/FAILED|TIMED_OUT|TERMINATED|CANCELED|CANCELLED/.test(st)) {
      throw new WorkflowFailedError(st);
    }
    if (Date.now() > deadline) throw new WorkflowTimeoutError();
    await sleep(intervalMs);
  }
}
