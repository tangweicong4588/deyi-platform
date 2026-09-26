/**
 * modules/delivery/pipeline.mjs —— V1.0-B 五阶段流水线编排。
 *
 * 五阶段（方案 p19–p20）：facts → requirements → clarify → develop → handover。
 * 每个阶段产出可评审对象：事实快照 / 需求（发布）/ 澄清记录与 AC / 变更包产物 /
 * 交接（ready_for_review）。阶段门禁是"必须具备"清单，未满足的门禁只能走
 * 例外审批（gate_exceptions，复用 P6 审批语义），绝不允许被模型文本掩盖。
 *
 * 设计决策（简单可靠优先，不为用 Temporal 而用）：
 * - 阶段推进 = service 层编排 + DB 原子 CAS，不经过 Temporal；Temporal 仍是
 *   P6 工具执行的底座，流水线如需长时任务可在 V1.0-C 再挂。
 * - 审计走 P7 tryAudit best-effort 钩子：gate pass/block、例外申请/决议、
 *   需求发布（service.mjs）、变更包移交（service.mjs）。
 * - 高风险/例外动作（例外审批决议）必须租户主体 + operator+，平台运维伪
 *   actor（'operator'）禁止决议。
 */
import { Errors } from '../../kernel/errors.mjs';
import { newId } from '../../kernel/ids.mjs';
import { db } from '../../db/index.mjs';
import { tryAudit } from '../evidence/audit.mjs';
import * as store from './store.mjs';
import * as svc from './service.mjs';
import { evaluateContract } from './contract.mjs';

export const STAGE_ORDER = ['facts', 'requirements', 'clarify', 'develop', 'handover'];

const nowMs = () => Date.now();

/** 平台运维伪 actor 禁止决议租户例外审批（与 P6 assertTenantActor 同规则） */
function assertTenantActor(actorId, what) {
  if (!actorId || actorId === 'operator') {
    throw Errors.forbidden(`平台运维不能直接${what}，请使用租户主体凭证`);
  }
}

/** 递归疑似密钥键扫描（environment/dependencies JSON 绝不能带明文凭据） */
const SECRET_KEY_RE = /(password|passwd|secret|token|api[_-]?key|credential|private[_-]?key|access[_-]?key)/i;
export function scanSecretKeys(obj, path = '$') {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    const norm = String(k).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[_-]/g, '');
    if (SECRET_KEY_RE.test(norm)) {
      throw Errors.badRequest(`事实快照 JSON 禁止包含疑似凭据字段: ${path}.${k}`, { code: 'PLAINTEXT_SECRET' });
    }
    scanSecretKeys(obj[k], `${path}.${k}`);
  }
}

// ---------------------------------------------------------------- 门禁清单
/**
 * 每个阶段的门禁评估。输入：已落库的事实（快照/需求状态/AC/产物）+ 本次提交的
 * evidence（记录进 gate_decision 备查）。输出 missing[]：缺失项代码。
 */
async function evalFactsGate({ tenantId, run }) {
  const missing = [];
  const snp = await store.getFactSnapshot(tenantId, run.id).catch(() => null);
  if (!snp) return ['fact_snapshot'];
  if (!String(snp.baseline_commit || '').trim()) missing.push('baseline_commit');
  if (!snp.environment || typeof snp.environment !== 'object' || Array.isArray(snp.environment)) missing.push('environment');
  if (!snp.dependencies || typeof snp.dependencies !== 'object' || Array.isArray(snp.dependencies)) missing.push('dependencies');
  if (!Array.isArray(snp.unknown_items)) missing.push('unknown_items');
  return missing;
}

const REQ_READY_STATES = new Set(['ready', 'in_progress', 'verifying', 'done']);
async function evalRequirementsGate({ tenantId, changePackage }) {
  const missing = [];
  const req = await store.getRequirement(tenantId, changePackage.requirement_id).catch(() => null);
  if (!req) return ['requirement'];
  if (!String(req.scope_md || '').trim()) missing.push('scope');
  if (req.kind === 'bug' && (!req.repro || Object.keys(req.repro).length === 0)) missing.push('repro');
  if (!REQ_READY_STATES.has(req.status)) missing.push(`requirement_ready(当前:${req.status})`);
  return missing;
}

async function evalClarifyGate({ tenantId, run, changePackage }) {
  const missing = [];
  const clfs = await store.listClarifications(tenantId, run.id);
  const unanswered = clfs.filter((c) => !String(c.answer || '').trim());
  if (unanswered.length) missing.push(`unanswered_clarifications(${unanswered.length})`);
  const acs = await store.listACs(tenantId, changePackage.requirement_id);
  if (!acs.length) missing.push('acceptance_criteria');
  return missing;
}

async function evalDevelopGate({ tenantId, changePackage }) {
  const missing = [];
  const arts = await store.listArtifacts(tenantId, changePackage.id);
  const kinds = new Set(arts.map((a) => a.kind));
  for (const k of ['diff', 'test_report', 'scan_report']) {
    if (!kinds.has(k)) missing.push(`artifact:${k}`);
  }
  if (!String(changePackage.head_commit || '').trim()) missing.push('head_commit');
  return missing;
}

async function evalHandoverGate({ tenantId, projectId, actorId, changePackage }) {
  const missing = [];
  const arts = await store.listArtifacts(tenantId, changePackage.id);
  if (!arts.some((a) => a.kind === 'report')) missing.push('artifact:report');
  if (!String(changePackage.branch || '').trim()) missing.push('branch');
  if (changePackage.status !== 'verifying') missing.push(`change_package_verifying(当前:${changePackage.status})`);
  // V1.0-E 门禁联动：handover 门禁**现场重评估**产物合同（H-1/M-1 安全 review）。
  // evaluateContract 只读落库证据（AC/各 step 最近运行/扫描汇总/草稿 PR），不重跑构建，
  // 因此现场重算成本可控；fail-closed：从未评估/证据缺失 → fail 项进入缺失清单，
  // 必须经"已批准且覆盖缺失项"的门禁例外逐项 waive 才能放行。评估结论落库备查。
  const contract = await evaluateContract({
    tenantId, projectId, changePackageId: changePackage.id, actorId,
  }).catch((e) => ({ passed: false, items: [], error: String(e && e.message || e) }));
  for (const item of contract.items || []) {
    if (item.status === 'fail') missing.push(item.key);
  }
  if (contract.error) missing.push('contract:evaluate_error');
  return missing;
}

const GATE_EVAL = {
  facts: evalFactsGate,
  requirements: evalRequirementsGate,
  clarify: evalClarifyGate,
  develop: evalDevelopGate,
  handover: evalHandoverGate,
};

// ---------------------------------------------------------------- 编排
/** 变更包的阶段运行（按 STAGE_ORDER 排序） */
async function loadOrderedRuns(tenantId, projectId, changePackageId) {
  const runs = await store.listPipelineRuns(tenantId, projectId, { changePackageId });
  const byStage = new Map(runs.map((r) => [r.stage, r]));
  return STAGE_ORDER.map((s) => byStage.get(s)).filter(Boolean);
}

export async function startPipeline({ tenantId, projectId, actorId, changePackageId }) {
  const chg = await svc.getChangePackage(tenantId, projectId, changePackageId);
  if (['cancelled', 'handed_over'].includes(chg.status)) {
    throw Errors.badRequest(`变更包已终态(${chg.status})，不能启动流水线`);
  }
  const existing = await loadOrderedRuns(tenantId, projectId, changePackageId);
  if (existing.length === STAGE_ORDER.length) return { runs: existing, created: false };
  // 幂等：已有部分记录（历史/静态）则补齐缺失阶段，不重建
  const have = new Set(existing.map((r) => r.stage));
  const runs = [...existing];
  const now = nowMs();
  for (const stage of STAGE_ORDER) {
    if (have.has(stage)) continue;
    const first = stage === 'facts';
    try {
      const r = await db().query(
        `INSERT INTO pipeline_runs(id,tenant_id,project_id,change_package_id,stage,status,
          gate_decision,started_at,finished_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [newId('pipe'), tenantId, projectId, chg.id, stage, first ? 'running' : 'pending',
          '{}', first ? now : null, null, now]);
      void r;
    } catch (e) {
      // 并发双 start：唯一索引冲突 → 回读已有记录
      if (!String(e && e.message || '').toLowerCase().includes('unique')) throw e;
    }
    const created = (await store.listPipelineRuns(tenantId, projectId, { changePackageId: chg.id }))
      .find((x) => x.stage === stage);
    if (created) runs.push(created);
  }
  const ordered = await loadOrderedRuns(tenantId, projectId, changePackageId);
  await tryAudit({
    tenantId, projectId, actorId, action: 'pipeline.start',
    resourceKind: 'change_package', resourceId: chg.id,
    payload: { stages: STAGE_ORDER },
  });
  return { runs: ordered, created: true };
}

/** 流水线视图：各阶段运行 + 门禁状态（GET …/runs/:runId 与包级视图共用） */
export async function getPipelineView({ tenantId, projectId, changePackageId }) {
  await svc.getChangePackage(tenantId, projectId, changePackageId);
  const runs = await loadOrderedRuns(tenantId, projectId, changePackageId);
  const stages = [];
  for (const run of runs) {
    stages.push({
      stage: run.stage, status: run.status, gate_decision: run.gate_decision,
      started_at: run.started_at, finished_at: run.finished_at, run_id: run.id,
    });
  }
  return { change_package_id: changePackageId, stages };
}

export async function getPipelineRunDetail({ tenantId, projectId, runId }) {
  const run = await svc.getPipelineRun(tenantId, projectId, runId);
  if (!run.change_package_id) throw Errors.badRequest('该运行未绑定变更包，无法编排推进');
  const view = await getPipelineView({ tenantId, projectId, changePackageId: run.change_package_id });
  const related = { fact_snapshot: null, clarifications: [], gate_exceptions: [] };
  if (run.stage === 'facts') related.fact_snapshot = await store.getFactSnapshot(tenantId, run.id).catch(() => null);
  if (run.stage === 'clarify') related.clarifications = await store.listClarifications(tenantId, run.id);
  related.gate_exceptions = await store.listGateExceptions(tenantId, run.id);
  return { run, pipeline: view, related };
}

/**
 * 推进阶段。decision: {note} 备注；evidence: {artifacts?, notes?} 门禁证据（落 gate_decision）。
 * - 门禁通过 → passed，激活下一阶段；handover 通过 → 变更包 ready_for_review。
 * - 门禁阻断 → gated；gated 状态下需"已批准且覆盖全部缺失项"的例外审批才能再次推进。
 * - 非法：推进已终态/未开始的阶段、跳过前序未通过阶段 → 400。
 */
export async function advanceStage({ tenantId, projectId, actorId, runId, decision = {}, evidence = {} }) {
  const run = await svc.getPipelineRun(tenantId, projectId, runId);
  if (!run.change_package_id) throw Errors.badRequest('该运行未绑定变更包，无法编排推进');
  if (['passed', 'failed', 'cancelled'].includes(run.status)) {
    throw Errors.badRequest(`阶段已终态(${run.status})，不能重复推进`, { code: 'INVALID_TRANSITION' });
  }
  if (run.status === 'pending') {
    throw Errors.badRequest('阶段尚未开始：前序阶段未完成，不能跳阶段推进', { code: 'INVALID_TRANSITION' });
  }
  const runs = await loadOrderedRuns(tenantId, projectId, run.change_package_id);
  const idx = runs.findIndex((r) => r.id === run.id);
  for (let i = 0; i < idx; i++) {
    if (runs[i].status !== 'passed') {
      throw Errors.badRequest(`前序阶段 ${runs[i].stage} 未通过(${runs[i].status})，不能跳阶段推进`, { code: 'INVALID_TRANSITION' });
    }
  }
  const chg = await svc.getChangePackage(tenantId, projectId, run.change_package_id);
  // L1 业务 review：变更包已终态（cancelled/handed_over）时禁止再推进任何阶段
  if (['cancelled', 'handed_over'].includes(chg.status)) {
    throw Errors.badRequest(`变更包已终态(${chg.status})，不能推进流水线`, { code: 'INVALID_TRANSITION' });
  }
  const missing = await GATE_EVAL[run.stage]({ tenantId, projectId, actorId, run, changePackage: chg, evidence });
  const checkedAt = nowMs();
  const evidenceSummary = {
    artifacts: Array.isArray(evidence.artifacts) ? evidence.artifacts.slice(0, 50) : [],
    notes: typeof evidence.notes === 'string' ? evidence.notes.slice(0, 2000) : '',
    decision_note: typeof decision.note === 'string' ? decision.note.slice(0, 2000) : '',
  };

  let waivedBy = null;
  if (missing.length) {
    // 门禁未满足时，只有"已批准且覆盖全部缺失项"的例外能放行；
    // 否则如实返回阻断（200 blocked），绝不静默通过。
    // batch3 遗留修复：contract.ac（整包豁免，需 broad_waiver 确认）在覆盖检查中
    // 蕴含其下的 ac:<id> 逐项——宽泛豁免的语义就是豁免整包所有 AC。
    const approved = await store.listGateExceptions(tenantId, run.id, { status: 'approved' });
    const covers = (g, m) =>
      g.missing_items.includes(m) ||
      (m.startsWith('ac:') && g.missing_items.includes('contract.ac') && !!g.broad_waiver);
    const cover = approved.find((g) => missing.every((m) => covers(g, m)));
    if (cover) waivedBy = cover.id;
  }

  if (missing.length && !waivedBy) {
    // 门禁阻断 → gated（CAS：running/gated 才能进入阻断态）
    const upd = await db().run(
      `UPDATE pipeline_runs SET status='gated', gate_decision=? WHERE id=? AND tenant_id=?
       AND status IN ('running','gated')`,
      [JSON.stringify({ passed: false, missing, checked_at: checkedAt, evidence: evidenceSummary }), run.id, tenantId]);
    if (upd.changes === 0) throw Errors.conflict('阶段状态已被并发修改');
    await tryAudit({
      tenantId, projectId, actorId, action: 'pipeline.gate.block',
      resourceKind: 'pipeline_run', resourceId: run.id,
      payload: { stage: run.stage, missing },
    });
    return { run: await svc.getPipelineRun(tenantId, projectId, run.id), blocked: true, missing };
  }

  // 门禁通过 → passed（CAS 防并发双重推进）
  const gateDecision = {
    passed: true, missing: [], checked_at: checkedAt, evidence: evidenceSummary,
    ...(waivedBy ? { exception_waived_by: waivedBy, waived_items: missing } : {}),
  };

  let next = null;
  if (idx + 1 < runs.length) {
    // 非终阶段：先 CAS 本阶段，再激活下一阶段
    const upd = await db().run(
      `UPDATE pipeline_runs SET status='passed', gate_decision=?, finished_at=?
       WHERE id=? AND tenant_id=? AND status IN ('running','gated')`,
      [JSON.stringify(gateDecision), nowMs(), run.id, tenantId]);
    if (upd.changes === 0) throw Errors.conflict('阶段已被并发推进');
    const n = runs[idx + 1];
    await db().run(
      `UPDATE pipeline_runs SET status='running', started_at=? WHERE id=? AND tenant_id=? AND status='pending'`,
      [nowMs(), n.id, tenantId]);
    next = await svc.getPipelineRun(tenantId, projectId, n.id);
  } else {
    // handover 通过 = 交接：先转变更包（幂等：并发下已是 ready_for_review 则跳过），
    // 再 CAS 本阶段。顺序不可反，否则变更包转移失败会留下"已通过但未交接"的不一致。
    const cur = await svc.getChangePackage(tenantId, projectId, chg.id);
    if (cur.status === 'verifying') {
      try {
        await svc.transitionChangePackage(tenantId, projectId, chg.id, 'ready_for_review', null, { viaPipeline: true });
      } catch (e) {
        // 并发推进：对方已先完成交接 → 视为成功，继续走 run 的 CAS（输家会 409）
        const recheck = await svc.getChangePackage(tenantId, projectId, chg.id);
        if (recheck.status !== 'ready_for_review') throw e;
      }
    } else if (cur.status !== 'ready_for_review') {
      throw Errors.conflict(`变更包状态异常，无法交接: ${cur.status}`);
    }
    const upd = await db().run(
      `UPDATE pipeline_runs SET status='passed', gate_decision=?, finished_at=?
       WHERE id=? AND tenant_id=? AND status IN ('running','gated')`,
      [JSON.stringify(gateDecision), nowMs(), run.id, tenantId]);
    if (upd.changes === 0) throw Errors.conflict('阶段已被并发推进');
  }
  await tryAudit({
    tenantId, projectId, actorId, action: 'pipeline.gate.pass',
    resourceKind: 'pipeline_run', resourceId: run.id,
    payload: { stage: run.stage, waived_by: waivedBy },
  });
  return { run: await svc.getPipelineRun(tenantId, projectId, run.id), next, waived_by: waivedBy };
}

// ---------------------------------------------------------------- 事实快照
export async function recordFactSnapshot({ tenantId, projectId, actorId, runId, body }) {
  const run = await svc.getPipelineRun(tenantId, projectId, runId);
  if (run.stage !== 'facts') throw Errors.badRequest('事实快照只能登记在 facts 阶段');
  if (!['running', 'gated'].includes(run.status)) throw Errors.badRequest(`facts 阶段状态 ${run.status} 不接受登记`);
  const { baselineCommit = '', environment = {}, dependencies = {}, unknownItems = [] } = body || {};
  if (typeof environment !== 'object' || Array.isArray(environment) || environment === null) {
    throw Errors.badRequest('environment 必须为 JSON 对象');
  }
  if (typeof dependencies !== 'object' || Array.isArray(dependencies) || dependencies === null) {
    throw Errors.badRequest('dependencies 必须为 JSON 对象');
  }
  if (!Array.isArray(unknownItems)) throw Errors.badRequest('unknownItems 必须为数组（空数组=已确认无未知项）');
  scanSecretKeys(environment);
  scanSecretKeys(dependencies);
  return store.upsertFactSnapshot({
    tenantId, projectId, pipelineRunId: run.id, baselineCommit: String(baselineCommit),
    environment, dependencies, unknownItems, recordedBy: actorId,
  });
}

// ---------------------------------------------------------------- 澄清
export async function askClarification({ tenantId, projectId, actorId, runId, body }) {
  const run = await svc.getPipelineRun(tenantId, projectId, runId);
  if (run.stage !== 'clarify') throw Errors.badRequest('澄清问题只能记录在 clarify 阶段');
  if (!['running', 'gated'].includes(run.status)) throw Errors.badRequest(`clarify 阶段状态 ${run.status} 不接受新问题`);
  const { question, impactsImplementation = false, requirementId = null } = body || {};
  if (!String(question || '').trim()) throw Errors.badRequest('question 必填');
  if (requirementId) await svc.getRequirement(tenantId, projectId, requirementId);
  return store.createClarification({
    tenantId, projectId, pipelineRunId: run.id, requirementId,
    question: String(question).trim(), impactsImplementation: !!impactsImplementation, createdBy: actorId,
  });
}

export async function answerClarification({ tenantId, projectId, actorId, runId, clfId, body }) {
  const run = await svc.getPipelineRun(tenantId, projectId, runId);
  const clf = await store.getClarification(tenantId, clfId).catch(() => null);
  if (!clf || clf.pipeline_run_id !== run.id) throw Errors.notFound('澄清记录不存在');
  const { answer } = body || {};
  if (!String(answer || '').trim()) throw Errors.badRequest('answer 必填');
  return store.answerClarification(tenantId, clfId, { answer: String(answer).trim(), answeredBy: actorId });
}

/** 澄清答案转为验收标准（复用 V1.0-A acceptance_criteria） */
export async function clarificationToAC({ tenantId, projectId, actorId, runId, clfId, body }) {
  const run = await svc.getPipelineRun(tenantId, projectId, runId);
  const clf = await store.getClarification(tenantId, clfId).catch(() => null);
  if (!clf || clf.pipeline_run_id !== run.id) throw Errors.notFound('澄清记录不存在');
  if (!String(clf.answer || '').trim()) throw Errors.badRequest('澄清尚未回答，不能转为验收标准');
  const chg = await svc.getChangePackage(tenantId, projectId, run.change_package_id);
  const { kind = 'manual' } = body || {};
  return svc.addAC(tenantId, projectId, chg.requirement_id, {
    givenMd: `澄清问题：${clf.question}`,
    whenMd: '',
    thenMd: clf.answer,
    kind,
  });
}

// ---------------------------------------------------------------- 门禁例外审批
export async function requestGateException({ tenantId, projectId, actorId, runId, body }) {
  const run = await svc.getPipelineRun(tenantId, projectId, runId);
  const gd = run.gate_decision || {};
  const missing = Array.isArray(gd.missing) ? gd.missing : [];
  if (run.status !== 'gated' || !missing.length) {
    throw Errors.badRequest('该阶段未被门禁阻断，无需例外审批');
  }
  const { missingItems = missing, reason = '', broadWaiver = false } = body || {};
  const items = Array.isArray(missingItems) && missingItems.length ? missingItems : missing;
  for (const m of items) {
    if (!missing.includes(m)) throw Errors.badRequest(`例外项 ${m} 不在当前缺失清单内`);
  }
  // batch3 遗留修复：contract.ac 是包级宽泛豁免键，一次批准可豁免整包所有 AC。
  // 优先用逐项 ac:<id>；若坚持整包豁免，必须显式 broadWaiver=true 确认（审批/审计留痕）。
  const wantsBroad = items.includes('contract.ac');
  if (wantsBroad && broadWaiver !== true) {
    throw Errors.badRequest(
      '整包豁免（contract.ac）需显式确认：请逐项使用 ac:<id> 申请，或在请求中设置 broadWaiver=true 确认已知悉整包豁免范围',
      { code: 'BROAD_WAIVER_CONFIRM_REQUIRED' });
  }
  // 幂等：同缺失集合的待决单直接返回
  const pending = await store.listGateExceptions(tenantId, run.id, { status: 'pending' });
  const key = [...items].sort().join('|');
  const dup = pending.find((g) => [...g.missing_items].sort().join('|') === key);
  if (dup) return dup;
  const gex = await store.createGateException({
    tenantId, projectId, pipelineRunId: run.id, stage: run.stage,
    missingItems: items, reason: String(reason).slice(0, 2000), requestedBy: actorId,
    broadWaiver: wantsBroad,
  });
  await tryAudit({
    tenantId, projectId, actorId, action: 'pipeline.gate_exception.request',
    resourceKind: 'gate_exception', resourceId: gex.id,
    payload: { stage: run.stage, missing_items: items, reason: gex.reason, broad_waiver: wantsBroad },
  });
  return gex;
}

export async function decideGateException({ tenantId, projectId, actorId, roles, gexId, approved, reason }) {
  assertTenantActor(actorId, '决议门禁例外审批');
  const gex = await store.getGateException(tenantId, gexId).catch(() => null);
  if (!gex || gex.project_id !== projectId) throw Errors.notFound('例外审批单不存在');
  // batch3 遗留修复（L 级）：SoD——申请人不能批准自己的门禁例外
  if (gex.requested_by === actorId) {
    throw Errors.forbidden('门禁例外审批需职责分离：申请人不能批准自己的例外申请', { code: 'SOD_VIOLATION' });
  }
  // 纵深防御：路由层已做 rank 检查，这里再查一次（复用 P6 decideApproval 模式）
  const { effectiveRank } = await import('../identity/middleware.mjs');
  if (effectiveRank(roles, projectId) < 1) throw Errors.forbidden('例外审批需要 operator 及以上角色');
  const out = await store.decideGateException(tenantId, gexId, { approved: !!approved, decidedBy: actorId, reason });
  await tryAudit({
    tenantId, projectId, actorId,
    action: approved ? 'pipeline.gate_exception.approve' : 'pipeline.gate_exception.reject',
    resourceKind: 'gate_exception', resourceId: gexId,
    payload: {
      stage: gex.stage, missing_items: gex.missing_items, reason: reason || null,
      broad_waiver: !!gex.broad_waiver,
      requested_by: gex.requested_by,
    },
  });
  return out;
}
