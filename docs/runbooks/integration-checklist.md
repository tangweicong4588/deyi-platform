# 开源底座联调清单（integration-checklist）

> 目标：在 Docker/K8s 可用的目标环境，把 compose 里的每个开源组件从
> `fallback` 切到 `live`。本清单在提交者环境**未真实执行**（本机无 Docker），
> 每一步都在目标环境按顺序验证，通过后再进行下一步。
>
> 总体验收：`curl $API/readyz` 的 `adapters` 全部为 `live`（tracing 除外），
> 且 `deploy/smoke.sh --strict` 通过。

约定：`$API` = 控制面地址（如 http://localhost:8080）。

---

## 0. 前置：镜像与网络

- [ ] `docker pull` 清单里 6 个镜像全部成功（tag 见 deploy/docker-compose.yml；V2.10 已移除 Keycloak）。
- [ ] 容器间 DNS 可达：control-plane 能解析 `postgres/litellm/opa/qdrant/docling/temporal`。
- [ ] 生产 `.env` 已填：`POSTGRES_PASSWORD / AUTH_JWT_SECRET / LITELLM_MASTER_KEY /
  OPERATOR_TOKEN / DEFAULT_API_KEY / AUDIT_ANCHOR_URL`，
  无 `CHANGEME_` 残留：`grep -r CHANGEME_ .env` 为空。

## 1. PostgreSQL（真相源）

- [ ] `docker compose up -d postgres` 后 `pg_isready` 通过；control-plane 启动日志无迁移报错。
- [ ] `/readyz` → `database: postgresql(live)`。
- [ ] 表存在：`docker compose exec postgres psql -U deyi -c '\dt'` 含 `tenants/_migrations` 等。
- 坑：`DATABASE_URL` 密码含特殊字符需 URL 编码；生产 `BOOTSTRAP_ENABLED` 必须 `false`
 （否则 config 拒绝启动）。

## 2. 身份（自研轻量身份服务 + 标准 OIDC Client）

V2.10 起移除 Keycloak：平台用自研本地账号（密码+TOTP+登录锁定），
外部身份只做标准 OIDC Relying Party，对接客户已有 IdP。

本地账号：
- [ ] `/readyz` → `idp: local-idp`（AUTH_JWT_SECRET 已配；生产缺失会启动拒绝）。
- [ ] 租户 admin 建用户：`POST /v1/admin/tenants/:tenantId/users` → 201。
- [ ] `POST /v1/auth/login` → 200 返回 access/refresh；`GET /v1/me`（Bearer access）→ 200。
- [ ] TOTP：`POST /v1/auth/totp/setup` → 扫码 → `enable`；登录必须带 `totpCode`。
- [ ] 锁定：连续 5 次错密码 → 423，15 分钟后自动解。

OIDC（可选；配了才启用）：
- [ ] `.env` 填 `OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET/REDIRECT_URI`；
      `/readyz` → `oidc: oidc-client`。
- [ ] `GET /v1/auth/oidc/login?tenant=<slug>` 302 跳到 IdP；回调后返回本平台会话。
- [ ] 租户映射：IdP claims 带 `tenant_id`/`deyi_tenant`，或配 `OIDC_DEFAULT_TENANT_ID`。
- [ ] JIT：首次登录自动建 actor（external_id = sub），审计有 `auth.oidc.jit`。
- 坑：`OIDC_ISSUER` 必须是**控制面容器内可达**地址，且与 discovery 返回的 issuer 一致，
  否则 ID token 的 iss 校验不通过。

## 3. LiteLLM（模型统一出口）

- [ ] `deploy/litellm/config.yaml` 的 `model_list` 至少有一个可用模型，
      其 `api_key` 对应 `.env` 的 `DEFAULT_API_KEY`。
- [ ] `curl -H "Authorization: Bearer $LITELLM_MASTER_KEY" http://localhost:4000/v1/models` 有模型列表。
- [ ] `/readyz` → `model_gateway: litellm(live)`。
- [ ] 端到端：按 tenant-onboarding 步骤 6 调 `$API/v1/gw/chat/completions`，
      usage 账本新增 1 条（不含 prompt 原文）。
- 坑：生产 `LITELLM_URL` 未设且无 `ALLOW_DIRECT_PROVIDER=true` 时控制面**拒绝启动**。

## 4. OPA（策略决策）

- [ ] `deploy/opa/policy/` 下的 rego 被挂载到容器 `/policy`（compose 已配 ro 挂载）。
- [ ] `curl -X POST http://localhost:8181/v1/data/deyi/authz -d '{"input":{}}'` 返回 200 且含 `result`。
- [ ] `/readyz` → `policy: opa(live)`。
- 坑：OPA 不可用时平台 **fail-closed 直接拒绝**（不回退 builtin），先确认 OPA 本身健康再排查平台。

## 5. Qdrant（向量索引，派生数据）

控制面期望两个 collection（维度均与当前 embedding 模型一致，不一致时 ensure
直接报错，要求重建索引）：
- `deyi_knowledge`：知识库 chunks（V1.x）；
- `deyi_memory`：记忆向量（V2.2-B，`POST /v1/tenants/:id/memory` 写入时 best-effort 索引）。

- [ ] `curl http://localhost:6333/collections` 200，能看到上述两个 collection
      （`deyi_memory` 在第一条记忆写入或 `scripts/rebuild-memory-index.mjs` 后出现）。
- [ ] 上传一篇文档走知识库 ingest，`/readyz` → `vector: qdrant(live)`。
- [ ] 写入一条记忆后 `GET /v1/tenants/:id/memory/recall?q=...` → `mode: semantic`。
- [ ] 换 embedding 模型后：先删 collection 重建
      （`DELETE /collections/deyi_knowledge` / `DELETE /collections/deyi_memory`），
      再跑 `scripts/rebuild-qdrant.mjs` / `scripts/rebuild-memory-index.mjs`；
      Qdrant 数据可重建，PostgreSQL 才是真相源。
- 坑：生产建议关闭 6333 的宿主机端口映射，仅容器网络访问。

## 6. Docling（文档解析）

- [ ] `curl http://localhost:5001/health` 有响应（控制面探测即打该路径）。
- [ ] 传一份 PDF 走文档解析，`/readyz` → `docling(live)`。
- 说明：未接时自动降级内置解析器（能力减弱但可用），属**允许的降级**，非 strict 失败项。

## 7. Temporal（工作流）

控制面期望：`TEMPORAL_ADDRESS=temporal:7233`；租户隔离 namespace=`deyi-<tenantId>`；
workflowId = execution 平台 ID（`exe_`）。

- [ ] temporal 服务 `docker compose logs temporal` 无持续报错（auto-setup 初始化较慢，多等 1–2 分钟）。
- [ ] 跑一条 V1.0 交付流水线，`/readyz` → `workflow: temporal(live)`，Temporal UI/CLI 能看到对应 namespace。
- 说明：未接时降级为内置执行器（`local(fallback)`），长流程无持久化恢复能力，生产建议接上。

## 8. Gitea（仓库，可选）

- [ ] 设 `GITEA_URL` 后 `/readyz` → `repo: gitea(live)`；未设为 `fake` 属预期（prodWarnings 会告警）。

## 9. 通知通道（V2.1-C）

- [ ] 按 `POST /v1/tenants/:id/notify/channels` 建 webhook 通道指向企业 IM 机器人
      （飞书/钉钉/企微/Slack 的 incoming-webhook URL），`POST …/channels/:id/test` 收到测试消息。
- [ ] `secret_ref` 用 `env:VAR` 引用（密钥只存在控制面环境，不在 DB）。
- [ ] 公网 webhook 不需要动；内网 webhook 才开 `NOTIFY_ALLOW_PRIVATE_TARGETS=true`
     （默认 SSRF 防护会拒绝私网目标）。

## 10. 收尾

- [ ] `OPERATOR_TOKEN=xxx API=$API ./deploy/smoke.sh --strict` 全 PASS。
- [ ] 备份策略按 `docs/runbooks/backup-restore.md` 落地（pgdata 卷快照 + DB 逻辑备份）。
- [ ] 把本清单每一步的结果（命令输出截图/日志片段）归档到交付文档，标记"已在目标环境验证"。
