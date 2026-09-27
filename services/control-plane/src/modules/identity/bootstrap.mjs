/**
 * modules/identity/bootstrap.mjs —— 首次启动引导。
 *
 * BOOTSTRAP_ENABLED=true 且 tenants 表为空时：建默认租户 + admin 主体 +
 * 租户级 admin 绑定 + API Key。Key 只打印一次。
 * 生产禁止（config 已 fail-fast）。
 */
import { config } from '../../kernel/config.mjs';
import { logger } from '../../kernel/logging.mjs';
import { db } from '../../db/index.mjs';
import { createTenant, createActor, bindRole, createApiKeyRow, slugify } from './store.mjs';
import { mintKey, KEY_SCOPES } from './keys.mjs';

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
    prefix, keyHash, scopes: [...KEY_SCOPES], // V2.5 起 '*' 非法：显式授予全部词表 scope
  });

  // L-4 安全 review：OPERATOR_TOKEN 不打明文；未设置时不编造"可用"token
  //（config.OPERATOR_TOKEN 为空时运维中间件恒拒绝，打印随机 token 会误导运维）
  if (config.OPERATOR_TOKEN) {
    logger.warn('bootstrap 完成（仅开发）：请妥善保存，以下信息只显示一次',
      { tenant: tenant.slug, adminKey: secret, operatorToken: '<redacted>' });
  } else {
    logger.warn('bootstrap 完成（仅开发）：OPERATOR_TOKEN 未设置，平台运维接口不可用（fail-closed），请设置后重启',
      { tenant: tenant.slug, adminKey: secret });
  }
  console.log('\n================ BOOTSTRAP（仅开发，信息只显示一次） ================');
  console.log(`租户: ${tenant.name} (${tenant.id})`);
  console.log(`Admin API Key: ${secret}`);
  if (config.OPERATOR_TOKEN) {
    console.log('Operator Token: <已通过 OPERATOR_TOKEN 配置，请自行保管>');
  } else {
    console.log('Operator Token: <未设置>  # 如需租户管理请设 OPERATOR_TOKEN=<你的token> 后重启');
  }
  console.log('==================================================================\n');
  return { tenant, actor, adminKey: secret, operatorToken: config.OPERATOR_TOKEN || null };
}
