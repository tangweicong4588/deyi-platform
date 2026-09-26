/**
 * modules/delivery/steps.mjs —— 分层验证的 Step 执行服务（V1.0-D，方案 p20/p23）。
 *
 * step 类型：build | test | scan | package。
 * 每个 step = 一次隔离 Runner 执行 + 结果落库（runner_runs, run_）：
 * - build 失败 → 阻断（blocked:true，DoD build 项打叉）；
 * - test 失败 → 关联回 AC（该需求下 pending 的 auto AC 标记 failed，证据指向 run）；
 * - scan 高危 → 阻断（沿用 p23 门禁语义：exit!=0 或 critical/high>0 即阻断，fail-closed）；
 * - package 失败 → 阻断（无产物不可移交）。
 *
 * 产物收集：step 声明的 artifacts [{kind, path}] 在工作区内读取、sha256 后
 * 登记为 artifacts（art_，content_hash 校验沿用 V1.0-A），供"变更就绪"门禁消费。
 *
 * reproduce：DoD"独立复现"的核心证据——在全新独立工作区重跑最近一次
 * build+test，对比 exit code + 关键产物 hash，一致则 dod_checklist.reproduce 打勾。
 * simulated（fake）基线拒绝复现：fake 不能证明 DoD。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Errors } from '../../kernel/errors.mjs';
import { nowMs } from '../../kernel/ids.mjs';
import { tryAudit } from '../evidence/audit.mjs';
import { logger } from '../../kernel/logging.mjs';
import * as store from './store.mjs';
import * as dsvc from './service.mjs';
import {
  execute as runnerExecute,
  prepareWorkspace,
  prevalidateRunnerInput,
  cleanupWorkspace,
  runnerRoot,
  currentRunnerMode,
  resolveInWorkspace,
} from '../../adapters/runner/isolated.mjs';

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_LOG_BYTES = 4 * 1024 * 1024;

const sha256File = (abs) => {
  const h = createHash('sha256');
  h.update(readFileSync(abs));
  return h.digest('hex');
};

/** 扫描报告 severity 提取（best-effort，支持常见形状；解析不出则返回 null） */
export function extractSeverities(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const pick = (o) => {
    if (!o || typeof o !== 'object') return null;
    const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0);
    if (o.critical !== undefined || o.high !== undefined) {
      return { critical: n(o.critical), high: n(o.high), moderate: n(o.moderate), low: n(o.low) };
    }
    return null;
  };
  return pick(obj.severities) || pick(obj.summary)
    || pick(obj.metadata && obj.metadata.vulnerabilities) || null;
}

function capLog(log) {
  if (log.length <= MAX_LOG_BYTES) return { log, truncated: false };
  return { log: log.slice(0, MAX_LOG_BYTES) + '\n…[truncated: 合并日志超过 4MB，已截断]', truncated: true };
}

function writeLogFile(runId, log) {
  const dir = join(runnerRoot(), 'logs');
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, `${runId}.log`);
  writeFileSync(abs, log, 'utf8');
  return `file://${abs}`;
}

/**
 * runStep({ tenantId, projectId, changePackageId, actorId, step, name,
 *           commands, env, limits, artifacts, reportFile, sourceDir, source })
 * artifacts: [{ kind, path }]（path 为工作区内相对路径）
 * reportFile: 扫描报告 JSON 的工作区内相对路径（仅 scan）
 * sourceDir/source: 源码来源（{kind:'dir',path,ref?}），不传则为空工作区
 */
export async function runStep({ tenantId, projectId, changePackageId, actorId,
  step, name = '', commands, env, limits, artifacts = [], reportFile = null,
  sourceDir = null, source = null }) {
  if (!store.RUNNER_STEPS.has(step)) {
    throw Errors.badRequest(`step 非法: ${step}（仅 build|test|scan|package）`);
  }
  if (!Array.isArray(commands) || commands.length === 0) {
    throw Errors.badRequest('commands 必填（非空数组）');
  }
  const chg = await dsvc.getChangePackage(tenantId, projectId, changePackageId); // 归属校验

  // M-12 安全 review：先验证再落库。工作区物化 + commands/env 全量校验
  // （密钥铁律、jail、危险变量名）必须在 createRunnerRun 持久化 env 之前完成，
  // 否则非法 env（含明文密钥）会以 pending run 的形式残留脏数据。
  const src = source || (sourceDir ? { kind: 'dir', path: sourceDir } : { kind: 'empty' });
  let wsDir;
  let materialization;
  try {
    ({ dir: wsDir, materialization } = prepareWorkspace({ source: src, label: `${step}:${Date.now().toString(36)}` }));
    prevalidateRunnerInput({ workdir: wsDir, commands, env });
  } catch (e) {
    if (wsDir) cleanupWorkspace(wsDir);
    throw e;
  }

  const run = await store.createRunnerRun({
    tenantId, projectId, changePackageId, step, name,
    commands, env: env || {}, limits: limits || {}, createdBy: actorId,
  });

  const mode = currentRunnerMode();

  let execResult;
  let collected = [];
  let scanSeverities = null;
  let scanNote = null;
  try {
    await store.setRunnerRunRunning(tenantId, run.id, {
      simulated: mode === 'fake', limits: limits || {}, workspaceRef: materialization, startedAt: nowMs(),
    });
    execResult = await runnerExecute({
      workdir: wsDir, commands, env, limits: limits || {}, mode,
    });

    // ---- 产物收集（必须在工作区销毁前）：工作区内相对路径 → sha256 → artifacts 登记 ----
    if (artifacts !== undefined && artifacts !== null && !Array.isArray(artifacts)) {
      throw Errors.badRequest('artifacts 必须为数组 [{kind, path}]');
    }
    for (const a of artifacts || []) {
      const kind = a && a.kind;
      const relPath = a && a.path;
      if (!kind || !relPath) throw Errors.badRequest('artifacts 元素必须含 kind 与 path');
      const abs = resolveInWorkspace(wsDir, String(relPath), 'artifacts[].path');
      let st;
      try { st = statSync(abs); } catch {
        throw Errors.badRequest(`产物文件不存在: ${relPath}`, { code: 'ARTIFACT_NOT_FOUND' });
      }
      if (!st.isFile()) throw Errors.badRequest(`产物不是文件: ${relPath}`, { code: 'ARTIFACT_NOT_FILE' });
      if (st.size > MAX_ARTIFACT_BYTES) {
        throw Errors.badRequest(`产物过大（>${MAX_ARTIFACT_BYTES} 字节）: ${relPath}`, { code: 'ARTIFACT_TOO_LARGE' });
      }
      const contentHash = sha256File(abs);
      // content_hash 校验沿用 V1.0-A（registerArtifact 校验 kind/hash 格式）
      const art = await dsvc.registerArtifact(tenantId, projectId, changePackageId, {
        kind, contentHash, uri: `runner_run:${run.id}:${relPath}`,
      });
      collected.push({ artifactId: art.id, kind, path: String(relPath), contentHash });
    }

    // ---- scan 报告解析（p23 门禁语义：critical/high>0 即阻断，fail-closed） ----
    if (step === 'scan' && reportFile) {
      const abs = resolveInWorkspace(wsDir, String(reportFile), 'reportFile');
      try {
        const parsed = JSON.parse(readFileSync(abs, 'utf8'));
        scanSeverities = extractSeverities(parsed);
        if (!scanSeverities) scanNote = '报告无可识别的 severity 汇总，按 exit code 判定';
      } catch (e) {
        scanNote = `报告不可读（${String((e && e.message) || e).slice(0, 120)}），fail-closed 阻断`;
      }
    }
  } catch (e) {
    // 执行/产物收集阶段抛错（如 PATH_ESCAPE、ARTIFACT_NOT_FOUND）：run 记 failed，
    // 原错误继续抛出（调用方得正确 4xx），避免 run 卡死在 running
    const msg = `step 异常终止: ${String((e && e.message) || e).slice(0, 500)}`;
    try {
      await store.finishRunnerRun(tenantId, run.id, {
        status: 'failed', exitCode: null, signal: null,
        logText: msg, logUri: writeLogFile(run.id, msg),
        artifacts: [], durationMs: 0, finishedAt: nowMs(),
      });
    } catch { /* 落库失败也不吞掉原始错误 */ }
    throw e;
  } finally {
    cleanupWorkspace(wsDir); // 工作区即用即毁（防磁盘堆积）；日志/产物已落库
  }

  const capped = capLog(execResult.log);
  const logUri = writeLogFile(run.id, capped.log);
  const finished = await store.finishRunnerRun(tenantId, run.id, {
    status: execResult.status,
    exitCode: execResult.exitCode,
    signal: execResult.signal,
    logText: capped.log,
    logUri,
    artifacts: collected,
    durationMs: execResult.durationMs,
    finishedAt: nowMs(),
  });

  // ---- 失败策略 ----
  const policy = { blocked: false, reasons: [], acFailed: [], scan: scanSeverities, scanNote };
  const failed = execResult.status !== 'passed';
  if (step === 'build' && failed) {
    policy.blocked = true;
    policy.reasons.push(`build 失败（status=${execResult.status}），阻断后续步骤`);
  }
  if (step === 'package' && failed) {
    policy.blocked = true;
    policy.reasons.push(`package 失败（status=${execResult.status}），无产物不可移交`);
  }
  if (step === 'scan') {
    if (reportFile && scanNote && !scanSeverities) {
      // 报告声明了但不可读 → fail-closed
      policy.blocked = true;
      policy.reasons.push(`scan 报告不可读，fail-closed 阻断：${scanNote}`);
    } else if (scanSeverities && (scanSeverities.critical > 0 || scanSeverities.high > 0)) {
      policy.blocked = true;
      policy.reasons.push(
        `scan 发现高危漏洞（critical=${scanSeverities.critical}, high=${scanSeverities.high}），阻断`);
    } else if (failed) {
      policy.blocked = true;
      policy.reasons.push(`scan 执行失败（status=${execResult.status}），阻断`);
    }
  }
  if (step === 'test' && failed && chg.requirement_id) {
    const acs = await store.listACs(tenantId, chg.requirement_id);
    for (const ac of acs) {
      if (ac.kind !== 'auto' || ac.status !== 'pending') continue;
      try {
        await dsvc.transitionAC(tenantId, projectId, chg.requirement_id, ac.id, 'failed', `runner_run:${run.id}`);
        policy.acFailed.push(ac.id);
      } catch (e) {
        logger.warn('runner: AC 回写失败（best-effort）', { ac: ac.id, err: String((e && e.message) || e).slice(0, 200) });
      }
    }
    if (policy.acFailed.length) policy.reasons.push(`test 失败，${policy.acFailed.length} 个 auto AC 已标记 failed`);
  }

  // ---- DoD 清单打勾（V1.0-E：scan 持久化 severities/blocked，供产物合同消费落库证据） ----
  await store.updateDodChecklist(tenantId, changePackageId, {
    [step]: {
      passed: !failed, runId: run.id, at: nowMs(), simulated: execResult.simulated,
      blocked: policy.blocked,
      ...(step === 'scan' ? { severities: scanSeverities, scanNote } : {}),
    },
  });

  await tryAudit({
    tenantId, projectId, actorId, action: 'runner.step.completed',
    resourceKind: 'runner_run', resourceId: run.id,
    payload: { step, status: execResult.status, blocked: policy.blocked, simulated: execResult.simulated },
  });

  return { run: finished, blocked: policy.blocked, policy };
}

/** 归属校验版读取 */
export async function getRunnerRun(tenantId, projectId, runId) {
  const r = await store.getRunnerRun(tenantId, runId).catch(() => null);
  if (!r || r.project_id !== projectId) throw Errors.notFound('Runner 运行记录不存在');
  return r;
}

export async function listRunnerRuns(tenantId, projectId, changePackageId, { step } = {}) {
  await dsvc.getChangePackage(tenantId, projectId, changePackageId); // 归属校验
  return store.listRunnerRuns(tenantId, changePackageId, { step });
}

/**
 * reproduce({ tenantId, projectId, changePackageId, actorId })
 * DoD"独立复现"的核心证据：
 * 1. 取该变更包最近一次已完成的 build / test 基线 run；
 * 2. 基线任一 simulated → 409（fake 不能证明 DoD）；
 * 3. 用基线记录的 workspace_ref.source 物化**全新独立工作区**，原样重跑基线 commands；
 * 4. 对比 exit code + 关键产物 content_hash（基线 artifacts_json）；
 * 5. 一致 → dod_checklist.reproduce = { passed:true, … }。
 * 复现 run 本身也落 runner_runs（step 不变，name 冠 [reproduce]），历史可审计。
 */
export async function reproduce({ tenantId, projectId, changePackageId, actorId }) {
  const chg = await dsvc.getChangePackage(tenantId, projectId, changePackageId); // 归属校验
  const baseline = {};
  for (const step of ['build', 'test']) {
    const r = await store.latestFinishedRunnerRun(tenantId, changePackageId, step);
    if (!r) {
      throw Errors.badRequest(`无已完成的 ${step} 基线，无法复现（请先跑一次 ${step} step）`,
        { code: 'NO_BASELINE_RUN' });
    }
    baseline[step] = r;
  }
  for (const step of ['build', 'test']) {
    if (baseline[step].simulated) {
      throw Errors.conflict(
        `基线 ${step}（${baseline[step].id}）为 fake 模拟，无法作为 DoD 复现证据`,
        { code: 'SIMULATED_NOT_REPRODUCIBLE' });
    }
    const src = baseline[step].workspace_ref && baseline[step].workspace_ref.source;
    if (!src || !src.path) {
      throw Errors.badRequest(`基线 ${step} 未记录工作区来源，无法复现`, { code: 'SOURCE_NOT_RECORDED' });
    }
  }

  const mode = currentRunnerMode();
  if (mode === 'fake') {
    throw Errors.conflict('当前 RUNNER_MODE=fake，复现必须在 live 模式下执行',
      { code: 'REPRODUCE_REQUIRES_LIVE' });
  }

  const detail = {};
  let consistent = true;
  const repRuns = {};
  for (const step of ['build', 'test']) {
    const base = baseline[step];
    const run = await store.createRunnerRun({
      tenantId, projectId, changePackageId, step,
      name: `[reproduce] ${base.name || step}`,
      commands: base.commands, env: base.env || {}, limits: base.limits, createdBy: actorId,
    });
    repRuns[step] = run.id; // 先登记：后续任一分支（成功/异常）DoD 记录都有 runId 可查
    const { dir: wsDir, materialization } = prepareWorkspace({
      source: base.workspace_ref.source, label: `reproduce:${step}:${run.id}`,
    });
    let execResult;
    let repHashes = {};
    try {
      await store.setRunnerRunRunning(tenantId, run.id, {
        simulated: false, limits: base.limits, workspaceRef: materialization, startedAt: nowMs(),
      });
      execResult = await runnerExecute({
        workdir: wsDir, commands: base.commands, env: base.env || {},
        limits: base.limits || {}, mode: 'live',
      });
      // 关键产物 hash（按基线 artifacts_json 的 path 逐一重算）
      for (const a of base.artifacts || []) {
        try {
          const abs = resolveInWorkspace(wsDir, String(a.path), 'artifact path');
          repHashes[a.path] = sha256File(abs);
        } catch {
          repHashes[a.path] = null; // 产物缺失 → 不一致
        }
      }
    } catch (e) {
      // 复现执行抛错（如基线命令非法）：该 step 记 failed，本次复现整体不一致
      const msg = `reproduce ${step} 异常终止: ${String((e && e.message) || e).slice(0, 500)}`;
      try {
        await store.finishRunnerRun(tenantId, run.id, {
          status: 'failed', exitCode: null, signal: null,
          logText: msg, logUri: writeLogFile(run.id, msg),
          artifacts: [], durationMs: 0, finishedAt: nowMs(),
        });
      } catch { /* 忽略 */ }
      consistent = false;
      detail[step] = { baselineRunId: base.id, reproduceRunId: run.id, error: msg, consistent: false };
      continue;
    } finally {
      cleanupWorkspace(wsDir);
    }
    const capped = capLog(execResult.log);
    const logUri = writeLogFile(run.id, capped.log);
    const finished = await store.finishRunnerRun(tenantId, run.id, {
      status: execResult.status, exitCode: execResult.exitCode, signal: execResult.signal,
      logText: capped.log, logUri, artifacts: [], durationMs: execResult.durationMs, finishedAt: nowMs(),
    });
    // repRuns[step] 已在创建时登记（= run.id = finished.id）
    const exitMatch = execResult.exitCode === base.exit_code;
    const hashMatch = (base.artifacts || []).every((a) => repHashes[a.path] === a.contentHash);
    const stepOk = exitMatch && hashMatch;
    if (!stepOk) consistent = false;
    detail[step] = {
      baselineRunId: base.id,
      reproduceRunId: finished.id,
      baselineExit: base.exit_code,
      reproduceExit: execResult.exitCode,
      exitMatch,
      artifacts: (base.artifacts || []).map((a) => ({
        path: a.path, baselineHash: a.contentHash,
        reproduceHash: repHashes[a.path] || null,
        match: repHashes[a.path] === a.contentHash,
      })),
      hashMatch,
      consistent: stepOk,
    };
    await tryAudit({
      tenantId, projectId, actorId, action: 'runner.reproduce.step',
      resourceKind: 'runner_run', resourceId: finished.id,
      payload: { step, baselineRunId: base.id, consistent: stepOk },
    });
  }

  const dod = await store.updateDodChecklist(tenantId, changePackageId, {
    reproduce: {
      passed: consistent, at: nowMs(),
      buildRunId: repRuns.build, testRunId: repRuns.test,
      baseline: { build: baseline.build.id, test: baseline.test.id },
    },
  });
  await tryAudit({
    tenantId, projectId, actorId, action: 'runner.reproduce.completed',
    resourceKind: 'change_package', resourceId: changePackageId,
    payload: { consistent, runs: repRuns },
  });
  return { consistent, detail, reproduceRuns: repRuns, dodChecklist: dod.dod_checklist };
}
