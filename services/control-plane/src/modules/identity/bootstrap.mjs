/**
 * modules/identity/bootstrap.mjs —— 首次启动引导。
 *
 * BOOTSTRAP_ENABLED=true 且 tenants 表为空时：建默认租户 + admin 主体 +
 * 租户级 admin 绑定 + API Key。Key 只打印一次。
 * 生产禁止（config 已 fail-fast）。
 */
import { randomBytes } from 'node:crypto';
import { config } from '../../kernel/config.mjs';
import { logger } from '../../kernel/logging.mjs';
import { db } from '../../db/index.mjs';
import { createTenant, createActor, bindRole, createApiKeyRow, slugify } from './store.mjs';
import { mintKey } from './keys.mjs';

export async function maybeBootstrap() {
  if (!config.bootstrapEnabled) return null;
  const n = await db().query('SELECT COUNT(*) AS c FROM tenants');
  if (Number(n[0].c) > 0) return null;

  const tenant = await createTenant({ name: config.BOOTSTRAP_TENANT_NAME, slug: slugify(config.BOOTSTRAP_TENANT_NAME) });
  const actor = await createActor(tenant.id, { kind: 'user', name: config.BOOTSTRAP_ADMIN_NAME });
  await bindRole(tenant.id, actor.id, null, 'admin');
  const { secret, prefix, keyHash } = mintKey();
  await createApiKeyRow({
    tenantId: tenant.id, actorId: actor.id, name: 'bootstrap-admin',
    prefix, keyHash, scopes: ['*'],
  });

  const operatorToken = config.OPERATOR_TOKEN || 'op_' + randomBytes(24).toString('base64url');
  logger.warn('bootstrap 完成（仅开发）：请妥善保存，以下信息只显示一次',
    { tenant: tenant.slug, adminKey: secret, operatorToken });
  console.log('\n================ BOOTSTRAP（仅开发，信息只显示一次） ================');
  console.log(`租户: ${tenant.name} (${tenant.id})`);
  console.log(`Admin API Key: ${secret}`);
  console.log(`Operator Token: ${operatorToken}   # 如需租户管理请设 OPERATOR_TOKEN=${operatorToken}`);
  console.log('==================================================================\n');
  return { tenant, actor, adminKey: secret, operatorToken };
}
