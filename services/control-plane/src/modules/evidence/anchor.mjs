/**
 * modules/evidence/anchor.mjs —— 审计链外部锚定（薄适配）。
 *
 * - AUDIT_ANCHOR_URL 未配置：明确返回 { anchored: false }，绝不伪造锚定。
 * - 已配置：把链尾 (seq, hash) POST 给锚定端点，期望返回 { ref }（时间戳
 *   token / 交易 id / 存证编号均可）；落库 anchors 表。
 * - RFC3161 说明：真正的 RFC3161 TSA 需要 ASN.1 打包 + 双向证书，本 MVP 只做
 *   通用 HTTP 锚定适配；生产如需 RFC3161，AUDIT_ANCHOR_URL 指向平台自研的
 *   TSA 代理即可，接口契约不变。
 */
import { newId, nowMs } from '../../kernel/ids.mjs';
import { config } from '../../kernel/config.mjs';
import { db } from '../../db/index.mjs';
import { logger } from '../../kernel/logging.mjs';
import { verifyChain } from './audit.mjs';

export function isAnchorConfigured() {
  return !!config.AUDIT_ANCHOR_URL;
}

/** 取某租户最新锚定记录；无则返回 { anchored: false } */
export async function getAnchorStatus(tenantId) {
  const rows = await db().query(
    'SELECT * FROM anchors WHERE tenant_id=? ORDER BY created_at DESC LIMIT 1', [tenantId]);
  if (!rows[0]) {
    return { anchored: false, reason: isAnchorConfigured() ? '尚未锚定' : '未配置 AUDIT_ANCHOR_URL（仅本地哈希链）' };
  }
  const a = rows[0];
  return {
    anchored: true, id: a.id, chain_head_id: a.chain_head_id,
    chain_head_hash: a.chain_head_hash, chain_head_seq: a.chain_head_seq,
    method: a.method, ref: a.ref, status: a.status, created_at: a.created_at,
  };
}

/**
 * 锚定链尾。流程：先验链（断裂拒绝锚定）→ 链尾已锚定则幂等返回 → POST 锚定端点 → 落库。
 */
export async function anchorChain(tenantId, { actorId = 'unknown' } = {}) {
  if (!isAnchorConfigured()) {
    return { anchored: false, reason: '未配置 AUDIT_ANCHOR_URL（仅本地哈希链）' };
  }
  const v = await verifyChain(tenantId);
  if (!v.ok) {
    throw new Error(`链断裂，拒绝锚定：seq=${v.brokenAt.seq} ${v.brokenAt.reason}`);
  }
  if (!v.head) return { anchored: false, reason: '链为空，无需锚定' };
  const last = await getAnchorStatus(tenantId);
  if (last.anchored && last.chain_head_seq === v.head.seq && last.chain_head_hash === v.head.hash) {
    return { ...last, deduped: true }; // 链尾未变，幂等
  }
  const url = config.AUDIT_ANCHOR_URL.replace(/\/$/, '');
  let ref = null;
  try {
    const res = await fetch(url + '/anchor', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenant_id: tenantId, seq: v.head.seq,
        digest: v.head.hash, algorithm: 'sha256', anchored_by: actorId,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`锚定端点返回 ${res.status}`);
    const j = await res.json().catch(() => ({}));
    ref = j.ref || j.token || j.txid || null;
  } catch (e) {
    logger.error('anchor failed', { err: String(e && e.message || e).slice(0, 200) });
    throw new Error(`外部锚定失败：${e.message}`);
  }
  const row = {
    id: newId('anc'), tenant_id: tenantId, chain_head_id: v.head.id,
    chain_head_hash: v.head.hash, chain_head_seq: v.head.seq,
    method: 'http-anchor', ref, status: 'ok', created_at: nowMs(),
  };
  await db().query(
    `INSERT INTO anchors(id, tenant_id, chain_head_id, chain_head_hash, chain_head_seq,
      method, ref, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    [row.id, row.tenant_id, row.chain_head_id, row.chain_head_hash, row.chain_head_seq,
     row.method, row.ref, row.status, row.created_at]);
  logger.info('evidence anchored', { tenant: tenantId, seq: v.head.seq, ref });
  return { anchored: true, ...row };
}

/**
 * V2.4：锚定验证。逐条核对锚定记录：
 *  1. 锚定时链尾事件 (chain_head_seq) 当前 hash/id 仍与锚定记录一致；
 *  2. 到该 seq 为止的链完整（verifyChain to=seq）。
 * 任一失败即标记 broken——说明锚定后链被改写。
 */
export async function verifyAnchors(tenantId) {
  const anchors = await db().query(
    'SELECT * FROM anchors WHERE tenant_id=? ORDER BY created_at ASC', [tenantId]);
  if (!anchors.length) {
    return { verified: false, reason: '该租户没有任何锚定记录', anchors: [] };
  }
  const results = [];
  for (const a of anchors) {
    const ev = await db().query(
      'SELECT id, hash FROM audit_events WHERE tenant_id=? AND seq=?',
      [tenantId, a.chain_head_seq]);
    if (!ev[0]) {
      results.push({ id: a.id, seq: a.chain_head_seq, ok: false, reason: '锚定的链尾事件已不存在（可能被删除）' });
      continue;
    }
    if (ev[0].hash !== a.chain_head_hash || ev[0].id !== a.chain_head_id) {
      results.push({
        id: a.id, seq: a.chain_head_seq, ok: false,
        reason: '锚定后链尾被改写：当前 hash 与锚定记录不一致',
        expected: a.chain_head_hash, actual: ev[0].hash,
      });
      continue;
    }
    const v = await verifyChain(tenantId, { to: Number(a.chain_head_seq) });
    if (!v.ok) {
      results.push({
        id: a.id, seq: a.chain_head_seq, ok: false,
        reason: `锚定点之前的链断裂：seq=${v.brokenAt?.seq} ${v.brokenAt?.reason || ''}`,
      });
      continue;
    }
    results.push({ id: a.id, seq: a.chain_head_seq, ok: true, ref: a.ref, method: a.method, created_at: a.created_at });
  }
  const broken = results.filter((r) => !r.ok);
  return {
    verified: broken.length === 0,
    anchors: results,
    ...(broken.length ? { reason: `${broken.length} 条锚定记录失效` } : {}),
  };
}

/**
 * V2.4：全租户锚定跑批（operator）。逐租户 anchorChain，单个失败不中断整批。
 * 未配置 AUDIT_ANCHOR_URL 时如实返回 anchored:false（见 anchorChain）。
 */
export async function anchorAllTenants({ actorId = 'unknown' } = {}) {
  const tenants = await db().query(
    `SELECT DISTINCT tenant_id AS id FROM audit_events ORDER BY tenant_id`);
  const results = [];
  for (const t of tenants) {
    try {
      const r = await anchorChain(t.id, { actorId });
      results.push({ tenant_id: t.id, anchored: !!r.anchored, ref: r.ref || null, reason: r.reason || null });
    } catch (e) {
      results.push({ tenant_id: t.id, anchored: false, error: String(e?.message || e).slice(0, 200) });
      logger.warn('anchor-all failed for tenant', { tenantId: t.id, err: String(e?.message || e).slice(0, 200) });
    }
  }
  logger.info('anchor-all done', { tenants: tenants.length });
  return { tenants: tenants.length, results };
}
