/**
 * modules/traceability/routes.mjs —— V3.4 全链路追溯 HTTP 立面。
 *
 * GET /v1/projects/:projectId/trace?seed_kind=<kind>&seed_id=<id>
 * 鉴权链：authenticate → requireScope('trace.read') → 项目归属 → 角色等级 →
 * 策略 decide（trace.read viewer+）。只读，无写入端点。
 */
import { sendJson } from '../../kernel/http.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { ctx, runWithContext } from '../../kernel/context.mjs';
import { authenticate, effectiveRank, requireScope } from '../identity/middleware.mjs';
import { getProject } from '../identity/store.mjs';
import { decide, inputFromRequest } from '../policy/index.mjs';
import { db } from '../../db/index.mjs';
import { buildTrace, TRACE_SEED_KINDS } from './trace.mjs';

const R = 'trace.read';

async function scopedProject(req, minRank) {
  const c = ctx();
  const pid = req.params.projectId;
  let project = null;
  let roles = c.roles || [];
  if (c.authKind === 'operator') {
    const rows = await db().query('SELECT * FROM projects WHERE id=?', [pid]);
    project = rows[0] || null;
    roles = [{ project_id: null, role: 'admin' }];
  } else {
    if (!c.tenantId) throw Errors.unauthorized();
    project = await getProject(c.tenantId, pid).catch(() => null);
    if (c.projectId && c.projectId !== pid) {
      throw Errors.forbidden('禁止跨项目查询追溯链');
    }
  }
  if (!project || project.status !== 'active') throw Errors.forbidden('项目不存在或无权访问');
  if (effectiveRank(roles, project.id) < minRank) {
    throw Errors.forbidden('需要项目 viewer 及以上角色');
  }
  const tenantId = project.tenant_id;
  const actor = { id: c.actorId, kind: c.actorKind, status: 'active', roles };
  return { c, project, tenantId, actor };
}

async function policyCheck({ actor, tenantId, project }) {
  const receipt = await decide(inputFromRequest({
    actor,
    tenant: { id: tenantId, status: 'active' },
    project: { id: project.id },
    action: 'trace.read',
    resource: { kind: 'trace' },
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

export function registerTraceabilityRoutes(app) {
  app.get('/v1/projects/:projectId/trace', authenticate, requireScope(R), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0);
    await policyCheck({ actor, tenantId, project });
    const { seed_kind: seedKind, seed_id: seedId } = req.query || {};
    if (!seedKind || !seedId) {
      throw Errors.badRequest(`seed_kind / seed_id 必填（seed_kind 可用：${TRACE_SEED_KINDS.join(',')}）`, { code: 'BAD_REQUEST' });
    }
    const out = await withTenant(tenantId, () => buildTrace({
      tenantId, projectId: project.id, seedKind, seedId,
    }));
    sendJson(res, 200, { data: out });
  });
}
