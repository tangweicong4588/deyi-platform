# 架构说明（V0.5 可治理底座）

依据《企业级应用智能交付与执行平台实现方案》V3.1。核心一句话：

> **自研控制面，复用开源执行底座。**平台的核心资产是项目事实、本体、策略、
> 审批、证据和产物合同；开源组件通过薄适配层接入，任何单一实现都可替换。

## 1. 四个平面

```
用户 / 外部系统
      │
      ▼
┌───────────── 体验与控制面（自研） ─────────────┐
│ 租户/项目/主体 · API Key · RBAC · 审批 · 预算账本 │  ← services/control-plane
│ 本体工作台 · 产物合同 · 运营配置                │
└─────────────┬───────────────┬──────────────────┘
              │               │
      ┌───────▼───────┐ ┌─────▼────────┐
      │ 编排与策略面   │ │ 知识与本体面  │
      │ LiteLLM(模型出口)│ Docling(解析) │
      │ OPA(策略)      │ │ LlamaIndex+Qdrant(RAG) │
      │ Temporal(工作流)│ │ Mem0+Graphiti(记忆)   │
      │ LangGraph(V1.0)│ │ PostgreSQL(真相源)    │
      └───────┬───────┘ └─────┬────────┘
              │               │
      ┌───────▼───────────────▼───────┐
      │ 执行与证据面                   │
      │ MCP 网关(自研:注册/分级/审批/幂等) │
      │ 隔离 Runner · Gitea Actions    │
      │ 审计哈希链(自研)+外部锚定 · 成本账本 │
      │ Langfuse · OTel                │
      └───────────────────────────────┘
```

## 2. 自研 vs 复用边界

| 能力 | 自研（本仓库） | 复用（适配层） | 说明 |
|---|---|---|---|
| 租户/项目/主体/Key/RBAC | ✅ | 自研身份服务（本地账号+TOTP；可选标准 OIDC Client 对接客户 IdP） | 平台只做 Relying Party，不自研 OIDC Provider；授权（RBAC/策略）归平台 |
| 策略决策 | ✅ 默认策略语义 | OPA（决策引擎） | Rego 包与内置引擎语义一致，可热插拔 |
| 模型网关治理 | ✅ 身份映射/预算/计量/熔断 | LiteLLM（统一出口） | 平台签发虚拟 key，不直接暴露 Provider key |
| 知识入库/检索策略 | ✅ CanonicalDoc/ACL预过滤/证据血缘 | Docling / LlamaIndex / Qdrant | Qdrant 只存派生索引，可重建 |
| 记忆治理 | ❌ 未实现（仅接口 stub：`src/adapters/memory/memory.mjs`） | Mem0 + Graphiti | 记忆不能直接成为项目事实；实现前勿对外宣称具备记忆能力 |
| 本体治理 | ✅ 候选→评审→发布/冲突仲裁/版本链 | tree-sitter（抽取） | 发布/审批/版本归本体服务 |
| 工具执行 | ✅ MCP 网关：注册/风险分级/审批令牌/幂等 | MCP SDK / LangGraph(V1.0) | 控制面只发命令，不持长期凭证 |
| 长流程 | ✅ 状态机/补偿定义 | Temporal | 重试/补偿/人工信号 |
| 审计/成本 | ✅ 哈希链/外部锚定/成本账本 | OTel / Langfuse | 审计事件不可变 |

## 3. 铁律

1. **平台 ID 是真相源**：领域对象主键全部由平台生成（`ten_`/`prj_`/`usr_`…）；
   Qdrant point ID、LangGraph checkpoint、LiteLLM key 只存于映射表，禁止反向依赖。
2. **请求上下文**：每个请求绑定 `tenant_id / project_id / actor_id / trace_id`；
   租户身份只从已认证凭证派生，绝不信任请求头。
3. **PostgreSQL 是事务真相源**；Qdrant/图存储/索引是派生（可重建）；
   对象存储存原件、CanonicalDoc、证据包（内容寻址）。
4. **fail-closed**：策略引擎不可用、预算未知时拒绝而不是放行。
5. **适配器诚实标记**：`/readyz` 上报每个引擎是 `live` 还是 `fallback`；
   fallback 只允许在开发/测试存在，生产启动校验会拒绝。

## 4. 模块边界（control-plane 内部）

```
src/
  kernel/     配置/日志/ID/上下文/错误/HTTP —— 无业务逻辑
  db/         迁移 + 双后端抽象（pg 优先 / sqlite 仅开发）
  modules/
    identity/ 租户·项目·主体·Key·RBAC·IdP适配
    policy/   决策入口·内置引擎·OPA适配
    gateway/  （P3）模型网关适配器
    knowledge/（P4）知识平面
    ontology/ （P5）本体平面
    execution/（P6）MCP网关·Runner·Temporal适配
    evidence/ （P7）审计链·成本账本·OTel
```

模块之间只通过 `index.mjs` 暴露的函数调用，不直接读对方表。
跨模块事实传递用 `inputFromRequest` 式的显式结构，不共享内部行对象。
