/**
 * modules/dora/routes.mjs —— V3.6 研发效能度量 HTTP 立面。
 *
 * GET /v1/projects/:projectId/dora?from=&to=&environment_id=  —— 项目级（viewer+）
 * GET /v1/admin/dora?tenant_id=&from=&to=&environment_id=      —— 租户级聚合（平台 operator）
 *
 * 只读报表；鉴权复用发布域只读（dora.read viewer+，KEY_SCOPES 同步）。
 */
import { sendJson } from '../../kernel/http.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { ctx, runWithContext } from '../../kernel/context.mjs';
import { authenticate, effectiveRank, requireScope } from '../identity/middleware.mjs';
import { getProject } from '../identity/store.mjs';
import { decide, inputFromRequest } from '../policy/index.mjs';
import { db } from '../../db/index.mjs';
import { computeDora } from './dora.mjs';

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
      throw Errors.forbidden('禁止跨项目查询效能报表');
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
    action: 'dora.read',
    resource: { kind: 'dora_report' },
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

const num = (v) => (v == null || v === '' ? null : Number(v));

export function registerDoraRoutes(app) {
  const R = (p) => `/v1/projects/:projectId${p}`;

  app.get(R('/dora'), authenticate, requireScope('dora.read'), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0);
    await policyCheck({ actor, tenantId, project });
    const q = req.query || {};
    const out = await withTenant(tenantId, () => computeDora({
      tenantId, projectId: project.id,
      from: num(q.from), to: num(q.to),
      environmentId: q.environment_id || null,
    }));
    sendJson(res, 200, { data: out });
  });

  // 租户级聚合：平台 operator
  app.get('/v1/admin/dora', authenticate, async (req, res) => {
    const c = ctx();
    if (c.authKind !== 'operator') throw Errors.forbidden('仅平台 operator 可查询租户级报表');
    const q = req.query || {};
    const tenantId = q.tenant_id;
    if (!tenantId) throw Errors.badRequest('tenant_id 必填');
    const out = await computeDora({
      tenantId,
      from: num(q.from), to: num(q.to),
      environmentId: q.environment_id || null,
    });
    sendJson(res, 200, { data: out });
  });
}
