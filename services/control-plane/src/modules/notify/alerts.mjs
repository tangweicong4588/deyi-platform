/**
 * modules/notify/alerts.mjs —— V2.13 平台事件告警 webhook。
 *
 * 四个事件：budget.exhausted / ratelimit.hit / invoice.finalized / tenant.suspended。
 * 租户经 notify_channels（webhook）订阅；投递复用 sendNotification（HMAC 签名 +
 * delivery ledger + 审计），与 V2.1-C 同一链路。
 *
 * - best-effort：emitAlert 永远不抛错；无通道记 skipped，投递失败记 failed，不阻塞主流程。
 * - 采样节流：ratelimit.hit（60s/租户）、budget.exhausted（300s/租户）防轰炸；
 *   invoice.finalized / tenant.suspended 为低频管理事件，不采样。
 * - 采样状态走共享限流器后端（memory/redis 可配）；多副本集中化已随 V2.15 Redis 落地。
 *
 * 调用约定：网关热路径（402/429）用 `void emitAlert(...)` 不等待响应；
 * 低频管理路径（账单定稿/租户停用）await 等待，测试可确定性断言。
 */
import { sendNotification } from './service.mjs';
import { logger } from '../../kernel/logging.mjs';
import { getRateLimiter } from '../gateway/ratelimit/index.mjs';

export const ALERT_INTENTS = ['budget.exhausted', 'ratelimit.hit', 'invoice.finalized', 'tenant.suspended'];

// 采样窗口（毫秒）：高频事件防轰炸
export const SAMPLE_WINDOWS = {
  'ratelimit.hit': 60_000,
  'budget.exhausted': 300_000,
};

const lastSent = new Map(); // 降级兜底：限流器不可用时的进程内存采样 `${tenantId}:${intent}` -> timestamp
/** 测试用：清空采样状态 */
export function clearAlertSamples() {
  lastSent.clear();
  try { getRateLimiter().__internal?.clear?.(); } catch { /* ignore */ }
}

/**
 * V2.15：采样节流走共享限流器后端（memory/redis 可配），多实例下集中防轰炸；
 * 限流器异常时回退进程内存 Map（best-effort，不抛错）。
 */
async function shouldSend(tenantId, intent) {
  const w = SAMPLE_WINDOWS[intent];
  if (!w) return true;
  const k = `alert:${tenantId}:${intent}`;
  try {
    return await getRateLimiter().throttle(k, w);
  } catch (e) {
    logger.warn('告警采样节流异常，回退进程内存', { error: String(e?.message || e).slice(0, 120) });
    const last = lastSent.get(k) || 0;
    if (Date.now() - last < w) return false;
    lastSent.set(k, Date.now());
    return true;
  }
}

/**
 * 发送告警。永远不抛错。返回 { sent, reason?, ...sendNotification 结果 }。
 * reason: 'sampled'（被采样节流）| 'error'（内部异常，已吞错记日志）。
 * 无通道/投递失败由 sendNotification 记 ledger（skipped/failed）+ 审计，此处不视为异常。
 */
export async function emitAlert({ tenantId, intent, title, body, extra = {} }) {
  try {
    if (!ALERT_INTENTS.includes(intent)) {
      logger.warn('未知告警 intent，已忽略', { tenantId, intent });
      return { sent: false, reason: 'unknown-intent' };
    }
    if (!(await shouldSend(tenantId, intent))) return { sent: false, reason: 'sampled' };
    const r = await sendNotification({ tenantId, intent, title, body, extra });
    return { sent: true, ...r };
  } catch (e) {
    logger.warn('告警发送异常（best-effort，已吞错）',
      { tenantId, intent, error: String(e?.message || e).slice(0, 200) });
    return { sent: false, reason: 'error' };
  }
}

// ---------- 四个事件的便捷封装 ----------

export const alertBudgetExhausted = ({ tenantId, reason, remainingCostCents = null, remainingTokens = null }) =>
  emitAlert({
    tenantId,
    intent: 'budget.exhausted',
    title: '预算已耗尽',
    body: `租户预算不足，请求被拒绝：${reason}`,
    extra: {
      reason,
      remaining_cost_cents: remainingCostCents,
      remaining_tokens: remainingTokens,
    },
  });

export const alertRateLimitHit = ({ tenantId, keyId = null, rpm = null, retryAfterMs = null }) =>
  emitAlert({
    tenantId,
    intent: 'ratelimit.hit',
    title: '触发速率限制',
    body: `请求频率超过限制（rpm=${rpm ?? '未知'}），已被限流。`,
    extra: { key_id: keyId, rpm, retry_after_ms: retryAfterMs },
  });

export const alertInvoiceFinalized = ({ tenantId, invoice }) =>
  emitAlert({
    tenantId,
    intent: 'invoice.finalized',
    title: `账单已定稿：${invoice.period_key}`,
    body: `账期 ${invoice.period_key} 账单已定稿，金额 ${(Number(invoice.total_cents) / 100).toFixed(2)} ${invoice.currency}。`,
    extra: {
      invoice_id: invoice.id,
      period_key: invoice.period_key,
      total_cents: invoice.total_cents,
      currency: invoice.currency,
    },
  });

export const alertTenantSuspended = ({ tenantId, tenantName = '' }) =>
  emitAlert({
    tenantId,
    intent: 'tenant.suspended',
    title: '租户已停用',
    body: `租户${tenantName ? `「${tenantName}」` : ''}已被平台停用，所有 API Key/JWT 即刻失效。`,
    extra: { tenant_name: tenantName },
  });
