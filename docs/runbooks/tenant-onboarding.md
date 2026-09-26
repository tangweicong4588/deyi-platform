# 新租户上线 SOP（tenant-onboarding）

> 约定：`$API` 为控制面地址（如 http://localhost:8080），`$OP` 为 OPERATOR_TOKEN。
> API Key 的 `key` 字段**只在签发响应里出现一次**，立即存入密钥管理。

## 步骤 1：原子开通（平台运维，一次调用）

`POST /v1/admin/tenants/provision` 在同一事务内创建：租户 + 默认项目 + admin 主体 +
租户级 admin 角色绑定 + 一次性 API Key（任一步失败整体回滚）。

```bash
PROV=$(curl -s -X POST $API/v1/admin/tenants/provision \
  -H "Authorization: Bearer $OP" -H 'Content-Type: application/json' \
  -d '{"name":"示例企业","plan":"trial","adminName":"张三","adminEmail":"zhangsan@acme.com"}')
echo "$PROV" | python3 -m json.tool
# 记下：data.tenant.id（ten_xxx）、data.project.id（prj_xxx）、
#      data.actor.id、data.apiKey.key（dyk_…，只返回一次！）
T=$(echo "$PROV" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['tenant']['id'])")
K=$(echo "$PROV" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['apiKey']['key'])")
P=$(echo "$PROV" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['project']['id'])")
# plan：trial | professional | enterprise（默认 trial）；trial 限 5 项目 / 20 主体 / 20 Key
```

> 旧的分步建租户/项目/主体/Key 流程仍可用（`POST /v1/admin/tenants` 等），
> 但新租户一律走原子开通；手工分步只用于补救场景。

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
  -H "x-deyi-project: $P" \
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
- 租户停用：`POST /v1/admin/tenants/$T/suspend`（其全部 Key 立即 401；审计记 tenant.suspend）
- 租户恢复：`POST /v1/admin/tenants/$T/resume`（原 Key 自动可用；审计记 tenant.resume）
- 套餐变更：`PATCH /v1/admin/tenants/$T` `{"plan":"professional"}`（配额即时生效；无计费结算，如需计费另行对接）
