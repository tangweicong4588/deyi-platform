/**
 * modules/agents/agents.mjs —— Agent 编排运行时域逻辑（V4.2，Track B）。
 *
 * Agent = 可版本化的业务流程定义（LangGraph StateGraph 语义，见 adapters/langgraph），
 * 由 llm / tool / hitl 节点组成的有向无环图。
 *
 * - 注册/版本：定义 JSON 不可变快照，version 递增。
 * - 执行：startRun 按编译图推进；hitl 节点触发 interrupt → 落库审批单 →
 *   run 进入 waiting_approval；decideApproval 决议后 resume。
 * - mode：live（llm 走网关真实调用）/ simulated（显式编排演练，输出标注 simulated:true）。
 * - 审计：agent.create / agent.version / agent.run.start / agent.run.waiting_approval /
 *   agent.approval.requested / agent.approval.approved / agent.approval.rejected /
 *   agent.run.succeeded / agent.run.failed / agent.run.cancelled。
 * - SoD：审批人不能是 run 发起人。
 *
 * 诚实边界：
 * - llm 节点 live 模式依赖网关上游（LiteLLM/直连）；未配置时 run 失败并如实报错，
 *   不伪造模型输出。
 * - tool 节点复用执行域 invokeTool；若工具调用本身需要审批（高风险），run 按失败
 *   结束并透出 APPROVAL_REQUIRED（嵌套审批语义留待 V4.3）。
 */
import { createHash } from 'node:crypto';
import { newId, nowMs } from '../../kernel/ids.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { ctx } from '../../kernel/context.mjs';
import { db } from '../../db/index.mjs';
import { logger } from '../../kernel/logging.mjs';
import { compileAgentDefinition } from '../../adapters/langgraph/graph.mjs';
import { runGraph, resumeGraph } from '../../adapters/langgraph/local.mjs';
import { chatInternal } from '../gateway/routes.mjs';
import { invokeTool } from '../execution/service.mjs';
import { tryAudit } from '../evidence/audit.mjs';

const SECRET_KEY_RE = /(^|_)(secret|passwd|password|api_key|token|authorization|credentials?|private_key)($|_)/i;

/** 步骤输出脱敏：疑似密钥字段打码（结构化对象），文本原样保留 */
function scrubSecrets(value) {
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => {
      const norm = String(k).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
      return [k, SECRET_KEY_RE.test(norm) ? '***' : scrubSecrets(v)];
    }));
  }
  return value;
}

const parseJson = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };

// ---------- 注册与版本 ----------

export async function registerAgent({ tenantId, projectId, actorId, key, name, description = null }) {
  if (!key || !/^[A-Za-z0-9_-]{1,64}$/.test(key)) throw Errors.badRequest('key 非法（1-64 位字母数字/_/-）');
  if (!name || !name.trim()) throw Errors.badRequest('name 必填');
  const now = nowMs();
  const id = newId('ag');
  try {
    await db().run(
      `INSERT INTO agents(id,tenant_id,project_id,key,name,description,created_by,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [id, tenantId, projectId, key, name.trim(), description, actorId, now, now]);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw Errors.conflict('同一项目下 agent key 已存在');
    throw e;
  }
  await tryAudit({ tenantId, projectId, actorId, action: 'agent.create',
    resourceKind: 'agent', resourceId: id, payload: { key, name } });
  return getAgent({ tenantId, agentId: id });
}

export async function listAgents({ tenantId, projectId, includeArchived = false }) {
  const rows = await db().query(
    `SELECT * FROM agents WHERE tenant_id=? AND project_id=? ${includeArchived ? '' : 'AND archived_at IS NULL'}
     ORDER BY created_at DESC`,
    [tenantId, projectId]);
  return rows;
}

export async function getAgent({ tenantId, agentId }) {
  const rows = await db().query('SELECT * FROM agents WHERE id=? AND tenant_id=?', [agentId, tenantId]);
  const agent = rows[0];
  if (!agent) throw Errors.notFound('Agent 不存在');
  const versions = await db().query(
    'SELECT id, version, created_by, created_at FROM agent_versions WHERE agent_id=? ORDER BY version DESC', [agentId]);
  return { ...agent, versions };
}

export async function getAgentVersion({ tenantId, agentId, version = null }) {
  const agent = await getAgent({ tenantId, agentId });
  let row;
  if (version == null) {
    const rows = await db().query(
      'SELECT * FROM agent_versions WHERE agent_id=? ORDER BY version DESC LIMIT 1', [agentId]);
    row = rows[0];
  } else {
    const rows = await db().query(
      'SELECT * FROM agent_versions WHERE agent_id=? AND version=?', [agentId, version]);
    row = rows[0];
  }
  if (!row) throw Errors.notFound('Agent 版本不存在');
  return { ...row, agent, definition: parseJson(row.definition, null) };
}

export async function createAgentVersion({ tenantId, projectId, actorId, agentId, definition }) {
  const agent = await getAgent({ tenantId, agentId });
  if (agent.project_id !== projectId) throw Errors.forbidden('Agent 不属于该项目');
  if (agent.archived_at) throw Errors.conflict('Agent 已归档，不能发版');
  const compiled = compileAgentDefinition(definition); // 抛 400 即校验失败
  const now = nowMs();
  const maxRow = await db().query(
    'SELECT MAX(version) AS m FROM agent_versions WHERE agent_id=?', [agentId]);
  const version = (maxRow[0]?.m || 0) + 1;
  const id = newId('agv');
  // definition 按传入原样做不可变快照（键序归一化，避免语义相同的 JSON 因格式不同产生歧义）
  const snapshot = JSON.stringify(definition);
  await db().run(
    `INSERT INTO agent_versions(id,tenant_id,agent_id,version,definition,created_by,created_at)
     VALUES(?,?,?,?,?,?,?)`,
    [id, tenantId, agentId, version, snapshot, actorId, now]);
  await tryAudit({ tenantId, projectId, actorId, action: 'agent.version',
    resourceKind: 'agent_version', resourceId: id,
    payload: { agent_id: agentId, version, entry: compiled.entry, node_count: compiled.nodes.size } });
  return { id, agent_id: agentId, version, created_by: actorId, created_at: now, definition };
}

// ---------- 执行 ----------

function buildExecutors({ tenantId, projectId, actorId, traceId, mode }) {
  return {
    llm: async ({ node, prompt }) => {
      if (mode === 'simulated') {
        // 显式编排演练：不调网关，输出确定性占位并明确标注
        return { text: `[simulated] ${node.name || node.id}`, prompt_preview: prompt.slice(0, 200), simulated: true };
      }
      // live：走网关全链路（白名单/预算/上游/计量）；未配置上游时抛错，run 失败
      const r = await chatInternal({
        model: node.model || 'deyi-default',
        messages: [{ role: 'user', content: prompt }],
        project: projectId,
        dataClass: 'internal',
      });
      return { text: r.text, usage: r.usage || {}, model: r.model?.name || null };
    },
    tool: async ({ node, args }) => {
      const r = await invokeTool({
        tenantId, projectId, actorId, traceId,
        toolId: node.tool, action: node.action, args,
      });
      return { result: r };
    },
  };
}

/** 驱动一次图执行，把节点/中断/终态落库。返回最终 run 行。 */
async function driveRun({ run, compiled, executors, tenantId, projectId, actorId, resumeFrom = null, decision = null }) {
  const traceId = run.id; // run 级 trace；审批事件用派生 trace
  // resume 时 seq 从已有最大值继续（run_id, seq 唯一）
  const maxSeqRow = await db().query('SELECT MAX(seq) AS m FROM agent_run_steps WHERE run_id=?', [run.id]);
  let seq = maxSeqRow[0]?.m || 0;

  const recordStep = async ({ node, output, decision: dec = null }) => {
    seq += 1;
    const now = nowMs();
    const status = node.type === 'hitl' ? (dec === 'approved' ? 'approved' : 'rejected') : 'ok';
    await db().run(
      `INSERT INTO agent_run_steps(id,tenant_id,run_id,seq,node_id,node_type,status,input,output,started_at,finished_at,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [newId('agrs'), tenantId, run.id, seq, node.id, node.type, status,
        node.type === 'hitl' ? JSON.stringify({ title: node.title || node.name }) : null,
        JSON.stringify(scrubSecrets(output || {})), now, now, now]);
  };

  const onInterrupt = async ({ node, state }) => {
    const now = nowMs();
    const approvalId = newId('aga');
    // 呈交审批人的上下文：已执行节点的输出摘要（脱敏）
    const payload = {
      agent_id: run.agent_id, version: run.version, node_id: node.id,
      title: node.title || node.name || node.id,
      context: scrubSecrets(state.steps || {}),
    };
    await db().run(
      `INSERT INTO agent_approvals(id,tenant_id,run_id,node_id,status,payload,requested_by,requested_at,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [approvalId, tenantId, run.id, node.id, 'pending', JSON.stringify(payload), run.created_by, now, now]);
    await db().run(
      `UPDATE agent_runs SET status='waiting_approval', current_node=?, state=?, updated_at=? WHERE id=?`,
      [node.id, JSON.stringify(state), now, run.id]);
    await tryAudit({ tenantId, projectId, actorId, traceId: `${traceId}:approval:${approvalId}`,
      action: 'agent.run.waiting_approval', resourceKind: 'agent_run', resourceId: run.id,
      payload: { node_id: node.id } });
    await tryAudit({ tenantId, projectId, actorId: run.created_by, traceId: `${traceId}:approval:${approvalId}`,
      action: 'agent.approval.requested', resourceKind: 'agent_approval', resourceId: approvalId,
      payload: { run_id: run.id, node_id: node.id, title: payload.title } });
    return { resume: false };
  };

  const driveOpts = {
    input: parseJson(run.input, {}),
    executors,
    onInterrupt,
    onNode: recordStep,
  };
  const result = resumeFrom
    ? await resumeGraph(compiled, { ...driveOpts, state: parseJson(run.state, {}), atNode: resumeFrom, decision })
    : await runGraph(compiled, driveOpts);

  // 中断已在 onInterrupt 里落库；这里处理终态
  const now = nowMs();
  if (result.status === 'succeeded') {
    await db().run(
      `UPDATE agent_runs SET status='succeeded', state=?, output=?, finished_at=?, updated_at=? WHERE id=?`,
      [JSON.stringify(result.state), JSON.stringify(scrubSecrets(result.state.last || {})), now, now, run.id]);
    await tryAudit({ tenantId, projectId, actorId, traceId, action: 'agent.run.succeeded',
      resourceKind: 'agent_run', resourceId: run.id, payload: {} });
  } else if (result.status === 'failed') {
    await db().run(
      `UPDATE agent_runs SET status='failed', state=?, error=?, finished_at=?, updated_at=? WHERE id=?`,
      [JSON.stringify(result.state), String(result.error).slice(0, 2000), now, now, run.id]);
    await tryAudit({ tenantId, projectId, actorId, traceId, action: 'agent.run.failed',
      resourceKind: 'agent_run', resourceId: run.id,
      payload: { node_id: result.nodeId, error: String(result.error).slice(0, 500) } });
  } else if (result.status === 'cancelled') {
    await db().run(
      `UPDATE agent_runs SET status='cancelled', state=?, error=?, finished_at=?, updated_at=? WHERE id=?`,
      [JSON.stringify(result.state), `审批拒绝: ${result.nodeId}`, now, now, run.id]);
    await tryAudit({ tenantId, projectId, actorId, traceId, action: 'agent.run.cancelled',
      resourceKind: 'agent_run', resourceId: run.id, payload: { node_id: result.nodeId, reason: 'rejected' } });
  }
  // interrupted → 状态已由 onInterrupt 落为 waiting_approval
  const rows = await db().query('SELECT * FROM agent_runs WHERE id=?', [run.id]);
  return rows[0];
}

export async function startRun({ tenantId, projectId, actorId, agentId, version = null, input = {}, mode = 'live' }) {
  if (!['live', 'simulated'].includes(mode)) throw Errors.badRequest('mode 必须是 live/simulated');
  if (input && typeof input !== 'object') throw Errors.badRequest('input 必须是对象');
  const ver = await getAgentVersion({ tenantId, agentId, version });
  if (ver.agent.project_id !== projectId) throw Errors.forbidden('Agent 不属于该项目');
  const compiled = compileAgentDefinition(ver.definition);
  const now = nowMs();
  const runId = newId('agr');
  const c = ctx();
  await db().run(
    `INSERT INTO agent_runs(id,tenant_id,project_id,agent_id,agent_version_id,version,mode,status,input,created_by,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [runId, tenantId, projectId, agentId, ver.id, ver.version, mode, 'running',
      JSON.stringify(input || {}), actorId, now, now]);
  await tryAudit({ tenantId, projectId, actorId, action: 'agent.run.start',
    resourceKind: 'agent_run', resourceId: runId,
    payload: { agent_id: agentId, version: ver.version, mode } });
  const run = (await db().query('SELECT * FROM agent_runs WHERE id=?', [runId]))[0];
  const executors = buildExecutors({ tenantId, projectId, actorId, traceId: c.traceId || runId, mode });
  const final = await driveRun({ run, compiled, executors, tenantId, projectId, actorId });
  logger.info('agent run finished', { run: runId, status: final.status, mode });
  return presentRun(final);
}

export async function decideApproval({ tenantId, projectId, actorId, runId, approved, note = null }) {
  const rows = await db().query('SELECT * FROM agent_runs WHERE id=? AND tenant_id=?', [runId, tenantId]);
  const run = rows[0];
  if (!run) throw Errors.notFound('执行记录不存在');
  if (run.project_id !== projectId) throw Errors.forbidden('执行记录不属于该项目');
  if (run.status !== 'waiting_approval') throw Errors.conflict(`当前状态 ${run.status} 不需要审批`);
  const apRows = await db().query(
    `SELECT * FROM agent_approvals WHERE run_id=? AND node_id=? AND status='pending' ORDER BY requested_at DESC LIMIT 1`,
    [runId, run.current_node]);
  const approval = apRows[0];
  if (!approval) throw Errors.conflict('没有待处理的审批单');
  // SoD：发起人不能审批自己的 run
  if (approval.requested_by === actorId) {
    throw Errors.forbidden('不能审批自己发起的执行（SoD）');
  }
  const now = nowMs();
  const decision = approved ? 'approved' : 'rejected';
  const r = await db().run(
    `UPDATE agent_approvals SET status=?, decided_by=?, decided_at=?, note=? WHERE id=? AND status='pending'`,
    [decision, actorId, now, note, approval.id]);
  if (r.changes === 0) throw Errors.conflict('审批单已被处理');
  const traceId = `${run.id}:approval:${approval.id}`;
  await tryAudit({ tenantId, projectId, actorId, traceId,
    action: approved ? 'agent.approval.approved' : 'agent.approval.rejected',
    resourceKind: 'agent_approval', resourceId: approval.id,
    payload: { run_id: runId, node_id: approval.node_id, note: note || null } });

  const ver = await getAgentVersion({ tenantId, agentId: run.agent_id, version: run.version });
  const compiled = compileAgentDefinition(ver.definition);
  const c = ctx();
  const executors = buildExecutors({ tenantId, projectId, actorId, traceId: c.traceId || run.id, mode: run.mode });
  // run 恢复为 running，resume 后由 driveRun 落终态
  await db().run(`UPDATE agent_runs SET status='running', updated_at=? WHERE id=?`, [now, run.id]);
  const fresh = (await db().query('SELECT * FROM agent_runs WHERE id=?', [runId]))[0];
  const final = await driveRun({
    run: fresh, compiled, executors, tenantId, projectId, actorId,
    resumeFrom: run.current_node, decision,
  });
  return presentRun(final);
}

export async function getRun({ tenantId, projectId, runId }) {
  const rows = await db().query('SELECT * FROM agent_runs WHERE id=? AND tenant_id=?', [runId, tenantId]);
  const run = rows[0];
  if (!run) throw Errors.notFound('执行记录不存在');
  if (run.project_id !== projectId) throw Errors.forbidden('执行记录不属于该项目');
  const steps = await db().query(
    'SELECT * FROM agent_run_steps WHERE run_id=? ORDER BY seq ASC', [runId]);
  const approvals = await db().query(
    'SELECT * FROM agent_approvals WHERE run_id=? ORDER BY requested_at ASC', [runId]);
  return { ...presentRun(run), steps: steps.map(presentStep), approvals: approvals.map(presentApproval) };
}

export async function listRuns({ tenantId, projectId, agentId, status = null, limit = 50 }) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const rows = await db().query(
    `SELECT * FROM agent_runs WHERE tenant_id=? AND project_id=? AND agent_id=?
     ${status ? 'AND status=?' : ''} ORDER BY created_at DESC LIMIT ?`,
    status ? [tenantId, projectId, agentId, status, lim] : [tenantId, projectId, agentId, lim]);
  return rows.map(presentRun);
}

function presentRun(r) {
  return {
    id: r.id, agent_id: r.agent_id, version: r.version, mode: r.mode, status: r.status,
    current_node: r.current_node,
    input: parseJson(r.input, {}), output: parseJson(r.output, null), error: r.error,
    created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at, finished_at: r.finished_at,
  };
}
function presentStep(s) {
  return {
    id: s.id, seq: s.seq, node_id: s.node_id, node_type: s.node_type, status: s.status,
    input: parseJson(s.input, null), output: parseJson(s.output, null),
    started_at: s.started_at, finished_at: s.finished_at,
  };
}
function presentApproval(a) {
  return {
    id: a.id, run_id: a.run_id, node_id: a.node_id, status: a.status,
    payload: parseJson(a.payload, {}),
    requested_by: a.requested_by, requested_at: a.requested_at,
    decided_by: a.decided_by, decided_at: a.decided_at, note: a.note,
  };
}
