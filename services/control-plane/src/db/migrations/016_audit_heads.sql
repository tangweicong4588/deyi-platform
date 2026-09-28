-- 016_audit_heads.sql —— Review-R6 L-11：审计尾部截断检测。
-- 哈希链能发现中间事件被删（prev_hash 断裂），但发现不了"尾部整段被删"
-- （删掉最后 N 条后链依然自洽）。audit_heads 在每次 append 的同一事务里
-- 记录各租户的链头（head_seq/head_hash）；验链时比对，尾部截断即现形。
-- 注：防的是运维事故/部分恢复/程序 bug，不是恶意 DBA（恶意写库者连检查点
-- 也能改；防恶意篡改需要外部锚定，见 docs/runbooks/audit-failure.md）。
CREATE TABLE IF NOT EXISTS audit_heads (
  tenant_id TEXT PRIMARY KEY,
  head_seq INTEGER NOT NULL,
  head_hash TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
-- 存量数据回填检查点
INSERT INTO audit_heads(tenant_id, head_seq, head_hash, updated_at)
SELECT tenant_id, MAX(seq),
  (SELECT hash FROM audit_events e2 WHERE e2.tenant_id=e.tenant_id ORDER BY seq DESC LIMIT 1),
  MAX(created_at)
FROM audit_events e
GROUP BY tenant_id
ON CONFLICT(tenant_id) DO NOTHING;
