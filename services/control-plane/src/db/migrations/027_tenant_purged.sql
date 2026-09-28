-- 027_tenant_purged.sql —— V2.12 租户 offboard：记录销户时间。
-- 销户后 tenants 行保留（账单/锚定外键 + 合规），status='purged'，name/slug 脱敏。
ALTER TABLE tenants ADD COLUMN purged_at BIGINT;
