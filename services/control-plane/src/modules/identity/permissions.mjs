/**
 * modules/identity/permissions.mjs —— V4.6 行级权限 helper。
 *
 * 项目成员 = 在 role_bindings 中有该项目绑定，或有租户级角色绑定
 * （租户级 admin/operator/viewer 天然覆盖其下全部项目，与 effectiveRank 口径一致）。
 * rank：viewer=0 / operator=1 / admin=2；-1 = 非成员。
 */
import { db } from '../../db/index.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { effectiveRank } from './middleware.mjs';
import { roleRank } from './store.mjs';

/** 该主体在项目上的有效等级；-1 表示非项目成员 */
export async function projectRankOf(tenantId, projectId, actorId) {
  const rows = await db().query(
    'SELECT project_id, role FROM role_bindings WHERE tenant_id=? AND actor_id=?',
    [tenantId, actorId]);
  return effectiveRank(rows, projectId);
}

/**
 * 断言主体具备项目最低角色；不满足时 403（ fail-closed）。
 * @param {string} minRole 'viewer' | 'operator' | 'admin'
 */
export async function assertProjectRole(tenantId, projectId, actorId, minRole, what = '操作') {
  const rank = await projectRankOf(tenantId, projectId, actorId);
  if (rank < roleRank(minRole)) {
    throw Errors.forbidden(
      `${what}需要项目 ${minRole} 及以上角色（当前主体非项目成员或等级不足）`,
      { code: 'NOT_PROJECT_MEMBER' });
  }
  return rank;
}
