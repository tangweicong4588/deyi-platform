-- 015_usage_outbox.sql —— Review-R6 M-16：计量失败不把上游成功改写成 500。
-- 上游模型调用已成功（token 已在 provider 侧消费）时，本地记账失败是平台内部问题；
-- 此时应返回成功给调用方，并把记账载荷写入 outbox，等待补记（reconcile）。
CREATE TABLE IF NOT EXISTS gateway_usage_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,   -- persistUsage 的全部记账参数
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at BIGINT NOT NULL,
  processed_at BIGINT          -- 补记成功后置时间；NULL=待处理
);
CREATE INDEX IF NOT EXISTS idx_usage_outbox_pending
  ON gateway_usage_outbox(processed_at, created_at);
