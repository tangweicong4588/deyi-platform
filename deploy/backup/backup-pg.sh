#!/usr/bin/env bash
# deploy/backup/backup-pg.sh —— V2.18：PostgreSQL 全量逻辑备份。
#
# 策略：每日 pg_dump 自定义格式全量（--format=custom），附 sha256 校验文件；
# 配合 WAL 归档实现时间点恢复（PITR），见文件底部"WAL 说明"。
#
# 用法：
#   PGHOST=db PGUSER=deyi PGDATABASE=deyi PGPASSWORD=... \
#     ./deploy/backup/backup-pg.sh [--dir /backups] [--retention-days 30]
#   DRY_RUN=1 ./deploy/backup/backup-pg.sh   # 只打印将执行的命令，不执行
#
# 环境变量（标准 libpq）：PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD
set -euo pipefail

BACKUP_DIR="${1:-}"
RETENTION_DAYS=30
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) BACKUP_DIR="$2"; shift 2 ;;
    --retention-days) RETENTION_DAYS="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
BACKUP_DIR="${BACKUP_DIR:-${BACKUP_DIR_ENV:-/backups}}"
: "${PGDATABASE:?必须设置 PGDATABASE}"
: "${PGUSER:?必须设置 PGUSER}"

STAMP="$(date +%Y%m%d-%H%M%S)"
BASE="deyi-pg-${STAMP}"
DUMP="${BACKUP_DIR}/${BASE}.dump"

run() {
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

echo "备份目标: ${DUMP}"
run mkdir -p "${BACKUP_DIR}"
# 自定义格式全量备份（含 schema + 数据；恢复用 pg_restore，见 restore-pg.sh）
run pg_dump --format=custom --compress=6 --file="${DUMP}"
# 完整性校验文件（恢复前/恢复后都可核对）
if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "[dry-run] sha256sum ${DUMP} > ${DUMP}.sha256"
else
  sha256sum "${DUMP}" > "${DUMP}.sha256"
fi
echo "备份完成: ${DUMP}"
echo "sha256: $( [[ "${DRY_RUN:-0}" == "1" ]] && echo '<dry-run>' || cut -d' ' -f1 < "${DUMP}.sha256" )"

# 过期清理（保留最近 N 天）
if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "[dry-run] find ${BACKUP_DIR} -name 'deyi-pg-*.dump*' -mtime +${RETENTION_DAYS} -delete"
else
  find "${BACKUP_DIR}" -name 'deyi-pg-*.dump*' -mtime +"${RETENTION_DAYS}" -delete || true
  echo "已清理 ${RETENTION_DAYS} 天前的旧备份"
fi

cat <<'WAL_NOTE'

---- WAL 说明（时间点恢复 PITR）----
逻辑备份只能恢复到"备份时刻"。要做到 RPO≈0（任意时间点恢复），需要：
  1. postgresql.conf：wal_level=replica（PG14+ 用 replica），archive_mode=on，
     archive_command='test ! -f /wal-archive/%f && cp %p /wal-archive/%f'
  2. 定期 base backup（pg_basebackup 或本脚本的逻辑备份作为基线）。
  3. 恢复：基线恢复后 replay WAL 到目标时间点（recovery_target_time）。
云环境建议直接用云厂商的自动备份 + PITR（RDS/Cloud SQL），本脚本的逻辑
备份作为第二道防线（跨云/离线可恢复）。
WAL_NOTE
