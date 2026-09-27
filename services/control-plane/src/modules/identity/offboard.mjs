/**
 * modules/identity/offboard.mjs —— V2.12 租户 offboard（销户），provision 的反操作。
 *
 * 两阶段，均为平台 operator：
 *   phase=dryRun  → 只统计、不删除；生成合规导出包 manifest；返回 confirm_token。
 *   phase=confirm → 校验 confirm_token（绑定租户 + 数据快照 + 15 分钟有效期），执行清除。
 *
 * 清除顺序（FK 安全的拓扑序，子表先删）：
 *   1. 先断访问：suspend（若 active）→ 删 api_keys/auth_sessions/local_credentials/login_attempts
 *   2. 业务数据：项目/主体/文档/知识/记忆/流水线/业务单据/通知/计量明细…（见 TABLE_DELETE_ORDER）
 *   3. 向量派生索引：deyi_memory + deyi_knowledge 按 tenant_id 清除
 *   4. 审计事件：全删（含历史 retention.checkpoint）→ 追加 retention.checkpoint
 *      （policy='tenant-offboard'）→ 再追加 tenant.offboard 事件。
 *      verifyChain 走「整链删光」分支判 truncated；verifyAnchors 对旧锚定判 archived。
 *   5. 保留：billing_invoices（账单头保留）、anchors（外部锚定引用保留）、audit_heads（seq 单调）
 *   6. tenants 行保留：status='purged'，name/slug 脱敏，quotas 清空，purged_at 打点。
 *
 * 幂等/可重入：confirm 按 tenant_id 全量删除，可重复执行；confirm_token 绑定 dryRun 时的
 * 数据快照——中途崩溃后需重新 dryRun 再 confirm（防止对已变化的数据集误确认）。
 * 边界：备份中的数据按备份策略；已发出的 webhook 与外部锚定无法召回（anchor 行保留备查）。
 */
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { config } from '../../kernel/config.mjs';
import { db } from '../../db/index.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { logger } from '../../kernel/logging.mjs';
import { newTraceId } from '../../kernel/context.mjs';
import { getTenant } from './store.mjs';
import { append, tryAudit, canonicalJson } from '../evidence/audit.mjs';
import { withRetentionBypass } from '../evidence/retention.mjs';
import { exportAudit } from '../evidence/compliance.mjs';
import { deleteChunksByTenant } from '../knowledge/vector.mjs';
import { deleteMemoriesByTenant } from '../memory/vector.mjs';

const CONFIRM_TTL_MS = 15 * 60_000;

/**
 * 删除顺序：FK 拓扑序（引用者先删，被引用者后删）。
 * audit_events 单独走 wipeAudit（在 projects 之前，因 FK 引用 projects）。
 * tenants / billing_invoices / anchors / audit_heads 不删（见模块头注释）。
 */
const TABLE_DELETE_ORDER = [
  // --- 叶子：业务单据/执行/访问 ---
  'reconciliation_items', 'acceptance_criteria', 'acl_entries',
  'action_executions', 'artifacts', 'auth_sessions', 'api_keys', 'budgets', 'clarifications',
  'cost_ledger', 'credential_grants', 'evidence_packages', 'executions', 'fact_snapshots',
  'facts', 'gate_exceptions', 'gateway_usage_outbox', 'local_credentials', 'login_attempts',
  'memory_links', 'memory_promotions', 'model_calls', 'notify_deliveries', 'ontology_conflicts',
  'plan_approvals', 'role_bindings', 'runner_runs',
  // --- 中层 ---
  'business_actions', 'ontology_terms', 'pull_requests', 'pipeline_runs', 'canonical_docs',
  'pipeline_instances', 'pipeline_template_versions', 'pipeline_templates',
  'notify_channels', 'memories', 'repo_bindings', 'documents', 'tools',
  'business_plans', 'change_packages',
  'requirements', 'business_intents',
  // --- 根（projects/actors 最后；audit_events 在此之前单独 wipe） ---
  'projects', 'actors',
];
// tool_credentials 无 tenant_id（经 tools 关联），单独按租户工具删除。

const tokenSecret = () =>
  config.AUTH_JWT_SECRET || config.DEV_IDP_SECRET || config.OPERATOR_TOKEN || 'deyi-offboard-dev';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const planHash = (counts) =>
  createHash('sha256').update(canonicalJson(counts), 'utf8').digest('hex');

/** dryRun 签发 confirm_token：绑定 tenantId + 数据快照 + 过期时间。 */
export function mintConfirmToken(tenantId, counts) {
  const exp = Date.now() + CONFIRM_TTL_MS;
  const body = `${tenantId}.${planHash(counts)}.${exp}`;
  const sig = b64u(createHmac('sha256', tokenSecret()).update(body, 'utf8').digest());
  return `${exp}.${sig}`;
}

/** confirm 校验 token：签名/租户/过期/数据快照一致性。 */
export function verifyConfirmToken(tenantId, token, counts) {
  if (!token || typeof token !== 'string') throw Errors.badRequest('confirm_token 必填（先调 phase=dryRun）');
  const [expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || !sig) throw Errors.badRequest('confirm_token 格式非法');
  if (Date.now() > exp) throw Errors.forbidden('confirm_token 已过期，请重新 dryRun');
  const body = `${tenantId}.${planHash(counts)}.${exp}`;
  const want = b64u(createHmac('sha256', tokenSecret()).update(body, 'utf8').digest());
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(want, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw Errors.forbidden('confirm_token 无效（租户不匹配或数据已变化，请重新 dryRun）');
  }
}

/** 逐表统计该租户行数（dryRun 用，不删除）。 */
export async function countOffboard(tenantId, h = db()) {
  const counts = {};
  for (const t of TABLE_DELETE_ORDER) {
    if (t === 'pipeline_template_versions') continue; // 无 tenant_id，经模板关联统计（见下）
    const r = await h.query(`SELECT COUNT(*) AS n FROM ${t} WHERE tenant_id=?`, [tenantId]);
    counts[t] = Number(r[0]?.n || 0);
  }
  // pipeline_template_versions：无 tenant_id，经 pipeline_templates 关联
  {
    const r = await h.query(
      `SELECT COUNT(*) AS n FROM pipeline_template_versions
       WHERE template_id IN (SELECT id FROM pipeline_templates WHERE tenant_id=?)`, [tenantId]);
    counts.pipeline_template_versions = Number(r[0]?.n || 0);
  }
  const ae = await h.query('SELECT COUNT(*) AS n, MAX(seq) AS max_seq FROM audit_events WHERE tenant_id=?', [tenantId]);
  counts.audit_events = Number(ae[0]?.n || 0);
  const tc = await h.query(
    'SELECT COUNT(*) AS n FROM tool_credentials WHERE tool_id IN (SELECT id FROM tools WHERE tenant_id=?)',
    [tenantId]);
  counts.tool_credentials = Number(tc[0]?.n || 0);
  const inv = await h.query('SELECT COUNT(*) AS n FROM billing_invoices WHERE tenant_id=?', [tenantId]);
  counts.billing_invoices_kept = Number(inv[0]?.n || 0);
  const anc = await h.query('SELECT COUNT(*) AS n FROM anchors WHERE tenant_id=?', [tenantId]);
  counts.anchors_kept = Number(anc[0]?.n || 0);
  return counts;
}

/**
 * phase 1：dryRun。统计 + 合规导出包 manifest + confirm_token；不删除任何数据。
 * 导出包内容本身通过合规导出接口另行获取（响应只带 manifest，避免响应过大）。
 */
export async function dryRunOffboard(tenantId, { actorId = 'operator' } = {}) {
  const tenant = await getTenant(tenantId);
  if (!tenant) throw Errors.notFound('租户不存在');
  if (tenant.status === 'purged') throw Errors.conflict('租户已销户（purged），无需重复 offboard');
  const counts = await countOffboard(tenantId);
  // 合规包：复用 V2.4 审计导出（含导出时刻链验证结论 + 锚定状态 + 内容 sha256）
  const exp = await exportAudit(tenantId, { format: 'jsonl' });
  await tryAudit({
    tenantId, actorId, traceId: newTraceId(),
    action: 'tenant.offboard.dryrun', resourceKind: 'tenant', resourceId: tenantId,
    payload: { export_sha256: exp.manifest.content_sha256 },
  });
  // dryRun 自身的审计事件在统计之后写入：重计审计事件数并以此签发 token，
  // 否则 confirm 侧的快照永远比 dryRun 多一条 → token 恒失效。
  const aeRow = await db().query('SELECT COUNT(*) AS n FROM audit_events WHERE tenant_id=?', [tenantId]);
  counts.audit_events = Number(aeRow[0]?.n || 0);
  const total = TABLE_DELETE_ORDER.reduce((s, t) => s + (counts[t] || 0), 0)
    + counts.audit_events + (counts.tool_credentials || 0);
  return {
    phase: 'dryRun',
    tenant_id: tenantId,
    tenant_status: tenant.status,
    counts,
    total_rows_to_delete: total,
    kept: {
      billing_invoices: counts.billing_invoices_kept,
      anchors: counts.anchors_kept,
      note: '账单头与外部锚定引用保留；备份中的数据按备份策略；已发出的 webhook 无法召回',
    },
    export_manifest: {
      filename: exp.manifest.filename || exp.filename,
      format: 'jsonl',
      event_count: exp.manifest.event_count,
      truncated: exp.manifest.truncated,
      content_sha256: exp.manifest.content_sha256,
      chain_verification: exp.manifest.chain_verification,
      latest_anchor: exp.manifest.latest_anchor,
    },
    export_hint: '完整合规包内容请调用 GET /v1/admin/tenants/:id/compliance/export?format=jsonl 获取',
    confirm_token: mintConfirmToken(tenantId, counts),
    confirm_token_ttl_ms: CONFIRM_TTL_MS,
  };
}

/** 审计全量 wipe：删光该租户 audit_events（含历史检查点），返回被删的最大 seq/hash/条数。 */
async function wipeAuditEvents(tenantId) {
  const maxRow = await db().query(
    'SELECT seq, hash FROM audit_events WHERE tenant_id=? ORDER BY seq DESC LIMIT 1', [tenantId]);
  const through = maxRow[0] ? { seq: Number(maxRow[0].seq), hash: maxRow[0].hash } : null;
  const cntRow = await db().query('SELECT COUNT(*) AS n FROM audit_events WHERE tenant_id=?', [tenantId]);
  const count = Number(cntRow[0]?.n || 0);
  if (count > 0) {
    await withRetentionBypass(async (h) => {
      await h.query('DELETE FROM audit_events WHERE tenant_id=?', [tenantId]);
    });
  }
  return { through_seq: through?.seq || 0, through_hash: through?.hash || null, deleted_count: count };
}

/**
 * phase 2：confirm。执行销户，返回摘要。幂等：已 purged 的租户直接返回已销户摘要。
 */
export async function confirmOffboard(tenantId, confirmToken, { actorId = 'operator' } = {}) {
  const tenant = await getTenant(tenantId);
  if (!tenant) throw Errors.notFound('租户不存在');
  if (tenant.status === 'purged') {
    return { phase: 'confirm', tenant_id: tenantId, already_purged: true, purged_at: tenant.purged_at };
  }
  // token 绑定 dryRun 时的数据快照：期间数据变化则拒绝（防误确认）
  const counts = await countOffboard(tenantId);
  verifyConfirmToken(tenantId, confirmToken, counts);

  const deleted = {};
  const now = Date.now();

  // 1) 先断访问：active → suspend（suspend 本身写审计，该事件随后连同全链一起归档）
  if (tenant.status === 'active') {
    await db().run('UPDATE tenants SET status=?, updated_at=? WHERE id=?', ['suspended', now, tenantId]);
  }

  // 2) 业务数据按拓扑序删除（projects/actors 在最后；audit_events 单独 wipe）
  // pipeline_template_versions：无 tenant_id，经 pipeline_templates 关联删除。
  // 必须先于 pipeline_templates（子表先删，父表后删），因此在通用循环之前显式处理。
  {
    const r = await db().run(
      `DELETE FROM pipeline_template_versions
       WHERE template_id IN (SELECT id FROM pipeline_templates WHERE tenant_id=?)`,
      [tenantId]);
    if (r.changes) deleted.pipeline_template_versions = r.changes;
    const c = await db().query(
      `SELECT COUNT(*) AS n FROM pipeline_template_versions
       WHERE template_id IN (SELECT id FROM pipeline_templates WHERE tenant_id=?)`,
      [tenantId]);
    counts.pipeline_template_versions = Number(c[0]?.n || 0);
  }
  for (const t of TABLE_DELETE_ORDER) {
    if (t === 'projects' || t === 'actors') continue;
    if (t === 'pipeline_template_versions') continue; // 已在上方经模板关联删除
    const r = await db().run(`DELETE FROM ${t} WHERE tenant_id=?`, [tenantId]);
    if (r.changes) deleted[t] = r.changes;
  }
  // tool_credentials：无 tenant_id，经 tools 关联删除
  {
    const r = await db().run(
      'DELETE FROM tool_credentials WHERE tool_id IN (SELECT id FROM tools WHERE tenant_id=?)',
      [tenantId]);
    if (r.changes) deleted.tool_credentials = r.changes;
    const c = await db().query(
      'SELECT COUNT(*) AS n FROM tool_credentials WHERE tool_id IN (SELECT id FROM tools WHERE tenant_id=?)',
      [tenantId]);
    counts.tool_credentials = Number(c[0]?.n || 0);
  }

  // 3) 向量派生索引按租户清除（best-effort：Qdrant 不可达不阻塞销户，如实记录）
  let vectors = {};
  try {
    vectors.memory = await deleteMemoriesByTenant(tenantId);
  } catch (e) { vectors.memory = { error: String(e.message || e).slice(0, 120) }; }
  try {
    vectors.knowledge = await deleteChunksByTenant(tenantId);
  } catch (e) { vectors.knowledge = { error: String(e.message || e).slice(0, 120) }; }

  // 4) 审计全量 wipe → 检查点 → offboard 事件（链尾）
  const wipe = await wipeAuditEvents(tenantId);
  const checkpointId = await append({
    tenantId, actorId, traceId: newTraceId(),
    action: 'retention.checkpoint', resourceKind: 'tenant', resourceId: tenantId,
    payload: {
      deleted_through_seq: wipe.through_seq,
      deleted_through_hash: wipe.through_hash,
      deleted_count: wipe.deleted_count,
      policy: 'tenant-offboard',
    },
  });
  const offboardEventId = await append({
    tenantId, actorId, traceId: newTraceId(),
    action: 'tenant.offboard', resourceKind: 'tenant', resourceId: tenantId,
    payload: {
      deleted_tables: deleted,
      audit_wiped: wipe.deleted_count,
      checkpoint_id: checkpointId,
      vectors,
      invoices_kept: counts.billing_invoices_kept,
      anchors_kept: counts.anchors_kept,
    },
  });

  // 5) projects / actors（此时已无子表引用）
  for (const t of ['projects', 'actors']) {
    const r = await db().run(`DELETE FROM ${t} WHERE tenant_id=?`, [tenantId]);
    if (r.changes) deleted[t] = r.changes;
  }

  // 6) tenants 行保留：脱敏 + purged 终态
  await db().run(
    `UPDATE tenants SET name=?, slug=?, status='purged', quotas='{}', purged_at=?, updated_at=?
     WHERE id=?`,
    ['[purged]', `purged-${tenantId}`, now, now, tenantId],
  );

  const summary = {
    phase: 'confirm',
    tenant_id: tenantId,
    purged_at: now,
    deleted_tables: deleted,
    audit: {
      wiped_events: wipe.deleted_count,
      checkpoint_id: checkpointId,
      offboard_event_id: offboardEventId,
    },
    vectors,
    kept: { billing_invoices: counts.billing_invoices_kept, anchors: counts.anchors_kept },
  };
  logger.info('tenant offboard 完成', { tenant_id: tenantId, purged_tables: Object.keys(deleted).length });
  return summary;
}
