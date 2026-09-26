# 备份与恢复（backup-restore）

备份优先级：**PostgreSQL > 对象存储/数据卷 > Qdrant**（Qdrant 是派生索引，可重建）。

## 1. PostgreSQL（真相源，必须备份）

```bash
# 逻辑备份（每日）
docker compose exec postgres pg_dump -U deyi deyi | gzip > deyi-$(date +%F).sql.gz

# k8s
kubectl -n deyi exec deploy/postgres -- pg_dump -U deyi deyi | gzip > deyi-$(date +%F).sql.gz
```

- 保留策略：每日全量保留 30 天，每周全量保留 12 周（按等保/客户合同调整）。
- 恢复演练：每季度一次，在隔离环境 `gunzip | psql` 恢复并跑 `curl /readyz` +
  抽查租户登录，记录演练报告。
- 云环境优先用云厂商的自动备份 + 时间点恢复（PITR），逻辑备份作为第二道。

## 2. Qdrant（派生索引，可重建）

```bash
# 快照（collection 名见 knowledge 模块，默认 deyi_knowledge）
curl -X POST http://<qdrant-host>:6333/collections/deyi_knowledge/snapshots
# 快照文件在 /qdrant/storage/snapshots（随 qdrantdata 卷）
```

- Qdrant 丢了**不丢数据**：从 PG 的 `documents/canonical_docs` 重跑入库即可重建。
- 因此 Qdrant 快照是"加速恢复"手段，不是必须；`qdrantdata` 卷建议还是进卷备份。

## 3. 数据卷

- compose：命名卷 `pgdata` / `qdrantdata`（`docker volume ls`），用卷备份工具
  或宿主机快照定期备份。
- k8s：Postgres/Qdrant 用 PVC（`volumeClaimTemplates`），用云盘快照或 Velero
  按 PVC 备份。RPO 按客户 SLA 定（建议 ≤24h）。

## 4. 密钥

- `.env` / k8s Secret `deyi-secrets` / LiteLLM 的 provider key：由外部密钥管理
  （Vault/云 KMS）托管，备份其访问策略，不要把明文 key 和数据备份放一起。
- 轮换：`LITELLM_MASTER_KEY`、`OPERATOR_TOKEN`、`POSTGRES_PASSWORD` 每 90 天
  轮换一次；轮换后滚动重启相关服务。

## 5. 恢复步骤（灾难场景）

1. 恢复 PostgreSQL（PITR 或逻辑备份）。
2. `docker compose up -d` / `kubectl apply -k` 拉起全栈。
3. `curl /readyz` 确认 `postgresql(live)`，其余 adapters 按 operations.md 处理。
4. 如 Qdrant 数据丢了：重跑各项目文档入库（或从 Qdrant 快照恢复）。
5. 用 tenant-onboarding.md 的验证步骤抽查一个租户的模型调用。
