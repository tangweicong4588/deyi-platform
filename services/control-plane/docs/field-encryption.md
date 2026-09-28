# 敏感字段落库加密（V2.16）

## 覆盖字段

| 表 | 列 | 说明 |
|---|---|---|
| `local_credentials` | `totp_secret_enc` | TOTP secret，AES-256-GCM 信封加密 |
| `notify_channels` | `secret_enc` | webhook 签名密钥（直接传 secret 建通道时），与 `secret_ref` 二选一 |

`secret_ref`（`env:VAR` 引用）继续可用；OAuth/OIDC token 目前没有落库列，
后续新增 token 类字段统一走 `kms.encrypt/decrypt` + `registerEncryptedField` 注册。

## KMS（`src/kernel/kms.mjs`）

- 本地 provider：每字段随机 DEK（32B）→ KEK 包裹 DEK（AES-256-GCM）。
  信封：`enc:v1:<kekId>:<b64(iv|wrappedDek|tag)>.<b64(iv|ct|tag)>`
- 云 KMS 预留：`KMS_PROVIDER=aws|gcp|alibaba` 目前显式报 NOT_IMPLEMENTED，
  替换点是 DEK 的 wrap/unwrap（信封格式不变）。

### 环境变量

| 变量 | 说明 |
|---|---|
| `FIELD_ENCRYPTION_KEY` | base64 32B，**生产必须设置**；缺失时敏感字段写操作 fail-closed（503），不落明文 |
| `FIELD_ENCRYPTION_KEY_ID` | 当前 key 版本 id（默认 `local-1`），写进信封 |
| `FIELD_ENCRYPTION_KEY_PREVIOUS` | 旧 key（`id:base64` 逗号分隔），解密旧信封用；key 读取是 live 的，轮换无需重启 |
| `KMS_PROVIDER` | `local`（默认）；非 local 暂未实现 |

生产未设置 `FIELD_ENCRYPTION_KEY` 会在启动校验给出 warning（见 `config.mjs`）。

## 历史明文 lazy 迁移

- `local_credentials.totp_secret`（旧明文列）保留：读到旧明文时登录仍可用，
  并 best-effort 加密回写到 `totp_secret_enc`、清空明文列。
- KMS 未配置时跳过迁移（登录不受影响）；新 `setupTotp` 此时直接 503。
- `notify_channels` 历史上只存 `secret_ref`，无明文迁移问题。

## key 轮换流程（operator）

1. 生成新 key，设置 `FIELD_ENCRYPTION_KEY=<新>` + `FIELD_ENCRYPTION_KEY_ID=<新id>`，
   旧 key 移入 `FIELD_ENCRYPTION_KEY_PREVIOUS`（格式 `旧id:旧base64`）。
2. `POST /v1/admin/security/field-keys/rotate-sweep`（operator 鉴权）：
   扫描注册表字段，把旧 `kekId` 的行重加密为当前 key，返回 `{ scanned, rotated, errors }`。
3. `GET /v1/admin/security/field-keys/status` 确认全部行已是当前 `kekId` 后，
   从 `FIELD_ENCRYPTION_KEY_PREVIOUS` 下线旧 key。
4. 解密时若 `kekId` 找不到对应 key，报 `FIELD_ENCRYPTION_KEY_MISSING`（503，不静默）。

## 安全边界

- 防：拖库后直接读取敏感字段（无 key 密文不可解）。
- 不防：运行时内存 dump；不做全列加密（只加密明确注册的敏感字段）。
- 篡改密文 → GCM 认证失败 → `FIELD_DECRYPT_FAILED`；登录路径按 401 处理，不泄露内部错误。
