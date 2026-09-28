/**
 * tests/isolation-manifest.mjs —— V2.19：租户隔离 sweep 清单。
 *
 * 新模块上线必须在此登记（module 名），并在 tests/tenant-isolation.test.mjs
 * 中实现对应的跨租户断言；`manifest 完整性` 测试会强制执行：
 * 清单中的每个 module 在 sweep 中至少有一个用例，缺失即失败。
 */
export const ISOLATION_MANIFEST = [
  { module: 'projects', note: '项目列表/详情：A 租户 token 读不到 B 的项目' },
  { module: 'knowledge', note: '知识文档列表/检索：跨租户项目 403' },
  { module: 'tasks', note: '业务任务列表/详情/成本：跨租户项目 403' },
  { module: 'memory', note: '记忆 recall：跨租户 403（tenantScope）' },
  { module: 'artifacts', note: '制品包列表：跨租户项目 403' },
  { module: 'releases', note: '发布列表：跨租户项目 403' },
  { module: 'billing', note: '账单：/v1/tenants/:tenantId/billing 跨租户 403' },
  { module: 'notify', note: '通知通道：跨租户 403（tenantScope）' },
  { module: 'admin-platform', note: '运营面 API：租户 key（非 operator）一律拒绝' },
  { module: 'positive-control', note: '正向对照：B 读自己 200；operator 读 B 200' },
  { module: 'mutation', note: 'mutation 验证：故意绕过 tenantScope，sweep 必须抓到' },
];
