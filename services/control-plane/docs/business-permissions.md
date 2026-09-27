# 业务权限口径（V4.6）

谁可发起 / 谁可审批 / 谁可查看。

## 三层鉴权链

每个业务写操作依次经过：

1. `authenticate` —— 身份合法（operator token / 本地 IdP JWT / API key）。
2. `requireScope` —— API key 的 scope 白名单（V2.5 衔接；空 scopes = 不限制，向后兼容）。
3. `scopedProject` 角色门槛 —— 项目 viewer+ 可读，operator+ 可写；租户级角色天然覆盖其下全部项目。
4. `policy decide` —— OPA 风格策略引擎（tasks.read/write、agent.read/write、release.read/write）。
5. **行级规则**（V4.6 新增）——本节。

## 行级规则

### 任务改派（createTask / assignTask 的 assigneeId）

- 只能指派给**本项目成员**（项目绑定或租户级角色，viewer+）。
- 非成员（含不存在的 actor）→ 403 `NOT_PROJECT_MEMBER`（fail-closed）。
- 口径变化：V4.1 是"本租户主体"检查（400）；V4.6 起收紧为项目成员（403）。

### 审批人指派规则

三类审批统一语义：**指派后，只有被指派人可决议**。

| 审批类型 | 指派入口 | 指派约束 | 决议校验 |
|---|---|---|---|
| 任务审批单 | 创建时 `payload.approver_id` | 项目成员 operator+；不能是发起人（SoD） | 非指派人 → 403 `APPROVER_MISMATCH` |
| Agent HITL 审批 | 图定义 hitl 节点 `approver_id`（发版时校验成员资格 viewer+） | 项目成员 | 非指派人 → 403 `APPROVER_MISMATCH` |
| 发布审批 | `request-approval` 的 `approverId` | 项目成员 operator+；不能是发起人（SoD） | 非指派人 → 403 `APPROVER_MISMATCH` |

- 未指派时保持原有规则：任一非发起人的 operator+ 可决议。
- SoD 始终优先：发起人永远不能决议自己的单（即使被误指派，发版/创建时即拒绝）。

### 越权审计

以下拒绝均写审计事件（`{domain}.access.denied` / `{domain}.approval.denied` / `biz_task.decide.denied`），满足"审计可查"：

- 角色门槛拒绝（viewer 试图发起写操作）。
- 策略引擎拒绝。
- SoD 拒绝、指派不匹配拒绝。

## 边界

- 项目成员资格是"有任一角色绑定"（viewer+），不区分任务是否与本人相关；更细的"只能看自己经办的任务"未做（企业实践中通常不需要）。
- 指派的审批人若离职/被移除项目角色，决议会 403，需要先改派（任务单无改派审批人接口，需重新创建；后续迭代可补）。
