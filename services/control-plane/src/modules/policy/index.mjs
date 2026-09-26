/**
 * modules/policy/index.mjs —— 策略决策统一入口。
 *
 * decide(input) -> receipt { allow, obligations, reason, policyVersion, engine, decidedAt }
 * - OPA_URL 设置 → 走 OPA；否则走内置引擎（语义与 deploy/opa 下的 Rego 包一致）。
 * - receipt 会被调用方写入审计事件（P7 证据平面）。
 */
import { decideBuiltin } from './engine.mjs';
import { decideViaOpa, isOpaEnabled } from './opa.mjs';
import { nowMs } from '../../kernel/ids.mjs';

export async function decide(input) {
  const receipt = isOpaEnabled() ? await decideViaOpa(input) : decideBuiltin(input);
  return { ...receipt, decidedAt: nowMs() };
}

/** 把当前请求上下文 + 动作拼成标准 decision input */
export function inputFromRequest({ actor, tenant, project, action, resource, context }) {
  return {
    actor: {
      id: actor?.id, kind: actor?.kind, status: actor?.status,
      roles: (actor?.roles || []).map((b) => ({ project_id: b.project_id ?? null, role: b.role })),
    },
    tenant: { id: tenant?.id, status: tenant?.status },
    project: project ? { id: project.id } : null,
    action, resource: resource || {}, context: context || {},
  };
}
