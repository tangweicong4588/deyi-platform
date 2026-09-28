#!/usr/bin/env bash
# deploy/backup/restore-pg.sh —— V2.18：PostgreSQL 备份恢复。
#
# 把 backup-pg.sh 产出的 .dump 恢复到目标库。默认要求目标库为空（防误覆盖），
# 用 --force 可跳过空库检查（仍会二次确认，除非 --yes）。
#
# 用法：
#   PGHOST=db PGUSER=deyi PGDATABASE=deyi_restored PGPASSWORD=... \
#     ./deploy/backup/restore-pg.sh /backups/deyi-pg-20260928-020000.dump [--force] [--yes]
#   DRY_RUN=1 ./deploy/backup/restore-pg.sh <dump>   # 只打印命令
#
# 恢复后必须跑 verify-backup.sh 做完整性校验（恢复到临时库 → verifyChain 烟雾）。
set -euo pipefail

DUMP="${1:?用法: restore-pg.sh <dump文件> [--force] [--yes]}"
FORCE=0; YES=0
for a in "$@"; do
  [[ "$a" == "--force" ]] && FORCE=1
  [[ "$a" == "--yes" ]] && YES=1
done
: "${PGDATABASE:?必须设置 PGDATABASE（恢复目标库）}"
: "${PGUSER:?必须设置 PGUSER}"
[[ -f "${DUMP}" ]] || { echo "备份文件不存在: ${DUMP}" >&2; exit 1; }

run() {
  if [[ "${DRY_RUN:-0}" == "1" ]]; then echo "[dry-run] $*"; else "$@"; fi
}

# 1. 校验 sha256（与 .dump 同目录的 .sha256）
if [[ -f "${DUMP}.sha256" ]]; then
  echo "校验备份完整性..."
  run sha256sum -c "${DUMP}.sha256"
else
  echo "警告: 未找到 ${DUMP}.sha256，跳过完整性校验" >&2
fi

# 2. 空库检查
if [[ "${FORCE}" != "1" ]]; then
  TABLES="$(PGDATABASE="${PGDATABASE}" psql -tA -c "SELECT count(*) FROM pg_tables WHERE schemaname='public';" 2>/dev/null || echo "?")"
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    echo "[dry-run] psql -tA -c \"SELECT count(*) FROM pg_tables WHERE schemaname='public';\""
  elif [[ "${TABLES}" != "0" ]]; then
    echo "目标库 ${PGDATABASE} 非空（${TABLES} 张表），拒绝恢复。用 --force 显式覆盖。" >&2
    exit 1
  fi
  echo "目标库为空，继续。"
fi

# 3. 二次确认
if [[ "${YES}" != "1" && "${DRY_RUN:-0}" != "1" ]]; then
  read -r -p "确认恢复 ${DUMP} 到库 ${PGDATABASE}？(yes/no) " ans
  [[ "${ans}" == "yes" ]] || { echo "已取消"; exit 0; }
fi

# 4. 恢复（单事务，失败整体回滚）。
# 注意：pg_restore 不允许 --single-transaction 与 --jobs 并用（PG 16 实测：
# "cannot specify both --single-transaction and multiple jobs"）。
# 原子恢复语义优先于并行速度，故只保留 --single-transaction；超大库如需并行，
# 应拆分为"先并行恢复到暂存库、校验通过后再切换"的两阶段流程（见 runbook）。
echo "开始恢复..."
run pg_restore --dbname="${PGDATABASE}" --single-transaction --verbose "${DUMP}" 2>&1 | tail -5
echo "恢复完成。下一步：./deploy/backup/verify-backup.sh --pg <(目标库连接串)> 做完整性校验。"
