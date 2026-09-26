/**
 * modules/policy/opa.mjs —— OPA 适配器。
 * OPA_URL 设置时决策走 OPA（/v1/data/deyi/authz），不可用则 fail-closed 拒绝。
 */
import { config } from '../../kernel/config.mjs';
import { logger } from '../../kernel/logging.mjs';

export function isOpaEnabled() {
  return !!config.OPA_URL;
}

export async function decideViaOpa(input) {
  const url = `${config.OPA_URL.replace(/\/$/, '')}/v1/data/deyi/authz`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    logger.error('opa unreachable -> fail-closed deny', { err: String(e) });
    return { allow: false, obligations: ['audit'], reason: '策略引擎不可用（fail-closed）', policyVersion: 'opa/unreachable', engine: 'opa' };
  }
  if (!res.ok) {
    logger.error('opa error -> fail-closed deny', { status: res.status });
    return { allow: false, obligations: ['audit'], reason: `策略引擎错误 ${res.status}（fail-closed）`, policyVersion: 'opa/error', engine: 'opa' };
  }
  // M-5 安全 review：res.json() 原来在 try/catch 之外，畸形 body 会抛 raw Error
  //（无审计 receipt）；现在解析失败也 fail-closed。
  let data;
  try {
    data = await res.json();
  } catch (e) {
    logger.error('opa bad body -> fail-closed deny', { err: String(e) });
    return { allow: false, obligations: ['audit'], reason: '策略引擎响应解析失败（fail-closed）', policyVersion: 'opa/bad-body', engine: 'opa' };
  }
  const r = data.result || {};
  return {
    allow: !!r.allow,
    obligations: Array.isArray(r.obligations) ? r.obligations : ['audit'],
    reason: r.reason || 'opa decision',
    policyVersion: r.policy_version || 'opa',
    engine: 'opa',
  };
}
