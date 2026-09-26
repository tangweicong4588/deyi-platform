-- 014_grant_holder.sql —— V2.0 安全 review H-2：credential grant 绑定持有人。
-- 之前 grant 只记 created_by（签发人），执行时不校验"谁在用"，拿到 grantId 的
-- 任意主体都能消费。新增 granted_to（持有人），执行时必须与当前 actor 一致。
ALTER TABLE credential_grants ADD COLUMN granted_to TEXT REFERENCES actors(id);
CREATE INDEX IF NOT EXISTS idx_grant_holder ON credential_grants(granted_to, status);
