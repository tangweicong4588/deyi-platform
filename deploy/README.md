# 部署指南

> ⚠️ 本目录所有产物在提交者环境**从未真实执行**（本机无 Docker/K8s）。
> 首次部署前必须走完下面的"首次部署核验清单"，并把结果记录下来。

## 一、Docker Compose（一键启动，单机/测试生产）

```bash
cd deploy
cp .env.example .env
# 编辑 .env：把每个 CHANGEME_ 换成强随机值（openssl rand -hex 32）
./verify-manifests.sh   # 先跑静态自洽检查（无需 Docker）：变量/卷/模型表/k8s 键引用
docker compose up --build -d
docker compose logs -f control-plane   # 看启动日志与 adapters 状态
```

启动约需 1–3 分钟（Docling 镜像较大，首次拉取更久）。

### 服务端口表

| 服务 | 宿主机端口 | 容器内 | 说明 |
|---|---|---|---|
| control-plane | 8080 | 8080 | 平台 API（唯一对外入口） |
| postgres | — | 5432 | 仅容器网络内访问 |
| qdrant | 6333 | 6333 | 向量索引（调试用；生产建议关闭宿主机映射） |
| litellm | 4000 | 4000 | 模型统一出口（仅 control-plane 调用） |
| opa | 8181 | 8181 | 策略决策（仅 control-plane 调用） |
| docling | 5001 | 5001 | 文档解析 |
| temporal | 7233 | 7233 | 工作流（gRPC） |

### /readyz 解读

```bash
curl http://localhost:8080/readyz | python3 -m json.tool
```

`adapters` 字段是各引擎的真实状态（控制面启动时探测）：

| 值 | 含义 | 行动 |
|---|---|---|
| `postgresql(live)` | 已连 PG | — |
| `sqlite(fallback)` | 没配 DATABASE_URL | 生产不允许，检查 .env |
| `local-idp` | 自研身份服务可用 | — |
| `none` | 未配置 AUTH_JWT_SECRET | 生产启动会直接拒绝 |
| `oidc-client` / `none` | 外部 IdP 对接状态 | 可选；不配只用本地账号登录 |
| `opa(live)` | OPA 可用 | — |
| `builtin(fallback)` | 内置策略引擎 | 可用但建议生产接 OPA |
| `litellm(live)` | LiteLLM 可用 | — |
| `none` | 模型网关未配置 | 检查 LITELLM_URL；生产启动会直接拒绝 |
| `qdrant(live)` / `local-index(fallback)` | 向量索引状态 | 生产必须 `qdrant(live)` |
| `docling(live)` / `builtin(fallback)` | 文档解析状态 | 降级可用，能力减弱 |
| `temporal(live)` / `local(fallback)` | 工作流引擎状态 | 降级为本地执行器 |
| `audit_anchor: none(本地哈希链)` | 未配外部锚定 | 生产必须配 AUDIT_ANCHOR_URL |

`/healthz` 只表示进程存活；`/readyz` 503 表示 DB 不可达。

### 首次部署核验清单（必须执行）

```bash
# 1. 镜像 tag 真实存在（提交时已用仓库 API 核验过一轮，部署前再确认一次）
for img in postgres:16.4 qdrant/qdrant:v1.11.0 \
  ghcr.io/berriai/litellm:main-v1.52.0 openpolicyagent/opa:0.68.0 \
  quay.io/docling-project/docling-serve:v1.35.0 temporalio/auto-setup:1.24.0; do
  docker pull "$img" || echo "缺失: $img"
done
# 2. 端口未被占用：8080/6333/8081/4000/8181/5001/7233
# 3. 卷目录可写（pgdata/qdrantdata 为命名卷，Docker 自动管理）
# 4. 启动后跑冒烟脚本（strict=生产验收：adapters 出现 fallback 即失败）
OPERATOR_TOKEN=xxx ./smoke.sh --strict
# 5. 按 docs/runbooks/tenant-onboarding.md 建第一个租户并调通模型调用
```

## 二、Kubernetes（生产推荐）

```bash
# 0. 先构建并推送控制面镜像（manifests 默认 deyi/control-plane:0.5.0，按需改）
docker build -t registry.example.com/deyi/control-plane:0.5.0 services/control-plane
docker push registry.example.com/deyi/control-plane:0.5.0
# 1. 先填 Secret（全占位，见 k8s/secret.yaml 注释），并改 image 地址
kubectl apply -k deploy/k8s/
# 2. 检查
kubectl -n deyi get pods
kubectl -n deyi port-forward svc/control-plane 8080:8080
curl http://localhost:8080/readyz
```

Ingress 为模板（`k8s/control-plane/ingress.yaml`），按实际域名修改 host 后启用。
镜像 tag 与 compose 共用同一份核验结论（见上）。

## 三、配置说明

- **LiteLLM 模型目录**：`deploy/litellm/config.yaml` 的 `model_list` 由运维维护；
  新增模型先灰度，再进控制面的模型白名单（`POST /v1/admin/models`）。
- **OPA 策略包**：`deploy/opa/policy/authz.rego`，与内置策略引擎语义一致；
  改完策略先 `opa test`（如装了 opa CLI），再滚动更新。
- **生产启动校验**（`src/kernel/config.mjs`）：缺 `DATABASE_URL`/`AUTH_JWT_SECRET`/
  `LITELLM_URL`/`QDRANT_URL`/`AUDIT_ANCHOR_URL` 或开了 `BOOTSTRAP_ENABLED`
  会直接拒绝启动，这是故意的。
