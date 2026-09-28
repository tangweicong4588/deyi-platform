#!/usr/bin/env bash
# deploy/backup/verify-backup.sh —— V2.18：备份完整性校验（一键）。
#
# 流程：备份文件 → 恢复到临时库 → node scripts/backup-verify.mjs（逐租户 verifyChain）
#       → 销毁临时库。校验通过才认为备份"可恢复"。
#
# 用法（PG）：
#   PGHOST=db PGUSER=deyi PGPASSWORD=... \
#     ./deploy/backup/verify-backup.sh --pg /backups/deyi-pg-20260928-020000.dump
# 用法（SQLite 开发/测试）：
#   ./deploy/backup/verify-backup.sh --sqlite /path/to/app.db
# DRY_RUN=1 只打印命令。
set -euo pipefail

MODE=""; DUMP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pg) MODE="pg"; DUMP="$2"; shift 2 ;;
    --sqlite) MODE="sqlite"; DUMP="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
[[ -n "${MODE}" && -n "${DUMP}" ]] || { echo "用法: verify-backup.sh --pg <dump> | --sqlite <db文件>" >&2; exit 2; }
[[ -f "${DUMP}" ]] || { echo "文件不存在: ${DUMP}" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CP_DIR="$(cd "${SCRIPT_DIR}/../../services/control-plane" && pwd)"

run() {
  if [[ "${DRY_RUN:-0}" == "1" ]]; then echo "[dry-run] $*"; else "$@"; fi
}

if [[ "${MODE}" == "sqlite" ]]; then
  TMPDB="$(mktemp /tmp/deyi-verify-XXXXXX.db)"
  trap 'rm -f "${TMPDB}"' EXIT
  echo "恢复备份到临时库: ${TMPDB}"
  run cp "${DUMP}" "${TMPDB}"
  echo "运行完整性校验..."
  run node "${CP_DIR}/scripts/backup-verify.mjs" --db "${TMPDB}"
  echo "校验通过（临时库已清理）。"
else
  : "${PGUSER:?必须设置 PGUSER}"; : "${PGHOST:?必须设置 PGHOST}"
  TMPDB="deyi_verify_$(date +%s)"
  echo "创建临时库 ${TMPDB} 并恢复..."
  run psql -c "CREATE DATABASE \"${TMPDB}\";"
  # shellcheck disable=SC2064
  trap "run psql -c \"DROP DATABASE IF EXISTS \\\"${TMPDB}\\\";\"" EXIT
  PGDATABASE="${TMPDB}" run "${SCRIPT_DIR}/restore-pg.sh" "${DUMP}" --force --yes
  echo "运行完整性校验..."
  PGDATABASE="${TMPDB}" run env DATABASE_URL="postgres://${PGUSER}:${PGPASSWORD:-}@${PGHOST}:${PGPORT:-5432}/${TMPDB}" \
    node "${CP_DIR}/scripts/backup-verify.mjs"
  echo "校验通过（临时库已销毁）。"
fi
