# 平台默认策略（OPA Rego 实现）
#
# 与 services/control-plane/src/modules/policy/engine.mjs 的内置引擎语义一致。
# OPA 接入后以这里为准；内置引擎仅在 OPA 未配置时生效。
package deyi.authz

import rego.v1

default allow := false
default obligations := ["audit"]

role_rank := {"viewer": 1, "operator": 2, "admin": 3}

# 在某项目下的有效角色等级（租户级绑定 project_id 为 null）
effective_rank(project_id) := max([r |
	some b in input.actor.roles
	((b.project_id == null) | (project_id != null; b.project_id == project_id))
	r := role_rank[b.role]
]) if {
	count(input.actor.roles) > 0
} else := 0

# R0: 停用租户/主体
deny_reason contains "租户已停用" if { input.tenant.status != "active" }
deny_reason contains "主体已停用" if { input.actor.status == "suspended" }

# R1: 管理面需租户级 admin
allow if { startswith(input.action, "admin."); effective_rank(null) >= 3 }
deny_reason contains "管理面需要 admin 角色" if {
	startswith(input.action, "admin."); effective_rank(null) < 3
}

# R2: 模型调用预算熔断
allow if {
	input.action == "model.invoke"
	not budget_exceeded
}
budget_exceeded if {
	is_number(input.context.budgetRemaining)
	is_number(input.context.estimatedCost)
	input.context.estimatedCost > input.context.budgetRemaining
}
deny_reason contains "预算不足，触发熔断" if {
	input.action == "model.invoke"; budget_exceeded
}

# R3: 工具调用风险分级
allow if { input.action == "tool.invoke"; input.resource.risk == "low" }
allow if {
	input.action == "tool.invoke"
	input.resource.risk == "medium"
	effective_rank(input.project.id) >= 2
}
deny_reason contains "中风险工具调用需要 operator 角色" if {
	input.action == "tool.invoke"; input.resource.risk == "medium"
	effective_rank(input.project.id) < 2
}
allow if { input.action == "tool.invoke"; input.resource.risk == "high" }
obligations := ["audit", "approval_required"] if {
	input.action == "tool.invoke"; input.resource.risk == "high"
}

# R4: 知识读取禁跨项目
allow if {
	input.action == "knowledge.read"
	not cross_project
}
cross_project if {
	input.resource.projectId != null
	input.project != null
	input.resource.projectId != input.project.id
	not input.resource.shared
}
deny_reason contains "禁止跨项目读取知识" if {
	input.action == "knowledge.read"; cross_project
}

# R4b: 知识写入需 operator+
allow if {
	input.action == "knowledge.ingest"
	effective_rank(input.project.id) >= 2
}
deny_reason contains "知识写入需要 operator 角色" if {
	input.action == "knowledge.ingest"; effective_rank(input.project.id) < 2
}

# R5: 本体发布需评审
allow if {
	input.action == "ontology.publish"
	effective_rank(input.project.id) >= 2
}
obligations := ["audit", "review_required"] if {
	input.action == "ontology.publish"
}
deny_reason contains "本体发布需要 operator 角色" if {
	input.action == "ontology.publish"; effective_rank(input.project.id) < 2
}

# R5b: 本体写入需 operator+
allow if {
	input.action == "ontology.write"
	effective_rank(input.project.id) >= 2
}
deny_reason contains "本体写入需要 operator 角色" if {
	input.action == "ontology.write"; effective_rank(input.project.id) < 2
}

# R5c: 工具注册需 operator+
allow if {
	input.action == "tool.register"
	effective_rank(input.project.id) >= 2
}
deny_reason contains "工具注册需要 operator 角色" if {
	input.action == "tool.register"; effective_rank(input.project.id) < 2
}

# R6: 交付域 —— delivery.read 需 viewer+，delivery.write 需 operator+
allow if {
	input.action == "delivery.read"
	effective_rank(input.project.id) >= 1
}
deny_reason contains "交付域读取需要 viewer 角色" if {
	input.action == "delivery.read"; effective_rank(input.project.id) < 1
}
allow if {
	input.action == "delivery.write"
	effective_rank(input.project.id) >= 2
}
deny_reason contains "交付域写入需要 operator 角色" if {
	input.action == "delivery.write"; effective_rank(input.project.id) < 2
}

reason := [r | some r in deny_reason][0] if { not allow } else := "default allow"

result := {
	"allow": allow,
	"obligations": obligations,
	"reason": reason,
	"policy_version": "deyi-default/1",
}
