-- 038_field_encryption.sql —— V2.16：敏感字段落库加密。
-- totp_secret（local_credentials）与 webhook secret（notify_channels）改存密文信封。
-- 旧明文列保留做 lazy 迁移（读时解密/迁移，写只写密文列）。

ALTER TABLE local_credentials ADD COLUMN totp_secret_enc TEXT;
ALTER TABLE notify_channels ADD COLUMN secret_enc TEXT;
