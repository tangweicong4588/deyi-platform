/**
 * modules/evidence/audit.mjs —— 审计哈希链（自研控制面资产）。
 *
 * - 只追加：本模块只暴露 append/verify，没有 update/delete；DB 层再用触发器
 *   兜底（initEvidence 按后端方言创建，启动时调用）。
 * - 链式哈希：hash = SHA256(prev_hash\ntenant_id\naction\nresource_kind\n
 *   resource_id\ncanonical(payload)\ncreated_at)，字段顺序与分隔符固定，
 *   消除原像拼接歧义；创世块 prev_hash='GENESIS'。
 * - 并发串行化：租户级进程内互斥 + 事务；PG 多实例再加
 *   pg_advisory_xact_lock（事务级建议锁），防并发 append 断链/seq 冲突。
 * - 幂等：同一 (trace_id, action, resource_id) 重复 append 返回已存在事件 id，
 *   不重复写（service 层钩子可安全重试）。
 */
import { createHash } from 'node:crypto';
import { newId, nowMs } from '../../kernel/ids.mjs';
import { ctx, newTraceId } from '../../kernel/context.mjs';
import { db } from '../../db/index.mjs';
import { logger } from '../../kernel/logging.mjs';

export const GENESIS = 'GENESIS';

/** 稳定 JSON：递归按键排序，保证同一 payload 永远得到同一原像 */
export function canonicalJson(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(v).sort()
    .map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}

export function chainHash({ prevHash, tenantId, action, resourceKind, resourceId, payload, createdAt }) {
  const preimage = [
    prevHash,
    tenantId,
    action,
    resourceKind,
    resourceId || '',
    canonicalJson(payload || {}),
    String(createdAt),
  ].join('\n');
  return createHash('sha256').update(preimage, 'utf8').digest('hex');
}

// ---- 租户级串行锁（进程内；PG 多实例另有建议锁兜底） ----
const locks = new Map();
function withTenantLock(tenantId, fn) {
  const prev = locks.get(tenantId) || Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.catch(() => {}); // 链不断，调用方仍拿到原始结果
  locks.set(tenantId, settled);
  // 无排队时清理 key，防长期运行泄漏（有后来者排队时 get 已被覆盖，不误删）
  settled.finally(() => { if (locks.get(tenantId) === settled) locks.delete(tenantId); });
  return next;
}

/**
 * 追加审计事件。返回事件 id。
 * 必填：tenantId, actorId, traceId, action, resourceKind。
 */
export async function append({ tenantId, projectId = null, actorId, traceId, action,
  resourceKind, resourceId = null, payload = {} }) {
  if (!tenantId || !actorId || !traceId || !action || !resourceKind) {
    throw new Error('audit.append 缺少必填字段');
  }
  return withTenantLock(tenantId, () => db().transaction(async (tx) => {
    if (db().kind === 'pg') {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext(?))', [tenantId]);
    }
    // 幂等去重
    const dup = await tx.query(
      `SELECT id FROM audit_events WHERE tenant_id=? AND trace_id=? AND action=?
       AND COALESCE(resource_id,'')=COALESCE(?,'') LIMIT 1`,
      [tenantId, traceId, action, resourceId]);
    if (dup[0]) return dup[0].id;

    const last = await tx.query(
      `SELECT seq, hash FROM audit_events WHERE tenant_id=? ORDER BY seq DESC LIMIT 1`,
      [tenantId]);
    const prevHash = last[0] ? last[0].hash : GENESIS;
    // V2.7：seq 永不重启。保留清扫可能删光全部事件，此时 MAX(seq) 归零；
    // 用 audit_heads.head_seq 做单调计数器，避免新事件复用旧 seq（否则旧锚定
    // 的 chain_head_seq 会与新事件碰撞）。无 head 行时回退到老逻辑。
    let seq;
    const headRow = await tx.query('SELECT head_seq FROM audit_heads WHERE tenant_id=?', [tenantId]);
    if (headRow[0] != null) {
      seq = Number(headRow[0].head_seq) + 1;
    } else {
      seq = last[0] ? Number(last[0].seq) + 1 : 1;
    }
    const createdAt = nowMs();
    const hash = chainHash({
      prevHash, tenantId, action, resourceKind, resourceId, payload, createdAt,
    });
    const id = newId('evd');
    await tx.query(
      `INSERT INTO audit_events(id, tenant_id, project_id, actor_id, trace_id, action,
        resource_kind, resource_id, payload, prev_hash, hash, seq, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, tenantId, projectId, actorId, traceId, action, resourceKind, resourceId,
       canonicalJson(payload), prevHash, hash, seq, createdAt]);
    // L-11：同事务更新链头检查点（尾部截断检测的基准）。幂等去重命中时直接返回，
    // 检查点不动——去重本就没有产生新事件。
    // EXCLUDED/excluded 大小写在 PG/SQLite 均可（标识符不区分大小写），单语句双库通用。
    await tx.query(
      `INSERT INTO audit_heads(tenant_id, head_seq, head_hash, updated_at)
       VALUES (?,?,?,?)
       ON CONFLICT(tenant_id) DO UPDATE SET head_seq=EXCLUDED.head_seq,
         head_hash=EXCLUDED.head_hash, updated_at=EXCLUDED.updated_at`,
      [tenantId, seq, hash, createdAt]);
    return id;
  }));
}

/**
 * 验链：按 seq 重算全链。返回 { ok, checked, head, brokenAt? }。
 * brokenAt 定位到第一个断裂的事件 { seq, id, reason, expected, actual }。
 */
export async function verifyChain(tenantId, { from = 1, to = null } = {}) {
  const rows = await db().query(
    `SELECT * FROM audit_events WHERE tenant_id=? AND seq>=? ${to ? 'AND seq<=?' : ''}
     ORDER BY seq ASC`,
    to ? [tenantId, from, to] : [tenantId, from]);
  // 范围起点不是创世块时，取前一个事件的 hash 作为期望 prev
  let expectedPrev = GENESIS;
  if (from > 1) {
    const prev = await db().query(
      'SELECT hash FROM audit_events WHERE tenant_id=? AND seq=?', [tenantId, from - 1]);
    if (!prev[0]) {
      return { ok: false, checked: 0, head: null, brokenAt: { seq: from, id: null, reason: '缺少前序事件，无法确定链起点' } };
    }
    expectedPrev = prev[0].hash;
  }
  // V2.7：保留截断识别。from=1 且链首 seq>1 时，可能是保留策略删掉了前缀：
  // 查找 deleted_through_seq = 首 seq-1、且 hash 与首事件 prev_hash 一致的检查点。
  // 找到→对剩余链做截断验证（返回 truncated）；找不到→判 broken（绕过策略的删除=篡改）。
  let truncated = null;
  let startIdx = 0;
  if (from === 1 && rows.length && Number(rows[0].seq) > 1) {
    const cps = await db().query(
      `SELECT id, seq, payload FROM audit_events
       WHERE tenant_id=? AND action='retention.checkpoint' ORDER BY seq DESC`,
      [tenantId]);
    for (const cp of cps) {
      let p;
      try { p = JSON.parse(cp.payload); } catch { continue; }
      if (Number(p.deleted_through_seq) === Number(rows[0].seq) - 1
          && p.deleted_through_hash === rows[0].prev_hash) {
        truncated = {
          checkpoint_id: cp.id,
          checkpoint_seq: Number(cp.seq),
          deleted_through_seq: Number(p.deleted_through_seq),
          deleted_count: Number(p.deleted_count) || 0,
        };
        break;
      }
      // V2.7：整链被删光时，链首就是检查点自身（seq 永不重启，见 append）。
      // 此时 prev_hash 为 GENESIS（或删除后剩余链尾），hash 对不上已删事件是正常的，
      // 只需确认链首确为合法的检查点事件。
      if (cp.id === rows[0].id) {
        truncated = {
          checkpoint_id: cp.id,
          checkpoint_seq: Number(cp.seq),
          deleted_through_seq: Number(p.deleted_through_seq) || 0,
          deleted_count: Number(p.deleted_count) || 0,
        };
        break;
      }
    }
    if (!truncated) {
      return {
        ok: false, checked: 0, head: null,
        brokenAt: {
          seq: Number(rows[0].seq), id: rows[0].id,
          reason: '链头部缺失且无保留检查点（可能被绕过策略删除或篡改）',
          expected: GENESIS, actual: rows[0].prev_hash,
        },
      };
    }
    // 首事件：prev 已被策略删除（有检查点背书），只验内容 hash；后续事件正常验链。
    const r0 = rows[0];
    let p0;
    try { p0 = JSON.parse(r0.payload); } catch { p0 = {}; }
    const recomputed0 = chainHash({
      prevHash: r0.prev_hash, tenantId: r0.tenant_id, action: r0.action,
      resourceKind: r0.resource_kind, resourceId: r0.resource_id, payload: p0, createdAt: r0.created_at,
    });
    if (recomputed0 !== r0.hash) {
      return {
        ok: false, checked: 0, head: null,
        brokenAt: {
          seq: r0.seq, id: r0.id, reason: '截断后首事件内容被篡改（重算 hash 不一致）',
          expected: recomputed0, actual: r0.hash,
        },
      };
    }
    expectedPrev = r0.hash;
    startIdx = 1;
  }
  for (let i = startIdx; i < rows.length; i++) {
    const r = rows[i];
    if (r.prev_hash !== expectedPrev) {
      return {
        ok: false, checked: i, head: null,
        brokenAt: { seq: r.seq, id: r.id, reason: 'prev_hash 与前一事件 hash 不连续', expected: expectedPrev, actual: r.prev_hash },
      };
    }
    let payload;
    try { payload = JSON.parse(r.payload); } catch { payload = {}; }
    const recomputed = chainHash({
      prevHash: r.prev_hash, tenantId: r.tenant_id, action: r.action,
      resourceKind: r.resource_kind, resourceId: r.resource_id, payload, createdAt: r.created_at,
    });
    if (recomputed !== r.hash) {
      return {
        ok: false, checked: i, head: null,
        brokenAt: { seq: r.seq, id: r.id, reason: '事件内容被篡改（重算 hash 不一致）', expected: recomputed, actual: r.hash },
      };
    }
    expectedPrev = r.hash;
  }
  const head = rows.length ? { id: rows[rows.length - 1].id, seq: rows[rows.length - 1].seq, hash: expectedPrev } : null;
  // L-11：尾部截断检测。哈希链自洽但尾部整段被删时，链内无从发现——用检查点比对。
  // 只在全链验（from=1 且 to=null）时做；区间验跳过（区间本就不含链头）。
  // 双向比对：检查点超前=尾部事件丢失；检查点滞后=有人绕过 append 直写事件。
  if (from === 1 && to == null) {
    const cp = await db().query(
      'SELECT head_seq, head_hash FROM audit_heads WHERE tenant_id=?', [tenantId]);
    if (cp[0]) {
      const maxSeq = head ? Number(head.seq) : 0;
      const cpSeq = Number(cp[0].head_seq);
      if (cpSeq !== maxSeq || (head && cp[0].head_hash !== head.hash)) {
        const reason = cpSeq > maxSeq
          ? `尾部截断：检查点 head_seq=${cpSeq}，但链上最大 seq=${maxSeq}（事件丢失或被删）`
          : `检查点滞后：检查点 head_seq=${cpSeq}，但链上最大 seq=${maxSeq}（可能有人绕过 append 直写）`;
        return {
          ok: false, checked: rows.length, head: null,
          brokenAt: {
            seq: null, id: null, reason,
            expected: { seq: cpSeq, hash: cp[0].head_hash },
            actual: head,
          },
        };
      }
    }
  }
  return { ok: true, checked: rows.length, head, truncated };
}

/** 按方言创建 append-only 触发器（幂等；迁移后调用）
 *
 * V2.7：触发器识别保留清扫的受控绕行——
 * - PG：事务内 `SET LOCAL deyi.retention_bypass='1'` 时允许 DELETE（retention.mjs 专用）；
 * - SQLite：主库 retention_bypass 标记表存在行时允许 DELETE（触发器不能引用 temp 表）。
 *   启动时清空残留标记（崩溃残留只会放行删除，不影响断链检测）。
 * 绕行只放行 DELETE，且必须由保留清扫显式开启；UPDATE 永远拦截。
 */
export async function initEvidence() {
  if (db().kind === 'pg') {
    await db().exec(`
      CREATE OR REPLACE FUNCTION fn_audit_append_only() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE'
           AND current_setting('deyi.retention_bypass', true) = '1' THEN
          RETURN OLD; -- V2.7 保留清扫显式放行
        END IF;
        RAISE EXCEPTION 'audit_events is append-only';
      END; $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_audit_no_update ON audit_events;
      DROP TRIGGER IF EXISTS trg_audit_no_delete ON audit_events;
      CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_events
        FOR EACH ROW EXECUTE FUNCTION fn_audit_append_only();
      CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_events
        FOR EACH ROW EXECUTE FUNCTION fn_audit_append_only();`);
  } else {
    // SQLite：触发器不能引用 temp 表，用主库标记表做绕行开关；
    // DROP+CREATE 保证已部署的旧触发器也能升级为保留感知版本。
    await db().exec('CREATE TABLE IF NOT EXISTS retention_bypass(flag INTEGER)');
    await db().exec('DELETE FROM retention_bypass'); // 清理崩溃残留的标记
    await db().exec('DROP TRIGGER IF EXISTS trg_audit_no_update');
    await db().exec('DROP TRIGGER IF EXISTS trg_audit_no_delete');
    await db().exec(`
      CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;`);
    await db().exec(`
      CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_events
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM retention_bypass)
          THEN RAISE(ABORT, 'audit_events is append-only')
        END;
      END;`);
  }
  logger.info('evidence: append-only 触发器已就绪', { backend: db().kind });
}

/**
 * service 层钩子用：best-effort 审计，失败只打日志不阻断业务。
 * 字段缺省从请求上下文补（traceId/actorId/projectId）。
 */
export async function tryAudit({ tenantId, projectId, actorId, traceId, action, resourceKind, resourceId, payload }) {
  try {
    const c = ctx();
    return await append({
      tenantId,
      projectId: projectId ?? c.projectId ?? null,
      actorId: actorId ?? c.actorId ?? 'unknown',
      traceId: traceId ?? c.traceId ?? newTraceId(),
      action, resourceKind, resourceId: resourceId ?? null, payload: payload || {},
    });
  } catch (e) {
    logger.error('audit append failed (best-effort)', { action, err: String(e && e.message || e).slice(0, 200) });
    return null;
  }
}
