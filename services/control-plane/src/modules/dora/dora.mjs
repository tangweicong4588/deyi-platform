/**
 * modules/dora/dora.mjs —— V3.6 研发效能度量（DORA 四指标）。
 *
 * 数据源（全部为平台已有真相源，不新增采集）：
 * - releases（V3.2）：发布单状态机；终态时刻取 updated_at（每次状态迁移都会刷新，
 *   终态行的 updated_at 即部署结束时刻；口径见 docs/dora-metrics.md）
 * - change_packages（V1.0）：变更包创建时间（前置时间的起点）
 * - deploy_environments：环境维度过滤
 *
 * 口径版本：dora-v1（docs/dora-metrics.md）。
 */
import { Errors } from '../../kernel/errors.mjs';
import { db } from '../../db/index.mjs';

export const DORA_VERSION = 'dora-v1';
const TERMINAL = ['succeeded', 'failed', 'rolled_back'];
const FAILED = new Set(['failed', 'rolled_back']);

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
// nearest-rank p90
const p90 = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)];
};
const hours = (ms) => ms / 3600000;

/**
 * 计算 DORA 四指标。
 * @param {string} tenantId
 * @param {string|null} projectId —— null = 租户级聚合（池化该租户全部项目）
 * @param {object} opts { from, to, environmentId }
 */
export async function computeDora({ tenantId, projectId = null, from = null, to = null, environmentId = null }) {
  const now = Date.now();
  const wTo = to ?? now;
  const wFrom = from ?? (wTo - 30 * 86400000);
  if (!(wFrom < wTo)) throw Errors.badRequest('from 必须早于 to');
  if (projectId) {
    const pj = (await db().query('SELECT id FROM projects WHERE id=? AND tenant_id=?', [projectId, tenantId]))[0];
    if (!pj) throw Errors.notFound('项目不存在');
  }
  const scopeSql = projectId ? 'AND r.project_id=?' : '';
  const scopeParams = projectId ? [projectId] : [];
  const envSql = environmentId ? 'AND r.environment_id=?' : '';
  const envParams = environmentId ? [environmentId] : [];

  // 窗口内终态发布单（按终态时刻 updated_at 落窗）
  const rels = await db().query(
    `SELECT r.id, r.project_id, r.environment_id, r.status, r.change_package_id, r.updated_at,
            cp.created_at AS cp_created_at
     FROM releases r LEFT JOIN change_packages cp ON cp.id = r.change_package_id
     WHERE r.tenant_id=? ${scopeSql} ${envSql}
       AND r.status IN (${TERMINAL.map(() => '?').join(',')})
       AND r.updated_at >= ? AND r.updated_at < ?
     ORDER BY r.updated_at`,
    [tenantId, ...scopeParams, ...envParams, ...TERMINAL, wFrom, wTo],
  );

  const windowDays = (wTo - wFrom) / 86400000;
  const succeeded = rels.filter((r) => r.status === 'succeeded');
  const failed = rels.filter((r) => FAILED.has(r.status));

  // 1. 部署频率：窗口内成功部署数 / 窗口天数
  const deployment_frequency = {
    count: succeeded.length,
    window_days: Math.round(windowDays * 100) / 100,
    per_day: Math.round((succeeded.length / windowDays) * 100) / 100,
  };

  // 2. 变更前置时间：succeeded 发布单（关联变更包）终态时刻 - 变更包创建时间
  const leadSamples = [];
  let excluded_no_change_package = 0;
  for (const r of succeeded) {
    if (r.change_package_id && r.cp_created_at != null) {
      leadSamples.push(hours(r.updated_at - r.cp_created_at));
    } else {
      excluded_no_change_package++;
    }
  }
  const lead_time = {
    median_hours: median(leadSamples) == null ? null : Math.round(median(leadSamples) * 100) / 100,
    p90_hours: p90(leadSamples) == null ? null : Math.round(p90(leadSamples) * 100) / 100,
    count: leadSamples.length,
    excluded_no_change_package,
  };

  // 3. 变更失败率：失败部署 / 全部终态部署
  const change_failure_rate = {
    rate: rels.length ? Math.round((failed.length / rels.length) * 10000) / 10000 : 0,
    failed: failed.length,
    total: rels.length,
  };

  // 4. 恢复时间：每次失败 → 同项目+环境下一次成功部署的时长中位数
  const restoreSamples = [];
  let unrecovered = 0;
  for (const f of failed) {
    const rec = await db().query(
      `SELECT updated_at FROM releases
       WHERE tenant_id=? AND project_id=? AND environment_id=?
         AND status='succeeded' AND updated_at > ?
       ORDER BY updated_at LIMIT 1`,
      [tenantId, f.project_id, f.environment_id, f.updated_at],
    );
    if (rec[0]) restoreSamples.push(hours(rec[0].updated_at - f.updated_at));
    else unrecovered++;
  }
  const restoreMedian = median(restoreSamples);
  const time_to_restore = {
    median_hours: restoreMedian == null ? null : Math.round(restoreMedian * 100) / 100,
    count: restoreSamples.length,
    unrecovered,
  };

  return {
    methodology: DORA_VERSION,
    window: { from: wFrom, to: wTo },
    scope: { tenant_id: tenantId, project_id: projectId, environment_id: environmentId },
    deployment_frequency,
    lead_time,
    change_failure_rate,
    time_to_restore,
  };
}
