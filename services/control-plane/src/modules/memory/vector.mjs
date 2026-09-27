/**
 * modules/memory/vector.mjs —— V2.2-B：记忆向量索引（Qdrant 派生索引 deyi_memory）。
 *
 * 与 knowledge/vector.mjs 同构的薄适配：
 * - QDRANT_URL 设置 → 走 Qdrant（collection: deyi_memory）；
 * - 不可用 → 内存 fallback（Map + 余弦相似度，仅开发/测试，状态明确标记）。
 * - Qdrant 是可重建的派生索引：point ID 由平台 memory ID 经 sha256 派生为 UUID；
 *   payload 里同时存平台 ID；业务真相永远在 DB（memories 表）。
 * - filter 语义两边一致：{ tenant_id }（可见性/过期过滤在 DB 侧做，Qdrant 只做召回）。
 *
 * 联调状态：与 knowledge 共用 Qdrant 客户端契约；live 路径尚未与真实 Qdrant 联调，
 * 生产上线前必须端到端验证。重建见 scripts/rebuild-memory-index.mjs。
 */
import { createHash } from 'node:crypto';
import { config } from '../../kernel/config.mjs';
import { logger } from '../../kernel/logging.mjs';

export const MEMORY_COLLECTION = 'deyi_memory';
let cachedStatus = config.QDRANT_URL ? 'qdrant(configured)' : 'local-index(fallback)';

export function getMemoryVectorStatus() { return cachedStatus; }

/** point ID：平台 memory ID → 确定性 UUID（前缀与 knowledge 区分，防跨 collection 碰撞） */
export function memoryPointUuid(platformId) {
  const h = createHash('sha256').update('deyi-memory:' + platformId).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const base = () => config.QDRANT_URL.replace(/\/$/, '');

async function qfetch(path, { method = 'GET', body } = {}) {
  const res = await fetch(base() + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`qdrant ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json().catch(() => ({}));
}

async function qdrantAvailable() {
  if (!config.QDRANT_URL) return false;
  try {
    await qfetch('/');
    return true;
  } catch {
    return false;
  }
}

export async function probeMemoryVector() {
  cachedStatus = (await qdrantAvailable())
    ? 'qdrant(live)'
    : (config.QDRANT_URL ? 'qdrant(unreachable→local-index fallback)' : 'local-index(fallback)');
  logger.info('memory vector probe', { status: cachedStatus });
  return cachedStatus;
}

async function ensureCollection(dim) {
  const info = await qfetch(`/collections/${MEMORY_COLLECTION}`).catch(() => null);
  if (info?.result) {
    const size = info.result?.config?.params?.vectors?.size;
    if (size && size !== dim) {
      throw new Error(`Qdrant collection 维度 ${size} 与当前 embedding 维度 ${dim} 不一致（需重建索引）`);
    }
    return;
  }
  await qfetch(`/collections/${MEMORY_COLLECTION}`, {
    method: 'PUT',
    body: { vectors: { size: dim, distance: 'Cosine' } },
  });
  logger.info('qdrant collection created', { collection: MEMORY_COLLECTION, dim });
}

function qdrantFilter(filter = {}) {
  const must = [];
  if (filter.tenant_id) must.push({ key: 'tenant_id', match: { value: filter.tenant_id } });
  return must.length ? { must } : undefined;
}

// ---------------- 内存 fallback ----------------
const memPoints = new Map(); // memoryPointUuid -> { vector, payload }
export function clearMemoryVectorIndex() { memPoints.clear(); }

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ---------------- 统一接口 ----------------

/**
 * upsert: [{ id: 平台 memoryId, vector: number[], payload: { tenant_id, memory_id, kind, project_id } }]
 */
export async function upsertMemories(items) {
  if (!items.length) return { upserted: 0, engine: cachedStatus };
  const dim = items[0].vector.length;
  if (await qdrantAvailable()) {
    await ensureCollection(dim);
    const points = items.map((m) => ({ id: memoryPointUuid(m.id), vector: m.vector, payload: m.payload }));
    await qfetch(`/collections/${MEMORY_COLLECTION}/points`, {
      method: 'PUT', body: { points },
    });
    cachedStatus = 'qdrant(live)';
    return { upserted: points.length, engine: 'qdrant' };
  }
  for (const m of items) memPoints.set(memoryPointUuid(m.id), { vector: m.vector, payload: m.payload });
  return { upserted: items.length, engine: 'memory(fallback)' };
}

export async function deleteMemories(platformIds) {
  if (!platformIds.length) return { deleted: 0 };
  if (await qdrantAvailable()) {
    await qfetch(`/collections/${MEMORY_COLLECTION}/points/delete`, {
      method: 'POST', body: { points: platformIds.map(memoryPointUuid) },
    });
    return { deleted: platformIds.length, engine: 'qdrant' };
  }
  let n = 0;
  for (const id of platformIds) if (memPoints.delete(memoryPointUuid(id))) n++;
  return { deleted: n, engine: 'memory(fallback)' };
}

/**
 * V2.12：按租户清除记忆向量（offboard）。语义同 knowledge/vector.mjs 的 deleteChunksByTenant。
 */
export async function deleteMemoriesByTenant(tenantId) {
  if (await qdrantAvailable()) {
    await qfetch(`/collections/${MEMORY_COLLECTION}/points/delete`, {
      method: 'POST',
      body: { filter: { must: [{ key: 'tenant_id', match: { value: tenantId } }] } },
    });
    return { engine: 'qdrant', filter_applied: true };
  }
  let n = 0;
  for (const [id, p] of memPoints) {
    if (p?.payload?.tenant_id === tenantId) { memPoints.delete(id); n++; }
  }
  return { deleted: n, engine: 'memory(fallback)' };
}

/**
 * search: { vector, filter: { tenant_id }, limit }
 * 返回 [{ memory_id, score, engine }]（文本/可见性/过期过滤在 DB 侧做，Qdrant 只做召回）
 */
export async function searchMemories({ vector, filter = {}, limit = 10 }) {
  const n = Math.min(Math.max(Number(limit) || 10, 1), 50);
  if (await qdrantAvailable()) {
    const json = await qfetch(`/collections/${MEMORY_COLLECTION}/points/search`, {
      method: 'POST',
      body: { vector, filter: qdrantFilter(filter), limit: n, with_payload: true, with_vector: false },
    });
    return (json.result || []).map((p) => ({
      memory_id: p.payload?.memory_id, score: p.score, engine: 'qdrant',
    }));
  }
  const scored = [];
  for (const [, p] of memPoints) {
    if (filter.tenant_id && p.payload.tenant_id !== filter.tenant_id) continue;
    if (p.vector.length !== vector.length) continue;
    scored.push({ memory_id: p.payload.memory_id, score: cosine(vector, p.vector), engine: 'memory(fallback)' });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n);
}
