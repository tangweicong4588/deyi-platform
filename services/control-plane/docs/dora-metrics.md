# DORA 研发效能度量口径（dora-v1）

> 对应实现：`src/modules/dora/dora.mjs`；报表 API：`GET /v1/projects/:projectId/dora`、
> `GET /v1/admin/dora`。前端 F3 消费。

## 数据源

| 指标 | 真相源 |
|---|---|
| 部署频率 / 变更失败率 / 恢复时间 | `releases`（V3.2 发布单状态机） |
| 变更前置时间起点 | `change_packages.created_at`（V1.0） |
| 环境过滤 | `deploy_environments` |

**终态时刻口径**：发布单每次状态迁移都会刷新 `releases.updated_at`，
终态行（succeeded/failed/rolled_back）的 `updated_at` 即部署结束时刻。
非终态（draft/pending_approval/approved/deploying）不计入任何指标。

## 四指标定义

### 1. 部署频率（deployment_frequency）

- `count`：窗口内 `status='succeeded'` 的发布单数（按 `updated_at` 落窗）。
- `per_day`：`count / window_days`（保留 2 位小数）。
- `window_days`：`(to - from) / 86400000`，保留 2 位小数。

### 2. 变更前置时间（lead_time，小时）

- 样本：窗口内 succeeded 发布单中**关联了变更包**的，
  样本值 = `releases.updated_at - change_packages.created_at`（换算小时）。
- `median_hours`：样本中位数；`p90_hours`：nearest-rank p90
  （`sorted[ceil(0.9·n)-1]`）；均保留 2 位小数。
- `count`：有效样本数；`excluded_no_change_package`：未关联变更包被排除的成功发布数
  （如实披露，不静默丢弃）。

### 3. 变更失败率（change_failure_rate）

- `failed`：窗口内 `status IN ('failed','rolled_back')` 的发布单数
  （回滚视为失败，与 DORA 原定义一致）。
- `total`：窗口内全部终态发布单数（succeeded+failed+rolled_back）。
- `rate`：`failed / total`（保留 4 位小数）；窗口内无终态发布时为 0。

### 4. 恢复时间（time_to_restore，小时）

- 对窗口内每个失败发布单（failed/rolled_back），找**同一项目+同一环境**下
  其 `updated_at` 之后的第一条 succeeded 发布单，
  样本值 = 两者 `updated_at` 之差（小时）。
- `median_hours`：样本中位数（2 位小数）；`count`：有效样本数。
- `unrecovered`：窗口内失败但其后无成功恢复的发布数（如实披露）。

## 窗口与聚合

- `from`/`to` 为毫秒时间戳；缺省为最近 30 天（`to=now, from=now-30d`）；
  `from >= to` 时 400。
- 项目级：`GET /v1/projects/:projectId/dora`（viewer+）。
- 租户级：`GET /v1/admin/dora?tenant_id=`（平台 operator），池化该租户全部项目的发布单后
  按同一口径计算（中位数等不可加性指标不做按项目平均，直接池化原始样本）。
- `environment_id` 可选过滤（项目级与租户级均支持）。

## 诚实边界

- 前置时间依赖发布单关联变更包（`change_package_id` 可为空）；未关联的不参与计算，
  以 `excluded_no_change_package` 明示。
- 恢复时间的"恢复"指同一环境下一次成功部署，不感知业务健康检查之外的真实流量恢复。
- 本口径为 v1；口径变更时 `methodology` 字段升级（如 `dora-v2`），旧报表不可比。
