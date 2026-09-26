/**
 * adapters/credentials.mjs —— 仓库凭据解析（密钥铁律执行点）。
 *
 * - repo_binding 只存 credential_ref（vault 引用名），绝不存明文（bindRepo 已拒绝明文字段）。
 * - 运行时解析：默认从环境变量 `VAULT_<REF>` 读取（REF 大写、非字母数字转下划线），
 *   供开发/测试使用；生产应替换为真正的 vault provider（在此处集中替换）。
 * - fail-closed：credential_ref 非空但解析不到 → 直接抛错，绝不降级为匿名访问
 *   私有仓库（匿名访问可能泄露"仓库是否存在"等信息，且违背最小权限）。
 * - 返回的 token 只进 Authorization header，绝不进日志/错误/快照 JSON。
 */
import { Errors } from '../kernel/errors.mjs';

/** vault 引用名 → 环境变量名：gitea-token-main → VAULT_GITEA_TOKEN_MAIN */
export function vaultEnvName(credentialRef) {
  return 'VAULT_' + String(credentialRef).toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function resolveToken({ credentialRef, bindingId = '' }) {
  if (!credentialRef) return null; // 公开仓库：无需凭据
  const envName = vaultEnvName(credentialRef);
  const token = process.env[envName];
  if (!token) {
    throw Errors.badRequest(
      `仓库凭据未解析：vault 引用 ${credentialRef} 无对应环境变量 ${envName}，已拒绝继续（fail-closed）`,
      { code: 'VAULT_UNRESOLVED', binding_id: bindingId || undefined },
    );
  }
  return token;
}
