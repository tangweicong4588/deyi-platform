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
 *   action: 'model.invoke' | 'tool.invoke' | 'knowledge.read' | 'ontology.publish' |
 *           'delivery.read' | 'delivery.write' | 'admin.*' ...,
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
  // M-4 安全 review：原来 `tenant.status && ...` 在 status 缺失时放行（fail-open），
  // 与 Rego `!= "active"` 不一致；统一为"缺失即拒绝"（fail-closed）。
  if (tenant.status !== 'active') return deny('租户已停用');
  if (actor.status !== 'active') return deny('主体已停用');

  // 项目级动作要求项目上下文：project 为 null 时拒绝（fail-closed），
  // 与 Rego 侧 `input.project.id` 取值失败→规则不成立→默认拒绝语义一致。
  const requireProject = () => {
    if (!project) return deny('缺少项目上下文（fail-closed）');
    return null;
  };

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
      const pj = requireProject(); if (pj) return pj;
      return rankOf(actor.roles, project.id) >= 1 ? allow('中风险工具调用（operator+）') : deny('中风险工具调用需要 operator 角色');
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
    const pj0 = requireProject(); if (pj0) return pj0;
    return rankOf(actor.roles, project.id) >= 1
      ? allow('知识写入（operator+）')
      : deny('知识写入需要 operator 角色');
  }

  // R5: 本体发布 —— 必须走评审（obligation 由本体服务落实为"需评审通过"状态）
  if (action === 'ontology.publish') {
    const pj1 = requireProject(); if (pj1) return pj1;
    return rankOf(actor.roles, project.id) >= 1
      ? { allow: true, obligations: [OBL_AUDIT, 'review_required'], reason: '本体发布需评审', policyVersion: POLICY_VERSION, engine: 'builtin' }
      : deny('本体发布需要 operator 角色');
  }

  // R5b: 本体写入（提交候选/转评审/驳回/废止/冲突裁决）—— 需要 operator+
  if (action === 'ontology.write') {
    const pj2 = requireProject(); if (pj2) return pj2;
    return rankOf(actor.roles, project.id) >= 1
      ? allow('本体写入（operator+）')
      : deny('本体写入需要 operator 角色');
  }

  // R5c: 工具注册 —— 需要 operator+（项目级或租户级绑定）
  if (action === 'tool.register') {
    const pj3 = requireProject(); if (pj3) return pj3;
    return rankOf(actor.roles, project.id) >= 1
      ? allow('工具注册（operator+）')
      : deny('工具注册需要 operator 角色');
  }

  // R6: 交付域 —— delivery.read 需 viewer+，delivery.write 需 operator+
  if (action === 'delivery.read') {
    const pj4 = requireProject(); if (pj4) return pj4;
    return rankOf(actor.roles, project.id) >= 0
      ? allow('交付域读取（viewer+）')
      : deny('交付域读取需要 viewer 角色');
  }
  if (action === 'delivery.write') {
    const pj5 = requireProject(); if (pj5) return pj5;
    return rankOf(actor.roles, project.id) >= 1
      ? allow('交付域写入（operator+）')
      : deny('交付域写入需要 operator 角色');
  }

  // R6b: 业务意图与计划 —— business.read 需 viewer+，business.write 需 operator+
  if (action === 'business.read') {
    const pj6 = requireProject(); if (pj6) return pj6;
    return rankOf(actor.roles, project.id) >= 0
      ? allow('业务意图读取（viewer+）')
      : deny('业务意图读取需要 viewer 角色');
  }
  if (action === 'business.write') {
    const pj7 = requireProject(); if (pj7) return pj7;
    return rankOf(actor.roles, project.id) >= 1
      ? allow('业务意图写入（operator+）')
      : deny('业务意图写入需要 operator 角色');
  }

  // R6c: 业务任务域 —— tasks.read 需 viewer+，tasks.write 需 operator+
  if (action === 'tasks.read') {
    const pj8 = requireProject(); if (pj8) return pj8;
    return rankOf(actor.roles, project.id) >= 0
      ? allow('任务域读取（viewer+）')
      : deny('任务域读取需要 viewer 角色');
  }
  if (action === 'tasks.write') {
    const pj9 = requireProject(); if (pj9) return pj9;
    return rankOf(actor.roles, project.id) >= 1
      ? allow('任务域写入（operator+）')
      : deny('任务域写入需要 operator 角色');
  }

  // R6d: 发布域 —— release.read 需 viewer+，release.write 需 operator+
  if (action === 'release.read') {
    const pj10 = requireProject(); if (pj10) return pj10;
    return rankOf(actor.roles, project.id) >= 0
      ? allow('发布域读取（viewer+）')
      : deny('发布域读取需要 viewer 角色');
  }
  if (action === 'release.write') {
    const pj11 = requireProject(); if (pj11) return pj11;
    return rankOf(actor.roles, project.id) >= 1
      ? allow('发布域写入（operator+）')
      : deny('发布域写入需要 operator 角色');
  }

  // R6e: Agent 域 —— agent.read 需 viewer+，agent.write 需 operator+
  if (action === 'agent.read') {
    const pj12 = requireProject(); if (pj12) return pj12;
    return rankOf(actor.roles, project.id) >= 0
      ? allow('Agent 域读取（viewer+）')
      : deny('Agent 域读取需要 viewer 角色');
  }
  if (action === 'agent.write') {
    const pj13 = requireProject(); if (pj13) return pj13;
    return rankOf(actor.roles, project.id) >= 1
      ? allow('Agent 域写入（operator+）')
      : deny('Agent 域写入需要 operator 角色');
  }

  // 默认：拒绝未知动作（fail-closed）
  return deny(`未知动作: ${action}`);
}

export { POLICY_VERSION };
