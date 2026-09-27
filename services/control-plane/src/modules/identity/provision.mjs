/**
 * modules/identity/provision.mjs —— V2.1-B：租户原子开通。
 *
 * provisionTenant 一次调用完成：租户 + 默认项目 + 管理员主体 + admin 角色绑定 + API Key。
 * 全程在同一事务内：任一步失败整体回滚，不留下"租户建了但没管理员"的半成品。
 * （store.mjs 不能 import keys.mjs——keys.mjs 已依赖 store.mjs，开通逻辑放这里避免循环。）
 */
import { db } from '../../db/index.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { mintKey } from './keys.mjs';
import {
  createTenant, createProject, createActor, createApiKeyRow, bindRole,
} from './store.mjs';

export async function provisionTenant({
  name, slug, plan = 'trial', quotas = {},
  adminName = 'admin', adminEmail = null, projectName = 'default',
} = {}) {
  if (!name) throw Errors.badRequest('name 必填');
  return db().transaction(async (tx) => {
    const tenant = await createTenant({ name, slug, plan, quotas }, tx);
    // V2.6：套餐配额落地为当月预算行（幂等；手工预算行优先，不覆盖）
    const gw = await import('../gateway/store.mjs');
    await gw.ensurePlanBudget(tenant.id, tx);
    const project = await createProject(tenant.id, { name: projectName }, tx);
    const actor = await createActor(tenant.id, { kind: 'user', name: adminName, email: adminEmail }, tx);
    await bindRole(tenant.id, actor.id, null, 'admin', tx);
    const { secret, prefix, keyHash } = mintKey();
    const keyRow = await createApiKeyRow({
      tenantId: tenant.id, actorId: actor.id, name: 'provisioned-admin',
      prefix, keyHash,
    }, tx);
    const { key_hash: _dropped, ...safeKey } = keyRow;
    // secret 只在这里返回一次；调用方（路由）负责只向开通者展示一次
    return { tenant, project, actor, apiKey: { ...safeKey, key: secret } };
  });
}
