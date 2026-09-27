/**
 * modules/artifacts/store.mjs —— V3.3 制品库：真相源 CRUD + 内容寻址 blob 存储。
 *
 * 模型：artifact_packages（制品流，归属项目）→ artifact_versions（不可变版本行）
 *       → artifact_links（版本 ↔ pipeline_run / release / change_package）。
 *
 * Blob 存储（诚实边界）：
 * - 本地盘内容寻址：ARTIFACT_STORE_DIR/<sha256[0:2]>/<sha256[2:4]>/<sha256>。
 *   同一内容多版本/跨租户共享一份文件；删除版本时仅当无任何版本引用才删文件
 *   （引用计数式清理，避免误删别租户的 blob）。
 * - 生产若要上 S3/对象存储，替换本文件的 blob* 三函数即可，DB 契约不变；
 *   storage_path 存的是相对路径，迁移时可重写。
 * - 上传走"写临时文件 → 算哈希 → 原子 rename"，崩溃不留半文件。
 */
import { createHash } from 'node:crypto';
import { createWriteStream, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { db } from '../../db/index.mjs';
import { newId, nowMs } from '../../kernel/ids.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { tryAudit } from '../evidence/audit.mjs';
import { newTraceId } from '../../kernel/context.mjs';

export const ARTIFACT_KINDS = new Set([
  'image', 'helm_chart', 'binary', 'sbom', 'test_report', 'scan_report', 'doc', 'other',
]);
export const VERSION_STATUSES = new Set(['active', 'deprecated', 'pinned']);
export const LINK_KINDS = new Set(['pipeline_run', 'release', 'change_package']);
/** 版本号字符集：防路径穿越/注入；存储路径实际用版本行 id，与版本号无关。 */
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+\-]{0,127}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,127}$/;

const parseJson = (s, fb) => { try { const v = JSON.parse(s); return v ?? fb; } catch { return fb; } };

export function assertVersion(v) {
  if (!VERSION_RE.test(String(v || ''))) throw Errors.badRequest('version 非法（允许字母数字及 . _ + -，最长128）');
}
export function assertPackageName(n) {
  if (!NAME_RE.test(String(n || ''))) throw Errors.badRequest('name 非法（允许字母数字及 . _ - /，最长128）');
}

// ---------- blob 存储 ----------

export function storeDir() {
  const dir = process.env.ARTIFACT_STORE_DIR || join(resolve('data'), 'artifacts');
  return resolve(dir);
}

export function blobPathFor(hash) {
  return join(hash.slice(0, 2), hash.slice(2, 4), hash);
}

/** Buffer 写入内容寻址存储（幂等：同 hash 已存在则直接复用）。返回 { hash, size, storagePath }。 */
export async function writeBlob(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw Errors.badRequest('制品内容为空');
  const hash = createHash('sha256').update(buffer).digest('hex');
  const rel = blobPathFor(hash);
  const abs = join(storeDir(), rel);
  try {
    await fsp.stat(abs);
    return { hash, size: buffer.length, storagePath: rel }; // 已存在：去重复用
  } catch { /* 不存在，继续写 */ }
  await fsp.mkdir(dirname(abs), { recursive: true });
  const tmp = join(tmpdir(), `deyi-artifact-${hash}.tmp`);
  await new Promise((res, rej) => {
    const ws = createWriteStream(tmp);
    ws.on('error', rej);
    ws.on('finish', res);
    ws.end(buffer);
  });
  try {
    await fsp.rename(tmp, abs);
  } catch (e) {
    // 并发上传同一内容：rename 目标已存在 → 复用
    if (e?.code !== 'EEXIST') { try { await fsp.unlink(tmp); } catch { /* ignore */ } throw e; }
    try { await fsp.unlink(tmp); } catch { /* ignore */ }
  }
  return { hash, size: buffer.length, storagePath: rel };
}

/** 打开 blob 读流；文件缺失返回 null（调用方判 404/500，语义诚实）。 */
export async function openBlobReadStream(storagePath) {
  const abs = join(storeDir(), storagePath);
  try {
    const st = await fsp.stat(abs);
    if (!st.isFile()) return null;
    const { createReadStream } = await import('node:fs');
    return { stream: createReadStream(abs), size: st.size };
  } catch {
    return null;
  }
}

/** 引用计数式清理：没有任何版本行再引用该 hash 时才删文件。返回是否删除。 */
export async function deleteBlobIfUnreferenced(hash) {
  const rows = await db().query('SELECT id FROM artifact_versions WHERE content_hash=? LIMIT 1', [hash]);
  if (rows.length) return false;
  try {
    await fsp.unlink(join(storeDir(), blobPathFor(hash)));
    return true;
  } catch {
    return false; // 文件本就不存在：视为已清理
  }
}

/** offboard 用：删掉该租户独占的 blob（仍有其他租户版本引用则保留）。返回删除文件数。 */
export async function purgeTenantBlobs(tenantId) {
  const rows = await db().query(
    'SELECT DISTINCT content_hash FROM artifact_versions WHERE tenant_id=?', [tenantId]);
  let removed = 0;
  for (const r of rows) {
    const others = await db().query(
      'SELECT id FROM artifact_versions WHERE content_hash=? AND tenant_id<>? LIMIT 1',
      [r.content_hash, tenantId]);
    if (others.length) continue;
    try {
      await fsp.unlink(join(storeDir(), blobPathFor(r.content_hash)));
      removed++;
    } catch { /* ignore */ }
  }
  return removed;
}

// ---------- packages ----------

const normPkg = (r) => r && { ...r };
const normVer = (r) => r && { ...r, metadata: parseJson(r.metadata, {}) };

export async function createPackage({ tenantId, projectId, name, kind = 'other', description = '', retentionDays = null, createdBy }) {
  assertPackageName(name);
  if (!ARTIFACT_KINDS.has(kind)) throw Errors.badRequest(`kind 非法（可用：${[...ARTIFACT_KINDS].join(',')}）`);
  let rd = null;
  if (retentionDays !== null && retentionDays !== undefined) {
    rd = Number(retentionDays);
    if (!Number.isInteger(rd) || rd < 0) throw Errors.badRequest('retention_days 必须为非负整数天数');
  }
  const row = {
    id: newId('artp'), tenant_id: tenantId, project_id: projectId,
    name: String(name), kind, description: String(description || ''),
    retention_days: rd, created_by: createdBy || null,
    created_at: nowMs(), updated_at: nowMs(),
  };
  try {
    await db().query(
      `INSERT INTO artifact_packages(id,tenant_id,project_id,name,kind,description,retention_days,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [row.id, row.tenant_id, row.project_id, row.name, row.kind, row.description,
       row.retention_days, row.created_by, row.created_at, row.updated_at]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) throw Errors.conflict('同项目下制品包名称已存在');
    throw e;
  }
  await tryAudit({
    tenantId, projectId, actorId: createdBy, traceId: newTraceId(),
    action: 'artifact.package.create', resourceKind: 'artifact_package', resourceId: row.id,
    payload: { name: row.name, kind },
  });
  return normPkg(row);
}

export async function listPackages(tenantId, projectId) {
  const rows = await db().query(
    'SELECT * FROM artifact_packages WHERE tenant_id=? AND project_id=? ORDER BY created_at DESC',
    [tenantId, projectId]);
  return rows.map(normPkg);
}

export async function getPackage(tenantId, packageId) {
  const rows = await db().query(
    'SELECT * FROM artifact_packages WHERE tenant_id=? AND id=?', [tenantId, packageId]);
  return normPkg(rows[0]) || null;
}

export async function updatePackage(tenantId, packageId, { description, retentionDays }) {
  const pkg = await getPackage(tenantId, packageId);
  if (!pkg) throw Errors.notFound('制品包不存在');
  const patch = {};
  if (description !== undefined) patch.description = String(description || '');
  if (retentionDays !== undefined) {
    if (retentionDays === null) patch.retention_days = null;
    else {
      const rd = Number(retentionDays);
      if (!Number.isInteger(rd) || rd < 0) throw Errors.badRequest('retention_days 必须为非负整数天数');
      patch.retention_days = rd;
    }
  }
  if (!Object.keys(patch).length) return pkg;
  patch.updated_at = nowMs();
  const sets = Object.keys(patch).map((k) => `${k}=?`).join(',');
  await db().query(`UPDATE artifact_packages SET ${sets} WHERE tenant_id=? AND id=?`,
    [...Object.values(patch), tenantId, packageId]);
  return getPackage(tenantId, packageId);
}

/** 删除包：级联删版本行/links；blob 按引用计数清理。返回 { versions }。 */
export async function deletePackage(tenantId, packageId, { actorId } = {}) {
  const pkg = await getPackage(tenantId, packageId);
  if (!pkg) throw Errors.notFound('制品包不存在');
  const vers = await db().query('SELECT id, content_hash FROM artifact_versions WHERE tenant_id=? AND package_id=?',
    [tenantId, packageId]);
  for (const v of vers) {
    await db().query('DELETE FROM artifact_links WHERE tenant_id=? AND version_id=?', [tenantId, v.id]);
  }
  await db().query('DELETE FROM artifact_versions WHERE tenant_id=? AND package_id=?', [tenantId, packageId]);
  await db().query('DELETE FROM artifact_packages WHERE tenant_id=? AND id=?', [tenantId, packageId]);
  for (const v of vers) await deleteBlobIfUnreferenced(v.content_hash);
  await tryAudit({
    tenantId, projectId: pkg.project_id, actorId, traceId: newTraceId(),
    action: 'artifact.package.delete', resourceKind: 'artifact_package', resourceId: packageId,
    payload: { name: pkg.name, versions: vers.length },
  });
  return { versions: vers.length };
}

// ---------- versions ----------

export async function createVersion({ tenantId, packageId, version, filename = '', metadata = {}, createdBy, buffer }) {
  const pkg = await getPackage(tenantId, packageId);
  if (!pkg) throw Errors.notFound('制品包不存在');
  assertVersion(version);
  if (metadata !== undefined && (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))) {
    throw Errors.badRequest('metadata 必须为 JSON 对象');
  }
  const { hash, size, storagePath } = await writeBlob(buffer);
  const row = {
    id: newId('artv'), tenant_id: tenantId, package_id: packageId,
    version: String(version), content_hash: hash, size_bytes: size,
    storage_path: storagePath, filename: String(filename || ''),
    metadata: JSON.stringify(metadata || {}), status: 'active',
    created_by: createdBy || null, created_at: nowMs(),
  };
  try {
    await db().query(
      `INSERT INTO artifact_versions(id,tenant_id,package_id,version,content_hash,size_bytes,
        storage_path,filename,metadata,status,created_by,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [row.id, row.tenant_id, row.package_id, row.version, row.content_hash, row.size_bytes,
       row.storage_path, row.filename, row.metadata, row.status, row.created_by, row.created_at]);
  } catch (e) {
    await deleteBlobIfUnreferenced(hash); // 插入失败不留孤 blob
    if (/UNIQUE/i.test(String(e?.message))) throw Errors.conflict('该包下版本号已存在');
    throw e;
  }
  await tryAudit({
    tenantId, projectId: pkg.project_id, actorId: createdBy, traceId: newTraceId(),
    action: 'artifact.version.upload', resourceKind: 'artifact_version', resourceId: row.id,
    payload: { package: pkg.name, version: row.version, content_hash: hash, size_bytes: size },
  });
  return normVer(row);
}

/** 按版本行 id 或版本号串查找（同包内版本号唯一，优先按 id 精确匹配）。 */
export async function getVersion(tenantId, packageId, versionOrId) {
  let rows = await db().query(
    'SELECT * FROM artifact_versions WHERE tenant_id=? AND package_id=? AND id=?',
    [tenantId, packageId, versionOrId]);
  if (!rows.length) {
    rows = await db().query(
      'SELECT * FROM artifact_versions WHERE tenant_id=? AND package_id=? AND version=?',
      [tenantId, packageId, String(versionOrId)]);
  }
  return normVer(rows[0]) || null;
}

export async function listVersions(tenantId, packageId, { status = null, limit = 50 } = {}) {
  const pkg = await getPackage(tenantId, packageId);
  if (!pkg) throw Errors.notFound('制品包不存在');
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const args = [tenantId, packageId];
  let cond = 'tenant_id=? AND package_id=?';
  if (status) {
    if (!VERSION_STATUSES.has(status)) throw Errors.badRequest('status 非法');
    cond += ' AND status=?';
    args.push(status);
  }
  const rows = await db().query(
    `SELECT * FROM artifact_versions WHERE ${cond} ORDER BY created_at DESC LIMIT ${lim}`, args);
  return rows.map(normVer);
}

export async function setVersionStatus(tenantId, packageId, versionOrId, status, { actorId } = {}) {
  if (!VERSION_STATUSES.has(status)) throw Errors.badRequest('status 非法（active/deprecated/pinned）');
  const ver = await getVersion(tenantId, packageId, versionOrId);
  if (!ver) throw Errors.notFound('制品版本不存在');
  if (ver.status === status) return ver;
  await db().query('UPDATE artifact_versions SET status=? WHERE tenant_id=? AND id=?',
    [status, tenantId, ver.id]);
  await tryAudit({
    tenantId, actorId, traceId: newTraceId(),
    action: 'artifact.version.status', resourceKind: 'artifact_version', resourceId: ver.id,
    payload: { from: ver.status, to: status, version: ver.version },
  });
  return { ...ver, status };
}

/** 删除版本行 + 关联 links；blob 按引用计数清理。 */
export async function deleteVersion(tenantId, packageId, versionOrId, { actorId } = {}) {
  const ver = await getVersion(tenantId, packageId, versionOrId);
  if (!ver) throw Errors.notFound('制品版本不存在');
  await db().query('DELETE FROM artifact_links WHERE tenant_id=? AND version_id=?', [tenantId, ver.id]);
  await db().query('DELETE FROM artifact_versions WHERE tenant_id=? AND id=?', [tenantId, ver.id]);
  const blobRemoved = await deleteBlobIfUnreferenced(ver.content_hash);
  await tryAudit({
    tenantId, actorId, traceId: newTraceId(),
    action: 'artifact.version.delete', resourceKind: 'artifact_version', resourceId: ver.id,
    payload: { version: ver.version, blob_removed: blobRemoved },
  });
  return { blob_removed: blobRemoved };
}

// ---------- links ----------

const LINK_TARGET_TABLE = {
  pipeline_run: 'pipeline_runs',
  release: 'releases',
  change_package: 'change_packages',
};

export async function addLink({ tenantId, packageId, versionOrId, linkKind, linkId, createdBy }) {
  if (!LINK_KINDS.has(linkKind)) throw Errors.badRequest(`link_kind 非法（可用：${[...LINK_KINDS].join(',')}）`);
  const ver = await getVersion(tenantId, packageId, versionOrId);
  if (!ver) throw Errors.notFound('制品版本不存在');
  const table = LINK_TARGET_TABLE[linkKind];
  const target = await db().query(`SELECT id FROM ${table} WHERE tenant_id=? AND id=?`, [tenantId, linkId]);
  if (!target.length) throw Errors.notFound(`关联目标不存在：${linkKind}/${linkId}`);
  const row = {
    id: newId('artl'), tenant_id: tenantId, version_id: ver.id,
    link_kind: linkKind, link_id: linkId, created_by: createdBy || null, created_at: nowMs(),
  };
  try {
    await db().query(
      'INSERT INTO artifact_links(id,tenant_id,version_id,link_kind,link_id,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
      [row.id, row.tenant_id, row.version_id, row.link_kind, row.link_id, row.created_by, row.created_at]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) throw Errors.conflict('关联已存在');
    throw e;
  }
  await tryAudit({
    tenantId, actorId: createdBy, traceId: newTraceId(),
    action: 'artifact.link.add', resourceKind: 'artifact_version', resourceId: ver.id,
    payload: { link_kind: linkKind, link_id: linkId },
  });
  return row;
}

export async function listLinks(tenantId, packageId, versionOrId) {
  const ver = await getVersion(tenantId, packageId, versionOrId);
  if (!ver) throw Errors.notFound('制品版本不存在');
  return db().query('SELECT * FROM artifact_links WHERE tenant_id=? AND version_id=? ORDER BY created_at DESC',
    [tenantId, ver.id]);
}

export async function removeLink(tenantId, packageId, versionOrId, linkId) {
  const ver = await getVersion(tenantId, packageId, versionOrId);
  if (!ver) throw Errors.notFound('制品版本不存在');
  const r = await db().run('DELETE FROM artifact_links WHERE tenant_id=? AND version_id=? AND id=?',
    [tenantId, ver.id, linkId]);
  if (!r.changes) throw Errors.notFound('关联不存在');
  return { removed: true };
}

/**
 * V2.7 打通：按保留策略清理制品版本。
 * 规则：created_at 早于阈值 且 status != 'pinned' 且 未被任何 release 关联。
 * （release 是部署记录，关联即视为需追溯；pipeline_run/change_package 关联不钉住，
 *  它们本身也有各自的保留策略。）
 * 包级 retention_days 覆盖租户策略；days 参数为租户级天数。
 * 返回 { deleted, kept_release_linked, kept_pinned }。
 */
export async function sweepArtifactVersions(tenantId, { days, dryRun = false } = {}) {
  const now = nowMs();
  const pkgs = await db().query('SELECT id, retention_days FROM artifact_packages WHERE tenant_id=?', [tenantId]);
  let deleted = 0, keptPinned = 0, keptReleaseLinked = 0;
  const relLinked = new Set((await db().query(
    `SELECT version_id FROM artifact_links WHERE tenant_id=? AND link_kind='release'`, [tenantId]
  )).map((r) => r.version_id));
  for (const pkg of pkgs) {
    const d = Number.isInteger(pkg.retention_days) && pkg.retention_days >= 0 ? pkg.retention_days : days;
    const cutoff = now - d * 86400_000;
    const vers = await db().query(
      'SELECT id, content_hash, status FROM artifact_versions WHERE tenant_id=? AND package_id=? AND created_at<=?',
      [tenantId, pkg.id, cutoff]);
    for (const v of vers) {
      if (v.status === 'pinned') { keptPinned++; continue; }
      if (relLinked.has(v.id)) { keptReleaseLinked++; continue; }
      if (dryRun) { deleted++; continue; }
      await db().query('DELETE FROM artifact_links WHERE tenant_id=? AND version_id=?', [tenantId, v.id]);
      await db().query('DELETE FROM artifact_versions WHERE tenant_id=? AND id=?', [tenantId, v.id]);
      await deleteBlobIfUnreferenced(v.content_hash);
      deleted++;
    }
  }
  if (!dryRun && deleted > 0) {
    await tryAudit({
      tenantId, actorId: 'system:retention', traceId: newTraceId(),
      action: 'retention.sweep.artifacts', resourceKind: 'tenant', resourceId: tenantId,
      payload: { deleted, kept_pinned: keptPinned, kept_release_linked: keptReleaseLinked },
    });
  }
  return { deleted, kept_pinned: keptPinned, kept_release_linked: keptReleaseLinked };
}
