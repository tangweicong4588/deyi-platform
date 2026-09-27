/**
 * kernel/context.mjs —— 请求上下文 envelope。
 *
 * 方案要求：每个请求先绑定 tenant_id / project_id / actor_id / trace_id，
 * 每次模型与工具调用都继承上下文并回写证据。
 *
 * - tenantId / actorId：只由已认证的 API Key / JWT 派生，绝不信任请求头。
 * - projectId：可来自 Key 的绑定 project，或请求体/路径显式指定（必须属于该租户）。
 * - traceId：请求入口生成（或沿用上游传入的 x-trace-id），全链路透传。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { Errors } from './errors.mjs';

const als = new AsyncLocalStorage();

export function newTraceId() {
  return 'tr_' + randomBytes(16).toString('hex');
}

/** 在上下文中运行 fn（HTTP 入口调用） */
export function runWithContext(ctx, fn) {
  const full = {
    traceId: ctx.traceId || newTraceId(),
    tenantId: ctx.tenantId || null,
    projectId: ctx.projectId || null,
    actorId: ctx.actorId || null,
    actorKind: ctx.actorKind || null,
    authKind: ctx.authKind || null, // 'api_key' | 'jwt' | 'bootstrap' | null(匿名)
    roles: ctx.roles || [],
    // V2.5：API Key 级细粒度 scope（仅 api_key 认证时有；空数组 = 未设置 = 不限制）
    keyId: ctx.keyId || null,
    keyScopes: Array.isArray(ctx.keyScopes) ? ctx.keyScopes : [],
  };
  return als.run(full, fn);
}

/** 取当前上下文（无上下文时返回空壳，不抛错） */
export function ctx() {
  return als.getStore() || { traceId: null, tenantId: null, projectId: null, actorId: null, actorKind: null, authKind: null, roles: [] };
}

/** 要求已认证 + 已绑定租户，否则 401 */
export function requireTenant() {
  const c = ctx();
  if (!c.actorId || !c.tenantId) throw Errors.unauthorized('需要认证');
  return c;
}
