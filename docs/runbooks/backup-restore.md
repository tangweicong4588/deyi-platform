# 备份与恢复（backup-restore）——V2.18

备份优先级：**PostgreSQL > 对象存储/数据卷 > Qdrant**（Qdrant 是派生索引，可重建）。

## 1. PostgreSQL（真相源，必须备份）

### 1.1 每日全量逻辑备份

```bash
PGHOST=<db-host> PGUSER=deyi PGDATABASE=deyi PGPASSWORD=<secret> \
  ./deploy/backup/backup-pg.sh --dir /backups --retention-days 30
```

- 产物：`deyi-pg-YYYYMMDD-HHMMSS.dump`（pg_dump 自定义格式）+ 同名 `.sha256` 完整性文件。
- 保留：默认 30 天（`--retention-days` 可调；建议每周全量另存 12 周，按等保/客户合同调整）。
- 演练前检查：`DRY_RUN=1 ./deploy/backup/backup-pg.sh` 只打印命令不执行。

### 1.2 WAL 与时间点恢复（PITR）

逻辑备份只能恢复到"备份时刻"。RPO≈0 需要 WAL 归档：

```ini
# postgresql.conf
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /wal-archive/%f && cp %p /wal-archive/%f'
```

恢复时：基线（逻辑备份或 `pg_basebackup`）+ replay WAL 到 `recovery_target_time`。
云环境建议直接用云厂商自动备份 + PITR（RDS/Cloud SQL），本脚本的逻辑备份作为
第二道防线（跨云/离线可恢复）。

### 1.3 恢复

```bash
# 恢复到目标库（默认要求目标库为空，防误覆盖）
PGHOST=<db-host> PGUSER=deyi PGDATABASE=deyi_restored PGPASSWORD=<secret> \
  ./deploy/backup/restore-pg.sh /backups/deyi-pg-20260928-020000.dump
```

- 先校验 `.sha256`，再 `pg_restore --single-transaction`（失败整体回滚）。
- 恢复后**必须**跑完整性校验（下一节），再上线。

## 2. 备份完整性校验（恢复到临时库 → verifyChain 烟雾）

```bash
# PG：自动建临时库 → 恢复 → 逐租户审计链校验 → 销毁临时库
PGHOST=<db-host> PGUSER=deyi PGPASSWORD=<secret> \
  ./deploy/backup/verify-backup.sh --pg /backups/deyi-pg-20260928-020000.dump

# SQLite（开发/测试）：拷贝到临时文件 → 同样校验
./deploy/backup/verify-backup.sh --sqlite /path/to/app.db
```

底层是 `services/control-plane/scripts/backup-verify.mjs`：
对每个租户跑 `verifyChain`（哈希链逐段验签）+ 计量表计数 sanity；
任何租户链断裂即 exit 1，备份视为不可用。**校验通过才认为备份"可恢复"。**

校验频率：每次恢复演练必跑；建议备份任务成功后抽样跑（每周至少一次）。

## 3. 单租户恢复

场景：某租户误删数据 / 需要把租户迁到另一个环境。不需要全库恢复。

```bash
cd services/control-plane
# 1. 从"备份恢复出的临时库"导出该租户（不要直接对在线库做长事务导出）
SQLITE_PATH=/tmp/restored.db node scripts/tenant-export.mjs \
  --tenant <tenantId> --out /tmp/tenant-<tenantId>

# 2. 导入目标库（幂等：已存在行跳过，可重复跑）
SQLITE_PATH=/path/to/live.db node scripts/tenant-import.mjs \
  --tenant <tenantId> --in /tmp/tenant-<tenantId>

# 3. 校验
node scripts/backup-verify.mjs --db /path/to/live.db
```

- 导出表顺序与 `offboard` 共用同一拓扑（`TABLE_DELETE_ORDER` 逆序，父表在前），
  新增表只要进了 offboard 拓扑就会被覆盖。
- 导出内容含 `audit_events` / `billing_invoices` / `anchors`（offboard 不删它们，
  但恢复时需要）。
- `tenants` 行已存在时保留目标库现有行（不覆盖在线状态）。

## 4. Qdrant（派生索引，可重建）

```bash
curl -X POST http://<qdrant-host>:6333/collections/deyi_knowledge/snapshots
# 快照在 /qdrant/storage/snapshots（随 qdrantdata 卷）
```

- Qdrant 丢了**不丢数据**：从 PG 的 `documents`/`canonical_docs` 重跑入库即可重建
  （`services/control-plane/scripts/rebuild-qdrant.mjs`）。
- 记忆向量索引同理：`scripts/rebuild-memory-index.mjs`。
- 因此 Qdrant 快照是"加速恢复"手段；`qdrantdata` 卷建议仍进卷备份。

## 5. 数据卷与密钥

- compose：命名卷 `pgdata` / `qdrantdata`，用卷备份工具或宿主机快照定期备份。
- k8s：Postgres/Qdrant 用 PVC，用云盘快照或 Velero 按 PVC 备份。
- 密钥（`.env` / k8s Secret / LiteLLM provider key / `FIELD_ENCRYPTION_KEY`）：
  由外部密钥管理（Vault/云 KMS）保管，**备份恢复演练必须包含密钥可取回验证**，
  否则数据可恢复但服务起不来。注意：`FIELD_ENCRYPTION_KEY` 丢失 = 加密字段永久不可读，
  它不进数据库备份，必须单独保管。

## 6. 恢复演练

- 每季度一次全流程演练：备份 → 恢复到隔离环境 → `verify-backup.sh` →
  `curl /readyz` + 抽查租户登录 → 记录演练报告。
- 每月一次单租户恢复演练（export/import 到临时库）。
- 演练报告模板：日期 / 备份文件 / 恢复耗时 / 校验结果 / RTO 实测 / 问题记录。

## 诚实边界

- 开发机无 PostgreSQL：`backup-pg.sh` / `restore-pg.sh` / `verify-backup.sh --pg`
  已通过 shellcheck（0.10.0，无 warning）+ `bash -n` + `DRY_RUN=1` 验证，
  **未在真实 PG 上演练**，上线前必须在 staging 跑一次真实恢复。
- SQLite 级备份恢复流程已有自动化测试（`tests/backup-restore.test.mjs`，4 项全绿）。
