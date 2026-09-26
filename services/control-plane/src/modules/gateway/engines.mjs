/**
 * modules/gateway/engines.mjs —— 上游引擎适配：LiteLLM（主）/ 直连 Provider（fallback）。
 *
 * - LITELLM_URL 设置 → 走 LiteLLM（平台统一出口），用 LITELLM_MASTER_KEY，
 *   并在 user/metadata 里带上 tenant/project/actor/trace 做归属。
 * - 否则 ALLOW_DIRECT_PROVIDER=true 且 DIRECT_PROVIDER_BASE_URL 设置 → 直连，
 *   明确标记为 fallback（能力降级：无统一重试/降级/虚拟 key）。
 * - 重试只针对网络错误 / 429 / 5xx，且有总次数与退避上限。
 */
import { config } from '../../kernel/config.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { logger } from '../../kernel/logging.mjs';

export function engineKind() {
  if (config.LITELLM_URL) return 'litellm';
  if (config.allowDirectProvider && config.DIRECT_PROVIDER_BASE_URL) return 'direct';
  return 'none';
}

function targetFor(path) {
  if (config.LITELLM_URL) {
    return {
      tag: 'litellm',
      url: config.LITELLM_URL.replace(/\/$/, '') + path,
      auth: config.LITELLM_MASTER_KEY,
    };
  }
  return {
    tag: 'direct(fallback)',
    url: config.DIRECT_PROVIDER_BASE_URL.replace(/\/$/, '') + path,
    auth: config.DIRECT_PROVIDER_API_KEY,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const isRetryableStatus = (s) => s === 429 || (s >= 500 && s < 600);
const isRetryableError = (e) =>
  e?.cause?.code === 'ECONNREFUSED' || e?.cause?.code === 'ETIMEDOUT' ||
  e?.name === 'TimeoutError' || String(e).includes('fetch failed');

/**
 * 向上游发请求。返回 { res, engineTag }；非 2xx 不抛错（由调用方按状态处理，
 * 只有可重试的失败才在这里重试）。
 */
export async function upstreamFetch(path, body, { traceId } = {}) {
  const kind = engineKind();
  if (kind === 'none') {
    throw Errors.upstream('模型网关未配置：请设置 LITELLM_URL（或显式允许直连）');
  }
  const target = targetFor(path);
  const timeoutMs = Number(config.GATEWAY_TIMEOUT_MS) || 120000;
  const maxRetries = Number(config.GATEWAY_MAX_RETRIES) || 0;

  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(target.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(target.auth ? { authorization: `Bearer ${target.auth}` } : {}),
          ...(traceId ? { 'x-deyi-trace-id': traceId } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!isRetryableStatus(res.status) || attempt === maxRetries) return { res, engineTag: target.tag };
      try { await res.arrayBuffer(); } catch { /* 丢弃可重试响应体 */ }
      lastErr = Errors.upstream(`上游返回 ${res.status}（${target.tag}）`);
    } catch (e) {
      lastErr = e;
      if (!isRetryableError(e) || attempt === maxRetries) {
        throw Errors.upstream(`上游调用失败（${target.tag}）: ${e?.cause?.code || e.message}`, { engine: target.tag });
      }
    }
    logger.warn('gateway retry', { path, attempt: attempt + 1, tag: target.tag });
    await sleep(500 * 2 ** attempt);
  }
  throw lastErr;
}
