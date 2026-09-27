/**
 * modules/evidence/compliance.mjs —— V2.4：合规导出。
 *
 * 面向审计员的可携带导出：按时间范围导出租户审计事件（JSONL/CSV），
 * 附 manifest（sha256 内容摘要、导出时刻链验证结果、最新锚定状态）。
 * manifest 让离线审计员能独立验证：内容完整性（sha256）+ 链完整性（验证结果）。
 *
 * 诚实边界：
 * - manifest 中的链验证结论只对"导出时刻的库内数据"负责；离线重放验证需要
 *   packages.mjs 的 verifyPackage（merkle）或审计员自行重算 chainHash。
 * - 导出上限 10000 条，超限请分多次按时间窗导出（manifest 会标注 truncated）。
 */
import { createHash } from 'node:crypto';
import { db } from '../../db/index.mjs';
import { nowMs } from '../../kernel/ids.mjs';
import { ctx } from '../../kernel/context.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { verifyChain } from './audit.mjs';
import { getAnchorStatus } from './anchor.mjs';

const EXPORT_LIMIT = 10000;
const FORMATS = ['jsonl', 'csv'];

const CSV_COLS = ['seq', 'created_at', 'created_at_iso', 'actor_id', 'action',
  'resource_kind', 'resource_id', 'project_id', 'trace_id', 'hash', 'prev_hash'];

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toJsonl(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}

function toCsv(rows) {
  const lines = [CSV_COLS.join(',')];
  for (const r of rows) {
    lines.push(CSV_COLS.map((c) => csvCell(r[c])).join(','));
  }
  return lines.join('\n') + (rows.length ? '\n' : '');
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * 导出审计事件。返回 { filename, contentType, content, manifest }。
 * from/to：毫秒时间戳（闭区间），缺省为全量（受 EXPORT_LIMIT 上限）。
 */
export async function exportAudit(tenantId, { from = null, to = null, format = 'jsonl' } = {}) {
  if (!FORMATS.includes(format)) {
    throw Errors.badRequest(`format 非法：${format}（支持 ${FORMATS.join('/')}）`, { code: 'INVALID_FORMAT' });
  }
  const c = ctx();
  const conds = ['tenant_id=?'];
  const params = [tenantId];
  if (from != null) { conds.push('created_at>=?'); params.push(Number(from)); }
  if (to != null) { conds.push('created_at<=?'); params.push(Number(to)); }
  const rows = await db().query(
    `SELECT seq, created_at, actor_id, trace_id, action, resource_kind, resource_id,
            project_id, payload, prev_hash, hash
     FROM audit_events WHERE ${conds.join(' AND ')}
     ORDER BY seq ASC LIMIT ${EXPORT_LIMIT + 1}`,
    params);
  const truncated = rows.length > EXPORT_LIMIT;
  const page = truncated ? rows.slice(0, EXPORT_LIMIT) : rows;
  const enriched = page.map((r) => ({
    ...r, created_at_iso: new Date(r.created_at).toISOString(),
  }));

  const content = format === 'csv' ? toCsv(enriched) : toJsonl(enriched);
  // 导出时刻链验证（全链；区间导出也给出全链结论，manifest 明确标注）
  const chain = await verifyChain(tenantId);
  const anchor = await getAnchorStatus(tenantId);
  const manifest = {
    kind: 'deyi-audit-export', version: 1,
    tenant_id: tenantId, format,
    range: { from: from != null ? Number(from) : null, to: to != null ? Number(to) : null },
    event_count: enriched.length, truncated, export_limit: EXPORT_LIMIT,
    content_sha256: sha256(content),
    chain_verification: chain.ok
      ? { ok: true, checked: chain.checked, head: chain.head }
      : { ok: false, checked: chain.checked, brokenAt: chain.brokenAt },
    latest_anchor: anchor,
    exported_at: nowMs(), exported_by: c.actorId || 'unknown',
  };
  const stamp = new Date(manifest.exported_at).toISOString().slice(0, 10);
  return {
    filename: `audit-export-${tenantId}-${stamp}.${format}`,
    contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
    content, manifest,
  };
}
