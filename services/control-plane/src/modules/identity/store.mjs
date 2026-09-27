/**
 * modules/identity/store.mjs —— 身份域数据访问。
 * 所有查询强制带 tenant_id（租户隔离是底线，不在上层"记得加"）。
 */
import { newId, nowMs, assertId } from '../../kernel/ids.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { db } from '../../db/index.mjs';
import { mintKey, assertValidScopes } from './keys.mjs';

export function slugify(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 't';
}

const T = (r) => (r ? { ...r, scopes: undefined } : r);

export async function createTenant({ name, slug, plan = 'trial', quotas = {} }, h = db()) {
  slug = slug ? slugify(slug) : slugify(name);
  if (!TENANT_PLANS[plan]) throw Errors.badRequest(`非法套餐: ${plan}`);
  const row = {
    id: newId('ten'), name, slug, status: 'active', plan,
    quotas: JSON.stringify(quotas || {}),
    created_at: nowMs(), updated_at: nowMs(),
  };
  try {
    await h.query(
      'INSERT INTO tenants(id,name,slug,status,plan,quotas,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      [row.id, row.name, row.slug, row.status, row.plan, row.quotas, row.created_at, row.updated_at]);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw Errors.conflict(`租户 slug 已存在: ${slug}`);
    throw e;
  }
  // V2.8：开通即落套餐预算——所有创建入口（直调路由/provision/bootstrap）统一经此，
  // 不再依赖调用方记得调 ensurePlanBudget（动态 import 避免 identity↔gateway 循环依赖）
  const gw = await import('../gateway/store.mjs');
  await gw.ensurePlanBudget(row.id, h);
  return { ...row, quotas: quotas || {} };
}

/** 租户状态变更（停用/恢复），平台运维专用。返回更新后的租户。 */
export async function setTenantStatus(tenantId, status, h = db()) {
  assertId('ten', tenantId);
  if (!TENANT_STATUSES.has(status)) throw Errors.badRequest(`非法租户状态: ${status}`);
  const upd = await h.run('UPDATE tenants SET status=?, updated_at=? WHERE id=?',
    [status, nowMs(), tenantId]);
  if (upd.changes === 0) throw Errors.notFound('租户不存在');
  return getTenant(tenantId, h);
}

/** 租户资料/套餐更新（name/slug/plan/quotas），平台运维专用。 */
export async function updateTenant(tenantId, patch = {}, h = db()) {
  assertId('ten', tenantId);
  const sets = [], args = [];
  if (patch.name !== undefined) { sets.push('name=?'); args.push(patch.name); }
  if (patch.slug !== undefined) { sets.push('slug=?'); args.push(slugify(patch.slug)); }
  if (patch.plan !== undefined) {
    if (!TENANT_PLANS[patch.plan]) throw Errors.badRequest(`非法套餐: ${patch.plan}`);
    sets.push('plan=?'); args.push(patch.plan);
  }
  if (patch.quotas !== undefined) {
    if (patch.quotas === null || typeof patch.quotas !== 'object' || Array.isArray(patch.quotas)) {
      throw Errors.badRequest('quotas 必须为对象');
    }
    sets.push('quotas=?'); args.push(JSON.stringify(patch.quotas));
  }
  if (!sets.length) return getTenant(tenantId, h);
  sets.push('updated_at=?'); args.push(nowMs(), tenantId);
  try {
    await h.query(`UPDATE tenants SET ${sets.join(',')} WHERE id=?`, args);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw Errors.conflict('租户 slug 已存在');
    throw e;
  }
  // V2.6：套餐/配额变更 → 同步当月 plan 预算行（动态 import 避免 identity↔gateway 循环依赖）
  if (patch.plan !== undefined || patch.quotas !== undefined) {
    const gw = await import('../gateway/store.mjs');
    await gw.ensurePlanBudget(tenantId, h);
  }
  return getTenant(tenantId, h);
}

export const getTenant = async (id, h = db()) => {
  assertId('ten', id);
  const rows = await h.query('SELECT * FROM tenants WHERE id=?', [id]);
  return rows[0] || null;
};

/** V2.10：按 slug 解析租户（登录/OIDC 租户映射用）。 */
export const getTenantBySlug = async (slug, h = db()) => {
  if (typeof slug !== 'string' || !slug) return null;
  const rows = await h.query('SELECT * FROM tenants WHERE slug=?', [slugify(slug)]);
  return rows[0] ? T(rows[0]) : null;
};

export const listTenants = async () =>
  (await db().query('SELECT * FROM tenants ORDER BY created_at')).map(T);

// ---------- V2.1-B：租户套餐与配额（SaaS 运营面） ----------
// 配额语义：数字=上限；null=不限。quotas 列是租户级 JSON 覆盖，缺失的 key 用计划默认。
export const TENANT_PLANS = {
  // rpm：网关每 key 每分钟请求上限（null = 不限）；tokens_per_month：当月 token 配额（null = 不限）
  trial:        { max_projects: 5,  max_actors: 20,  max_api_keys: 20,  rpm: 30,  tokens_per_month: 1_000_000 },
  professional: { max_projects: 50, max_actors: 200, max_api_keys: 200, rpm: 300, tokens_per_month: 100_000_000 },
  enterprise:   { max_projects: null, max_actors: null, max_api_keys: null, rpm: null, tokens_per_month: null },
};
export const TENANT_STATUSES = new Set(['active', 'suspended']);

export function getTenantQuotas(tenant) {
  const base = TENANT_PLANS[tenant?.plan] || TENANT_PLANS.trial;
  let over = {};
  try { over = JSON.parse(tenant?.quotas || '{}') || {}; } catch { /* 脏数据则忽略覆盖 */ }
  return { ...base, ...over };
}

const QUOTA_TABLE = { max_projects: 'projects', max_actors: 'actors', max_api_keys: 'api_keys' };

/** 配额检查：超限抛 403 QUOTA_EXCEEDED。用调用方传入的 h，保证事务内读到自己的写入（PG）。 */
async function checkQuota(h, tenant, quotaKey) {
  const quotas = getTenantQuotas(tenant);
  const limit = quotas[quotaKey];
  if (limit == null) return; // 不限
  const table = QUOTA_TABLE[quotaKey];
  const rows = await h.query(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id=?`, [tenant.id]);
  if (Number(rows[0]?.n || 0) >= limit) {
    throw Errors.forbidden(
      `租户配额已用尽：${quotaKey}=${limit}（套餐 ${tenant.plan}），请升级套餐或清理后重试`,
      { code: 'QUOTA_EXCEEDED', quota: quotaKey, limit, plan: tenant.plan });
  }
}

const readTenantForWrite = async (h, tenantId) => {
  const t = await getTenant(tenantId, h);
  if (!t) throw Errors.badRequest('租户不存在');
  if (t.status !== 'active') throw Errors.forbidden('租户已停用，操作被拒绝', { code: 'TENANT_SUSPENDED' });
  return t;
};

export async function createProject(tenantId, { name, slug }, h = db()) {
  assertId('ten', tenantId);
  const tenant = await readTenantForWrite(h, tenantId);
  await checkQuota(h, tenant, 'max_projects');
  slug = slug ? slugify(slug) : slugify(name);
  const row = {
    id: newId('prj'), tenant_id: tenantId, name, slug, status: 'active',
    created_at: nowMs(), updated_at: nowMs(),
  };
  try {
    await h.query(
      'INSERT INTO projects(id,tenant_id,name,slug,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      [row.id, row.tenant_id, row.name, row.slug, row.status, row.created_at, row.updated_at]);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw Errors.conflict(`项目 slug 已存在: ${slug}`);
    throw e;
  }
  return row;
}

/** 取项目（强制校验属于该租户；不存在/不属于都返回 null，不泄露） */
export async function getProject(tenantId, projectId, h = db()) {
  assertId('ten', tenantId); assertId('prj', projectId);
  const rows = await h.query('SELECT * FROM projects WHERE id=? AND tenant_id=?', [projectId, tenantId]);
  return rows[0] || null;
}

export const listProjects = async (tenantId) => {
  assertId('ten', tenantId);
  return db().query('SELECT * FROM projects WHERE tenant_id=? ORDER BY created_at', [tenantId]);
};

export async function createActor(tenantId, { kind = 'user', name, email = null, externalId = null }, h = db()) {
  assertId('ten', tenantId);
  if (!['user', 'service'].includes(kind)) throw Errors.badRequest('非法 actor kind');
  if (!name) throw Errors.badRequest('name 必填');
  const tenant = await readTenantForWrite(h, tenantId);
  await checkQuota(h, tenant, 'max_actors');
  const row = {
    id: newId('usr'), tenant_id: tenantId, kind, external_id: externalId,
    name, email, status: 'active', created_at: nowMs(), updated_at: nowMs(),
  };
  await h.query(
    'INSERT INTO actors(id,tenant_id,kind,external_id,name,email,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [row.id, row.tenant_id, row.kind, row.external_id, row.name, row.email, row.status, row.created_at, row.updated_at]);
  return row;
}

export async function getActor(tenantId, actorId, h = db()) {
  assertId('ten', tenantId); assertId('usr', actorId);
  const rows = await h.query('SELECT * FROM actors WHERE id=? AND tenant_id=?', [actorId, tenantId]);
  return rows[0] || null;
}

export async function findActorByExternal(tenantId, externalId) {
  const rows = await db().query(
    'SELECT * FROM actors WHERE tenant_id=? AND external_id=?', [tenantId, externalId]);
  return rows[0] || null;
}

export async function createApiKeyRow({ tenantId, projectId = null, actorId, name, prefix, keyHash, scopes = [], expiresAt = null }, h = db()) {
  assertValidScopes(scopes);
  assertId('ten', tenantId); assertId('usr', actorId);
  const tenant = await readTenantForWrite(h, tenantId);
  await checkQuota(h, tenant, 'max_api_keys');
  if (projectId) {
    const p = await getProject(tenantId, projectId, h);
    if (!p) throw Errors.badRequest('项目不存在或不属于该租户');
  }
  const a = await getActor(tenantId, actorId, h);
  if (!a) throw Errors.badRequest('actor 不存在或不属于该租户');
  const row = {
    id: newId('key'), tenant_id: tenantId, project_id: projectId, actor_id: actorId,
    name, prefix, key_hash: keyHash, scopes: JSON.stringify(scopes),
    status: 'active', expires_at: expiresAt, last_used_at: null, created_at: nowMs(),
  };
  await h.query(
    `INSERT INTO api_keys(id,tenant_id,project_id,actor_id,name,prefix,key_hash,scopes,status,expires_at,last_used_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [row.id, row.tenant_id, row.project_id, row.actor_id, row.name, row.prefix, row.key_hash,
     row.scopes, row.status, row.expires_at, row.last_used_at, row.created_at]);
  return { ...row, scopes };
}

/** 按前缀找候选 key（含 hash，比对在 keys.mjs 做） */
export async function findApiKeyCandidates(prefix) {
  const rows = await db().query("SELECT * FROM api_keys WHERE prefix=? AND status='active'", [prefix]);
  return rows.map((r) => ({ ...r, scopes: JSON.parse(r.scopes || '[]') }));
}

export async function listApiKeys(tenantId) {
  assertId('ten', tenantId);
  const rows = await db().query(
    `SELECT id,tenant_id,project_id,actor_id,name,prefix,scopes,status,expires_at,last_used_at,created_at
     FROM api_keys WHERE tenant_id=? ORDER BY created_at`, [tenantId]);
  return rows.map((r) => ({ ...r, scopes: JSON.parse(r.scopes || '[]') }));
}

export async function revokeApiKey(tenantId, keyId) {
  assertId('ten', tenantId); assertId('key', keyId);
  const r = await db().run(
    "UPDATE api_keys SET status='revoked' WHERE id=? AND tenant_id=? AND status='active'", [keyId, tenantId]);
  if (!r.changes) throw Errors.notFound('API Key 不存在或已吊销');
}

/**
 * V2.5：API Key 轮换（带宽限期）。
 * - 旧 key 必须 active；签发新 key（继承租户/项目/actor/scopes），secret 仅返回一次；
 * - 旧 key 的 expires_at 收紧为 min(原值, now+graceHours)，宽限期内双 key 可用，
 *   到期自动失效（verifyApiKey 检查 expires_at），无需定时任务；
 * - 旧 key 记录 rotated_to（新 key id）与 rotated_at，形成轮换链；
 * - graceHours 范围 1~720（30 天），默认 24。
 * 返回 { oldKey, newKey: {..., secret} }。
 */
export async function rotateApiKey(tenantId, keyId, { graceHours = 24 } = {}) {
  assertId('ten', tenantId); assertId('key', keyId);
  graceHours = Number(graceHours);
  if (!Number.isFinite(graceHours) || graceHours < 1 || graceHours > 720) {
    throw Errors.badRequest('graceHours 必须在 1~720 之间');
  }
  const now = nowMs();
  const graceUntil = now + Math.round(graceHours * 3600_000);
  return db().transaction(async (h) => {
    const rows = await h.query(
      "SELECT * FROM api_keys WHERE id=? AND tenant_id=? AND status='active'", [keyId, tenantId]);
    const old = rows[0];
    if (!old) throw Errors.notFound('API Key 不存在或已吊销');
    const { secret, prefix, keyHash } = mintKey();
    const newId_ = newId('key');
    const newExpiresAt = old.expires_at && old.expires_at < graceUntil ? old.expires_at : graceUntil;
    const newRow = {
      id: newId_, tenant_id: tenantId, project_id: old.project_id, actor_id: old.actor_id,
      name: `${old.name}（轮换 ${new Date(now).toISOString().slice(0, 10)}）`,
      prefix, key_hash: keyHash, scopes: old.scopes, status: 'active',
      expires_at: newExpiresAt, last_used_at: null, created_at: now,
      rotated_to: null, rotated_at: null,
    };
    await h.query(
      `INSERT INTO api_keys(id,tenant_id,project_id,actor_id,name,prefix,key_hash,scopes,status,expires_at,last_used_at,created_at,rotated_to,rotated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [newRow.id, newRow.tenant_id, newRow.project_id, newRow.actor_id, newRow.name,
       newRow.prefix, newRow.key_hash, newRow.scopes, newRow.status, newRow.expires_at,
       newRow.last_used_at, newRow.created_at, null, null]);
    // 旧 key：宽限期后失效（取更早的那个时间），记录轮换链
    const oldExpiresAt = old.expires_at && old.expires_at < graceUntil ? old.expires_at : graceUntil;
    await h.query(
      'UPDATE api_keys SET expires_at=?, rotated_to=?, rotated_at=? WHERE id=? AND tenant_id=?',
      [oldExpiresAt, newId_, now, keyId, tenantId]);
    const scopes = JSON.parse(old.scopes || '[]');
    const { key_hash: _h1, ...safeNew } = newRow;
    const { key_hash: _h2, ...safeOld } = { ...old, expires_at: oldExpiresAt, rotated_to: newId_, rotated_at: now };
    return {
      oldKey: { ...safeOld, scopes },
      newKey: { ...safeNew, scopes, secret }, // secret 只在这里出现一次
      graceUntil: oldExpiresAt,
    };
  });
}

export const touchKeyLastUsed = (tenantId, keyId) =>
  db().query('UPDATE api_keys SET last_used_at=? WHERE id=? AND tenant_id=?', [nowMs(), keyId, tenantId]);

const ROLES = ['viewer', 'operator', 'admin'];

export async function bindRole(tenantId, actorId, projectId, role, h = db()) {
  assertId('ten', tenantId); assertId('usr', actorId);
  if (!ROLES.includes(role)) throw Errors.badRequest(`非法角色: ${role}`);
  if (projectId) {
    const p = await getProject(tenantId, projectId, h);
    if (!p) throw Errors.badRequest('项目不存在或不属于该租户');
  }
  const a = await getActor(tenantId, actorId, h);
  if (!a) throw Errors.badRequest('actor 不存在或不属于该租户');
  const row = { id: newId('rol'), tenant_id: tenantId, actor_id: actorId, project_id: projectId, role, created_at: nowMs() };
  try {
    await h.query(
      'INSERT INTO role_bindings(id,tenant_id,actor_id,project_id,role,created_at) VALUES (?,?,?,?,?,?)',
      [row.id, row.tenant_id, row.actor_id, row.project_id, row.role, row.created_at]);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw Errors.conflict('角色绑定已存在');
    throw e;
  }
  return row;
}

export const getRoleBindings = async (tenantId, actorId) => {
  assertId('ten', tenantId); assertId('usr', actorId);
  return db().query('SELECT project_id, role FROM role_bindings WHERE tenant_id=? AND actor_id=?', [tenantId, actorId]);
};

export const roleRank = (role) => ROLES.indexOf(role);
