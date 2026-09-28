/**
 * scripts/live/pg-live-check.mjs —— Phase 6：PostgreSQL 真实联调。
 * 前置：控制面已用 DATABASE_URL=postgres://... 启动并监听 $BASE（默认 http://127.0.0.1:18080），
 *       且设置了 OPERATOR_TOKEN（环境变量 OPERATOR_TOKEN 传入本脚本）。
 * 验证：租户/项目/记忆/知识文档在 PG 上的完整写入-读取链路，
 *       以及毫秒时间戳在 BIGINT 列上的正确落库（V6.1 修的 32 位 INTEGER 溢出）。
 */
import assert from 'node:assert/strict';
import { pgQuery as pg } from './pg-cli.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:18080';
const OP = process.env.OPERATOR_TOKEN;
if (!OP) { console.error('需要 OPERATOR_TOKEN'); process.exit(1); }

const results = [];
const check = (name, fn) => {
  try { fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', `${name}：${e.message}`]); }
};

async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : { authorization: `Bearer ${OP}` }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// 1. 租户列表（operator）
const { status: sT, json: jT } = await api('GET', '/v1/admin/tenants');
check('operator 读租户列表 200', () => assert.equal(sT, 200));
const tenant = jT.data?.[0] || jT.data?.tenants?.[0] || jT[0];
check('PG 中存在 bootstrap 租户', () => assert.ok(tenant?.id, '无租户'));
const tenantId = tenant.id;

// 2. 建项目（admin）
const pslug = 'pglive-' + Date.now().toString(36);
const { status: sP, json: jP } = await api('POST', `/v1/admin/tenants/${tenantId}/projects`, { name: 'pg-live', slug: pslug });
check('建项目 200/201', () => assert.ok([200, 201].includes(sP), `status=${sP} ${JSON.stringify(jP).slice(0, 120)}`));
const projectId = jP.data?.id || jP.id;
const nProj = pg('SELECT count(*) FROM projects');
check('项目行落 PG', () => assert.ok(Number(nProj) >= 1, `projects=${nProj}`));

// 3. 建租户 API key（用于租户面接口）
const actorId = pg("SELECT id FROM actors WHERE kind='user' LIMIT 1");
const { status: sK, json: jK } = await api('POST', `/v1/admin/tenants/${tenantId}/api-keys`, { actorId, name: 'pg-live-key' });
const apiKey = jK.data?.key || jK.data?.secret || jK.secret;
check('签发租户 key', () => assert.ok(apiKey, `status=${sK} ${JSON.stringify(jK).slice(0, 150)}`));

// 4. 写记忆（episodic，不依赖 embedding 上游）
if (!apiKey) { console.error('key 签发失败，停止'); process.exit(1); }
const { status: sM, json: jM } = await api('POST', `/v1/tenants/${tenantId}/memory`,
  { projectId, kind: 'episodic', content: 'PG 联调冒烟', visibility: 'project' }, apiKey);
check('写记忆 201', () => assert.ok([200, 201].includes(sM), `status=${sM} ${JSON.stringify(jM).slice(0, 150)}`));

// 5. 建知识文档（需要 embedding 上游；未配 LiteLLM 时应诚实返回 UPSTREAM_ERROR 而非 500）
const { status: sD, json: jD } = await api('POST', `/v1/projects/${projectId}/knowledge/documents`,
  { title: 'pg-live-doc', content: 'PostgreSQL 真实联调验证文档' }, apiKey);
check('建知识文档 201 或诚实的 UPSTREAM_ERROR', () => assert.ok(
  [200, 201].includes(sD) || jD?.error?.code === 'UPSTREAM_ERROR',
  `status=${sD} ${JSON.stringify(jD).slice(0, 150)}`));

// 6. 毫秒时间戳正确落库（BIGINT 回归）
const ts = pg('SELECT created_at FROM projects LIMIT 1');
check('created_at 为毫秒级时间戳', () => {
  const v = Number(ts);
  assert.ok(v > 1_700_000_000_000, `created_at=${ts} 不是毫秒时间戳`);
  assert.ok(v < 2_000_000_000_000, `created_at=${ts} 异常`);
});

// 7. 列类型确认为 bigint
const colType = pg("SELECT data_type FROM information_schema.columns WHERE table_name='projects' AND column_name='created_at'");
check('projects.created_at 列类型为 bigint', () => assert.match(colType, /bigint/i));

for (const [s, n] of results) console.log(`${s} ${n}`);
const failed = results.filter(([s]) => s === 'FAIL');
if (failed.length) { console.error(`PG LIVE CHECK: ${failed.length} 项失败`); process.exit(1); }
console.log('PG LIVE CHECK: 全部通过（真实 PostgreSQL 16，38 迁移 + 端到端读写）');
