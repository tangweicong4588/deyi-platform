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
