/**
 * modules/evidence/packages.mjs —— 证据包：把一组审计事件打包 + Merkle 根，
 * 用于对外举证（审计/合规/纠纷）。包内事件只读快照，重算 Merkle 根即可验包。
 *
 * Merkle：叶子 = 事件 hash（按 seq 升序）；两两 sha256(left+right)；
 * 奇数时复制最后一个。空包拒绝。
 */
import { createHash } from 'node:crypto';
import { newId, nowMs } from '../../kernel/ids.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { db } from '../../db/index.mjs';
import { logger } from '../../kernel/logging.mjs';

export function merkleRoot(leaves) {
  if (!leaves.length) throw new Error('空事件集不能打包');
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i], r = level[i + 1] || l;
      next.push(createHash('sha256').update(l + r, 'utf8').digest('hex'));
    }
    level = next;
  }
  return level[0];
}

async function mustOwnEvents(tenantId, eventIds) {
  const rows = await db().query(
    `SELECT * FROM audit_events WHERE tenant_id=? AND id IN (${eventIds.map(() => '?').join(',')})
     ORDER BY seq ASC`,
    [tenantId, ...eventIds]);
  if (rows.length !== eventIds.length) {
    throw Errors.badRequest('部分事件不存在或不属于本租户', { code: 'EVIDENCE_SCOPE' });
  }
  return rows;
}

/**
 * 打包。eventIds 与 timeRange 二选一（都给则取交集）。
 * projectId 可选：限定只包该项目的事件（跨项目事件混入则拒绝）。
 */
export async function buildPackage({ tenantId, projectId = null, name, eventIds = null, from = null, to = null, createdBy }) {
  if (!name) throw Errors.badRequest('name 必填');
  let rows;
  if (eventIds && eventIds.length) {
    rows = await mustOwnEvents(tenantId, [...new Set(eventIds)]);
  } else {
    rows = await db().query(
      `SELECT * FROM audit_events WHERE tenant_id=? ${from ? 'AND created_at>=?' : ''} ${to ? 'AND created_at<=?' : ''}
       ORDER BY seq ASC`,
      [tenantId, ...(from ? [from] : []), ...(to ? [to] : [])]);
  }
  if (projectId) {
    const foreign = rows.filter((r) => r.project_id && r.project_id !== projectId);
    if (foreign.length) throw Errors.forbidden('证据包不能混入其他项目的事件');
    rows = rows.filter((r) => !r.project_id || r.project_id === projectId);
  }
  if (!rows.length) throw Errors.badRequest('没有可打包的事件');
  const root = merkleRoot(rows.map((r) => r.hash));
  const pkg = {
    id: newId('pkg'), tenant_id: tenantId, project_id: projectId, name,
    event_ids: JSON.stringify(rows.map((r) => r.id)), merkle_root: root,
    event_count: rows.length, anchored: 0, anchor_ref: null,
    created_by: createdBy, created_at: nowMs(),
  };
  await db().query(
    `INSERT INTO evidence_packages(id, tenant_id, project_id, name, event_ids, merkle_root,
      event_count, anchored, anchor_ref, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [pkg.id, pkg.tenant_id, pkg.project_id, pkg.name, pkg.event_ids, pkg.merkle_root,
     pkg.event_count, pkg.anchored, pkg.anchor_ref, pkg.created_by, pkg.created_at]);
  logger.info('evidence package built', { pkg: pkg.id, events: rows.length });
  return { ...pkg, event_ids: rows.map((r) => r.id) };
}

export async function getPackage(tenantId, packageId) {
  const rows = await db().query(
    'SELECT * FROM evidence_packages WHERE id=? AND tenant_id=?', [packageId, tenantId]);
  if (!rows[0]) throw Errors.notFound('证据包不存在');
  const p = rows[0];
  return { ...p, event_ids: JSON.parse(p.event_ids || '[]') };
}

/** 验包：按包内事件 id 重取事件，重算 Merkle 根比对 */
export async function verifyPackage(tenantId, packageId) {
  const pkg = await getPackage(tenantId, packageId);
  const rows = await mustOwnEvents(tenantId, pkg.event_ids);
  const root = merkleRoot(rows.map((r) => r.hash));
  return {
    ok: root === pkg.merkle_root,
    package_id: pkg.id, event_count: rows.length,
    expected: pkg.merkle_root, actual: root,
  };
}

/** 下载：包元数据 + 事件快照（含各自 hash，可离线验 Merkle） */
export async function downloadPackage(tenantId, packageId) {
  const pkg = await getPackage(tenantId, packageId);
  const events = await mustOwnEvents(tenantId, pkg.event_ids);
  return {
    package: {
      id: pkg.id, name: pkg.name, tenant_id: pkg.tenant_id, project_id: pkg.project_id,
      merkle_root: pkg.merkle_root, event_count: pkg.event_count,
      created_by: pkg.created_by, created_at: pkg.created_at,
    },
    events: events.map((r) => ({
      id: r.id, seq: r.seq, action: r.action, resource_kind: r.resource_kind,
      resource_id: r.resource_id, actor_id: r.actor_id, trace_id: r.trace_id,
      payload: JSON.parse(r.payload || '{}'),
      prev_hash: r.prev_hash, hash: r.hash, created_at: r.created_at,
    })),
  };
}
