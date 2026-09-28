-- 020_notify.sql —— V2.1-C：通知通道（SaaS 运营面）
-- 密钥铁律：secret_ref 只存引用（env:VAR_NAME / vault:xxx），永不存明文密钥；
-- 真正的密钥材料只从环境变量或 vault 解析，发送时即时读取。
CREATE TABLE notify_channels (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  kind TEXT NOT NULL,              -- 'webhook'（首批真实通道）
  name TEXT NOT NULL,
  target TEXT NOT NULL,           -- webhook URL（非密钥）
  secret_ref TEXT,                -- env:VAR / vault:xxx；NULL=不签名
  status TEXT NOT NULL DEFAULT 'active',  -- active|disabled
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(tenant_id, name)
);
CREATE INDEX idx_notify_channels_tenant ON notify_channels(tenant_id, status);

-- 投递账本：每条通知的投递轨迹（运营可见），与审计链配合
CREATE TABLE notify_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  channel_id TEXT REFERENCES notify_channels(id),
  intent TEXT NOT NULL,           -- reconciliation.escalated / notify.test ...
  payload TEXT NOT NULL,         -- JSON（已脱敏，不含密钥材料）
  status TEXT NOT NULL,          -- queued|sent|failed|skipped
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX idx_notify_deliveries_tenant ON notify_deliveries(tenant_id, created_at);
