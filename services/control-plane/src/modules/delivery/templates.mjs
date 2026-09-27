/**
 * modules/delivery/templates.mjs —— V3.1 流水线模板与复用。
 *
 * 目标：从"一次编排"到"可复用的生产模具"。
 * - 模板：参数化（params_schema）+ 版本化（不可变快照）+ 可见性
 *   （private=项目私有，shared=租户级共享，project_id NULL）。
 * - 实例化：绑定变更包 + 模板版本 + 解析后参数，一次性创建各阶段运行；
 *   实例化出的运行直接复用 V1.0-B 编排（advanceStage 等），模板只做"模具"，
 *   不另起一套执行引擎。
 * - 模板变更审计：create / version / archive / instantiate 全部进审计链。
 *
 * 范围边界（诚实）：
 * - 模板阶段必须是五阶段（facts/requirements/clarify/develop/handover）的非空
 *   有序子集；自定义阶段类型留待后续版本。执行顺序沿用 STAGE_ORDER 的相对顺序，
 *   因此 advanceStage 无需改动。
 * - 一个变更包只能有一种流水线来源：已有 pipeline_runs 的包不能再实例化
 *   （409 PIPELINE_EXISTS），反之亦然由 startPipeline 的唯一约束保证。
 * - 共享模板的创建权限：项目 operator 即可创建租户级共享模板（治理收紧留待后续）。
 */
import { Errors } from '../../kernel/errors.mjs';
import { newId } from '../../kernel/ids.mjs';
import { db } from '../../db/index.mjs';
import { tryAudit } from '../evidence/audit.mjs';
import { STAGE_ORDER } from './pipeline.mjs';
import * as svc from './service.mjs';

const nowMs = () => Date.now();
const VISIBILITIES = new Set(['private', 'shared']);
const PARAM_TYPES = new Set(['string', 'number', 'boolean', 'enum']);
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// 原型污染防护：__proto__/constructor/prototype 即使符合正则也不允许做参数名
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const TERMINAL_PKG = new Set(['cancelled', 'handed_over']);

function parseJson(v, fallback) {
  try {
    const o = JSON.parse(v);
    return o === undefined ? fallback : o;
  } catch { return fallback; }
}

// ---------------------------------------------------------------- 定义校验
export function validateParamsSchema(schema) {
  if (!Array.isArray(schema)) throw Errors.badRequest('params_schema 必须为数组');
  if (schema.length > 64) throw Errors.badRequest('params_schema 参数过多（上限 64）');
  const names = new Set();
  for (const p of schema) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw Errors.badRequest('params_schema 元素必须为对象');
    if (typeof p.name !== 'string' || !NAME_RE.test(p.name) || p.name.length > 64) {
      throw Errors.badRequest(`非法参数名: ${JSON.stringify(p.name)}（仅允许字母/数字/下划线，字母或下划线开头）`);
    }
    if (names.has(p.name)) throw Errors.badRequest(`参数名重复: ${p.name}`);
    if (RESERVED_NAMES.has(p.name)) throw Errors.badRequest(`参数名保留不可用: ${p.name}`);
    names.add(p.name);
    if (!PARAM_TYPES.has(p.type)) {
      throw Errors.badRequest(`参数 ${p.name} 非法类型 ${JSON.stringify(p.type)}（允许 string/number/boolean/enum）`);
    }
    if (p.type === 'enum') {
      if (!Array.isArray(p.options) || !p.options.length || p.options.some((o) => typeof o !== 'string')) {
        throw Errors.badRequest(`enum 参数 ${p.name} 必须提供非空字符串 options`);
      }
    }
    if (p.required !== undefined && typeof p.required !== 'boolean') {
      throw Errors.badRequest(`参数 ${p.name} 的 required 必须为布尔值`);
    }
    if (p.default !== undefined) checkParamType(p, p.default, '默认值');
    if (p.description !== undefined && typeof p.description !== 'string') {
      throw Errors.badRequest(`参数 ${p.name} 的 description 必须为字符串`);
    }
  }
  return schema;
}

function checkParamType(p, value, what) {
  const t = p.type;
  if (t === 'string' && typeof value !== 'string') throw Errors.badRequest(`参数 ${p.name} ${what}必须为 string`);
  if (t === 'number' && (typeof value !== 'number' || Number.isNaN(value))) throw Errors.badRequest(`参数 ${p.name} ${what}必须为 number`);
  if (t === 'boolean' && typeof value !== 'boolean') throw Errors.badRequest(`参数 ${p.name} ${what}必须为 boolean`);
  if (t === 'enum') {
    if (typeof value !== 'string') throw Errors.badRequest(`参数 ${p.name} ${what}必须为 string`);
    if (!p.options.includes(value)) {
      throw Errors.badRequest(`参数 ${p.name} ${what}不在 options 范围内`, { code: 'INVALID_PARAM' });
    }
  }
}

export function validateStages(stages) {
  if (!Array.isArray(stages) || !stages.length) throw Errors.badRequest('stages 必须为非空数组');
  if (stages.length > STAGE_ORDER.length) throw Errors.badRequest(`stages 至多 ${STAGE_ORDER.length} 个`);
  const seen = new Set();
  for (const s of stages) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw Errors.badRequest('stages 元素必须为对象');
    if (!STAGE_ORDER.includes(s.key)) {
      throw Errors.badRequest(`非法阶段 key ${JSON.stringify(s.key)}（允许 ${STAGE_ORDER.join('/')})`);
    }
    if (seen.has(s.key)) throw Errors.badRequest(`阶段重复: ${s.key}`);
    seen.add(s.key);
    if (s.name !== undefined && (typeof s.name !== 'string' || s.name.length > 120)) {
      throw Errors.badRequest(`阶段 ${s.key} 的 name 必须为不超过 120 字符的字符串`);
    }
    if (s.config !== undefined && (typeof s.config !== 'object' || s.config === null || Array.isArray(s.config))) {
      throw Errors.badRequest(`阶段 ${s.key} 的 config 必须为 JSON 对象`);
    }
  }
  // 执行顺序沿用 STAGE_ORDER 的相对顺序，保证 advanceStage 语义不变
  return [...stages].sort((a, b) => STAGE_ORDER.indexOf(a.key) - STAGE_ORDER.indexOf(b.key));
}

/** 实例化参数校验：合并默认值 → 校验类型 → 拒绝未知参数 */
export function resolveParams(schema, provided) {
  const input = provided === undefined ? {} : provided;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Errors.badRequest('params 必须为 JSON 对象');
  }
  const known = new Set(schema.map((p) => p.name));
  for (const k of Object.keys(input)) {
    if (!known.has(k)) throw Errors.badRequest(`未知参数: ${k}`, { code: 'UNKNOWN_PARAM' });
  }
  const resolved = {};
  for (const p of schema) {
    let v = Object.prototype.hasOwnProperty.call(input, p.name) ? input[p.name] : undefined;
    if (v === undefined) v = p.default;
    if (v === undefined) {
      if (p.required) throw Errors.badRequest(`缺少必填参数: ${p.name}`, { code: 'MISSING_PARAM' });
      continue;
    }
    checkParamType(p, v, '取值');
    resolved[p.name] = v;
  }
  return resolved;
}

// ---------------------------------------------------------------- 查询
function rowToTemplate(r) {
  if (!r) return null;
  return {
    ...r,
    params_schema: parseJson(r.params_schema, []),
    stages: parseJson(r.stages, []),
  };
}

export async function getTemplate(tenantId, templateId) {
  const rows = await db().query('SELECT * FROM pipeline_templates WHERE id=? AND tenant_id=?', [templateId, tenantId]);
  const t = rowToTemplate(rows[0]);
  if (!t) throw Errors.notFound('流水线模板不存在');
  return t;
}

/** 项目视角的模板列表：本项目 private + 租户 shared */
export async function listTemplates(tenantId, projectId) {
  const rows = await db().query(
    `SELECT * FROM pipeline_templates
     WHERE tenant_id=? AND (project_id=? OR project_id IS NULL)
     ORDER BY created_at DESC`,
    [tenantId, projectId]);
  return rows.map(rowToTemplate);
}

export async function listVersions(tenantId, templateId) {
  await getTemplate(tenantId, templateId);
  const rows = await db().query(
    'SELECT * FROM pipeline_template_versions WHERE template_id=? ORDER BY version ASC', [templateId]);
  return rows.map((r) => ({ ...r, definition: parseJson(r.definition, {}) }));
}

export async function getVersion(tenantId, templateId, version) {
  await getTemplate(tenantId, templateId);
  const rows = await db().query(
    'SELECT * FROM pipeline_template_versions WHERE template_id=? AND version=?', [templateId, version]);
  if (!rows[0]) throw Errors.notFound('模板版本不存在');
  return { ...rows[0], definition: parseJson(rows[0].definition, {}) };
}

// ---------------------------------------------------------------- 变更
export async function createTemplate({ tenantId, projectId, actorId, body }) {
  const { name, description = '', visibility = 'private', paramsSchema = [], stages = [] } = body || {};
  if (!String(name || '').trim()) throw Errors.badRequest('name 必填');
  if (!VISIBILITIES.has(visibility)) throw Errors.badRequest('visibility 必须为 private 或 shared');
  // 路由恒为项目级：private → 绑定当前项目；shared → project_id 置 NULL（租户级共享）
  const boundProjectId = visibility === 'shared' ? null : projectId;
  if (visibility === 'private' && !boundProjectId) throw Errors.badRequest('private 模板必须绑定项目');
  const schema = validateParamsSchema(paramsSchema);
  const stageDefs = validateStages(stages);
  const now = nowMs();
  const id = newId('ptpl');
  const definition = JSON.stringify({ params_schema: schema, stages: stageDefs });
  await db().transaction(async (tx) => {
    await tx.run(
      `INSERT INTO pipeline_templates(id,tenant_id,project_id,name,description,visibility,
        params_schema,stages,current_version,status,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, tenantId, boundProjectId, String(name).trim(),
        String(description).slice(0, 2000), visibility,
        JSON.stringify(schema), JSON.stringify(stageDefs), 1, 'active', actorId, now, now]);
    await tx.run(
      `INSERT INTO pipeline_template_versions(id,template_id,version,definition,change_note,created_by,created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [newId('ptplv'), id, 1, definition, '初始版本', actorId, now]);
  });
  await tryAudit({
    tenantId, projectId, actorId, action: 'pipeline.template.create',
    resourceKind: 'pipeline_template', resourceId: id,
    payload: { name: String(name).trim(), visibility, stages: stageDefs.map((s) => s.key) },
  });
  return getTemplate(tenantId, id);
}

export async function createVersion({ tenantId, actorId, templateId, body }) {
  const tpl = await getTemplate(tenantId, templateId);
  if (tpl.status !== 'active') throw Errors.badRequest('模板已归档，不能发新版本', { code: 'TEMPLATE_ARCHIVED' });
  const { paramsSchema = tpl.params_schema, stages = tpl.stages, changeNote = '' } = body || {};
  const schema = validateParamsSchema(paramsSchema);
  const stageDefs = validateStages(stages);
  const now = nowMs();
  const version = tpl.current_version + 1;
  const definition = JSON.stringify({ params_schema: schema, stages: stageDefs });
  await db().transaction(async (tx) => {
    await tx.run(
      `INSERT INTO pipeline_template_versions(id,template_id,version,definition,change_note,created_by,created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [newId('ptplv'), templateId, version, definition, String(changeNote).slice(0, 2000), actorId, now]);
    await tx.run(
      `UPDATE pipeline_templates SET params_schema=?, stages=?, current_version=?, updated_at=?
       WHERE id=? AND tenant_id=?`,
      [JSON.stringify(schema), JSON.stringify(stageDefs), version, now, templateId, tenantId]);
  });
  await tryAudit({
    tenantId, projectId: tpl.project_id, actorId, action: 'pipeline.template.version',
    resourceKind: 'pipeline_template', resourceId: templateId,
    payload: { version, change_note: String(changeNote).slice(0, 2000) },
  });
  return getVersion(tenantId, templateId, version);
}

export async function archiveTemplate({ tenantId, actorId, templateId }) {
  const tpl = await getTemplate(tenantId, templateId);
  if (tpl.status === 'archived') return tpl;
  const now = nowMs();
  await db().run(
    `UPDATE pipeline_templates SET status='archived', updated_at=? WHERE id=? AND tenant_id=?`,
    [now, templateId, tenantId]);
  await tryAudit({
    tenantId, projectId: tpl.project_id, actorId, action: 'pipeline.template.archive',
    resourceKind: 'pipeline_template', resourceId: templateId,
    payload: { name: tpl.name },
  });
  return getTemplate(tenantId, templateId);
}

// ---------------------------------------------------------------- 实例化
export async function instantiate({ tenantId, projectId, actorId, templateId, body }) {
  const tpl = await getTemplate(tenantId, templateId);
  if (tpl.status !== 'active') {
    throw Errors.badRequest('模板已归档，不能实例化', { code: 'TEMPLATE_ARCHIVED' });
  }
  if (tpl.visibility === 'private' && tpl.project_id !== projectId) {
    throw Errors.forbidden('私有模板只能在其所属项目内实例化');
  }
  const { changePackageId, params, version } = body || {};
  if (!changePackageId) throw Errors.badRequest('changePackageId 必填');
  const ver = version === undefined ? tpl.current_version : version;
  const verRow = await getVersion(tenantId, templateId, ver).catch(() => null);
  if (!verRow) throw Errors.notFound('模板版本不存在');

  // 变更包归属 + 非终态（getChangePackage 已做租户/项目归属校验）
  const chg = await svc.getChangePackage(tenantId, projectId, changePackageId);
  if (TERMINAL_PKG.has(chg.status)) {
    throw Errors.badRequest(`变更包已终态(${chg.status})，不能实例化流水线`);
  }
  // 幂等：同模板同版本重复实例化 → 直接返回已有实例（200 created:false）
  const sameInst = await db().query(
    `SELECT * FROM pipeline_instances
     WHERE tenant_id=? AND change_package_id=? AND template_id=? AND template_version=?`,
    [tenantId, changePackageId, templateId, ver]);
  if (sameInst[0]) return { instance: rowToInstance(sameInst[0]), created: false };
  // 一个变更包只能有一种流水线来源：已有运行（普通 start 或其他模板）则拒绝
  const existingRuns = await db().query(
    'SELECT id FROM pipeline_runs WHERE tenant_id=? AND change_package_id=? LIMIT 1',
    [tenantId, changePackageId]);
  if (existingRuns.length) {
    throw Errors.conflict('该变更包已有流水线运行，不能重复实例化', { code: 'PIPELINE_EXISTS' });
  }

  const schema = verRow.definition.params_schema || [];
  const stageDefs = verRow.definition.stages || [];
  const resolved = resolveParams(schema, params);
  const now = nowMs();
  const instanceId = newId('ptnst');

  try {
    await db().transaction(async (tx) => {
      await tx.run(
        `INSERT INTO pipeline_instances(id,tenant_id,project_id,change_package_id,template_id,
          template_version,resolved_params,resolved_definition,status,created_by,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [instanceId, tenantId, projectId, changePackageId, templateId, ver,
          JSON.stringify(resolved), JSON.stringify(verRow.definition), 'active', actorId, now]);
      let first = true;
      for (const s of stageDefs) {
        await tx.run(
          `INSERT INTO pipeline_runs(id,tenant_id,project_id,change_package_id,stage,status,
            gate_decision,started_at,finished_at,created_at,instance_id,template_id,template_version)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [newId('pipe'), tenantId, projectId, changePackageId, s.key,
            first ? 'running' : 'pending', '{}', first ? now : null, null, now,
            instanceId, templateId, ver]);
        first = false;
      }
    });
  } catch (e) {
    // 并发双实例化：唯一约束冲突 → 回读已有实例（幂等）
    if (!String((e && e.message) || '').toLowerCase().includes('unique')) throw e;
    const dup = await db().query(
      `SELECT * FROM pipeline_instances
       WHERE tenant_id=? AND change_package_id=? AND template_id=? AND template_version=?`,
      [tenantId, changePackageId, templateId, ver]);
    if (dup[0]) return { instance: rowToInstance(dup[0]), created: false };
    throw e;
  }

  await tryAudit({
    tenantId, projectId, actorId, action: 'pipeline.template.instantiate',
    resourceKind: 'pipeline_instance', resourceId: instanceId,
    payload: {
      template_id: templateId, template_version: ver,
      change_package_id: changePackageId, stages: stageDefs.map((s) => s.key),
    },
  });
  const rows = await db().query('SELECT * FROM pipeline_instances WHERE id=?', [instanceId]);
  return { instance: rowToInstance(rows[0]), created: true };
}

function rowToInstance(r) {
  if (!r) return null;
  return {
    ...r,
    resolved_params: parseJson(r.resolved_params, {}),
    resolved_definition: parseJson(r.resolved_definition, {}),
  };
}

export async function getInstance(tenantId, projectId, instanceId) {
  const rows = await db().query(
    'SELECT * FROM pipeline_instances WHERE id=? AND tenant_id=? AND project_id=?',
    [instanceId, tenantId, projectId]);
  const inst = rowToInstance(rows[0]);
  if (!inst) throw Errors.notFound('流水线实例不存在');
  const runs = await db().query(
    'SELECT * FROM pipeline_runs WHERE instance_id=? ORDER BY created_at ASC', [instanceId]);
  return { instance: inst, runs };
}
