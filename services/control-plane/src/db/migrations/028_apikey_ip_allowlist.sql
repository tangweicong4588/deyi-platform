-- 028_apikey_ip_allowlist.sql —— V2.14 API Key 使用限制：IP 白名单 + 用途备注。
-- ip_allowlist：JSON 数组，元素为 IPv4 CIDR/单 IP 或 IPv6 单 IP；空数组 = 不限制
-- （历史 key 默认 '[]'，向后兼容，不受影响）。
-- note：用途备注（纯展示，不参与鉴权）。
ALTER TABLE api_keys ADD COLUMN ip_allowlist TEXT NOT NULL DEFAULT '[]';
ALTER TABLE api_keys ADD COLUMN note TEXT;
