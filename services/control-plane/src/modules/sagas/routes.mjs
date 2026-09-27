/**
 * modules/sagas/routes.mjs —— V4.3 长流程与补偿 HTTP 立面。
 *
 * POST   /v1/projects/:projectId/sagas                                            建 saga（operator+）
 * GET    /v1/projects/:projectId/sagas                                            列表（viewer+）
 * GET    /v1/projects/:projectId/sagas/:sagaId                                    详情（viewer+）
 * POST   /v1/projects/:projectId/sagas/:sagaId/runs                               启动执行（operator+；engine=local|temporal）
 * GET    /v1/projects/:projectId/sagas/:sagaId/runs                               run 列表（viewer+）
 * GET    /v1/projects/:projectId/sagas/:sagaId/runs/:runId                        run 详情（viewer+；temporal 引擎读时合并远端状态）
 * GET    /v1/projects/:projectId/sagas/:sagaId/runs/:runId/history                执行历史（viewer+）
 * POST   /v1/projects/:projectId/sagas/:sagaId/runs/:runId/replay                  重放（operator+）
 * POST   /v1/projects/:projectId/sagas/:sagaId/runs/:runId/cancel                  取消（operator+）
 *
 * 鉴权链与 artifacts 模块一致：authenticate → requireScope → 项目归属 → 角色等级 →
 * 策略 decide（saga.read / saga.write）。
 */
import { sendJson } from '../../kernel/http.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { ctx } from '../../kernel/context.mjs';
import { authenticate, effectiveRank, requireScope } from '../identity/middleware.mjs';
import { getProject } from '../identity/store.mjs';
import { decide, inputFromRequest } from '../policy/index.mjs';
import { db } from '../../db/index.mjs';
import { logger } from '../../kernel/logging.mjs';
import * as svc from './sagas.mjs';

async function scopedProject(req, minRank, opName) {
  const c = ctx();
  const pid = req.params.projectId;
  let project = null;
  let roles = c.roles || [];
  if (c.authKind === 'operator') {
    const rows = await db().query('SELECT * FROM projects WHERE id=?', [pid]);
    project = rows[0] || null;
    roles = [{ project_id: null, role: 'admin' }];
    logger.warn('sagas operator access', { op: opName, projectId: pid, tenant_id: project?.tenant_id });
  } else {
    if (!c.tenantId) throw Errors.unauthorized();
    project = await getProject(c.tenantId, pid).catch(() => null);
    if (c.projectId && c.projectId !== pid) throw Errors.forbidden('禁止跨项目操作 saga');
  }
  if (!project || project.status !== 'active') throw Errors.forbidden('项目不存在或无权访问');
  if (effectiveRank(roles, project.id) < minRank) {
    throw Errors.forbidden(minRank >= 1 ? '需要项目 operator 及以上角色' : '需要项目 viewer 及以上角色');
  }
  const tenantId = project.tenant_id;
  const actor = { id: c.actorId, kind: c.actorKind, status: 'active', roles };
  return { c, project, tenantId, actor, roles };
}

async function policyCheck({ actor, tenantId, project, action }) {
  const receipt = await decide(inputFromRequest({
    actor,
    tenant: { id: tenantId, status: 'active' },
    project: { id: project.id },
    action,
    resource: { kind: 'saga', projectId: project.id },
    context: {},
  }));
  if (!receipt.allow) throw Errors.policyDenied(receipt.reason, { receipt });
  return receipt;
}

const R = 'sagas.read';
const W = 'sagas.write';

export function registerSagaRoutes(app) {
  app.post('/v1/projects/:projectId/sagas', authenticate, requireScope(W), async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'saga.create');
    await policyCheck({ actor, tenantId, project, action: 'saga.write' });
    const { name, definition } = req.body || {};
    const out = await svc.createSaga({ tenantId, projectId: project.id, name, definition, createdBy: c.actorId });
    sendJson(res, 201, { data: out });
  });

  app.get('/v1/projects/:projectId/sagas', authenticate, requireScope(R), async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 0, 'saga.list');
    await policyCheck({ actor, tenantId, project, action: 'saga.read' });
    sendJson(res, 200, { data: await svc.listSagas({ tenantId, projectId: project.id }) });
  });

  app.get('/v1/projects/:projectId/sagas/:sagaId', authenticate, requireScope(R), async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 0, 'saga.get');
    await policyCheck({ actor, tenantId, project, action: 'saga.read' });
    sendJson(res, 200, { data: await svc.getSaga({ tenantId, projectId: project.id, sagaId: req.params.sagaId }) });
  });

  app.post('/v1/projects/:projectId/sagas/:sagaId/runs', authenticate, requireScope(W), async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'saga.run.start');
    await policyCheck({ actor, tenantId, project, action: 'saga.write' });
    const { input, engine } = req.body || {};
    const out = await svc.startRun({
      tenantId, projectId: project.id, sagaId: req.params.sagaId,
      input, engine: engine || 'local', actorId: c.actorId,
    });
    sendJson(res, 201, { data: out });
  });

  app.get('/v1/projects/:projectId/sagas/:sagaId/runs', authenticate, requireScope(R), async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 0, 'saga.run.list');
    await policyCheck({ actor, tenantId, project, action: 'saga.read' });
    sendJson(res, 200, { data: await svc.listRuns({ tenantId, projectId: project.id, sagaId: req.params.sagaId }) });
  });

  app.get('/v1/projects/:projectId/sagas/:sagaId/runs/:runId', authenticate, requireScope(R), async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 0, 'saga.run.get');
    await policyCheck({ actor, tenantId, project, action: 'saga.read' });
    sendJson(res, 200, { data: await svc.getRun({ tenantId, projectId: project.id, runId: req.params.runId }) });
  });

  app.get('/v1/projects/:projectId/sagas/:sagaId/runs/:runId/history', authenticate, requireScope(R), async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 0, 'saga.run.history');
    await policyCheck({ actor, tenantId, project, action: 'saga.read' });
    sendJson(res, 200, { data: await svc.getHistory({ tenantId, projectId: project.id, runId: req.params.runId }) });
  });

  app.post('/v1/projects/:projectId/sagas/:sagaId/runs/:runId/replay', authenticate, requireScope(W), async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'saga.run.replay');
    await policyCheck({ actor, tenantId, project, action: 'saga.write' });
    const { engine } = req.body || {};
    const out = await svc.replayRun({
      tenantId, projectId: project.id, runId: req.params.runId, actorId: c.actorId, engine,
    });
    sendJson(res, 201, { data: out });
  });

  app.post('/v1/projects/:projectId/sagas/:sagaId/runs/:runId/cancel', authenticate, requireScope(W), async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'saga.run.cancel');
    await policyCheck({ actor, tenantId, project, action: 'saga.write' });
    const out = await svc.cancelRun({ tenantId, projectId: project.id, runId: req.params.runId, actorId: c.actorId });
    sendJson(res, 200, { data: out });
  });
}
