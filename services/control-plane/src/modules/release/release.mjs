/**
 * modules/release/release.mjs —— V3.2 多环境发布与部署策略。
 *
 * 发布单：environment（dev/staging/prod）× strategy（canary/blue_green/rolling）。
 * - 审批：requires_approval（默认 prod 必须）时 draft→pending_approval→approved/
 *   rejected；SoD：审批人≠发起人（与 V4.1 审批单同语义）。
 *   approval.source='manual'；V4.2 HITL 落地后可接入审批节点（source='hitl'）。
 * - 执行：startRelease 按策略生成步骤并顺序执行。mode='simulated' 为显式标注的
 *   编排演练（每步 result.simulated=true）；mode='runner' 走隔离 Runner 真实执行
 *   部署脚本（deploy_spec.commands 结构化 argv，经 prevalidateRunnerInput 校验）。
 * - 失败语义：任一步骤失败 → 自动生成回滚步骤并执行 → rolled_back；
 *   也支持失败/成功后手动 rollbackRelease。
 * - 边界：V3.2 在请求内同步执行步骤（长耗时部署的异步化随 Temporal/Phase 4 展开）；
 *   无健康检查命令时 runner 模式健康检查默认通过（如实记录）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Errors } from '../../kernel/errors.mjs';
import { newId } from '../../kernel/ids.mjs';
import { ctx, newTraceId } from '../../kernel/context.mjs';
import { db } from '../../db/index.mjs';
import { tryAudit } from '../evidence/audit.mjs';
import { getChangePackage } from '../delivery/service.mjs';
import {
  execute as runnerExecute,
  runnerRoot,
} from '../../adapters/runner/isolated.mjs';

const nowMs = () => Date.now();

export const STRATEGIES = new Set(['canary', 'blue_green', 'rolling']);
export const RELEASE_STATUSES = new Set([
  'draft', 'pending_approval', 'approved', 'rejected',
  'deploying', 'succeeded', 'failed', 'rolled_back',
]);
export const DEFAULT_ENVIRONMENTS = [
  { key: 'dev', name: '开发环境' },
  { key: 'staging', name: '预发布环境' },
  { key: 'prod', name: '生产环境' },
];

const parseJson = (v, fb) => { try { const o = JSON.parse(v); return o ?? fb; } catch { return fb; } };

function rowToRelease(r) {
  if (!r) return null;
  return {
    ...r,
    requires_approval: !!r.requires_approval,
    strategy_config: parseJson(r.strategy_config, {}),
    approval: r.approval ? parseJson(r.approval, null) : null,
    deploy_spec: parseJson(r.deploy_spec, {}),
    health_check_spec: parseJson(r.health_check_spec, {}),
  };
}
const rowToStep = (r) => r ? {
  ...r,
  target: parseJson(r.target, {}),
  result: parseJson(r.result, {}),
} : null;

// ---------- environments ----------

export async function ensureDefaultEnvironments(tenantId, projectId, actorId) {
  const now = nowMs();
  const out = [];
  for (const e of DEFAULT_ENVIRONMENTS) {
    const id = newId('de');
    await db().run(
      `INSERT INTO deploy_environments(id,tenant_id,project_id,key,name,created_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(project_id, key) DO NOTHING`,
      [id, tenantId, projectId, e.key, e.name, now]);
    const rows = await db().query(
      'SELECT * FROM deploy_environments WHERE tenant_id=? AND project_id=? AND key=?',
      [tenantId, projectId, e.key]);
    out.push(rows[0]);
  }
  await tryAudit({
    tenantId, projectId, actorId, action: 'release.environment.ensure',
    resourceKind: 'deploy_environment', resourceId: projectId,
    payload: { keys: DEFAULT_ENVIRONMENTS.map((e) => e.key) },
  });
  return out;
}

export async function createEnvironment(tenantId, projectId, actorId, { key, name }) {
  const k = String(key || '').trim().toLowerCase();
  if (!/^[a-z0-9-]{1,32}$/.test(k)) throw Errors.badRequest('key 须为 1-32 位小写字母/数字/连字符');
  if (!String(name || '').trim()) throw Errors.badRequest('name 必填');
  const id = newId('de');
  try {
    await db().run(
      'INSERT INTO deploy_environments(id,tenant_id,project_id,key,name,created_at) VALUES (?,?,?,?,?,?)',
      [id, tenantId, projectId, k, String(name).trim(), nowMs()]);
  } catch (e) {
    throw Errors.conflict(`环境 key 已存在: ${k}`);
  }
  await tryAudit({
    tenantId, projectId, actorId, action: 'release.environment.create',
    resourceKind: 'deploy_environment', resourceId: id, payload: { key: k },
  });
  return (await db().query('SELECT * FROM deploy_environments WHERE id=?', [id]))[0];
}

export async function listEnvironments(tenantId, projectId) {
  return db().query(
    'SELECT * FROM deploy_environments WHERE tenant_id=? AND project_id=? ORDER BY created_at ASC',
    [tenantId, projectId]);
}

async function getEnvironmentRow(tenantId, projectId, environmentKey) {
  const rows = await db().query(
    'SELECT * FROM deploy_environments WHERE tenant_id=? AND project_id=? AND key=?',
    [tenantId, projectId, environmentKey]);
  if (!rows[0]) throw Errors.notFound(`环境不存在: ${environmentKey}（可先调 ensure-defaults）`);
  return rows[0];
}

// ---------- releases ----------

function validateStrategyConfig(strategy, cfg) {
  if (!STRATEGIES.has(strategy)) throw Errors.badRequest(`strategy 必须为 ${[...STRATEGIES].join('/')}`);
  cfg = cfg && typeof cfg === 'object' ? cfg : {};
  if (strategy === 'canary') {
    const steps = cfg.steps;
    if (!Array.isArray(steps) || steps.length < 2 || steps.length > 10) {
      throw Errors.badRequest('canary.steps 须为 2-10 个百分比');
    }
    let prev = 0;
    for (const s of steps) {
      if (typeof s !== 'number' || !(s > 0) || s > 100) throw Errors.badRequest('canary.steps 元素须为 (0,100]');
      if (s <= prev) throw Errors.badRequest('canary.steps 须严格递增');
      prev = s;
    }
    if (prev !== 100) throw Errors.badRequest('canary.steps 最后一步须为 100');
  }
  if (strategy === 'rolling') {
    const b = Number(cfg.batches);
    if (!Number.isInteger(b) || b < 2 || b > 20) throw Errors.badRequest('rolling.batches 须为 2-20 的整数');
  }
  return cfg;
}

function validateCommands(commands, field) {
  if (commands === undefined || commands === null) return;
  if (!Array.isArray(commands)) throw Errors.badRequest(`${field}.commands 须为数组`);
  // 形状预检（与 Runner assertCommand 同口径：对象 {argv:[...]}，禁止 shell 字符串）；
  // 完整的 jail 校验在执行时由 Runner 的 prevalidateRunnerInput 完成。
  commands.forEach((c, i) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      throw Errors.badRequest(`${field}.commands[${i}] 必须为对象 {argv:[...]}，禁止 shell 字符串`);
    }
    const { argv } = c;
    if (!Array.isArray(argv) || argv.length === 0
      || !argv.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 4096)) {
      throw Errors.badRequest(`${field}.commands[${i}].argv 必须为非空字符串数组`);
    }
  });
}

export async function createRelease({ tenantId, projectId, actorId, body }) {
  const {
    environment_key: envKey, version, strategy,
    strategy_config: strategyConfig = {},
    change_package_id: changePackageId = null,
    deploy = {}, health_check: healthCheck = {},
    requires_approval: requiresApproval,
  } = body || {};
  const env = await getEnvironmentRow(tenantId, projectId, envKey);
  if (!String(version || '').trim()) throw Errors.badRequest('version 必填');
  const cfg = validateStrategyConfig(strategy, strategyConfig);
  validateCommands(deploy.commands, 'deploy');
  validateCommands(healthCheck.commands, 'health_check');
  if (changePackageId) {
    await getChangePackage(tenantId, projectId, changePackageId).catch(() => {
      throw Errors.badRequest('change_package_id 不存在或不属于本项目');
    });
  }
  const id = newId('rel');
  const now = nowMs();
  const needApproval = requiresApproval !== undefined ? !!requiresApproval : env.key === 'prod';
  await db().run(
    `INSERT INTO releases(id,tenant_id,project_id,environment_id,change_package_id,version,
       strategy,strategy_config,status,requires_approval,deploy_spec,health_check_spec,
       created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, projectId, env.id, changePackageId, String(version).trim(), strategy,
      JSON.stringify(cfg), 'draft', needApproval ? 1 : 0,
      JSON.stringify({ commands: deploy.commands || [], env: deploy.env || {} }),
      JSON.stringify({ commands: healthCheck.commands || [] }),
      actorId, now, now]);
  await tryAudit({
    tenantId, projectId, actorId, action: 'release.create',
    resourceKind: 'release', resourceId: id,
    payload: { version: String(version).trim(), strategy, environment: env.key, requires_approval: needApproval },
  });
  return rowToRelease((await db().query('SELECT * FROM releases WHERE id=?', [id]))[0]);
}

async function getReleaseRow(tenantId, projectId, releaseId) {
  const rows = await db().query(
    'SELECT * FROM releases WHERE id=? AND tenant_id=? AND project_id=?',
    [releaseId, tenantId, projectId]);
  const r = rowToRelease(rows[0]);
  if (!r) throw Errors.notFound('发布单不存在');
  return r;
}

export async function getRelease(tenantId, projectId, releaseId) {
  const release = await getReleaseRow(tenantId, projectId, releaseId);
  const steps = (await db().query(
    'SELECT * FROM release_steps WHERE release_id=? ORDER BY seq ASC', [releaseId])).map(rowToStep);
  const env = (await db().query('SELECT * FROM deploy_environments WHERE id=?', [release.environment_id]))[0];
  return { release, steps, environment: env };
}

export async function listReleases(tenantId, projectId, { status, environment_key: envKey } = {}) {
  const conds = ['r.tenant_id=?', 'r.project_id=?'];
  const args = [tenantId, projectId];
  if (status) {
    if (!RELEASE_STATUSES.has(status)) throw Errors.badRequest(`非法状态: ${status}`);
    conds.push('r.status=?'); args.push(status);
  }
  if (envKey) { conds.push('e.key=?'); args.push(envKey); }
  const rows = await db().query(
    `SELECT r.*, e.key AS env_key FROM releases r
     JOIN deploy_environments e ON e.id=r.environment_id
     WHERE ${conds.join(' AND ')} ORDER BY r.created_at DESC LIMIT 200`, args);
  return rows.map(rowToRelease);
}

// ---------- approval ----------

export async function requestApproval({ tenantId, projectId, actorId, releaseId }) {
  const rel = await getReleaseRow(tenantId, projectId, releaseId);
  if (!rel.requires_approval) throw Errors.badRequest('该发布单不需要审批');
  if (rel.status !== 'draft') throw Errors.badRequest(`只有 draft 可发起审批，当前 ${rel.status}`);
  const now = nowMs();
  const approval = { required: true, requested_by: actorId, requested_at: now, decision: 'pending', source: 'manual' };
  await db().run('UPDATE releases SET status=?, approval=?, updated_at=? WHERE id=? AND tenant_id=?',
    ['pending_approval', JSON.stringify(approval), now, releaseId, tenantId]);
  await tryAudit({
    tenantId, projectId, actorId, action: 'release.approval.request',
    resourceKind: 'release', resourceId: releaseId, payload: {},
  });
  return getReleaseRow(tenantId, projectId, releaseId);
}

/** 发布审批：SoD——发起人不能审批自己的发布单（V4.2 HITL 落地后 source 可为 'hitl'）。 */
export async function decideApproval({ tenantId, projectId, actorId, releaseId, approved, note = '' }) {
  const rel = await getReleaseRow(tenantId, projectId, releaseId);
  if (rel.status !== 'pending_approval') throw Errors.badRequest(`当前状态 ${rel.status} 不可审批`);
  if (rel.created_by === actorId) {
    throw Errors.forbidden('发布审批需职责分离：发起人不能审批自己的发布单', { code: 'SOD_VIOLATION' });
  }
  const now = nowMs();
  const approval = {
    ...(rel.approval || {}), decision: approved ? 'approved' : 'rejected',
    decided_by: actorId, decided_at: now,
    note: String(note).slice(0, 2000), source: 'manual',
  };
  const to = approved ? 'approved' : 'rejected';
  await db().run('UPDATE releases SET status=?, approval=?, updated_at=? WHERE id=? AND tenant_id=?',
    [to, JSON.stringify(approval), now, releaseId, tenantId]);
  await tryAudit({
    tenantId, projectId, actorId, action: 'release.approval.decide',
    resourceKind: 'release', resourceId: releaseId,
    payload: { decision: approval.decision, requested_by: approval.requested_by },
  });
  return getReleaseRow(tenantId, projectId, releaseId);
}

// ---------- step plan ----------

function buildStepPlan(rel) {
  const cfg = rel.strategy_config;
  const plan = [];
  const push = (kind, label, target = {}) => plan.push({ kind, label, target });
  if (rel.strategy === 'canary') {
    for (const pct of cfg.steps) {
      push('deploy', `金丝雀部署 ${pct}%`, { percentage: pct });
      push('health_check', `健康检查 ${pct}%`, { percentage: pct });
    }
    push('promote', '全量确认（100%）', { percentage: 100 });
    push('verify', '发布验证');
  } else if (rel.strategy === 'blue_green') {
    push('deploy', '部署 Green 环境', { slot: 'green' });
    push('health_check', 'Green 健康检查', { slot: 'green' });
    push('promote', '流量切换 Blue→Green', { from: 'blue', to: 'green' });
    push('verify', '发布验证');
  } else { // rolling
    const n = cfg.batches;
    for (let i = 1; i <= n; i++) {
      push('deploy', `滚动部署批次 ${i}/${n}`, { batch: `${i}/${n}` });
      push('health_check', `批次 ${i}/${n} 健康检查`, { batch: `${i}/${n}` });
    }
    push('verify', '发布验证');
  }
  return plan;
}

function buildRollbackPlan(rel) {
  // 策略感知的回滚步骤：恢复到发布前状态
  if (rel.strategy === 'canary') return [
    { kind: 'rollback', label: '回滚：金丝雀流量收回 0%', target: { percentage: 0 } },
    { kind: 'verify', label: '回滚后验证', target: {} },
  ];
  if (rel.strategy === 'blue_green') return [
    { kind: 'rollback', label: '回滚：流量切回 Blue', target: { from: 'green', to: 'blue' } },
    { kind: 'verify', label: '回滚后验证', target: {} },
  ];
  return [
    { kind: 'rollback', label: '回滚：重部署上一版本', target: {} },
    { kind: 'verify', label: '回滚后验证', target: {} },
  ];
}

async function setReleaseStatus(tenantId, releaseId, status) {
  await db().run('UPDATE releases SET status=?, updated_at=? WHERE id=? AND tenant_id=?',
    [status, nowMs(), releaseId, tenantId]);
}

// ---------- step execution ----------

async function executeOneStep({ tenantId, projectId, actorId, rel, step, mode }) {
  const failAt = (rel.strategy_config.simulate_fail_at || []);
  // 审计幂等去重的键含 trace_id：同一次 start 内多个步骤事件必须各有独立 trace，
  // 否则会被去重吞掉。用层级 trace（<parent>:step:<seq>）保留追溯关联。
  const c = ctx() || {};
  const stepTraceId = `${c.traceId || newTraceId()}:step:${step.seq}`;
  await db().run('UPDATE release_steps SET status=?, started_at=? WHERE id=?',
    ['running', nowMs(), step.id]);
  let result;
  try {
    if (mode === 'simulated') {
      result = { simulated: true, ok: !failAt.includes(step.seq) };
    } else {
      result = await executeViaRunner(rel, step);
    }
    if (!result.ok) throw new Error(result.error || `步骤执行失败（exit=${result.exit_code ?? '?'}`);
    await db().run('UPDATE release_steps SET status=?, result=?, finished_at=? WHERE id=?',
      ['succeeded', JSON.stringify(result), nowMs(), step.id]);
    await tryAudit({
      tenantId, projectId, actorId, traceId: stepTraceId, action: 'release.step',
      resourceKind: 'release', resourceId: rel.id,
      payload: { seq: step.seq, kind: step.kind, label: step.label, simulated: !!result.simulated },
    });
    return { ok: true, result };
  } catch (e) {
    const failResult = { simulated: mode === 'simulated', ok: false, error: String((e && e.message) || e).slice(0, 500) };
    await db().run('UPDATE release_steps SET status=?, result=?, finished_at=? WHERE id=?',
      ['failed', JSON.stringify(failResult), nowMs(), step.id]);
    await tryAudit({
      tenantId, projectId, actorId, traceId: stepTraceId, action: 'release.step.failed',
      resourceKind: 'release', resourceId: rel.id,
      payload: { seq: step.seq, kind: step.kind, label: step.label, error: failResult.error },
    });
    return { ok: false, result: failResult };
  }
}

/** runner 模式：部署/健康检查/回滚步骤走隔离 Runner 真实执行配置的命令。 */
async function executeViaRunner(rel, step) {
  const spec = step.kind === 'health_check' ? rel.health_check_spec : rel.deploy_spec;
  const commands = spec.commands || [];
  if (commands.length === 0) {
    // 如实记录：无命令可执行（健康检查默认通过；部署/回滚无命令则失败）
    if (step.kind === 'health_check' || step.kind === 'verify' || step.kind === 'promote') {
      return { simulated: false, ok: true, note: 'no commands configured, treated as no-op' };
    }
    return { simulated: false, ok: false, error: '未配置部署命令（deploy.commands 为空）' };
  }
  const workdir = mkdtempSync(join(runnerRoot(), 'release-'));
  try {
    const execResult = await runnerExecute({
      workdir,
      commands,
      env: { ...(rel.deploy_spec.env || {}), DEYI_RELEASE_ID: rel.id, DEYI_STEP_SEQ: String(step.seq) },
      limits: { timeoutMs: 120000, stepTimeoutMs: 600000 },
      mode: 'live',
    });
    const ok = execResult.ok === true;
    return {
      simulated: false, ok,
      exit_code: execResult.exitCode,
      status: execResult.status,
      output_truncated: (execResult.commands || []).map((r) => ({
        cmd: r.argv, exit: r.exitCode,
        stdout: String(r.stdout || '').slice(-2000), stderr: String(r.stderr || '').slice(-2000),
      })),
    };
  } finally {
    try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

async function insertSteps(tenantId, releaseId, plan, startSeq) {
  const now = nowMs();
  for (let i = 0; i < plan.length; i++) {
    await db().run(
      `INSERT INTO release_steps(id,tenant_id,release_id,seq,kind,label,target,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [newId('rels'), tenantId, releaseId, startSeq + i, plan[i].kind, plan[i].label,
        JSON.stringify(plan[i].target || {}), 'pending', now]);
  }
}

/**
 * 启动发布：生成步骤计划并顺序执行（V3.2 同步执行）。
 * 前置：requires_approval 的须已 approved；否则须为 draft。
 */
export async function startRelease({ tenantId, projectId, actorId, releaseId, mode = 'simulated' }) {
  if (!['simulated', 'runner'].includes(mode)) throw Errors.badRequest("mode 必须为 simulated|runner");
  const rel = await getReleaseRow(tenantId, projectId, releaseId);
  if (rel.requires_approval) {
    if (rel.status !== 'approved') throw Errors.badRequest(`需审批的发布单当前状态 ${rel.status}，须先审批通过`);
  } else if (rel.status !== 'draft') {
    throw Errors.badRequest(`只有 draft 可启动，当前 ${rel.status}`);
  }
  if (mode === 'runner') {
    const cmds = (rel.deploy_spec.commands || []).length;
    if (cmds === 0) throw Errors.badRequest('runner 模式要求发布单配置 deploy.commands');
  }
  const plan = buildStepPlan(rel);
  await insertSteps(tenantId, releaseId, plan, 1);
  await setReleaseStatus(tenantId, releaseId, 'deploying');
  await tryAudit({
    tenantId, projectId, actorId, action: 'release.start',
    resourceKind: 'release', resourceId: releaseId,
    payload: { mode, strategy: rel.strategy, steps: plan.length },
  });

  let seq = 1;
  for (const p of plan) {
    const step = rowToStep((await db().query(
      'SELECT * FROM release_steps WHERE release_id=? AND seq=?', [releaseId, seq]))[0]);
    const r = await executeOneStep({ tenantId, projectId, actorId, rel, step, mode });
    if (!r.ok) {
      // 自动回滚：先把原计划剩余 pending 步骤标记 skipped，再把回滚步骤追加到最大 seq 之后
      await db().run(
        `UPDATE release_steps SET status='skipped' WHERE release_id=? AND status='pending' AND seq>?`,
        [releaseId, seq]);
      const maxRow = (await db().query(
        'SELECT MAX(seq) AS m FROM release_steps WHERE release_id=?', [releaseId]))[0];
      const maxSeq = maxRow?.m || 0;
      const rbPlan = buildRollbackPlan(rel);
      await insertSteps(tenantId, releaseId, rbPlan, maxSeq + 1);
      let rbOk = true;
      for (let j = 0; j < rbPlan.length; j++) {
        const rbStep = rowToStep((await db().query(
          'SELECT * FROM release_steps WHERE release_id=? AND seq=?', [releaseId, maxSeq + 1 + j]))[0]);
        const rr = await executeOneStep({ tenantId, projectId, actorId, rel, step: rbStep, mode });
        if (!rr.ok) { rbOk = false; break; }
      }
      await setReleaseStatus(tenantId, releaseId, rbOk ? 'rolled_back' : 'failed');
      await tryAudit({
        tenantId, projectId, actorId, action: 'release.rollback',
        resourceKind: 'release', resourceId: releaseId,
        payload: { trigger: 'auto', failed_seq: seq, rollback_ok: rbOk },
      });
      return getRelease(tenantId, projectId, releaseId);
    }
    seq++;
  }
  await setReleaseStatus(tenantId, releaseId, 'succeeded');
  await tryAudit({
    tenantId, projectId, actorId, action: 'release.succeeded',
    resourceKind: 'release', resourceId: releaseId, payload: { mode },
  });
  return getRelease(tenantId, projectId, releaseId);
}

/** 手动回滚：failed 或 succeeded 的发布单可回滚（幂等：已 rolled_back 直接返回）。 */
export async function rollbackRelease({ tenantId, projectId, actorId, releaseId, mode = 'simulated' }) {
  if (!['simulated', 'runner'].includes(mode)) throw Errors.badRequest("mode 必须为 simulated|runner");
  const rel = await getReleaseRow(tenantId, projectId, releaseId);
  if (rel.status === 'rolled_back') return getRelease(tenantId, projectId, releaseId);
  if (!['failed', 'succeeded'].includes(rel.status)) {
    throw Errors.badRequest(`只有 failed/succeeded 可手动回滚，当前 ${rel.status}`);
  }
  const maxSeq = (await db().query(
    'SELECT MAX(seq) AS m FROM release_steps WHERE release_id=?', [releaseId]))[0]?.m || 0;
  const rbPlan = buildRollbackPlan(rel);
  await insertSteps(tenantId, releaseId, rbPlan, maxSeq + 1);
  let rbOk = true;
  for (let j = 0; j < rbPlan.length; j++) {
    const rbStep = rowToStep((await db().query(
      'SELECT * FROM release_steps WHERE release_id=? AND seq=?', [releaseId, maxSeq + 1 + j]))[0]);
    const rr = await executeOneStep({ tenantId, projectId, actorId, rel, step: rbStep, mode });
    if (!rr.ok) { rbOk = false; break; }
  }
  await setReleaseStatus(tenantId, releaseId, rbOk ? 'rolled_back' : 'failed');
  await tryAudit({
    tenantId, projectId, actorId, action: 'release.rollback',
    resourceKind: 'release', resourceId: releaseId,
    payload: { trigger: 'manual', rollback_ok: rbOk },
  });
  return getRelease(tenantId, projectId, releaseId);
}
