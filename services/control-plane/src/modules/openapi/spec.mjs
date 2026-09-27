/**
 * modules/openapi/spec.mjs —— V2.9：OpenAPI 规范生成。
 *
 * 设计原则（防漂移）：
 * - path/method/鉴权 全部从运行时的真实路由表派生，不手写第二份清单；
 * - 新增路由自动进入规范；contract 测试反向校验"路由表 ⊆ 规范 ⊆ 路由表"。
 *
 * 诚实边界：summary/description 为自动生成或人工摘要；各接口的 request/response
 * schema 尚未逐接口精化，集成时以实际联调为准（见 info.description）。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../../../package.json');

// 路径前缀 → tag（最长前缀匹配）
const TAG_TABLE = [
  ['/v1/admin/tenants/:tenantId/budgets', '预算管理'],
  ['/v1/admin/tenants/:tenantId/compliance', '合规审计'],
  ['/v1/admin/tenants/:tenantId/cost', '成本'],
  ['/v1/admin/tenants/:tenantId/usage', '用量'],
  ['/v1/admin/tenants/:tenantId/evidence', '审计证据'],
  ['/v1/admin/tenants', '租户管理'],
  ['/v1/admin/budgets', '预算管理'],
  ['/v1/admin/billing', '计费管理'],
  ['/v1/admin/memory', '记忆管理'],
  ['/v1/admin/metering', '计量管理'],
  ['/v1/admin/models', '模型管理'],
  ['/v1/admin/retention', '数据保留'],
  ['/v1/admin/anchor', '审计锚定'],
  ['/v1/tenants/:tenantId/billing', '账单'],
  ['/v1/tenants/:tenantId/memory', '记忆'],
  ['/v1/tenants/:tenantId/notify', '通知'],
  ['/v1/projects/:projectId/knowledge', '知识库'],
  ['/v1/projects/:projectId/ontology', '本体'],
  ['/v1/projects/:projectId/tools', '工具'],
  ['/v1/projects/:projectId/business', '业务执行'],
  ['/v1/projects/:projectId/delivery', '研发交付'],
  ['/v1/projects/:projectId/executions', '执行记录'],
  ['/v1/projects/:projectId/approvals', '审批'],
  ['/v1/gw', '模型网关'],
  ['/v1/me', '身份'],
  ['/v1/models', '模型网关'],
  ['/v1/projects', '通用'],
  ['/v1/admin', '平台运维'],
  ['/v1', '通用'],
];

// 重点接口的人工摘要（其余自动生成 "METHOD path"）
const SUMMARY_OVERRIDES = {
  'POST /v1/admin/tenants/provision': '原子开通租户（含默认项目/管理员/API Key/套餐预算）',
  'POST /v1/admin/tenants': '创建租户（自动落套餐预算）',
  'GET /v1/admin/tenants': '租户列表',
  'PATCH /v1/admin/tenants/:tenantId': '更新租户（资料/套餐/配额）',
  'POST /v1/admin/tenants/:tenantId/suspend': '停用租户',
  'POST /v1/admin/tenants/:tenantId/resume': '恢复租户',
  'POST /v1/admin/tenants/:tenantId/api-keys/:keyId/rotate': '轮换 API Key（宽限期双 key 可用）',
  'POST /v1/gw/chat/completions': '模型对话（OpenAI 兼容，租户 key 隔离/计量）',
  'POST /v1/gw/embeddings': '向量嵌入（OpenAI 兼容）',
  'PUT /v1/admin/tenants/:tenantId/budgets': '设置租户预算（手工行优先）',
  'POST /v1/admin/budgets/sync-plan': '全租户同步套餐预算',
  'POST /v1/admin/billing/run': '账单跑批（operator）',
  'GET /v1/admin/tenants/:tenantId/compliance/export': '合规导出（JSONL/CSV，审计链验证）',
  'POST /v1/admin/retention/sweep': '执行数据保留清理',
  'POST /v1/tenants/:tenantId/memory': '写入记忆',
  'GET /v1/tenants/:tenantId/memory/recall': '记忆召回（语义/关键词）',
  'POST /v1/projects/:projectId/knowledge/documents': '知识文档摄入',
  'POST /v1/projects/:projectId/knowledge/search': '知识检索',
  'POST /v1/projects/:projectId/delivery/pipeline-runs': '发起流水线执行',
  'POST /v1/projects/:projectId/business/intents': '创建业务意图',
  'GET /v1/me': '当前身份',
};

function toOpenApiPath(raw) {
  return raw.replace(/:([a-zA-Z_]+)/g, '{$1}');
}

function tagFor(raw) {
  let best = null;
  for (const [prefix, tag] of TAG_TABLE) {
    if (raw === prefix || raw.startsWith(prefix + '/')) {
      if (!best || prefix.length > best[0].length) best = [prefix, tag];
    }
  }
  return best ? best[1] : '通用';
}

function operationId(method, openapiPath) {
  return (method.toLowerCase() + '_' + openapiPath)
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

// 从中间件链的 authInfo 标记提炼鉴权需求（按注册顺序）
function authRequirements(handlers) {
  const out = [];
  for (const h of handlers || []) {
    const info = h && h.authInfo;
    if (!info) continue;
    switch (info.kind) {
      case 'authenticated': out.push('authenticated'); break;
      case 'operator': out.push('operator'); break;
      case 'tenantScope': out.push('tenant-scope'); break;
      case 'tenantRole': out.push(`tenant-role:${info.role}`); break;
      case 'scopes': out.push(`scopes:${info.scopes.join('|')}`); break;
      default: break;
    }
  }
  return [...new Set(out)];
}

export function buildOpenApi(routes) {
  const paths = {};
  for (const r of routes || []) {
    const openapiPath = toOpenApiPath(r.path);
    const method = r.method.toLowerCase();
    const paramNames = [...r.path.matchAll(/:([a-zA-Z_]+)/g)].map((m) => m[1]);
    const reqs = authRequirements(r.handlers);
    const op = {
      tags: [tagFor(r.path)],
      summary: SUMMARY_OVERRIDES[`${r.method} ${r.path}`] || `${r.method} ${r.path}`,
      operationId: operationId(r.method, openapiPath),
      parameters: paramNames.map((n) => ({
        name: n, in: 'path', required: true, schema: { type: 'string' },
      })),
      responses: {
        200: { description: '成功（data 包裹）' },
        400: { description: '请求非法' },
        401: { description: '未认证' },
        403: { description: '无权限/配额超限/预算熔断' },
        404: { description: '不存在' },
      },
      'x-deyi-auth': reqs,
    };
    if (reqs.includes('authenticated')) op.security = [{ bearerAuth: [] }];
    (paths[openapiPath] ||= {})[method] = op;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: '得逸智行企业级 AI 交付与执行平台 API',
      version: pkg.version || '0.0.0',
      description: [
        '本规范由服务运行时的真实路由表自动生成：path / method / 鉴权需求与实现保持一致，',
        '新增路由自动进入规范，contract 测试保障"路由表 ⊆ 规范 ⊆ 路由表"双向一致。',
        '注意：各接口的 request/response schema 尚未逐接口精化，集成时以实际联调为准；',
        'x-deyi-auth 列出该接口的鉴权链（authenticated=需 Bearer 凭证；operator=平台运维；',
        'tenant-role=租户角色；scopes=API Key 所需 scope；tenant-scope=租户隔离）。',
      ].join(''),
    },
    tags: [...new Set(TAG_TABLE.map(([, t]) => t))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'OPERATOR_TOKEN / dyk_ API Key / JWT',
          description: 'Authorization: Bearer <凭证>。平台运维用 OPERATOR_TOKEN；租户用 dyk_ 开头的 API Key（或已配置 IdP 的 JWT）。',
        },
      },
    },
    'x-deyi': {
      generated: 'runtime-route-table',
      routeCount: (routes || []).length,
    },
  };
}
