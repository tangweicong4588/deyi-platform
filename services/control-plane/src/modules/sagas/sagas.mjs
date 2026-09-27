/**
 * modules/sagas/sagas.mjs —— V4.3 长流程与补偿（Saga 编排）。
 *
 * - saga 定义：有序步骤，每步 { key, tool, action, args?, compensate?, timeout_ms?, retries?, retry_backoff_ms? }。
 * - 执行语义：某步耗尽重试仍失败 → 终止正向流程，对已完成的步骤按逆序执行补偿动作；
 *   补偿全部成功（或无补偿）→ run=compensated；任一补偿失败 → run=failed。
 * - engine=local：控制面内同步驱动（开发/测试；HTTP 请求内跑完，步骤超时有上限）。
 *   生产长流程请用 engine=temporal：提交 Temporal worker 异步执行，控制面只做提交/查询/取消。
 * - Temporal 路径沿用 modules/execution/temporal.mjs 的诚实契约：
 *   未配置 TEMPORAL_ADDRESS → 503 明示，不静默降级（长流程的持久化语义不容"看起来跑了"）。
 * - 执行历史：saga_steps 按 seq 全序记录（含补偿行 kind='compensate'），供查询/重放/追溯（V3.4）。
 * - 步骤动作复用执行域 invokeTool（MCP 工具真实调用）；补偿动作同。
 *   注意：超时用 Promise.race 实现，底层调用可能仍在后台完成——幂等依赖
 *   idempotencyKey（run:step:attempt），工具侧需保证幂等。
 */
import { db } from '../../db/index.mjs';
import { config } from '../../kernel/config.mjs';
import { newId, nowMs } from '../../kernel/ids.mjs';
import { Errors, PlatformError } from '../../kernel/errors.mjs';
import { tryAudit } from '../evidence/audit.mjs';
import { invokeTool } from '../execution/service.mjs';
import {
  namespaceFor, submitWorkflow, describeWorkflow, cancelWorkflow,
  WorkflowFailedError,
} from '../execution/temporal.mjs';

const KEY_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_STEPS = 50;

/** 校验并归一化 saga 定义；失败抛 Errors.badRequest。返回 { steps: [...] }。 */
export function validateDefinition(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw Errors.badRequest('definition 必须是对象');
  }
  const steps = raw.steps;
  if (!Array.isArray(steps) || steps.length === 0) throw Errors.badRequest('steps 必须是非空数组');
  if (steps.length > MAX_STEPS) throw Errors.badRequest(`steps 最多 ${MAX_STEPS} 步`);
  const seen = new Set();
  const norm = steps.map((s, i) => {
    if (!s || typeof s !== 'object') throw Errors.badRequest(`steps[${i}] 必须是对象`);
    if (!s.key || !KEY_RE.test(s.key)) throw Errors.badRequest(`steps[${i}].key 非法（字母数字/_/-，1-64）`);
    if (seen.has(s.key)) throw Errors.badRequest(`steps[${i}].key 重复：${s.key}`);
    seen.add(s.key);
    if (!s.tool || typeof s.tool !== 'string') throw Errors.badRequest(`steps[${i}].tool 必填`);
    if (!s.action || typeof s.action !== 'string') throw Errors.badRequest(`steps[${i}].action 必填`);
    const out = {
      key: s.key, tool: s.tool, action: s.action,
      args: (s.args && typeof s.args === 'object') ? s.args : {},
      timeout_ms: num(s.timeout_ms, 30000, 100, 3600000, `steps[${i}].timeout_ms`),
      retries: int(s.retries, 0, 0, 10, `steps[${i}].retries`),
      retry_backoff_ms: num(s.retry_backoff_ms, 0, 0, 60000, `steps[${i}].retry_backoff_ms`),
    };
    if (s.compensate !== undefined && s.compensate !== null) {
      const c = s.compensate;
      if (typeof c !== 'object') throw Errors.badRequest(`steps[${i}].compensate 必须是对象`);
      if (!c.tool || typeof c.tool !== 'string') throw Errors.badRequest(`steps[${i}].compensate.tool 必填`);
      if (!c.action || typeof c.action !== 'string') throw Errors.badRequest(`steps[${i}].compensate.action 必填`);
      out.compensate = {
        tool: c.tool, action: c.action,
        args: (c.args && typeof c.args === 'object') ? c.args : {},
      };
    }
    return out;
  });
  return { steps: norm };
}
function num(v, dflt, min, max, name) {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw Errors.badRequest(`${name} 须在 ${min}~${max} 之间`);
  }
  return v;
}
function int(v, dflt, min, max, name) {
  const n = num(v, dflt, min, max, name);
  if (!Number.isInteger(n)) throw Errors.badRequest(`${name} 须为整数`);
  return n;
}

const row = (r) => (r ? {
  ...r,
  definition: r.definition ? JSON.parse(r.definition) : null,
  input: r.input ? JSON.parse(r.input) : null,
} : null);

export async function createSaga({ tenantId, projectId, name, definition, createdBy }) {
  if (!name || typeof name !== 'string' || name.length > 128) throw Errors.badRequest('name 必填（≤128）');
  const def = validateDefinition(definition);
  const now = nowMs();
  const id = newId('saga');
  try {
    await db().run(
      `INSERT INTO sagas(id,tenant_id,project_id,name,definition,status,created_by,created_at,updated_at)
       VALUES(?,?,?,?,?,'active',?,?,?)`,
      [id, tenantId, projectId, name, JSON.stringify(def), createdBy || null, now, now]);
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) throw Errors.conflict('同项目下 saga 名称已存在');
    throw e;
  }
  await tryAudit({ tenantId, projectId, actorId: createdBy, action: 'saga.create',
    resourceKind: 'saga', resourceId: id, payload: { result: 'ok', name, steps: def.steps.length } });
  return row((await db().query('SELECT * FROM sagas WHERE id=?', [id]))[0]);
}

export async function listSagas({ tenantId, projectId }) {
  const rows = await db().query(
    'SELECT * FROM sagas WHERE tenant_id=? AND project_id=? ORDER BY created_at DESC', [tenantId, projectId]);
  return rows.map(row);
}

export async function getSaga({ tenantId, projectId, sagaId }) {
  const r = (await db().query(
    'SELECT * FROM sagas WHERE id=? AND tenant_id=? AND project_id=?', [sagaId, tenantId, projectId]))[0];
  if (!r) throw Errors.notFound('saga 不存在');
  return row(r);
}

// ---------- run ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class StepTimeoutError extends Error {
  constructor(ms) { super(`步骤执行超时（${ms}ms）`); this.name = 'StepTimeoutError'; this.code = 'STEP_TIMEOUT'; }
}

/** 带超时的单次执行；超时后底层 promise 仍可能继续（见模块头注释）。 */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeoutError(ms)), ms);
  });
  const raced = Promise.race([promise, timeout]);
  return raced.finally(() => clearTimeout(timer));
}

async function runWithRetry({ fn, retries, backoffMs, timeoutMs, onAttempt }) {
  let lastErr = null;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    if (onAttempt) await onAttempt(attempt);
    try {
      const value = await withTimeout(fn(attempt), timeoutMs);
      return { ok: true, value, attempts: attempt };
    } catch (e) {
      lastErr = e;
      if (attempt <= retries && backoffMs > 0) await sleep(backoffMs);
    }
  }
  return { ok: false, error: lastErr, attempts: retries + 1 };
}

const errText = (e) => (e && e.code && e.message ? `${e.code}: ${e.message}` : String(e && e.message || e)).slice(0, 2000);

async function insertStepRow({ tenantId, runId, seq, kind, stepKey, action, startedAt }) {
  const id = newId('sagst');
  await db().run(
    `INSERT INTO saga_steps(id,tenant_id,run_id,seq,kind,step_key,action,status,attempts,started_at,created_at)
     VALUES(?,?,?,?,?,?,?,'running',0,?,?)`,
    [id, tenantId, runId, seq, kind, stepKey, JSON.stringify(action), startedAt, startedAt]);
  return id;
}

async function updateStepRow(id, patch) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) { sets.push(`${k}=?`); vals.push(v); }
  vals.push(id);
  await db().run(`UPDATE saga_steps SET ${sets.join(',')} WHERE id=?`, vals);
}

async function setRun({ runId, patch }) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) { sets.push(`${k}=?`); vals.push(v); }
  vals.push(runId);
  await db().run(`UPDATE saga_runs SET ${sets.join(',')} WHERE id=?`, vals);
}

function stepAction({ tenantId, projectId, actorId, traceId, tool, action, args, idempotencyKey }) {
  return async () => {
    const r = await invokeTool({
      tenantId, projectId, actorId, traceId, toolId: tool, action, args, idempotencyKey,
    });
    // 注意：invokeTool/runExecution 把工具业务失败吞成 execution 行状态（不抛错），
    // saga 必须显式检查，否则"失败"会被当成成功继续正向流程。
    const exe = r && (r.execution || r);
    if (exe && exe.status && exe.status !== 'succeeded') {
      const err = new Error(exe.error || `工具执行未成功: ${exe.status}`);
      err.code = 'TOOL_FAILED';
      throw err;
    }
    return r;
  };
}

/**
 * 本地 Saga 驱动：同步按序执行；失败步触发逆序补偿。返回终态 run 行。
 * run/status/steps 全程落库，可查询、可重放。
 */
async function driveLocalRun({ run, definition, tenantId, projectId, actorId }) {
  const now = nowMs();
  let seq = 0;
  const completed = []; // {step, stepRowId}
  let failedInfo = null;

  for (const step of definition.steps) {
    const stepRowId = await insertStepRow({
      tenantId, runId: run.id, seq: ++seq, kind: 'forward',
      stepKey: step.key, action: { tool: step.tool, action: step.action, args: step.args }, startedAt: nowMs(),
    });
    const r = await runWithRetry({
      fn: (attempt) => stepAction({
        tenantId, projectId, actorId, traceId: `${run.id}:step:${step.key}`,
        tool: step.tool, action: step.action, args: step.args,
        idempotencyKey: `${run.id}:${step.key}:attempt${attempt}`,
      })(),
      retries: step.retries, backoffMs: step.retry_backoff_ms, timeoutMs: step.timeout_ms,
      onAttempt: (attempt) => updateStepRow(stepRowId, { attempts: attempt }),
    });
    if (r.ok) {
      await updateStepRow(stepRowId, {
        status: 'succeeded', output: JSON.stringify(scrub(r.value)), finished_at: nowMs(),
      });
      completed.push({ step, stepRowId });
      await setRun({ runId: run.id, patch: { current_step: seq, updated_at: nowMs() } });
      await tryAudit({ tenantId, projectId, actorId, action: 'saga.step.succeeded',
        resourceKind: 'saga_run', resourceId: run.id, payload: { result: 'ok', step: step.key, attempts: r.attempts } });
    } else {
      await updateStepRow(stepRowId, { status: 'failed', error: errText(r.error), finished_at: nowMs() });
      failedInfo = { step, error: errText(r.error), attempts: r.attempts };
      await tryAudit({ tenantId, projectId, actorId, action: 'saga.step.failed',
        resourceKind: 'saga_run', resourceId: run.id, payload: { result: 'fail', step: step.key, error: failedInfo.error } });
      break;
    }
  }

  let finalStatus;
  if (!failedInfo) {
    finalStatus = 'succeeded';
  } else {
    // 补偿分支：已完成步骤逆序补偿（同重试/超时策略，尽力执行完所有补偿）
    await setRun({ runId: run.id, patch: { status: 'compensating', updated_at: nowMs() } });
    await tryAudit({ tenantId, projectId, actorId, action: 'saga.run.compensating',
      resourceKind: 'saga_run', resourceId: run.id,
      payload: { result: 'ok', failed_step: failedInfo.step.key, error: failedInfo.error } });
    let compensationFailed = false;
    for (const { step, stepRowId } of [...completed].reverse()) {
      if (!step.compensate) {
        await updateStepRow(stepRowId, { status: 'succeeded' }); // 无补偿动作：保持 succeeded
        continue;
      }
      const compRowId = await insertStepRow({
        tenantId, runId: run.id, seq: ++seq, kind: 'compensate',
        stepKey: step.key,
        action: { tool: step.compensate.tool, action: step.compensate.action, args: step.compensate.args },
        startedAt: nowMs(),
      });
      const r = await runWithRetry({
        fn: (attempt) => stepAction({
          tenantId, projectId, actorId, traceId: `${run.id}:compensate:${step.key}`,
          tool: step.compensate.tool, action: step.compensate.action, args: step.compensate.args,
          idempotencyKey: `${run.id}:${step.key}:compensate:attempt${attempt}`,
        })(),
        retries: step.retries, backoffMs: step.retry_backoff_ms, timeoutMs: step.timeout_ms,
        onAttempt: (attempt) => updateStepRow(compRowId, { attempts: attempt }),
      });
      if (r.ok) {
        await updateStepRow(compRowId, {
          status: 'succeeded', output: JSON.stringify(scrub(r.value)), finished_at: nowMs(),
        });
        await updateStepRow(stepRowId, { status: 'compensated' });
        await tryAudit({ tenantId, projectId, actorId, action: 'saga.compensation.succeeded',
          resourceKind: 'saga_run', resourceId: run.id, payload: { result: 'ok', step: step.key } });
      } else {
        compensationFailed = true;
        await updateStepRow(compRowId, { status: 'failed', error: errText(r.error), finished_at: nowMs() });
        await updateStepRow(stepRowId, { status: 'compensation_failed' });
        await tryAudit({ tenantId, projectId, actorId, action: 'saga.compensation.failed',
          resourceKind: 'saga_run', resourceId: run.id,
          payload: { result: 'fail', step: step.key, error: errText(r.error) } });
      }
    }
    finalStatus = compensationFailed ? 'failed' : 'compensated';
  }

  const finished = nowMs();
  await setRun({ runId: run.id, patch: { status: finalStatus, updated_at: finished, finished_at: finished } });
  await tryAudit({ tenantId, projectId, actorId, action: `saga.run.${finalStatus}`,
    resourceKind: 'saga_run', resourceId: run.id,
    payload: { result: finalStatus === 'failed' ? 'fail' : 'ok',
      ...(failedInfo ? { failed_step: failedInfo.step.key, error: failedInfo.error } : {}) } });
  return getRun({ tenantId, projectId, runId: run.id });
}

/** 输出脱敏：沿用执行域口径（密钥字段打码），防 args 回显泄露。 */
function scrub(v) {
  try {
    const s = JSON.stringify(v);
    return JSON.parse(s.replace(/"(password|secret|token|api[_-]?key)"\s*:\s*"[^"]*"/gi, '"$1":"***"'));
  } catch { return { note: 'unserializable output' }; }
}

/** Temporal 可用性断言：未配置 → 503 明示，绝不静默降级为 local（长流程的持久化语义不容"看起来跑了"）。 */
export function assertTemporalConfigured(address = config.TEMPORAL_ADDRESS) {
  if (!address) {
    throw new PlatformError('TEMPORAL_NOT_CONFIGURED',
      'Temporal 未配置（TEMPORAL_ADDRESS 为空）：长流程生产执行不可用，请用 engine=local 或先完成 Temporal 联调',
      { status: 503 });
  }
}

export async function startRun({ tenantId, projectId, sagaId, input = {}, engine = 'local', actorId }) {
  const saga = await getSaga({ tenantId, projectId, sagaId });
  if (saga.status !== 'active') throw Errors.badRequest('saga 已归档');
  if (engine !== 'local' && engine !== 'temporal') throw Errors.badRequest('engine 只能是 local|temporal');
  if (input && typeof input !== 'object') throw Errors.badRequest('input 必须是对象');
  if (engine === 'temporal') assertTemporalConfigured();

  const now = nowMs();
  const runId = newId('sagrn');
  await db().run(
    `INSERT INTO saga_runs(id,tenant_id,saga_id,project_id,input,engine,status,created_by,created_at,updated_at)
     VALUES(?,?,?,?,?,?, 'running',?,?,?)`,
    [runId, tenantId, sagaId, projectId, JSON.stringify(input || {}), engine, actorId || null, now, now]);
  await tryAudit({ tenantId, projectId, actorId, action: 'saga.run.start',
    resourceKind: 'saga_run', resourceId: runId, payload: { result: 'ok', saga: sagaId, engine } });

  if (engine === 'temporal') {
    // 生产路径：提交 Temporal worker 异步执行；控制面返回 running + workflow_id
    const namespace = namespaceFor(tenantId);
    try {
      const { workflowId, runId: wfRunId } = await submitWorkflow({
        namespace,
        workflowId: runId,
        workflowType: 'deyi.sagaRun',
        taskQueue: 'deyi-sagas',
        input: { run_id: runId, saga_id: sagaId, definition: saga.definition, input: input || {} },
      });
      await setRun({ runId, patch: { workflow_id: workflowId, updated_at: nowMs() } });
      return { ...(await getRun({ tenantId, projectId, runId })), temporal_run_id: wfRunId, namespace };
    } catch (e) {
      // 提交失败：run 落终态 failed（不悬挂 running），错误向上传
      const now2 = nowMs();
      await setRun({ runId, patch: { status: 'failed', updated_at: now2, finished_at: now2 } });
      await tryAudit({ tenantId, projectId, actorId, action: 'saga.run.failed',
        resourceKind: 'saga_run', resourceId: runId,
        payload: { result: 'fail', error: `temporal 提交失败: ${e.message}`.slice(0, 500) } });
      throw e;
    }
  }
  const run = row((await db().query('SELECT * FROM saga_runs WHERE id=?', [runId]))[0]);
  return driveLocalRun({ run, definition: saga.definition, tenantId, projectId, actorId });
}

export async function listRuns({ tenantId, projectId, sagaId }) {
  const rows = await db().query(
    'SELECT * FROM saga_runs WHERE tenant_id=? AND project_id=? AND saga_id=? ORDER BY created_at DESC',
    [tenantId, projectId, sagaId]);
  return rows.map(row);
}

export async function getRun({ tenantId, projectId, runId }) {
  const r = (await db().query(
    'SELECT * FROM saga_runs WHERE id=? AND tenant_id=? AND project_id=?', [runId, tenantId, projectId]))[0];
  if (!r) throw Errors.notFound('saga run 不存在');
  const out = row(r);
  if (out.engine === 'temporal' && out.workflow_id && out.status === 'running') {
    // 读时合并远端状态（best-effort；远端不可达不掩盖本地记录）
    try {
      const desc = await describeWorkflow({ namespace: namespaceFor(tenantId), workflowId: out.workflow_id });
      const st = desc.status || desc?.workflowExecutionInfo?.status || '';
      out.temporal_status = st;
      if (/COMPLETED/.test(st)) {
        await setRun({ runId, patch: { status: 'succeeded', updated_at: nowMs(), finished_at: nowMs() } });
        out.status = 'succeeded';
      } else if (/FAILED|TIMED_OUT|TERMINATED|CANCELED|CANCELLED/.test(st)) {
        await setRun({ runId, patch: { status: 'failed', updated_at: nowMs(), finished_at: nowMs() } });
        out.status = 'failed';
        out.temporal_error = st;
      }
    } catch (e) {
      out.temporal_error = `describe 失败：${e.message}`.slice(0, 200);
    }
  }
  return out;
}

/** 执行历史：run + 按 seq 全序的步骤（含补偿行），供查询/重放/追溯。 */
export async function getHistory({ tenantId, projectId, runId }) {
  const run = await getRun({ tenantId, projectId, runId });
  const steps = await db().query(
    'SELECT * FROM saga_steps WHERE run_id=? AND tenant_id=? ORDER BY seq ASC', [runId, tenantId]);
  return {
    run,
    steps: steps.map((s) => ({
      ...s,
      action: s.action ? JSON.parse(s.action) : null,
      output: s.output ? JSON.parse(s.output) : null,
    })),
  };
}

/** 重放：用相同 saga 定义与 input 起一个新 run（replay_of 指向原 run）。 */
export async function replayRun({ tenantId, projectId, runId, actorId, engine }) {
  const orig = await getRun({ tenantId, projectId, runId });
  if (orig.status === 'running' || orig.status === 'compensating') {
    throw Errors.conflict('原 run 尚未结束，不能重放');
  }
  const now = nowMs();
  const newIdVal = newId('sagrn');
  const useEngine = engine || orig.engine;
  if (useEngine === 'temporal') assertTemporalConfigured();
  await db().run(
    `INSERT INTO saga_runs(id,tenant_id,saga_id,project_id,input,engine,status,replay_of,created_by,created_at,updated_at)
     VALUES(?,?,?,?,?,?, 'running',?,?,?,?)`,
    [newIdVal, tenantId, orig.saga_id, projectId, JSON.stringify(orig.input || {}), useEngine,
      runId, actorId || null, now, now]);
  await tryAudit({ tenantId, projectId, actorId, action: 'saga.run.replay',
    resourceKind: 'saga_run', resourceId: newIdVal, payload: { result: 'ok', replay_of: runId, engine: useEngine } });
  const saga = await getSaga({ tenantId, projectId, sagaId: orig.saga_id });
  if (useEngine === 'temporal') {
    const namespace = namespaceFor(tenantId);
    const { workflowId } = await submitWorkflow({
      namespace, workflowId: newIdVal,
      workflowType: 'deyi.sagaRun',
      taskQueue: 'deyi-sagas',
      input: { run_id: newIdVal, saga_id: orig.saga_id, definition: saga.definition, input: orig.input || {}, replay_of: runId },
    });
    await setRun({ runId: newIdVal, patch: { workflow_id: workflowId, updated_at: nowMs() } });
    return getRun({ tenantId, projectId, runId: newIdVal });
  }
  const run = row((await db().query('SELECT * FROM saga_runs WHERE id=?', [newIdVal]))[0]);
  return driveLocalRun({ run, definition: saga.definition, tenantId, projectId, actorId });
}

export async function cancelRun({ tenantId, projectId, runId, actorId }) {
  const run = await getRun({ tenantId, projectId, runId });
  if (run.status !== 'running' && run.status !== 'compensating') {
    throw Errors.conflict(`run 已终态（${run.status}），不可取消`);
  }
  if (run.engine === 'temporal') {
    assertTemporalConfigured();
    await cancelWorkflow({ namespace: namespaceFor(tenantId), workflowId: run.workflow_id || run.id });
  }
  // local 引擎为同步驱动：能调到 cancel 时正向流程必然已在请求内结束；
  // 此处仅处理理论上的 running 残留（标记 cancelled），不伪造"中断执行中流程"。
  const now = nowMs();
  await setRun({ runId, patch: { status: 'cancelled', updated_at: now, finished_at: now } });
  await tryAudit({ tenantId, projectId, actorId, action: 'saga.run.cancelled',
    resourceKind: 'saga_run', resourceId: runId, payload: { result: 'ok', engine: run.engine } });
  return getRun({ tenantId, projectId, runId });
}

/** offboard：按 run → steps → saga 顺序清理（FK 拓扑序由调用方保证）。 */
export async function purgeTenantSagas(tenantId) {
  await db().run('DELETE FROM saga_steps WHERE tenant_id=?', [tenantId]);
  await db().run('DELETE FROM saga_runs WHERE tenant_id=?', [tenantId]);
  await db().run('DELETE FROM sagas WHERE tenant_id=?', [tenantId]);
}
