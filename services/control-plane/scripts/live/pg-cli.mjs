// scripts/live/pg-cli.mjs —— live 脚本共用的 psql 调用封装。
// 用环境变量解耦本机临时路径：
//   PG_CLI       psql 可执行文件路径（默认 PATH 中的 psql；本联调机可用 /tmp/pg-bin/pg-bin/bin/psql）
//   PG_LD_PATH   psql 需要的 LD_LIBRARY_PATH（pgserver wheel 场景）
//   DATABASE_URL 标准连接串（默认 postgres://deyi:deyi@127.0.0.1:5432/deyi）
// 不再把 /tmp/pg-bin 这类 VM 临时路径写死在各个脚本里。
import { execSync } from 'node:child_process';

const PSQL = process.env.PG_CLI || 'psql';
const DB = process.env.DATABASE_URL || 'postgres://deyi:deyi@127.0.0.1:5432/deyi';

export function pgQuery(sql) {
  const env = process.env.PG_LD_PATH ? `LD_LIBRARY_PATH=${process.env.PG_LD_PATH} ` : '';
  const esc = sql.replace(/"/g, '\\"');
  return execSync(`${env}${PSQL} "${DB}" -tA -c "${esc}"`, { encoding: 'utf8' }).trim();
}
