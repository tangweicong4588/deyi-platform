-- 023_identity_keys.sql —— V2.5：API Key 轮换链路。
-- rotated_to：旧 key → 新 key 的 id（轮换审计链）；rotated_at：轮换发生时间。
-- 宽限期通过复用 expires_at 实现（轮换时设为 now+grace，旧 key 到期自动失效，
-- verifyApiKey 本就检查 expires_at），无需新状态。
ALTER TABLE api_keys ADD COLUMN rotated_to TEXT;
ALTER TABLE api_keys ADD COLUMN rotated_at INTEGER;
