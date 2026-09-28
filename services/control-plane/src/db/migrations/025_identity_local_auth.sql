-- 025_identity_local_auth.sql —— V2.10：自研轻量身份服务（替代 Keycloak）。
-- 本地用户凭证 / 会话（refresh）/ 登录尝试（锁定+审计）。
-- 注意：totp_secret 暂明文存储，V2.16 敏感字段加密会统一覆盖（见 localauth.mjs 注释）。

CREATE TABLE IF NOT EXISTS local_credentials (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  actor_id TEXT NOT NULL REFERENCES actors(id),
  username TEXT NOT NULL,                    -- 租户内唯一
  password_hash TEXT NOT NULL,                -- scrypt 版本化格式（见 passwords.mjs）
  totp_secret TEXT,                           -- base32；totp_enabled=1 时必填
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cred_tenant_username ON local_credentials(tenant_id, username);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cred_tenant_actor ON local_credentials(tenant_id, actor_id);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,                        -- jti（access token 的 jti 与之对应）
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  actor_id TEXT NOT NULL REFERENCES actors(id),
  refresh_hash TEXT NOT NULL UNIQUE,          -- refresh token 的 sha256（库中不存明文）
  expires_at BIGINT NOT NULL,
  revoked_at BIGINT,
  ip TEXT,
  user_agent TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_actor ON auth_sessions(tenant_id, actor_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id),     -- 租户未解析时可空
  username TEXT NOT NULL,
  success INTEGER NOT NULL,                   -- 1 成功 / 0 失败
  ip TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(tenant_id, username, created_at);
