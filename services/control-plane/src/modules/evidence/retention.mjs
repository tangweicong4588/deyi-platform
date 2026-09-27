/**
 * modules/evidence/retention.mjs —— V2.7：数据保留策略（retention）。
 *
 * 企业客户的合规刚需：审计事件、计量明细、通知投递记录不能无限增长，
 * 需要按策略清理，同时不能破坏审计链的可验证性。
 *
 * 策略来源：平台默认值 + 租户 quotas JSON 覆盖（与 V2.1 套餐配额覆盖机制一致）：
 *   retention_days_audit_events      默认 730（审计事件）
 *   retention_days_model_calls       默认 180（网关计量明细；账单/预算汇总不受影响）
 *   retention_days_notify_deliveries 默认 90（只删终态 sent/failed/skipped，queued 保留）
 *   retention_days_usage_outbox      默认 30（只删已处理 processed_at 非空）
 *   retention_days_artifacts         默认 365（制品版本；pinned/被 release 关联的不删；包级 retention_days 可覆盖）
 *   retention_audit_include_anchored 默认 false（审计事件保留是否包含已被锚定覆盖的旧事件）
 *
 * 审计链安全删除（核心设计）：
 * - 只删「连续前缀」[1..C]，C = 从 seq=1 起 created_at 早于阈值的最大连续 seq。
 *   绝不在链中间挖洞；中间断裂一律视为篡改。
 * - 删除后在链尾追加 action='retention.checkpoint' 的审计事件，载荷记录
 *   deleted_through_seq / deleted_through_hash / deleted_count / 受影响的锚定。
 *   检查点的 prev_hash 指向删除后剩余链的链尾，链保持 hash 连续（seq 允许跳号）。
 *   verifyChain 识别该检查点后，对剩余链做「截断验证」并返回 truncated:true；
 *   没有检查点的前缀缺失则判 broken（防有人绕过策略删事件）。
 * - 默认不删除锚定覆盖的事件（保留锚定可重验）；显式开启
 *   retention_audit_include_anchored 后才删，且检查点记录 anchors_covered，
 *   verifyAnchors 对这类锚定返回 archived（非 broken，凭外部锚定引用追溯）。
 *
 * 诚实边界：
 * - 硬删除不可恢复；备份中的旧数据按备份保留策略另行处理，本模块不碰备份。
 * - 删除与检查点追加不是同一个 DB 事务（append 自带租户锁+事务）；
 *   先删后写检查点：中间崩溃会留下无背书的断链（verifyChain 如实判 broken），
 *   窗口极小；检查点用会抛错的 append 而非 best-effort，保证失败时 loud。
 */
import { db } from '../../db/index.mjs';
import { nowMs } from '../../kernel/ids.mjs';
import { newTraceId } from '../../kernel/context.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { append, tryAudit } from './audit.mjs';
import { getTenant } from '../identity/store.mjs';
import { sweepArtifactVersions } from '../artifacts/store.mjs';

export const RETENTION_DEFAULTS = {
  audit_events_days: 730,
  model_calls_days: 180,
  notify_deliveries_days: 90,
  usage_outbox_days: 30,
  artifacts_days: 365,
};

const DAY_MS = 86400_000;
const BATCH = 1000;

/**
 * V2.7：在受控绕行下执行保留删除。
 * append-only 触发器默认拦截一切 DELETE；只有本函数能显式开启绕行：
 * - PG：事务内 SET LOCAL deyi.retention_bypass='1'（事务结束自动失效）；
 * - SQLite：主库 retention_bypass 标记表（连接级谈不上，finally 清理；崩溃残留由
 *   initEvidence 启动时清理，残留期间仅放行 DELETE，不影响断链检测）。
 * 导出仅供测试模拟 DBA 级删除；业务代码永远不要调用本函数。
 */
export async function withRetentionBypass(fn) {
  if (db().kind === 'pg') {
    return db().transaction(async (tx) => {
      await tx.query(`SET LOCAL deyi.retention_bypass = '1'`);
      return fn(tx);
    });
  }
  await db().exec('CREATE TABLE IF NOT EXISTS retention_bypass(flag INTEGER)');
  await db().exec('DELETE FROM retention_bypass');
  await db().exec('INSERT INTO retention_bypass(flag) VALUES (1)');
  try {
    return await fn(db());
  } finally {
    await db().exec('DELETE FROM retention_bypass');
  }
}

/** 合并平台默认与租户 quotas 覆盖，返回各表保留天数。 */
export function getRetentionPolicy(tenant) {
  let over = {};
  try { over = JSON.parse(tenant?.quotas || '{}') || {}; } catch { over = {}; }
  const pickDays = (key, def) => {
    const v = Number(over[key]);
    return Number.isFinite(v) && v >= 0 ? v : def;
  };
  return {
    audit_events_days: pickDays('retention_days_audit_events', RETENTION_DEFAULTS.audit_events_days),
    model_calls_days: pickDays('retention_days_model_calls', RETENTION_DEFAULTS.model_calls_days),
    notify_deliveries_days: pickDays('retention_days_notify_deliveries', RETENTION_DEFAULTS.notify_deliveries_days),
    usage_outbox_days: pickDays('retention_days_usage_outbox', RETENTION_DEFAULTS.usage_outbox_days),
    artifacts_days: pickDays('retention_days_artifacts', RETENTION_DEFAULTS.artifacts_days),
    audit_include_anchored: over.retention_audit_include_anchored === true,
  };
}

/** 按条件分批删除（SQLite/PG 通用：DELETE 不支持 LIMIT，用 id IN 子查询）。 */
async function deleteBatched(table, cond, args) {
  let total = 0;
  for (;;) {
    const ids = await db().query(
      `SELECT id FROM ${table} WHERE ${cond} LIMIT ${BATCH}`, args);
    if (!ids.length) break;
    await db().query(
      `DELETE FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids.map((r) => r.id));
    total += ids.length;
    if (ids.length < BATCH) break;
  }
  return total;
}

async function countWhere(table, cond, args) {
  const r = await db().query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${cond}`, args);
  return Number(r[0]?.n || 0);
}

/**
 * 系统事件前缀：保留自身的检查点/清扫记录永不删除，也不打断连续性 walk。
 */
const SYSTEM_ACTION_PREFIX = 'retention.';

/**
 * 找审计事件的可删前缀。返回 { floor, through, count, coveredAnchors }：
 * - floor：不可删水位 = max(锚定保护水位, 历史检查点 deleted_through_seq)
 * - 只删 floor 之后、连续的老的「业务事件」；retention.* 系统事件跳过且永不删除。
 * - through=null 表示无可删。
 */
async function findDeletableAuditPrefix(tenantId, cutoff, includeAnchored) {
  let floor = 0;
  let coveredAnchors = [];
  if (!includeAnchored) {
    const anc = await db().query(
      `SELECT id, chain_head_seq FROM anchors WHERE tenant_id=? AND status='ok'`, [tenantId]);
    coveredAnchors = anc.map((a) => ({ id: a.id, seq: Number(a.chain_head_seq) }));
    floor = coveredAnchors.reduce((m, a) => Math.max(m, a.seq), 0);
  }
  // 历史检查点之后的水位：之前删过的区间不再重复处理
  const cps = await db().query(
    `SELECT payload FROM audit_events WHERE tenant_id=? AND action='retention.checkpoint'`, [tenantId]);
  for (const cp of cps) {
    try {
      const p = JSON.parse(cp.payload);
      if (Number.isFinite(Number(p.deleted_through_seq))) {
        floor = Math.max(floor, Number(p.deleted_through_seq));
      }
    } catch { /* 忽略坏载荷 */ }
  }
  const rows = await db().query(
    `SELECT seq, hash, created_at, action FROM audit_events
     WHERE tenant_id=? AND seq>? ORDER BY seq ASC`,
    [tenantId, floor]);
  let through = null;
  let count = 0;
  let expected = floor;
  for (const r of rows) {
    if (Number(r.seq) !== expected + 1) break; // 链内不应有洞；有洞就停
    expected = Number(r.seq);
    if (String(r.action).startsWith(SYSTEM_ACTION_PREFIX)) continue; // 系统事件：跳过，不删
    if (Number(r.created_at) > cutoff) break;
    through = r;
    count++;
  }
  return { floor, through, count, coveredAnchors };
}

/**
 * 审计事件清扫：只删连续前缀。返回检查点信息或 null（无可删）。
 * includeAnchored=false 时，被锚定覆盖的事件（seq <= max(chain_head_seq)）不删。
 */
async function sweepAuditEvents(tenantId, cutoff, includeAnchored) {
  const { floor, through, count, coveredAnchors } =
    await findDeletableAuditPrefix(tenantId, cutoff, includeAnchored);
  if (!through) return null;

  // 先删、后写检查点：检查点追加在链尾，其 prev_hash 指向删除后剩余链的链尾，
  // 链保持连续（seq 允许跳号，只校验 hash 链接）。删除与追加之间崩溃会留下
  // 无背书的断链（verifyChain 如实判 broken），窗口极小且语义诚实——此处用会抛错的
  // append 而不用 best-effort 的 tryAudit，检查点写失败则直接抛错。
  // 注意：retention.* 系统事件永不删除（检查点自身就是审计轨迹的一部分）。
  await withRetentionBypass(async (h) => {
    // 分批按 seq 前缀删，避免单条大 DELETE 锁表过久
    for (let s = floor + 1; s <= Number(through.seq); s += 5000) {
      await h.query(
        `DELETE FROM audit_events
         WHERE tenant_id=? AND seq>=? AND seq<=? AND action NOT LIKE '${SYSTEM_ACTION_PREFIX}%'`,
        [tenantId, s, Math.min(s + 4999, Number(through.seq))]);
    }
  });

  const checkpointId = await append({
    tenantId,
    actorId: 'system:retention',
    traceId: newTraceId(),
    action: 'retention.checkpoint',
    resourceKind: 'tenant',
    resourceId: tenantId,
    payload: {
      deleted_through_seq: Number(through.seq),
      deleted_through_hash: through.hash,
      deleted_count: count,
      policy: 'audit_events_days',
      audit_include_anchored: includeAnchored,
      anchors_covered: includeAnchored ? undefined : coveredAnchors,
    },
  });

  return {
    checkpoint_id: checkpointId,
    deleted_through_seq: Number(through.seq),
    deleted_through_hash: through.hash,
    deleted_count: count,
  };
}

/**
 * 对单个租户执行保留清扫。dryRun=true 只计数不删除。
 * 返回 { tenant_id, dry_run, policy, deleted, checkpoint }。
 */
export async function sweepTenant(tenantId, { dryRun = false } = {}) {
  const tenant = await getTenant(tenantId);
  if (!tenant) throw Errors.notFound('租户不存在');
  const policy = getRetentionPolicy(tenant);
  const now = nowMs();
  const deleted = { audit_events: 0, model_calls: 0, notify_deliveries: 0, usage_outbox: 0, artifacts: 0 };
  let checkpoint = null;

  const mcCut = now - policy.model_calls_days * DAY_MS;
  const ndCut = now - policy.notify_deliveries_days * DAY_MS;
  const uoCut = now - policy.usage_outbox_days * DAY_MS;
  const aCut = now - policy.audit_events_days * DAY_MS;

  if (dryRun) {
    deleted.model_calls = await countWhere('model_calls', 'tenant_id=? AND created_at<=?', [tenantId, mcCut]);
    deleted.notify_deliveries = await countWhere(
      'notify_deliveries', `tenant_id=? AND status IN ('sent','failed','skipped') AND updated_at<=?`, [tenantId, ndCut]);
    deleted.usage_outbox = await countWhere(
      'gateway_usage_outbox', 'tenant_id=? AND processed_at IS NOT NULL AND processed_at<=?', [tenantId, uoCut]);
    // 审计事件 dry-run：只做前缀计数，不写检查点
    const pre = await findDeletableAuditPrefix(tenantId, aCut, policy.audit_include_anchored);
    deleted.audit_events = pre.count;
    // V3.3：制品版本 dry-run（pinned/被 release 关联的不计入）
    deleted.artifacts = (await sweepArtifactVersions(tenantId, { days: policy.artifacts_days, dryRun: true })).deleted;
  } else {
    deleted.model_calls = await deleteBatched('model_calls', 'tenant_id=? AND created_at<=?', [tenantId, mcCut]);
    deleted.notify_deliveries = await deleteBatched(
      'notify_deliveries', `tenant_id=? AND status IN ('sent','failed','skipped') AND updated_at<=?`, [tenantId, ndCut]);
    deleted.usage_outbox = await deleteBatched(
      'gateway_usage_outbox', 'tenant_id=? AND processed_at IS NOT NULL AND processed_at<=?', [tenantId, uoCut]);
    checkpoint = await sweepAuditEvents(tenantId, aCut, policy.audit_include_anchored);
    deleted.audit_events = checkpoint?.deleted_count || 0;
    // V3.3：制品版本清扫（pinned/被 release 关联的保留）
    const artSweep = await sweepArtifactVersions(tenantId, { days: policy.artifacts_days });
    deleted.artifacts = artSweep.deleted;
    await tryAudit({
      tenantId,
      actorId: 'system:retention',
      traceId: newTraceId(),
      action: 'retention.sweep',
      resourceKind: 'tenant',
      resourceId: tenantId,
      payload: { deleted, policy_days: policy, checkpoint_id: checkpoint?.checkpoint_id || null },
    });
  }

  return { tenant_id: tenantId, dry_run: dryRun, policy, deleted, checkpoint };
}

/** 全租户清扫（operator 跑批）。tenantId 指定时只扫该租户。 */
export async function sweepAllTenants({ tenantId = null, dryRun = false } = {}) {
  const tenants = tenantId
    ? [{ id: tenantId }]
    : await db().query('SELECT id FROM tenants ORDER BY id ASC');
  const results = [];
  for (const t of tenants) {
    try {
      results.push({ ...(await sweepTenant(t.id, { dryRun })), ok: true });
    } catch (e) {
      results.push({ tenant_id: t.id, ok: false, error: String(e?.message || e).slice(0, 200) });
    }
  }
  const failed = results.filter((r) => !r.ok);
  return {
    dry_run: dryRun,
    tenants: results.length,
    succeeded: results.length - failed.length,
    failed: failed.length,
    results,
  };
}
