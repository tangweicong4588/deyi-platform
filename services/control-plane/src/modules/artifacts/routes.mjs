/**
 * modules/artifacts/routes.mjs —— V3.3 制品库 HTTP 立面。
 *
 * POST   /v1/projects/:projectId/artifact-packages                                   建包（operator+）
 * GET    /v1/projects/:projectId/artifact-packages                                   列表（viewer+）
 * GET    /v1/projects/:projectId/artifact-packages/:packageId                        详情（viewer+）
 * PATCH  /v1/projects/:projectId/artifact-packages/:packageId                        改描述/保留期（operator+）
 * DELETE /v1/projects/:projectId/artifact-packages/:packageId                        删包级联（operator+）
 * POST   /v1/projects/:projectId/artifact-packages/:packageId/versions                上传（operator+，二进制 body；query: version/filename/metadata）
 * GET    /v1/projects/:projectId/artifact-packages/:packageId/versions                版本列表（viewer+）
 * GET    /v1/projects/:projectId/artifact-packages/:packageId/versions/:version       版本元数据（viewer+）
 * PATCH  /v1/projects/:projectId/artifact-packages/:packageId/versions/:version      改状态（operator+）
 * DELETE /v1/projects/:projectId/artifact-packages/:packageId/versions/:version      删版本（operator+）
 * GET    /v1/projects/:projectId/artifact-packages/:packageId/versions/:version/download  下载（viewer+）
 * POST   /v1/projects/:projectId/artifact-packages/:packageId/versions/:version/links    关联（operator+）
 * GET    /v1/projects/:projectId/artifact-packages/:packageId/versions/:version/links    关联列表（viewer+）
 * DELETE /v1/projects/:projectId/artifact-packages/:packageId/versions/:version/links/:linkId  解关联（operator+）
 *
 * 鉴权链与 knowledge 模块一致：authenticate → requireScope → 项目归属 → 角色等级 →
 * 策略 decide（artifact.read / artifact.write）。
 */
import { sendJson } from '../../kernel/http.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { ctx } from '../../kernel/context.mjs';
import { authenticate, effectiveRank, requireScope } from '../identity/middleware.mjs';
import { getProject } from '../identity/store.mjs';
import { decide, inputFromRequest } from '../policy/index.mjs';
import { db } from '../../db/index.mjs';
import { logger } from '../../kernel/logging.mjs';
import * as svc from './store.mjs';

async function scopedProject(req, minRank, opName) {
  const c = ctx();
  const pid = req.params.projectId;
  let project = null;
  let roles = c.roles || [];
  if (c.authKind === 'operator') {
    const rows = await db().query('SELECT * FROM projects WHERE id=?', [pid]);
    project = rows[0] || null;
    roles = [{ project_id: null, role: 'admin' }];
    logger.warn('artifacts operator access', { op: opName, projectId: pid, tenant_id: project?.tenant_id });
  } else {
    if (!c.tenantId) throw Errors.unauthorized();
    project = await getProject(c.tenantId, pid).catch(() => null);
    if (c.projectId && c.projectId !== pid) throw Errors.forbidden('禁止跨项目操作制品');
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
    resource: { kind: 'artifact', projectId: project.id },
    context: {},
  }));
  if (!receipt.allow) throw Errors.policyDenied(receipt.reason, { receipt });
  return receipt;
}

const R = 'artifacts.read';
const W = 'artifacts.write';

export function registerArtifactRoutes(app) {
  // ---- packages ----
  app.post('/v1/projects/:projectId/artifact-packages', authenticate, requireScope(W), async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'package.create');
    await policyCheck({ actor, tenantId, project, action: 'artifact.write' });
    const { name, kind, description, retention_days } = req.body || {};
    const out = await svc.createPackage({
      tenantId, projectId: project.id, name, kind, description,
      retentionDays: retention_days ?? null, createdBy: c.actorId,
    });
    sendJson(res, 201, { data: out });
  });

  app.get('/v1/projects/:projectId/artifact-packages', authenticate, requireScope(R), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'package.list');
    await policyCheck({ actor, tenantId, project, action: 'artifact.read' });
    sendJson(res, 200, { data: await svc.listPackages(tenantId, project.id) });
  });

  app.get('/v1/projects/:projectId/artifact-packages/:packageId', authenticate, requireScope(R), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'package.get');
    await policyCheck({ actor, tenantId, project, action: 'artifact.read' });
    const pkg = await svc.getPackage(tenantId, req.params.packageId);
    if (!pkg) throw Errors.notFound('制品包不存在');
    sendJson(res, 200, { data: pkg });
  });

  app.patch('/v1/projects/:projectId/artifact-packages/:packageId', authenticate, requireScope(W), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'package.update');
    await policyCheck({ actor, tenantId, project, action: 'artifact.write' });
    const { description, retention_days } = req.body || {};
    const out = await svc.updatePackage(tenantId, req.params.packageId, {
      description, retentionDays: retention_days,
    });
    sendJson(res, 200, { data: out });
  });

  app.delete('/v1/projects/:projectId/artifact-packages/:packageId', authenticate, requireScope(W), async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'package.delete');
    await policyCheck({ actor, tenantId, project, action: 'artifact.write' });
    const out = await svc.deletePackage(tenantId, req.params.packageId, { actorId: c.actorId });
    sendJson(res, 200, { data: out });
  });

  // ---- versions ----
  app.post('/v1/projects/:projectId/artifact-packages/:packageId/versions', authenticate, requireScope(W), async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'version.upload');
    await policyCheck({ actor, tenantId, project, action: 'artifact.write' });
    if (!Buffer.isBuffer(req.body)) throw Errors.badRequest('上传需 application/octet-stream 二进制 body');
    const version = req.query.version;
    if (!version) throw Errors.badRequest('query.version 必填');
    let metadata;
    if (req.query.metadata !== undefined) {
      try { metadata = JSON.parse(req.query.metadata); }
      catch { throw Errors.badRequest('query.metadata 非法 JSON'); }
    }
    const out = await svc.createVersion({
      tenantId, packageId: req.params.packageId, version,
      filename: req.query.filename || '', metadata,
      createdBy: c.actorId, buffer: req.body,
    });
    sendJson(res, 201, { data: out });
  });

  app.get('/v1/projects/:projectId/artifact-packages/:packageId/versions', authenticate, requireScope(R), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'version.list');
    await policyCheck({ actor, tenantId, project, action: 'artifact.read' });
    const out = await svc.listVersions(tenantId, req.params.packageId, {
      status: req.query.status || null, limit: req.query.limit,
    });
    sendJson(res, 200, { data: out });
  });

  app.get('/v1/projects/:projectId/artifact-packages/:packageId/versions/:version', authenticate, requireScope(R), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'version.get');
    await policyCheck({ actor, tenantId, project, action: 'artifact.read' });
    const ver = await svc.getVersion(tenantId, req.params.packageId, req.params.version);
    if (!ver) throw Errors.notFound('制品版本不存在');
    sendJson(res, 200, { data: ver });
  });

  app.patch('/v1/projects/:projectId/artifact-packages/:packageId/versions/:version', authenticate, requireScope(W), async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'version.status');
    await policyCheck({ actor, tenantId, project, action: 'artifact.write' });
    const { status } = req.body || {};
    if (!status) throw Errors.badRequest('status 必填');
    const out = await svc.setVersionStatus(tenantId, req.params.packageId, req.params.version, status, { actorId: c.actorId });
    sendJson(res, 200, { data: out });
  });

  app.delete('/v1/projects/:projectId/artifact-packages/:packageId/versions/:version', authenticate, requireScope(W), async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'version.delete');
    await policyCheck({ actor, tenantId, project, action: 'artifact.write' });
    const out = await svc.deleteVersion(tenantId, req.params.packageId, req.params.version, { actorId: c.actorId });
    sendJson(res, 200, { data: out });
  });

  app.get('/v1/projects/:projectId/artifact-packages/:packageId/versions/:version/download', authenticate, requireScope(R), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'version.download');
    await policyCheck({ actor, tenantId, project, action: 'artifact.read' });
    const ver = await svc.getVersion(tenantId, req.params.packageId, req.params.version);
    if (!ver) throw Errors.notFound('制品版本不存在');
    const blob = await svc.openBlobReadStream(ver.storage_path);
    if (!blob) throw Errors.notFound('制品文件缺失：存储与元数据不一致（BLOB_MISSING）');
    const fname = encodeURIComponent(ver.filename || `${ver.version}.bin`);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': blob.size,
      'content-disposition': `attachment; filename*=UTF-8''${fname}`,
      'etag': `"${ver.content_hash}"`,
      'x-content-sha256': ver.content_hash,
    });
    blob.stream.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
    blob.stream.pipe(res);
  });

  // ---- links ----
  app.post('/v1/projects/:projectId/artifact-packages/:packageId/versions/:version/links', authenticate, requireScope(W), async (req, res) => {
    const { project, tenantId, actor, c } = await scopedProject(req, 1, 'link.add');
    await policyCheck({ actor, tenantId, project, action: 'artifact.write' });
    const { link_kind, link_id } = req.body || {};
    if (!link_kind || !link_id) throw Errors.badRequest('link_kind / link_id 必填');
    const out = await svc.addLink({
      tenantId, packageId: req.params.packageId, versionOrId: req.params.version,
      linkKind: link_kind, linkId: link_id, createdBy: c.actorId,
    });
    sendJson(res, 201, { data: out });
  });

  app.get('/v1/projects/:projectId/artifact-packages/:packageId/versions/:version/links', authenticate, requireScope(R), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 0, 'link.list');
    await policyCheck({ actor, tenantId, project, action: 'artifact.read' });
    sendJson(res, 200, { data: await svc.listLinks(tenantId, req.params.packageId, req.params.version) });
  });

  app.delete('/v1/projects/:projectId/artifact-packages/:packageId/versions/:version/links/:linkId', authenticate, requireScope(W), async (req, res) => {
    const { project, tenantId, actor } = await scopedProject(req, 1, 'link.remove');
    await policyCheck({ actor, tenantId, project, action: 'artifact.write' });
    sendJson(res, 200, {
      data: await svc.removeLink(tenantId, req.params.packageId, req.params.version, req.params.linkId),
    });
  });
}
