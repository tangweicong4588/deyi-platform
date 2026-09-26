# 新租户上线 SOP（tenant-onboarding）

> 约定：`$API` 为控制面地址（如 http://localhost:8080），`$OP` 为 OPERATOR_TOKEN。
> API Key 的 `key` 字段**只在签发响应里出现一次**，立即存入密钥管理。

## 步骤 1：建租户（平台运维）

```bash
curl -s -X POST $API/v1/admin/tenants \
  -H "Authorization: Bearer $OP" -H 'Content-Type: application/json' \
  -d '{"name":"示例企业","slug":"acme"}'
# 记下返回的 id：ten_xxx
```

## 步骤 2：建项目（平台运维代建，或先给租户 admin key 让对方自建）

```bash
T=ten_xxx
curl -s -X POST $API/v1/admin/tenants/$T/projects \
  -H "Authorization: Bearer $OP" -H 'Content-Type: application/json' \
  -d '{"name":"客服知识库","slug":"kb"}'
# 记下 prj_xxx
```

## 步骤 3：建主体 + 发 API Key

```bash
# 主体
A=$(curl -s -X POST $API/v1/admin/tenants/$T/actors \
  -H "Authorization: Bearer $OP" -H 'Content-Type: application/json' \
  -d '{"kind":"user","name":"张三","email":"zhangsan@acme.com"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['id'])")
# 角色绑定（租户级 admin；项目级用 {"projectId":"prj_xxx","role":"operator"}）
curl -s -X POST $API/v1/admin/tenants/$T/role-bindings \
  -H "Authorization: Bearer $OP" -H 'Content-Type: application/json' \
  -d "{\"actorId\":\"$A\",\"role\":\"admin\"}"
# 发 key（key 只返回一次！）
curl -s -X POST $API/v1/admin/tenants/$T/api-keys \
  -H "Authorization: Bearer $OP" -H 'Content-Type: application/json' \
  -d "{\"actorId\":\"$A\",\"name\":\"prod-key\"}"
# 记下 data.key：dyk_...（存入 Vault，发给客户）
```

## 步骤 4：设预算（租户级 + 项目级，按需）

```bash
K=dyk_...  # 上一步拿到的 key
curl -s -X PUT $API/v1/admin/tenants/$T/budgets \
  -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
  -d '{"period":"monthly","costLimitCents":100000,"tokenLimit":10000000}'
```

## 步骤 5：确认模型白名单

```bash
curl -s $API/v1/models -H "Authorization: Bearer $K"
# 需要新增模型 → 平台运维：POST /v1/admin/models（先改 litellm/config.yaml 灰度）
```

## 步骤 6：验证调用（端到端）

```bash
# 身份
curl -s $API/v1/me -H "Authorization: Bearer $K"
# 模型调用（带项目头，费用记到项目账本）
curl -s -X POST $API/v1/gw/chat/completions \
  -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
  -H "x-deyi-project: prj_xxx" \
  -d '{"model":"deyi-default","messages":[{"role":"user","content":"你好"}]}'
# 查账本（应有 1 条，不含 prompt 原文）
curl -s "$API/v1/admin/tenants/$T/usage?limit=5" -H "Authorization: Bearer $K"
```

## 步骤 7：交付客户

- API Key（`dyk_`，通过安全通道）
- 租户/项目 ID、预算额度、可用模型列表
- 指向本文档 + operations.md（故障时看哪里）

## 下线/轮换

- 吊销 key：`DELETE /v1/admin/tenants/$T/api-keys/:keyId`（立即失效）
- 租户停用：平台运维在 DB 将 tenant status 置 `suspended`（策略层全局拒绝）
