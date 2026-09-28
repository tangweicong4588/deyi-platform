# RPO / RTO 承诺——V2.18

> RPO（恢复点目标）：最多丢多少数据。RTO（恢复时间目标）：多长时间恢复服务。
> 以下为平台默认承诺，客户合同可单独约定（私有化部署按客户基础设施调整）。

## 1. 默认承诺

| 层级 | RPO | RTO | 手段 |
|---|---|---|---|
| PostgreSQL（真相源），WAL 归档开启 | ≤ 5 分钟 | ≤ 4 小时 | 每日逻辑全量 + WAL 连续归档 + PITR |
| PostgreSQL，仅逻辑备份 | ≤ 24 小时 | ≤ 4 小时 | 每日逻辑全量（`deploy/backup/backup-pg.sh`） |
| Qdrant 向量索引 | 不适用（派生数据） | ≤ 8 小时 | 快照加速；最坏从 PG 重建（`rebuild-qdrant.mjs` / `rebuild-memory-index.mjs`） |
| 对象存储 / 数据卷（制品 blob 等） | ≤ 24 小时 | ≤ 4 小时 | 卷快照 / Velero（随 PG 恢复验证） |
| 单租户数据误删 | ≤ 24 小时（取最近备份） | ≤ 2 小时 | `tenant-export` / `tenant-import`（不需全库恢复） |

## 2. 承诺成立的前提（任一不满足则承诺降级）

1. 备份任务每日成功执行且 `.sha256` 校验通过（监控告警覆盖备份失败）。
2. WAL 归档链连续（`archive_command` 无失败；断档则 RPO 退化为"上次成功备份时刻"）。
3. 密钥可取回：`FIELD_ENCRYPTION_KEY` / DB 密码 / provider key 在 Vault/云 KMS 中可用。
   密钥丢失不在 RPO/RTO 承诺内（加密字段不可恢复）。
4. 恢复演练按季度执行且上次演练通过（演练报告见 backup-restore runbook §6）。

## 3. 不承诺事项

- 备份保留期外的数据（默认 30 天，超期备份已清理）。
- retention 策略已清扫的数据（审计/计量明细按保留期删除是**预期行为**，不是数据丢失）。
- Qdrant 快照缺失时的向量检索即时可用性（数据不丢，但重建需要时间，见上表 RTO）。
- 客户自管基础设施（私有化）上的备份执行：平台提供脚本与手册，执行责任在客户运维。

## 4. 与账单/合规的衔接

- 恢复演练中如涉及生产数据恢复，需先做合规导出留存（`compliance/export`），
  恢复动作本身记审计（`backup.restore` action）。
- RPO 窗口内丢失的计量明细（model_calls）会影响该账期账单精度：
  恢复后用 `cost/breakdown` 的 `detail_archived` 标注向客户说明。
