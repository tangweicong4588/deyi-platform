# 运维手册（operations）

## 1. 启动顺序

Docker Compose 已通过 `depends_on` 保证：`postgres(healthy)` → `keycloak/temporal/control-plane`。
K8s 用 `initContainers` 等 postgres 5432 就绪。控制面启动时会主动探测各适配器，
单个引擎不可用**不阻塞启动**（降级 + `/readyz` 上报），只有 DB 不可达会 503。

```bash
# compose
docker compose up --build -d
docker compose logs -f control-plane   # 找 "control-plane listening" 与 adapters 一行

# k8s
kubectl apply -k deploy/k8s/
kubectl -n deyi get pods -w
kubectl -n deyi logs -l app=control-plane --tail=50
```

## 2. /readyz adapters 状态解读

`curl http://<host>:8080/readyz` 返回 `adapters` 对象，见 `deploy/README.md` 的对照表。
生产红线：`database` 必须 `postgresql(live)`；`idp` 必须 `keycloak(live)`；
`model_gateway` 必须 `litellm(live)`；`vector` 必须 `qdrant(live)`；
`audit_anchor` 不能是 `none(本地哈希链)`。任一红线不满足 → 按第 4 节排查，
不要先让业务流量进来。

## 3. 日志看哪里

- 控制面：JSON 结构化日志（stdout），字段含 `trace_id/tenant_id/actor_id`。
  compose：`docker compose logs -f control-plane`；
  k8s：`kubectl -n deyi logs -l app=control-plane -f`。
- 网关调用：`msg="gateway chat"` 行含 `model/via/engine/tokens/cost_cents`。
- LiteLLM：`docker compose logs -f litellm`（上游 4xx/5xx 先看这里）。
- Keycloak：管理后台 http://宿主机:8081（admin / KEYCLOAK_ADMIN_PASSWORD）。

## 4. 常见故障

### Qdrant 连不上 → adapters.vector = `qdrant(unreachable→local-index fallback)`
1. `curl http://<qdrant-host>:6333/healthz` 是否通。
2. 检查 `QDRANT_URL`（compose 固定 `http://qdrant:6333`）。
3. fallback 模式下检索仍可用，但数据只在内存，重启丢失 → 尽快恢复 Qdrant，
   恢复后重跑文档入库（派生索引可重建）。

### Docling 超时 → adapters.doc_parse = `builtin(fallback)`
1. `curl http://<docling-host>:5001/health` 是否通（首次启动模型加载需数分钟）。
2. fallback 用内置解析器：txt/md 正常，复杂 pdf 可能失败（document 状态 `failed`）。
3. 检查 Docling 容器资源（建议 4C/8G，见 k8s manifests）。

### LiteLLM 401 → 网关返回 502 `模型调用失败: 401`
1. `LITELLM_MASTER_KEY` 在 control-plane 与 litellm 两端是否一致
  （compose/k8s 都从同一 Secret 注入，优先查是否改了一边没改另一边）。
2. `curl http://<litellm-host>:4000/v1/models -H "Authorization: Bearer $LITELLM_MASTER_KEY"`。
3. 若上游 provider 401：查 `DEFAULT_API_KEY` 是否有效、是否欠费。

### 模型调用 402 `预算不足`
正常熔断。查 `GET /v1/admin/tenants/:tenantId/budgets`（租户 admin），
调大 `costLimitCents`：`PUT /v1/admin/tenants/:tenantId/budgets`。

### Keycloak 登录失败
1. realm 是否为 `deyi`（KEYCLOAK_REALM），client 是否配好。
2. `adapters.idp` 若为 `dev-idp(fallback)`/`none`：生产不允许，检查 KEYCLOAK_URL。

### OPA 不可用
控制面自动 fail-closed 拒绝（策略安全）。查 `curl http://<opa-host>:8181/health`，
策略改坏了先回滚 `deploy/opa/policy/authz.rego`。

### 磁盘/卷满
- `pgdata`：PG 主库，满了先扩容再删（见 backup-restore.md）。
- `qdrantdata`：可删重建（重跑入库），但重建期间检索降级。
