# 得逸智行企业级 AI 交付与执行平台

> 自研控制面，复用开源执行底座。平台的核心资产是项目事实、本体、策略、审批、
> 证据和产物合同；开源组件通过薄适配层接入，任何单一实现都可替换。

当前版本：**V0.5 可治理底座**（SSO → 模型调用 → 文档/源码入库 → 工具执行 →
trace/审计/成本，全链路可归属、可阻断）。

## 架构：四个平面

| 平面 | 自研（本仓库） | 开源底座（适配层接入） |
|---|---|---|
| 体验与控制面 | 租户/项目/任务模板/审批/预算/产物合同 | Keycloak（身份）、Temporal（工作流） |
| 知识与本体面 | CanonicalDoc、Fact 版本链、权限过滤、本体评审发布 | Docling、LlamaIndex、Qdrant、Mem0+Graphiti、PostgreSQL |
| 编排与策略面 | 策略决策、MCP 网关（注册/分级/审批/幂等） | LiteLLM（模型出口）、LangGraph、OPA |
| 执行与证据面 | 审计哈希链、成本账本、证据包 | 隔离 Runner、Gitea Actions、Langfuse、OTel |

详见 [docs/architecture.md](docs/architecture.md)。

## 关键原则

1. **平台 ID 是真相源**：领域对象只存平台 ID（如 `ten_`、`prj_`），Qdrant point ID、
   LangGraph checkpoint ID、LiteLLM key 只作可替换绑定，禁止反向依赖。
2. **每个请求绑定上下文**：`tenant_id / project_id / actor_id / trace_id`，
   租户身份由已认证的 Key/JWT 派生，绝不信任请求头。
3. **控制面只发命令**：不直接持有目标系统长期凭证，工具执行走短期凭证。
4. **PostgreSQL 是事务真相源**；Qdrant 是派生索引（可重建）；对象存储存原件与证据包。

## 快速开始（开发模式）

```bash
cd services/control-plane
npm install
BOOTSTRAP_ENABLED=true npm run dev   # 首次启动自动建租户并发放 admin key（仅开发）
```

生产部署见 [deploy/README.md](deploy/README.md)（compose 一键启动 / K8s manifests /
首次部署核验清单），运维文档在 [docs/runbooks/](docs/runbooks/)（日常运维、
备份恢复、新租户上线 SOP）。

## 仓库结构

```
deyi-platform/
  docs/                  架构 / 运维文档（含 runbooks/：运维、备份恢复、租户上线 SOP）
  deploy/                docker-compose.yml、.env.example、K8s manifests（k8s/）、
                         OPA 策略包、LiteLLM 配置、部署指南（README.md）
  services/
    control-plane/       自研控制面（模块化单体，模块边界严格）
      src/kernel/        配置 / 日志 / ID / 上下文 / 错误 / HTTP / DB
      src/db/            迁移脚本（PostgreSQL 优先，SQLite 仅开发 fallback）
      src/modules/       identity / policy / gateway / knowledge / ontology / execution / evidence
      tests/
```

`services/control-plane` 之外不写业务代码；引擎全部走适配层。
