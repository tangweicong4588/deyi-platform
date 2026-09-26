/**
 * modules/policy/engine.mjs —— 内置策略引擎。
 *
 * OPA 未接入时的默认决策器。规则与 deploy/opa/policy/authz.rego 保持语义一致，
 * 两边是同一份"平台默认策略"的两种表达，OPA 接入后以 OPA 为准。
 *
 * 决策输入 input: {
 *   actor:  { id, kind, roles: [{project_id, role}] },
 *   tenant: { id, status },
 *   project:{ id } | null,
 *   action: 'model.invoke' | 'tool.invoke' | 'knowledge.read' | 'ontology.publish' | 'admin.*' ...,
 *   resource: { kind, id?, risk?, projectId?, ... },
 *   context: { estimatedCost?, budgetRemaining?, ... }  // 调用方提供的事实
 * }
 * 决策输出: { allow, obligations: [], reason }
 * obligations 可选值: 'approval_required' | 'audit' | 'redact_pii'
 */
const POLICY_VERSION = 'deyi-default/1';

function rankOf(roles, projectId) {
  const order = { viewer: 0, operator: 1, admin: 2 };
  let r = -1;
  for (const b of roles || []) {
    if (b.project_id === null || (projectId && b.project_id === projectId)) {
      r = Math.max(r, order[b.role] ?? -1);
    }
  }
  return r;
}

const OBL_AUDIT = 'audit';

export function decideBuiltin(input) {
  const { actor = {}, tenant = {}, project = null, action = '', resource = {}, context = {} } = input;
  const deny = (reason) => ({ allow: false, obligations: [OBL_AUDIT], reason, policyVersion: POLICY_VERSION, engine: 'builtin' });
  const allow = (reason, obligations = [OBL_AUDIT]) =>
    ({ allow: true, obligations, reason, policyVersion: POLICY_VERSION, engine: 'builtin' });

  // R0: 租户/主体停用 → 一律拒绝（纵深防御；认证层通常已拦截）
  if (tenant.status && tenant.status !== 'active') return deny('租户已停用');
  if (actor.status && actor.status !== 'active') return deny('主体已停用');

  // R1: 管理面动作需要租户级 admin（路由层一般已做，这里兜底）
  if (action.startsWith('admin.')) {
    return rankOf(actor.roles, null) >= 2 ? allow('租户 admin') : deny('管理面需要 admin 角色');
  }

  // R2: 模型调用 —— 预算熔断（调用方需在 context.budgetRemaining 提供剩余额度）
  if (action === 'model.invoke') {
    if (typeof context.budgetRemaining === 'number' && typeof context.estimatedCost === 'number') {
      if (context.estimatedCost > context.budgetRemaining) return deny('预算不足，触发熔断');
    }
    return allow('模型调用配额内');
  }

  // R3: 工具调用 —— 风险分级：high 必须审批，medium 需 operator+，low 放行
  if (action === 'tool.invoke') {
    const risk = resource.risk || 'low';
    if (risk === 'high') {
      return { allow: true, obligations: [OBL_AUDIT, 'approval_required'], reason: '高风险工具调用需审批', policyVersion: POLICY_VERSION, engine: 'builtin' };
    }
    if (risk === 'medium') {
      return rankOf(actor.roles, project?.id) >= 1 ? allow('中风险工具调用（operator+）') : deny('中风险工具调用需要 operator 角色');
    }
    return allow('低风险工具调用');
  }

  // R4: 知识读取 —— 禁止跨项目（除非资源显式共享）
  if (action === 'knowledge.read') {
    if (resource.projectId && project && resource.projectId !== project.id && !resource.shared) {
      return deny('禁止跨项目读取知识');
    }
    return allow('知识读取（项目内）');
  }

  // R4b: 知识写入 —— 需要 operator+（项目级或租户级绑定）
  if (action === 'knowledge.ingest') {
    return rankOf(actor.roles, project?.id) >= 1
      ? allow('知识写入（operator+）')
      : deny('知识写入需要 operator 角色');
  }

  // R5: 本体发布 —— 必须走评审（obligation 由本体服务落实为"需评审通过"状态）
  if (action === 'ontology.publish') {
    return rankOf(actor.roles, project?.id) >= 1
      ? { allow: true, obligations: [OBL_AUDIT, 'review_required'], reason: '本体发布需评审', policyVersion: POLICY_VERSION, engine: 'builtin' }
      : deny('本体发布需要 operator 角色');
  }

  // R5b: 本体写入（提交候选/转评审/驳回/废止/冲突裁决）—— 需要 operator+
  if (action === 'ontology.write') {
    return rankOf(actor.roles, project?.id) >= 1
      ? allow('本体写入（operator+）')
      : deny('本体写入需要 operator 角色');
  }

  // 默认：拒绝未知动作（fail-closed）
  return deny(`未知动作: ${action}`);
}

export { POLICY_VERSION };
