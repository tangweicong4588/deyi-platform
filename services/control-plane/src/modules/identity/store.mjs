/**
 * modules/identity/store.mjs —— 身份域数据访问。
 * 所有查询强制带 tenant_id（租户隔离是底线，不在上层"记得加"）。
 */
import { newId, nowMs, assertId } from '../../kernel/ids.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { db } from '../../db/index.mjs';

export function slugify(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 't';
}

const T = (r) => (r ? { ...r, scopes: undefined } : r);

export async function createTenant({ name, slug }) {
  slug = slug ? slugify(slug) : slugify(name);
  const row = {
    id: newId('ten'), name, slug, status: 'active',
    created_at: nowMs(), updated_at: nowMs(),
  };
  try {
    await db().query(
      'INSERT INTO tenants(id,name,slug,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      [row.id, row.name, row.slug, row.status, row.created_at, row.updated_at]);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw Errors.conflict(`租户 slug 已存在: ${slug}`);
    throw e;
  }
  return row;
}

export const getTenant = async (id) => {
  assertId('ten', id);
  const rows = await db().query('SELECT * FROM tenants WHERE id=?', [id]);
  return rows[0] || null;
};

export const listTenants = async () =>
  (await db().query('SELECT * FROM tenants ORDER BY created_at')).map(T);

export async function createProject(tenantId, { name, slug }) {
  assertId('ten', tenantId);
  slug = slug ? slugify(slug) : slugify(name);
  const row = {
    id: newId('prj'), tenant_id: tenantId, name, slug, status: 'active',
    created_at: nowMs(), updated_at: nowMs(),
  };
  try {
    await db().query(
      'INSERT INTO projects(id,tenant_id,name,slug,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      [row.id, row.tenant_id, row.name, row.slug, row.status, row.created_at, row.updated_at]);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw Errors.conflict(`项目 slug 已存在: ${slug}`);
    throw e;
  }
  return row;
}

/** 取项目（强制校验属于该租户；不存在/不属于都返回 null，不泄露） */
export async function getProject(tenantId, projectId) {
  assertId('ten', tenantId); assertId('prj', projectId);
  const rows = await db().query('SELECT * FROM projects WHERE id=? AND tenant_id=?', [projectId, tenantId]);
  return rows[0] || null;
}

export const listProjects = async (tenantId) => {
  assertId('ten', tenantId);
  return db().query('SELECT * FROM projects WHERE tenant_id=? ORDER BY created_at', [tenantId]);
};

export async function createActor(tenantId, { kind = 'user', name, email = null, externalId = null }) {
  assertId('ten', tenantId);
  if (!['user', 'service'].includes(kind)) throw Errors.badRequest('非法 actor kind');
  if (!name) throw Errors.badRequest('name 必填');
  const row = {
    id: newId('usr'), tenant_id: tenantId, kind, external_id: externalId,
    name, email, status: 'active', created_at: nowMs(), updated_at: nowMs(),
  };
  await db().query(
    'INSERT INTO actors(id,tenant_id,kind,external_id,name,email,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [row.id, row.tenant_id, row.kind, row.external_id, row.name, row.email, row.status, row.created_at, row.updated_at]);
  return row;
}

export async function getActor(tenantId, actorId) {
  assertId('ten', tenantId); assertId('usr', actorId);
  const rows = await db().query('SELECT * FROM actors WHERE id=? AND tenant_id=?', [actorId, tenantId]);
  return rows[0] || null;
}

export async function findActorByExternal(tenantId, externalId) {
  const rows = await db().query(
    'SELECT * FROM actors WHERE tenant_id=? AND external_id=?', [tenantId, externalId]);
  return rows[0] || null;
}

export async function createApiKeyRow({ tenantId, projectId = null, actorId, name, prefix, keyHash, scopes = [], expiresAt = null }) {
  assertId('ten', tenantId); assertId('usr', actorId);
  if (projectId) {
    const p = await getProject(tenantId, projectId);
    if (!p) throw Errors.badRequest('项目不存在或不属于该租户');
  }
  const a = await getActor(tenantId, actorId);
  if (!a) throw Errors.badRequest('actor 不存在或不属于该租户');
  const row = {
    id: newId('key'), tenant_id: tenantId, project_id: projectId, actor_id: actorId,
    name, prefix, key_hash: keyHash, scopes: JSON.stringify(scopes),
    status: 'active', expires_at: expiresAt, last_used_at: null, created_at: nowMs(),
  };
  await db().query(
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

export const touchKeyLastUsed = (tenantId, keyId) =>
  db().query('UPDATE api_keys SET last_used_at=? WHERE id=? AND tenant_id=?', [nowMs(), keyId, tenantId]);

const ROLES = ['viewer', 'operator', 'admin'];

export async function bindRole(tenantId, actorId, projectId, role) {
  assertId('ten', tenantId); assertId('usr', actorId);
  if (!ROLES.includes(role)) throw Errors.badRequest(`非法角色: ${role}`);
  if (projectId) {
    const p = await getProject(tenantId, projectId);
    if (!p) throw Errors.badRequest('项目不存在或不属于该租户');
  }
  const a = await getActor(tenantId, actorId);
  if (!a) throw Errors.badRequest('actor 不存在或不属于该租户');
  const row = { id: newId('rol'), tenant_id: tenantId, actor_id: actorId, project_id: projectId, role, created_at: nowMs() };
  try {
    await db().query(
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
