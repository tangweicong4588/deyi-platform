/**
 * modules/agent_templates/templates.mjs —— V4.4 业务场景模板（Track B）。
 *
 * 模板 = 参数化 prompt + 工具 + 流程（Agent 定义模板），租户开箱即用：
 * - 平台内置模板（tenant_id NULL）：客服助手 / 文档审阅 / 数据分析，全租户可见；
 * - 租户自定义模板：租户级市场，本租户可见；
 * - 实例化：解析参数 → 渲染定义 → 校验 → 注册 Agent + 发版（复用 V4.2 运行时）。
 *
 * 占位语法：实例化参数用 [[name]]，与运行时 runner 的 {{input.x}} / {{steps.x}}
 * 明确区分——前者在实例化时填充，后者在每次 run 执行时填充。
 */
import { newId, nowMs } from '../../kernel/ids.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { db } from '../../db/index.mjs';
import { compileAgentDefinition } from '../../adapters/langgraph/graph.mjs';
import { validateParamsSchema, resolveParams } from '../delivery/templates.mjs';
import { registerAgent, createAgentVersion } from '../agents/agents.mjs';
import { tryAudit } from '../evidence/audit.mjs';

export const TEMPLATE_CATEGORIES = new Set(['support', 'review', 'analytics', 'dev', 'custom']);
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PLACEHOLDER_RE = /\[\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]\]/g;
const PLACEHOLDER_ONLY_RE = /^\[\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]\]$/;

const parseJson = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };

function rowToTemplate(r) {
  if (!r) return null;
  return {
    ...r,
    builtin: r.tenant_id == null,
    params_schema: parseJson(r.params_schema, []),
    definition_template: parseJson(r.definition_template, {}),
  };
}

/** 渲染定义模板：[[param]] → 参数值（整串恰为占位符时保留原始类型）。未知占位符直接 400。 */
export function renderDefinition(definitionTemplate, params, schema) {
  const known = new Set((schema || []).map((p) => p.name));
  const assertKnown = (name) => {
    if (!known.has(name)) {
      throw Errors.badRequest(`定义模板引用了未声明的参数: [[${name}]]`, { code: 'UNKNOWN_TEMPLATE_PARAM' });
    }
    if (!(name in params)) {
      throw Errors.badRequest(`参数 [[${name}]] 无取值（必填参数缺失或无默认值）`, { code: 'MISSING_PARAM' });
    }
  };
  const renderValue = (v) => {
    if (typeof v === 'string') {
      const only = PLACEHOLDER_ONLY_RE.exec(v);
      if (only) { assertKnown(only[1]); return params[only[1]]; }
      return v.replace(PLACEHOLDER_RE, (_, name) => {
        assertKnown(name);
        const val = params[name];
        return (val !== null && typeof val === 'object') ? JSON.stringify(val) : String(val);
      });
    }
    if (Array.isArray(v)) return v.map(renderValue);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renderValue(x)]));
    }
    return v;
  };
  return renderValue(definitionTemplate);
}

/** 为模板创建时的干跑校验构造示例参数（按类型给哑值，保证模板可实例化）。 */
function dummyParams(schema) {
  const out = {};
  for (const p of schema) {
    if (p.default !== undefined) { out[p.name] = p.default; continue; }
    if (!p.required) continue;
    out[p.name] = p.type === 'number' ? 0 : p.type === 'boolean' ? false
      : p.type === 'enum' ? p.options[0] : `示例${p.name}`;
  }
  return out;
}

// ---------- 平台内置模板 ----------

const BUILTINS = [
  {
    id: 'agt_builtin_customer_service',
    key: 'customer-service',
    name: '客服助手',
    description: '开箱即用的客服问答 Agent：理解用户问题 → 生成回复。实例化时填入品牌名与语气。',
    category: 'support',
    params_schema: [
      { name: 'brand_name', type: 'string', required: true, description: '品牌/产品名称' },
      { name: 'tone', type: 'enum', options: ['亲切', '专业', '简洁'], default: '亲切', description: '回复语气' },
      { name: 'model', type: 'string', default: 'deyi-default', description: 'LLM 模型（网关模型名）' },
    ],
    definition_template: {
      entry: 'understand',
      nodes: [
        {
          id: 'understand', type: 'llm', name: '理解问题', model: '[[model]]',
          prompt: '你是[[brand_name]]的客服助手，请用[[tone]]的语气，先理解用户真正想问的问题，用一句话概括。用户问题：{{input.question}}',
          next: 'answer',
        },
        {
          id: 'answer', type: 'llm', name: '生成回复', model: '[[model]]',
          prompt: '你是[[brand_name]]的客服助手，请用[[tone]]的语气回答用户。问题理解：{{steps.understand.text}}。原始问题：{{input.question}}',
          next: null,
        },
      ],
    },
  },
  {
    id: 'agt_builtin_doc_review',
    key: 'doc-review',
    name: '文档审阅',
    description: '文档审阅 Agent：提取问题 → 人工确认（HITL）→ 输出终稿报告。',
    category: 'review',
    params_schema: [
      { name: 'focus_areas', type: 'string', required: true, description: '重点关注方向（如：合规性、错别字）' },
      { name: 'strictness', type: 'enum', options: ['宽松', '标准', '严格'], default: '标准', description: '审阅严格程度' },
      { name: 'model', type: 'string', default: 'deyi-default', description: 'LLM 模型（网关模型名）' },
    ],
    definition_template: {
      entry: 'extract',
      nodes: [
        {
          id: 'extract', type: 'llm', name: '提取问题', model: '[[model]]',
          prompt: '你是文档审阅助手，审阅严格程度：[[strictness]]。请从以下文档中提取需要关注的问题（重点关注：[[focus_areas]]），逐条列出。文档内容：{{input.document}}',
          next: 'human_review',
        },
        {
          id: 'human_review', type: 'hitl', name: '人工确认',
          title: '请确认审阅发现的问题是否准确',
          on_approve: 'finalize', on_reject: null,
        },
        {
          id: 'finalize', type: 'llm', name: '输出报告', model: '[[model]]',
          prompt: '审阅结论已通过人工确认（严格程度[[strictness]]），请输出最终中文审阅报告。发现的问题：{{steps.extract.text}}',
          next: null,
        },
      ],
    },
  },
  {
    id: 'agt_builtin_data_analysis',
    key: 'data-analysis',
    name: '数据分析',
    description: '数据分析 Agent：针对指定指标分析数据 → 输出中文摘要。',
    category: 'analytics',
    params_schema: [
      { name: 'dataset_description', type: 'string', required: true, description: '数据集描述' },
      { name: 'metrics', type: 'string', required: true, description: '关注指标（逗号分隔）' },
      { name: 'model', type: 'string', default: 'deyi-default', description: 'LLM 模型（网关模型名）' },
    ],
    definition_template: {
      entry: 'analyze',
      nodes: [
        {
          id: 'analyze', type: 'llm', name: '分析数据', model: '[[model]]',
          prompt: '你是数据分析助手。数据集：[[dataset_description]]。请针对以下指标进行分析：[[metrics]]。数据：{{input.data}}',
          next: 'summarize',
        },
        {
          id: 'summarize', type: 'llm', name: '输出摘要', model: '[[model]]',
          prompt: '请将以下分析结果整理成一份简洁的中文摘要，包含关键结论。分析结果：{{steps.analyze.text}}',
          next: null,
        },
      ],
    },
  },
  {
    id: 'agt_builtin_code_review',
    key: 'code-review',
    name: '代码评审',
    description: 'AI 代码评审 Agent：分析代码变更 → 输出中文评审报告（含严重级别与修改建议）。',
    category: 'dev',
    params_schema: [
      { name: 'strictness', type: 'enum', options: ['宽松', '标准', '严格'], default: '标准', description: '评审严格程度' },
      { name: 'model', type: 'string', default: 'deyi-default', description: 'LLM 模型（网关模型名）' },
    ],
    definition_template: {
      entry: 'analyze',
      nodes: [
        {
          id: 'analyze', type: 'llm', name: '分析变更', model: '[[model]]',
          prompt: '你是资深代码评审专家，评审严格程度：[[strictness]]。请分析以下代码变更，找出 bug、坏味道、安全问题与可维护性问题。变更内容：{{input.diff}}。变更背景：{{input.context}}',
          next: 'report',
        },
        {
          id: 'report', type: 'llm', name: '输出评审报告', model: '[[model]]',
          prompt: '请将以下代码分析整理成中文评审报告：问题列表（含严重级别：阻塞/严重/建议）、每条问题的修改建议、总体结论。分析内容：{{steps.analyze.text}}',
          next: null,
        },
      ],
    },
  },
  {
    id: 'agt_builtin_testgen',
    key: 'testgen',
    name: '测试用例生成',
    description: 'AI 测试用例生成 Agent：设计测试策略 → 输出具体测试用例。',
    category: 'dev',
    params_schema: [
      { name: 'framework', type: 'string', default: 'node:test', description: '测试框架' },
      { name: 'model', type: 'string', default: 'deyi-default', description: 'LLM 模型（网关模型名）' },
    ],
    definition_template: {
      entry: 'design',
      nodes: [
        {
          id: 'design', type: 'llm', name: '设计测试策略', model: '[[model]]',
          prompt: '你是测试专家。请为以下代码变更设计测试策略（测试框架：[[framework]]），覆盖正常路径、边界条件与异常路径。变更内容：{{input.diff}}。变更背景：{{input.context}}',
          next: 'cases',
        },
        {
          id: 'cases', type: 'llm', name: '输出测试用例', model: '[[model]]',
          prompt: '请根据以下测试策略输出具体测试用例，每条用例包含：用例名、前置条件、测试步骤、预期结果。测试策略：{{steps.design.text}}',
          next: null,
        },
      ],
    },
  },
  {
    id: 'agt_builtin_change_risk',
    key: 'change-risk',
    name: '变更风险评估',
    description: 'AI 变更风险评估 Agent：评估变更风险 → 输出风险等级、依据与缓解建议。',
    category: 'dev',
    params_schema: [
      { name: 'model', type: 'string', default: 'deyi-default', description: 'LLM 模型（网关模型名）' },
    ],
    definition_template: {
      entry: 'assess',
      nodes: [
        {
          id: 'assess', type: 'llm', name: '评估风险', model: '[[model]]',
          prompt: '你是变更风险评估专家。请评估以下代码变更的风险：影响范围、回滚难度、数据风险、依赖风险。变更内容：{{input.diff}}。变更背景：{{input.context}}',
          next: 'summary',
        },
        {
          id: 'summary', type: 'llm', name: '输出评估结论', model: '[[model]]',
          prompt: '请根据以下风险评估输出结论：风险等级（高/中/低）、评级依据、缓解建议。风险评估：{{steps.assess.text}}',
          next: null,
        },
      ],
    },
  },
];

/** 幂等确保内置模板存在（INSERT OR IGNORE，按固定 id）。 */
export async function ensureBuiltinTemplates() {
  const now = nowMs();
  for (const b of BUILTINS) {
    await db().run(
      `INSERT OR IGNORE INTO agent_templates
       (id,tenant_id,key,name,description,category,params_schema,definition_template,created_by,created_at,updated_at,archived_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)`,
      [b.id, null, b.key, b.name, b.description, b.category,
        JSON.stringify(b.params_schema), JSON.stringify(b.definition_template),
        null, now, now],
    );
  }
}

// ---------- 查询 ----------

/** 模板市场：平台内置 + 本租户自定义（未归档）。 */
export async function listTemplates({ tenantId, category = null }) {
  await ensureBuiltinTemplates();
  let sql = `SELECT * FROM agent_templates
             WHERE archived_at IS NULL AND (tenant_id IS NULL OR tenant_id=?)
             ORDER BY tenant_id NULLS FIRST, created_at`;
  const args = [tenantId];
  if (category) {
    if (!TEMPLATE_CATEGORIES.has(category)) throw Errors.badRequest(`category 非法（可用：${[...TEMPLATE_CATEGORIES].join(',')}）`);
    sql = `SELECT * FROM agent_templates
           WHERE archived_at IS NULL AND category=? AND (tenant_id IS NULL OR tenant_id=?)
           ORDER BY tenant_id NULLS FIRST, created_at`;
    args.unshift(category);
  }
  return (await db().query(sql, args)).map(rowToTemplate);
}

export async function getTemplate({ tenantId, templateId }) {
  await ensureBuiltinTemplates();
  const rows = await db().query(
    `SELECT * FROM agent_templates
     WHERE id=? AND archived_at IS NULL AND (tenant_id IS NULL OR tenant_id=?)`,
    [templateId, tenantId],
  );
  const t = rowToTemplate(rows[0]);
  if (!t) throw Errors.notFound('模板不存在');
  return t;
}

// ---------- 创建（租户自定义） ----------

export async function createTemplate({ tenantId, actorId, body }) {
  const { key, name, description = '', category = 'custom', params_schema: paramsSchema, definition_template: definitionTemplate } = body || {};
  if (!key || !KEY_RE.test(key)) throw Errors.badRequest('key 非法（1-64 位字母数字/_/-）');
  if (!name || !String(name).trim()) throw Errors.badRequest('name 必填');
  if (!TEMPLATE_CATEGORIES.has(category)) throw Errors.badRequest(`category 非法（可用：${[...TEMPLATE_CATEGORIES].join(',')}）`);
  const schema = validateParamsSchema(paramsSchema ?? []);
  if (!definitionTemplate || typeof definitionTemplate !== 'object' || Array.isArray(definitionTemplate)) {
    throw Errors.badRequest('definition_template 必须为对象');
  }
  // 干跑：用示例参数渲染并编译，保证模板可实例化（未知占位符/非法图在此暴露）
  const rendered = renderDefinition(definitionTemplate, dummyParams(schema), schema);
  compileAgentDefinition(rendered); // 抛 400 即模板非法
  const now = nowMs();
  const id = newId('agt');
  try {
    await db().run(
      `INSERT INTO agent_templates
       (id,tenant_id,key,name,description,category,params_schema,definition_template,created_by,created_at,updated_at,archived_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)`,
      [id, tenantId, key, String(name).trim(), String(description || ''), category,
        JSON.stringify(schema), JSON.stringify(definitionTemplate), actorId, now, now],
    );
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw Errors.conflict('本租户下模板 key 已存在');
    throw e;
  }
  await tryAudit({ tenantId, projectId: null, actorId, action: 'agent_template.create',
    resourceKind: 'agent_template', resourceId: id, payload: { key, category } });
  return rowToTemplate((await db().query('SELECT * FROM agent_templates WHERE id=?', [id]))[0]);
}

// ---------- 实例化 ----------

export async function instantiateTemplate({ tenantId, projectId, actorId, templateId, params = {}, agentKey = null, agentName = null }) {
  const template = await getTemplate({ tenantId, templateId });
  const resolved = resolveParams(template.params_schema, params); // 缺必填/未知参数 → 400
  const definition = renderDefinition(template.definition_template, resolved, template.params_schema);
  compileAgentDefinition(definition); // 渲染后必须仍是合法 Agent 定义
  const key = agentKey || `tpl-${template.key}-${newId('tk').slice(3, 11)}`;
  const agent = await registerAgent({
    tenantId, projectId, actorId, key,
    name: agentName || `${template.name}（${template.key}）`,
    description: `由场景模板 ${template.key} 实例化`,
  });
  const version = await createAgentVersion({ tenantId, projectId, actorId, agentId: agent.id, definition });
  const now = nowMs();
  const instanceId = newId('agi');
  await db().run(
    `INSERT INTO agent_template_instances
     (id,tenant_id,project_id,template_id,agent_id,params,created_by,created_at)
     VALUES(?,?,?,?,?,?,?,?)`,
    [instanceId, tenantId, projectId, template.id, agent.id, JSON.stringify(resolved), actorId, now],
  );
  await tryAudit({ tenantId, projectId, actorId, action: 'agent_template.instantiate',
    resourceKind: 'agent_template_instance', resourceId: instanceId,
    payload: { template_id: template.id, agent_id: agent.id, version: version.version } });
  return {
    template: { id: template.id, key: template.key, name: template.name, category: template.category },
    agent, version: { id: version.id, version: version.version },
    instance: { id: instanceId, params: resolved, created_at: now },
  };
}

export async function listInstances({ tenantId, projectId }) {
  const rows = await db().query(
    `SELECT i.*, t.key AS template_key, t.name AS template_name, a.key AS agent_key, a.name AS agent_name
     FROM agent_template_instances i
     JOIN agent_templates t ON t.id = i.template_id
     JOIN agents a ON a.id = i.agent_id
     WHERE i.tenant_id=? AND i.project_id=?
     ORDER BY i.created_at DESC`,
    [tenantId, projectId],
  );
  return rows.map((r) => ({ ...r, params: parseJson(r.params, {}) }));
}
