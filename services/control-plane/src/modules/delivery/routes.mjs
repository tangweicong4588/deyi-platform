/**
 * modules/delivery/routes.mjs —— 交付域 HTTP 立面（V1.0-A 静态模型）。
 *
 * 需求 / 验收标准 / 仓库绑定 / 变更包 / 产物 / 流水线运行。
 * 鉴权链：authenticate → 项目归属（租户隔离）→ Key 项目绑定检查 → 角色等级 →
 * 策略 decide（delivery.read viewer+ / delivery.write operator+，与 P2 规则及
 * deploy/opa 策略包语义一致）。
 */
import { sendJson } from '../../kernel/http.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { ctx, runWithContext } from '../../kernel/context.mjs';
import { authenticate, effectiveRank } from '../identity/middleware.mjs';
import { getProject } from '../identity/store.mjs';
import { decide, inputFromRequest } from '../policy/index.mjs';
import { db } from '../../db/index.mjs';
import { logger } from '../../kernel/logging.mjs';
import * as svc from './service.mjs';
import * as pipe from './pipeline.mjs';
import * as repo from './repo.mjs';
import * as stp from './steps.mjs';
import { evaluateContract } from './contract.mjs';
import { assemblePackage, getHandoverReport } from './handover.mjs';

async function scopedProject(req, minRank, opName) {
  const c = ctx();
  const pid = req.params.projectId;
  let project = null;
  let roles = c.roles || [];
  if (c.authKind === 'operator') {
    const rows = await db().query('SELECT * FROM projects WHERE id=?', [pid]);
    project = rows[0] || null;
    roles = [{ project_id: null, role: 'admin' }];
    logger.warn('delivery operator access', { op: opName, projectId: pid, tenant_id: project?.tenant_id });
  } else {
    if (!c.tenantId) throw Errors.unauthorized();
    project = await getProject(c.tenantId, pid).catch(() => null);
    if (c.projectId && c.projectId !== pid) {
      throw Errors.forbidden('禁止跨项目操作交付域');
    }
  }
  if (!project || project.status !== 'active') throw Errors.forbidden('项目不存在或无权访问');
  if (effectiveRank(roles, project.id) < minRank) {
    throw Errors.forbidden(minRank >= 1 ? '需要项目 operator 及以上角色' : '需要项目 viewer 及以上角色');
  }
  const tenantId = project.tenant_id;
  const actor = { id: c.actorId, kind: c.actorKind, status: 'active', roles };
  return { c, project, tenantId, actor, roles };
}

async function policyCheck({ actor, tenantId, project, action, resource }) {
  const receipt = await decide(inputFromRequest({
    actor,
    tenant: { id: tenantId, status: 'active' },
    project: { id: project.id },
    action, resource: resource || {},
    context: {},
  }));
  if (!receipt.allow) throw Errors.policyDenied(receipt.reason, { receipt });
  return receipt;
}

function withTenant(tenantId, fn) {
  const c = ctx();
  if (c.authKind === 'operator' && !c.tenantId) {
    return runWithContext({ ...c, tenantId }, fn);
  }
  return fn();
}

const R = (p) => `/v1/projects/:projectId${p}`;

export function registerDeliveryRoutes(app) {
  // ---- requirements ----
  app.post(R('/delivery/requirements'), authenticate, async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'req.create');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'requirement' } });
    const out = await withTenant(tenantId, () => svc.createRequirement({
      tenantId, projectId: project.id, actorId: c.actorId, body: req.body || {},
    }));
    sendJson(res, 201, { data: out });
  });

  app.get(R('/delivery/requirements'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'req.list');
    await policyCheck({ actor, tenantId, project, action: 'delivery.read', resource: { kind: 'requirement' } });
    sendJson(res, 200, {
      data: await svc.store.listRequirements(tenantId, project.id, {
        status: req.query.status, kind: req.query.kind,
      }),
    });
  });

  app.get(R('/delivery/requirements/:id'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'req.get');
    await policyCheck({ actor, tenantId, project, action: 'delivery.read', resource: { kind: 'requirement' } });
    sendJson(res, 200, { data: await svc.getRequirement(tenantId, project.id, req.params.id) });
  });

  app.patch(R('/delivery/requirements/:id'), authenticate, async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'req.patch');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'requirement' } });
    const body = req.body || {};
    const out = await withTenant(tenantId, () => body.status !== undefined
      ? svc.transitionRequirement(tenantId, project.id, req.params.id, body.status)
      : svc.patchRequirement(tenantId, project.id, req.params.id, c.actorId, body));
    sendJson(res, 200, { data: out });
  });

  // ---- acceptance criteria ----
  app.post(R('/delivery/requirements/:id/acceptance-criteria'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'ac.create');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'acceptance_criterion' } });
    const out = await withTenant(tenantId, () => svc.addAC(tenantId, project.id, req.params.id, req.body || {}));
    sendJson(res, 201, { data: out });
  });

  app.get(R('/delivery/requirements/:id/acceptance-criteria'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'ac.list');
    await policyCheck({ actor, tenantId, project, action: 'delivery.read', resource: { kind: 'acceptance_criterion' } });
    await svc.getRequirement(tenantId, project.id, req.params.id);
    sendJson(res, 200, { data: await svc.store.listACs(tenantId, req.params.id) });
  });

  app.patch(R('/delivery/requirements/:reqId/acceptance-criteria/:acId'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'ac.patch');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'acceptance_criterion' } });
    const { status, evidenceRef } = req.body || {};
    if (!status) throw Errors.badRequest('status 必填');
    const out = await withTenant(tenantId, () => svc.transitionAC(
      tenantId, project.id, req.params.reqId, req.params.acId, status, evidenceRef, actor.id));
    sendJson(res, 200, { data: out });
  });

  // ---- repo bindings ----
  app.post(R('/delivery/repo-bindings'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'repo.bind');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'repo_binding' } });
    const out = await withTenant(tenantId, () => svc.bindRepo(tenantId, project.id, req.body || {}));
    sendJson(res, 201, { data: out });
  });

  app.get(R('/delivery/repo-bindings'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'repo.list');
    await policyCheck({ actor, tenantId, project, action: 'delivery.read', resource: { kind: 'repo_binding' } });
    sendJson(res, 200, { data: await svc.store.listRepoBindings(tenantId, project.id) });
  });

  app.patch(R('/delivery/repo-bindings/:id'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'repo.patch');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'repo_binding' } });
    const { status } = req.body || {};
    if (!['active', 'disabled'].includes(status)) throw Errors.badRequest('status 非法: 仅 active|disabled');
    const out = await withTenant(tenantId, async () => {
      await svc.getRepoBinding(tenantId, project.id, req.params.id); // 归属校验
      return svc.store.setRepoBindingStatus(tenantId, req.params.id, status);
    });
    sendJson(res, 200, { data: out });
  });

  // ---- change packages ----
  app.post(R('/delivery/change-packages'), authenticate, async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'chg.create');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'change_package' } });
    const out = await withTenant(tenantId, () => svc.createChangePackage({
      tenantId, projectId: project.id, actorId: c.actorId, body: req.body || {},
    }));
    sendJson(res, 201, { data: out });
  });

  app.get(R('/delivery/change-packages'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'chg.list');
    await policyCheck({ actor, tenantId, project, action: 'delivery.read', resource: { kind: 'change_package' } });
    sendJson(res, 200, {
      data: await svc.store.listChangePackages(tenantId, project.id, { requirementId: req.query.requirementId }),
    });
  });

  app.get(R('/delivery/change-packages/:id'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'chg.get');
    await policyCheck({ actor, tenantId, project, action: 'delivery.read', resource: { kind: 'change_package' } });
    sendJson(res, 200, { data: await svc.getChangePackage(tenantId, project.id, req.params.id) });
  });

  app.patch(R('/delivery/change-packages/:id'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'chg.patch');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'change_package' } });
    const { status, headCommit } = req.body || {};
    if (!status) throw Errors.badRequest('status 必填');
    const out = await withTenant(tenantId, () => svc.transitionChangePackage(
      tenantId, project.id, req.params.id, status, headCommit));
    sendJson(res, 200, { data: out });
  });

  // ---- artifacts ----
  app.post(R('/delivery/change-packages/:id/artifacts'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'art.register');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'artifact' } });
    const out = await withTenant(tenantId, () => svc.registerArtifact(
      tenantId, project.id, req.params.id, req.body || {}));
    sendJson(res, 201, { data: out });
  });

  app.get(R('/delivery/change-packages/:id/artifacts'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'art.list');
    await policyCheck({ actor, tenantId, project, action: 'delivery.read', resource: { kind: 'artifact' } });
    await svc.getChangePackage(tenantId, project.id, req.params.id);
    sendJson(res, 200, { data: await svc.store.listArtifacts(tenantId, req.params.id) });
  });

  // ---- pipeline runs（静态模型） ----
  app.post(R('/delivery/pipeline-runs'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'pipe.create');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'pipeline_run' } });
    const out = await withTenant(tenantId, () => svc.createPipelineRun({
      tenantId, projectId: project.id, body: req.body || {},
    }));
    sendJson(res, 201, { data: out });
  });

  app.get(R('/delivery/pipeline-runs'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'pipe.list');
    await policyCheck({ actor, tenantId, project, action: 'delivery.read', resource: { kind: 'pipeline_run' } });
    sendJson(res, 200, {
      data: await svc.store.listPipelineRuns(tenantId, project.id, { changePackageId: req.query.changePackageId }),
    });
  });

  app.patch(R('/delivery/pipeline-runs/:id'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'pipe.patch');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'pipeline_run' } });
    const { status, gateDecision } = req.body || {};
    if (!status) throw Errors.badRequest('status 必填');
    const out = await withTenant(tenantId, () => svc.transitionPipelineRun(
      tenantId, project.id, req.params.id, status, gateDecision));
    sendJson(res, 200, { data: out });
  });

  // ---- V1.0-B 五阶段流水线编排 ----
  app.post(R('/delivery/change-packages/:id/pipeline/start'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'pipeline.start');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'pipeline' } });
    const out = await withTenant(tenantId, () => pipe.startPipeline({
      tenantId, projectId: project.id, actorId: actor.id, changePackageId: req.params.id,
    }));
    sendJson(res, out.created ? 201 : 200, { data: out });
  });

  app.get(R('/delivery/change-packages/:id/pipeline'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'pipeline.view');
    await policyCheck({ actor, tenantId, project, action: 'delivery.read', resource: { kind: 'pipeline' } });
    const out = await withTenant(tenantId, () => pipe.getPipelineView({
      tenantId, projectId: project.id, changePackageId: req.params.id,
    }));
    sendJson(res, 200, { data: out });
  });

  app.get(R('/delivery/pipeline-runs/:runId'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'pipeline.run.get');
    await policyCheck({ actor, tenantId, project, action: 'delivery.read', resource: { kind: 'pipeline_run' } });
    const out = await withTenant(tenantId, () => pipe.getPipelineRunDetail({
      tenantId, projectId: project.id, runId: req.params.runId,
    }));
    sendJson(res, 200, { data: out });
  });

  app.post(R('/delivery/pipeline-runs/:runId/advance'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'pipeline.advance');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'pipeline_run' } });
    const { decision, evidence } = req.body || {};
    const out = await withTenant(tenantId, () => pipe.advanceStage({
      tenantId, projectId: project.id, actorId: actor.id,
      runId: req.params.runId, decision: decision || {}, evidence: evidence || {},
    }));
    sendJson(res, 200, { data: out });
  });

  // 事实快照（facts 阶段手动登记）
  app.post(R('/delivery/pipeline-runs/:runId/fact-snapshot'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'fact.snapshot.record');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'fact_snapshot' } });
    const out = await withTenant(tenantId, () => pipe.recordFactSnapshot({
      tenantId, projectId: project.id, actorId: actor.id, runId: req.params.runId, body: req.body || {},
    }));
    sendJson(res, 201, { data: out });
  });

  app.get(R('/delivery/pipeline-runs/:runId/fact-snapshot'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'fact.snapshot.get');
    await policyCheck({ actor, tenantId, project, action: 'delivery.read', resource: { kind: 'fact_snapshot' } });
    const detail = await withTenant(tenantId, () => pipe.getPipelineRunDetail({
      tenantId, projectId: project.id, runId: req.params.runId,
    }));
    sendJson(res, 200, { data: detail.related.fact_snapshot });
  });

  // 澄清记录（clarify 阶段）
  app.post(R('/delivery/pipeline-runs/:runId/clarifications'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'clarify.ask');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'clarification' } });
    const out = await withTenant(tenantId, () => pipe.askClarification({
      tenantId, projectId: project.id, actorId: actor.id, runId: req.params.runId, body: req.body || {},
    }));
    sendJson(res, 201, { data: out });
  });

  app.get(R('/delivery/pipeline-runs/:runId/clarifications'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'clarify.list');
    await policyCheck({ actor, tenantId, project, action: 'delivery.read', resource: { kind: 'clarification' } });
    const detail = await withTenant(tenantId, () => pipe.getPipelineRunDetail({
      tenantId, projectId: project.id, runId: req.params.runId,
    }));
    sendJson(res, 200, { data: detail.related.clarifications });
  });

  app.post(R('/delivery/pipeline-runs/:runId/clarifications/:clfId/answer'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'clarify.answer');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'clarification' } });
    const out = await withTenant(tenantId, () => pipe.answerClarification({
      tenantId, projectId: project.id, actorId: actor.id,
      runId: req.params.runId, clfId: req.params.clfId, body: req.body || {},
    }));
    sendJson(res, 200, { data: out });
  });

  app.post(R('/delivery/pipeline-runs/:runId/clarifications/:clfId/to-ac'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'clarify.to-ac');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'clarification' } });
    const out = await withTenant(tenantId, () => pipe.clarificationToAC({
      tenantId, projectId: project.id, actorId: actor.id,
      runId: req.params.runId, clfId: req.params.clfId, body: req.body || {},
    }));
    sendJson(res, 201, { data: out });
  });

  // 门禁例外审批
  app.post(R('/delivery/pipeline-runs/:runId/gate-exceptions'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'gate.exception.request');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'gate_exception' } });
    const out = await withTenant(tenantId, () => pipe.requestGateException({
      tenantId, projectId: project.id, actorId: actor.id, runId: req.params.runId, body: req.body || {},
    }));
    sendJson(res, 201, { data: out });
  });

  app.post(R('/delivery/gate-exceptions/:gexId/decide'), authenticate, async (req, res) => {
    const { project, tenantId, actor, roles } = await scopedProject(req, 1, 'gate.exception.decide');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'gate_exception' } });
    const { approved, reason } = req.body || {};
    const out = await withTenant(tenantId, () => pipe.decideGateException({
      tenantId, projectId: project.id, actorId: actor.id, roles,
      gexId: req.params.gexId, approved: !!approved, reason,
    }));
    sendJson(res, 200, { data: out });
  });

  // ---- V1.0-C 仓库与 CI 适配 ----
  // RepoSnapshot 自动采集（挂到 facts 阶段运行，满足事实门禁的基线 commit 项）
  app.post(R('/delivery/repo-snapshots/collect'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'repo.snapshot.collect');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'repo_snapshot' } });
    const { repoBindingId = null, pipelineRunId } = req.body || {};
    const out = await withTenant(tenantId, () => repo.collectRepoSnapshot({
      tenantId, projectId: project.id, actorId: actor.id, repoBindingId, pipelineRunId,
    }));
    sendJson(res, 201, { data: out });
  });

  // 受控分支：为变更包创建 dy/<chg_id>（分支一经创建不可覆盖）
  app.post(R('/delivery/change-packages/:id/branch'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'repo.branch.create');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'change_package' } });
    const { repoBindingId = null, baseBranch = null } = req.body || {};
    const out = await withTenant(tenantId, () => repo.createControlledBranch({
      tenantId, projectId: project.id, actorId: actor.id,
      changePackageId: req.params.id, repoBindingId, baseBranch,
    }));
    sendJson(res, out.existed ? 200 : 201, { data: out });
  });

  // 草稿 PR：平台只创建 draft（硬禁令：无 merge 端点，merged 只能由外部同步）
  app.post(R('/delivery/change-packages/:id/pull-request'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'repo.pr.create');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'pull_request' } });
    const { repoBindingId = null, title = null, description = '' } = req.body || {};
    const out = await withTenant(tenantId, () => repo.createDraftPullRequest({
      tenantId, projectId: project.id, actorId: actor.id,
      changePackageId: req.params.id, repoBindingId, title, description,
    }));
    sendJson(res, out.existed ? 200 : 201, { data: out });
  });

  app.get(R('/delivery/pull-requests'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'repo.pr.list');
    await policyCheck({ actor, tenantId, project, action: 'delivery.read', resource: { kind: 'pull_request' } });
    sendJson(res, 200, {
      data: await repo.listPullRequests(tenantId, project.id, { changePackageId: req.query.changePackageId || null }),
    });
  });

  app.get(R('/delivery/pull-requests/:id'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'repo.pr.get');
    await policyCheck({ actor, tenantId, project, action: 'delivery.read', resource: { kind: 'pull_request' } });
    sendJson(res, 200, { data: await repo.getPullRequest(tenantId, project.id, req.params.id) });
  });

  // PR 状态同步：从远端轮询（merged/closed 只能经此进入）
  app.post(R('/delivery/pull-requests/:id/sync'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'repo.pr.sync');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'pull_request' } });
    const out = await withTenant(tenantId, () => repo.syncPullRequest({
      tenantId, projectId: project.id, actorId: actor.id, prId: req.params.id,
    }));
    sendJson(res, 200, { data: out });
  });

  // ---- V1.0-D 隔离 Runner ----
  // 触发一次 step（build|test|scan|package）：隔离执行 + 结果落库
  // 注意：body 字段逐个白名单提取，绝不 spread——防止调用方覆盖 tenantId/projectId
  app.post(R('/delivery/change-packages/:id/steps'), authenticate, async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'runner.step.run');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'runner_run' } });
    const b = req.body || {};
    const out = await withTenant(tenantId, () => stp.runStep({
      tenantId, projectId: project.id, actorId: c.actorId,
      changePackageId: req.params.id,
      step: b.step, name: b.name, commands: b.commands, env: b.env, limits: b.limits,
      artifacts: b.artifacts, reportFile: b.reportFile, sourceDir: b.sourceDir, source: b.source,
    }));
    sendJson(res, 201, { data: out });
  });

  // 变更包的 Runner 执行记录
  app.get(R('/delivery/change-packages/:id/runner-runs'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'runner.runs.list');
    await policyCheck({ actor, tenantId, project, action: 'delivery.read', resource: { kind: 'runner_run' } });
    sendJson(res, 200, {
      data: await stp.listRunnerRuns(tenantId, project.id, req.params.id, { step: req.query.step || null }),
    });
  });

  // 单条 Runner 执行记录（含脱敏日志）
  app.get(R('/delivery/runner-runs/:runId'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'runner.run.get');
    await policyCheck({ actor, tenantId, project, action: 'delivery.read', resource: { kind: 'runner_run' } });
    sendJson(res, 200, { data: await stp.getRunnerRun(tenantId, project.id, req.params.runId) });
  });

  // DoD 独立复现：在全新独立工作区重跑 build+test，对比 exit code + 产物 hash
  app.post(R('/delivery/change-packages/:id/reproduce'), authenticate, async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'runner.reproduce');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'runner_run' } });
    const out = await withTenant(tenantId, () => stp.reproduce({
      tenantId, projectId: project.id, actorId: c.actorId, changePackageId: req.params.id,
    }));
    sendJson(res, 200, { data: out });
  });

  // ---- V1.0-E 产物合同与交接 ----
  // 产物合同评估：逐项校验 DoD，输出 contract_result JSON（机读 + 人读）
  app.post(R('/delivery/change-packages/:id/contract/evaluate'), authenticate, async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'contract.evaluate');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'change_package' } });
    const out = await withTenant(tenantId, () => evaluateContract({
      tenantId, projectId: project.id, changePackageId: req.params.id, actorId: c.actorId,
    }));
    sendJson(res, 200, { data: out });
  });

  // 变更包组装：合同现场评估通过后生成 manifest/handover/cost 并封存证据包
  app.post(R('/delivery/change-packages/:id/assemble'), authenticate, async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'package.assemble');
    await policyCheck({ actor, tenantId, project, action: 'delivery.write', resource: { kind: 'change_package' } });
    const out = await withTenant(tenantId, () => assemblePackage({
      tenantId, projectId: project.id, changePackageId: req.params.id, actorId: c.actorId,
    }));
    sendJson(res, 201, { data: out });
  });

  // 交接报告下载（Markdown；读取时重算 hash 与登记值比对，防篡改）
  app.get(R('/delivery/change-packages/:id/handover'), authenticate, async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'handover.get');
    await policyCheck({ actor, tenantId, project, action: 'delivery.read', resource: { kind: 'change_package' } });
    const out = await withTenant(tenantId, () => getHandoverReport({
      tenantId, projectId: project.id, changePackageId: req.params.id,
    }));
    const body = out.markdown;
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  });
}
